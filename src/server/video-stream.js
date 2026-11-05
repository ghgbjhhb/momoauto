'use strict';

const { WebSocket } = require('ws');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { YunmomoClient } = require('../index');

// 统一 720P 原生物理分辨率 H.264 流中枢：
// 1. 本地向云端协商 720x1280、4Mbps 原生画质；
// 2. 多端复用：单台/手动控制全量转发，宫格平滑过滤非关键帧（仅传 I 帧，零转码降帧率）；
// 3. 内置无损 PNG 帧捕获缓冲：自动化脚本 OCR 与截屏直接从当前流获取最新帧，耗时 < 30ms，杜绝双流并发。
const SETTINGS = Object.freeze({
  bitrate: 4000000,
  maxFps: 24,
  iFrameInterval: 1,
  bounds: Object.freeze({ width: 720, height: 1280 }),
  sendFrameMeta: false
});
const MAX_VIDEO_SHORT = 720;
const MAX_VIDEO_LONG = 1280;
const MAX_BUFFER = 4 * 1024 * 1024;
const UPSTREAM_PING_MS = 15000;
const UPSTREAM_PONG_MS = 10000;
const FRAME_STALL_MS = 30000;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function containsKeyframe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return false;
  const scanLimit = Math.min(buf.length, 512);
  for (let i = 0; i < scanLimit - 4; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let nalByte = -1;
      if (buf[i + 2] === 1) {
        nalByte = buf[i + 3];
      } else if (buf[i + 2] === 0 && buf[i + 3] === 1) {
        nalByte = buf[i + 4];
      }
      if (nalByte !== -1) {
        const type = nalByte & 0x1f;
        if (type === 5 || type === 7) return true; // 5: IDR, 7: SPS
      }
    }
  }
  return false;
}

function publicVideoBounds(control) {
  const display = control.info?.displays?.find(item => item.displayId === control.displayId);
  const width = Number(display?.width);
  const height = Number(display?.height);
  if (![width, height].every(value => Number.isInteger(value) && value >= 16 && value <= 0x7fff)) return null;
  const portrait = height >= width;
  const limitWidth = portrait ? MAX_VIDEO_SHORT : MAX_VIDEO_LONG;
  const limitHeight = portrait ? MAX_VIDEO_LONG : MAX_VIDEO_SHORT;
  const scale = Math.min(1, limitWidth / width, limitHeight / height);
  const align = dimension => Math.max(16, Math.floor(dimension * scale / 16) * 16);
  return { width: align(width), height: align(height) };
}

function createVideoStreams({ client }) {
  const streams = new Map();

  function getOrCreate(device, token = null) {
    const key = device.deviceId + ':' + createHash('sha256').update(token || 'global').digest('hex');
    let entry = streams.get(key);
    if (!entry) {
      if (streams.size >= 64) throw Object.assign(new Error('视频连接数量已达上限'), { code: 'VIDEO_LIMIT' });
      entry = create(device, token, key);
      streams.set(key, entry);
    }
    return entry;
  }

  function scheduleIdleClose(entry) {
    if (entry.viewers.size || entry.holders.size || entry.waiters.size || entry.closed) return;
    entry.idle = setTimeout(() => entry.close(), 30000);
    entry.idle.unref();
  }

  function subscribe(device, ws, { onSize, onClose, onError }, token = null, mode = 'single') {
    const entry = getOrCreate(device, token);
    if (entry.viewers.size >= 16) throw Object.assign(new Error('该设备的视频观看连接已达上限'), { code: 'VIEWER_LIMIT' });
    clearTimeout(entry.idle);
    const viewer = { ws, onSize, onClose, onError, pongAt: Date.now(), mode: mode || 'single' };
    viewer.onPong = () => { viewer.pongAt = Date.now(); };
    ws.on('pong', viewer.onPong);
    entry.viewers.add(viewer);
    if (entry.control.ready) onSize(entry.control);
    // GOP 关键帧缓存即时重放：新接入的客户端在第 0 毫秒立刻收到最新关键帧并出画，消除等待时差
    if (entry.latestKeyframe && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(entry.latestKeyframe, { binary: true });
        entry.refresh();
      } catch {}
    }
    return {
      control: entry.control,
      ready: entry.ready,
      refresh: () => entry.refresh(),
      release() {
        ws.removeListener('pong', viewer.onPong);
        entry.viewers.delete(viewer);
        scheduleIdleClose(entry);
      }
    };
  }

  function hold(device, { onSize = () => {}, onClose = () => {}, onError = () => {} } = {}, token = null) {
    const entry = getOrCreate(device, token);
    clearTimeout(entry.idle);
    const holder = { onSize, onClose, onError };
    entry.holders.add(holder);
    if (entry.control.ready) onSize(entry.control);
    return {
      control: entry.control,
      ready: entry.ready,
      refresh: () => entry.refresh(),
      release() {
        entry.holders.delete(holder);
        scheduleIdleClose(entry);
      }
    };
  }

  async function captureScreenshot(device, options = {}, token = null) {
    const entry = getOrCreate(device, token);
    clearTimeout(entry.idle);
    await entry.ready;
    entry.ensureDecoder();
    const maxAgeMs = options.maxAgeMs ?? 800;
    const timeoutMs = options.timeoutMs ?? 10000;

    // 若缓存帧足够新鲜，直接同步返回无损 PNG 帧（0 延迟）
    if (entry.latestFrame && Date.now() - entry.latestFrame.at < maxAgeMs) {
      scheduleIdleClose(entry);
      return entry.latestFrame;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.waiters.delete(waiter);
        scheduleIdleClose(entry);
        if (entry.latestFrame) resolve(entry.latestFrame);
        else reject(new Error('等待高清帧解码超时'));
      }, timeoutMs);

      const waiter = {
        finish(err, frame) {
          clearTimeout(timer);
          entry.waiters.delete(waiter);
          scheduleIdleClose(entry);
          if (err) reject(err);
          else resolve(frame);
        }
      };
      entry.waiters.add(waiter);
      entry.refresh();
    });
  }

  function create(device, token = null, key) {
    const c = token ? new YunmomoClient({ token, timeoutMs: 20000 }) : client();
    const control = c.openControl({ deviceId: device.deviceId, udid: device.udid,
      autoRefresh: false, inputOverStream: false, videoSettings: { ...SETTINGS, bounds: { ...SETTINGS.bounds } } });
    const entry = {
      control, viewers: new Set(), holders: new Set(), waiters: new Set(),
      closed: false, lastPacketAt: 0, lastRefreshAt: 0,
      refreshBit: false, startedAt: 0, pingAt: 0, lastPingAt: 0,
      decoder: null, pngBuffer: Buffer.alloc(0), pngOffset: 8,
      latestFrame: null, latestKeyframe: null, decoderIdleTimer: null
    };

    control.on('initial', () => {
      const bounds = publicVideoBounds(control);
      if (bounds) control.videoSettings = { ...control.videoSettings, bounds };
    });

    entry.ensureDecoder = () => {
      if (entry.decoder && !entry.decoder.killed) {
        clearTimeout(entry.decoderIdleTimer);
        entry.decoderIdleTimer = setTimeout(() => entry.closeDecoder(), 15000);
        entry.decoderIdleTimer.unref();
        return;
      }
      try {
        entry.decoder = spawn(process.env.YUNMOMO_FFMPEG_PATH || 'ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0',
          '-flags', 'low_delay', '-f', 'h264', '-i', 'pipe:0', '-an',
          '-fps_mode', 'vfr', '-threads', '1', '-c:v', 'png', '-compression_level', '1',
          '-f', 'image2pipe', 'pipe:1'
        ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

        entry.decoder.stdout.on('data', data => entry.consumePngData(data));
        entry.decoder.on('error', () => entry.closeDecoder());
        entry.decoder.on('exit', () => { entry.decoder = null; });

        clearTimeout(entry.decoderIdleTimer);
        entry.decoderIdleTimer = setTimeout(() => entry.closeDecoder(), 15000);
        entry.decoderIdleTimer.unref();
      } catch (err) {
        console.warn('[VideoStream] FFmpeg 解码器启动跳过:', err.message);
      }
    };

    entry.closeDecoder = () => {
      if (!entry.decoder) return;
      try {
        entry.decoder.stdin.end();
        entry.decoder.kill('SIGTERM');
      } catch {}
      entry.decoder = null;
      entry.pngBuffer = Buffer.alloc(0);
      entry.pngOffset = 8;
    };

    entry.consumePngData = data => {
      if (entry.closed) return;
      entry.pngBuffer = Buffer.concat([entry.pngBuffer, data]);
      if (entry.pngBuffer.length > 16 * 1024 * 1024) {
        entry.pngBuffer = Buffer.alloc(0);
        entry.pngOffset = 8;
        return;
      }
      while (entry.pngBuffer.length >= 8) {
        if (!entry.pngBuffer.subarray(0, 8).equals(PNG_MAGIC)) {
          entry.pngBuffer = Buffer.alloc(0);
          entry.pngOffset = 8;
          return;
        }
        if (entry.pngOffset + 12 > entry.pngBuffer.length) return;
        const length = entry.pngBuffer.readUInt32BE(entry.pngOffset);
        if (length > 16 * 1024 * 1024 || entry.pngOffset + length + 12 > 16 * 1024 * 1024) {
          entry.pngBuffer = Buffer.alloc(0);
          entry.pngOffset = 8;
          return;
        }
        if (entry.pngOffset + length + 12 > entry.pngBuffer.length) return;
        const end = entry.pngOffset + length + 12;
        const isEnd = entry.pngBuffer.toString('ascii', entry.pngOffset + 4, entry.pngOffset + 8) === 'IEND';
        entry.pngOffset = end;
        if (!isEnd) continue;

        const image = Buffer.from(entry.pngBuffer.subarray(0, end));
        entry.pngBuffer = entry.pngBuffer.subarray(end);
        entry.pngOffset = 8;

        if (image.length >= 57 && image.toString('ascii', 12, 16) === 'IHDR') {
          const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
          entry.latestFrame = {
            data: image,
            contentType: 'image/png',
            status: 200,
            source: 'stream',
            width,
            height,
            at: Date.now(),
            decodedAt: new Date().toISOString()
          };
          for (const waiter of [...entry.waiters]) {
            waiter.finish(null, entry.latestFrame);
          }
        }
      }
    };

    entry.refresh = () => {
      if (entry.closed || !control.ready || Date.now() - entry.lastRefreshAt < 1200) return;
      entry.lastRefreshAt = Date.now();
      entry.refreshBit = !entry.refreshBit;
      try { control.setVideoSettings({ bitrate: SETTINGS.bitrate - Number(entry.refreshBit) }); }
      catch { entry.close('VIDEO_REFRESH_FAILED', '视频刷新失败'); }
    };

    entry.close = (code, message) => {
      if (entry.closed) return;
      entry.closed = true;
      clearTimeout(entry.idle);
      clearInterval(entry.timer);
      entry.closeDecoder();
      if (entry.upstream) entry.upstream.removeListener('pong', entry.onPong);
      if (streams.get(key) === entry) streams.delete(key);
      for (const viewer of [...entry.viewers]) {
        if (code) viewer.onError(code, message);
        viewer.onClose();
      }
      for (const holder of [...entry.holders]) {
        if (code) holder.onError(code, message);
        holder.onClose();
      }
      for (const waiter of [...entry.waiters]) {
        waiter.finish(new Error(message || '视频连接已关闭'));
      }
      entry.viewers.clear();
      entry.holders.clear();
      entry.waiters.clear();
      entry.closing = control.close({ timeoutMs: 250 }).catch(() => {});
    };

    control.on('screen-info', () => {
      for (const viewer of entry.viewers) viewer.onSize(control);
      for (const holder of entry.holders) holder.onSize(control);
    });

    control.on('video', frame => {
      if (entry.closed) return;
      if (!Buffer.isBuffer(frame) || frame.length > MAX_BUFFER) {
        entry.close('VIDEO_PACKET_INVALID', '视频数据超出限制'); return;
      }
      entry.lastPacketAt = Date.now();

      // 若内部挂载了解码器，喂给本地解码器产出无损截图
      if (entry.decoder && !entry.decoder.stdin.destroyed) {
        try { entry.decoder.stdin.write(frame); } catch {}
      }

      const isKey = containsKeyframe(frame);
      if (isKey) {
        entry.latestKeyframe = frame;
      }
      for (const viewer of entry.viewers) {
        if (viewer.ws.readyState !== WebSocket.OPEN) continue;
        // 宫格模式仅分发关键帧包，平滑降帧率且省带宽；单台模式全量超清 24fps
        if (viewer.mode === 'grid' && !isKey) continue;
        if (viewer.ws.bufferedAmount + frame.length > MAX_BUFFER) {
          viewer.onError('VIDEO_BACKPRESSURE', '视频连接积压，已停止');
          viewer.ws.close(1013); continue;
        }
        viewer.ws.send(frame, { binary: true }, error => { if (error) viewer.ws.terminate(); });
      }
    });

    control.on('connection-error', () => entry.close('VIDEO_CONNECTION_LOST', '云手机视频连接异常'));
    control.on('protocol-error', () => entry.close('VIDEO_PROTOCOL_ERROR', '云手机视频协议异常'));
    control.on('close', () => entry.close('VIDEO_DISCONNECTED', '云手机视频已断开'));

    entry.timer = setInterval(() => {
      if (entry.closed) return;
      const now = Date.now();
      if (entry.startedAt && (entry.viewers.size || entry.holders.size || entry.waiters.size)) {
        if (entry.pingAt && now - entry.pingAt > UPSTREAM_PONG_MS) {
          entry.close('VIDEO_UPSTREAM_TIMEOUT', '云端视频心跳超时'); return;
        }
        if (!entry.pingAt && now - entry.lastPingAt >= UPSTREAM_PING_MS && entry.upstream.readyState === WebSocket.OPEN) {
          entry.pingAt = entry.lastPingAt = now;
          try {
            entry.upstream.ping(undefined, undefined, error => {
              if (error) entry.close('VIDEO_CONNECTION_LOST', '云手机视频连接异常');
            });
          } catch { entry.close('VIDEO_CONNECTION_LOST', '云手机视频连接异常'); }
          if (entry.closed) return;
        }
        const frameAge = now - (entry.lastPacketAt || entry.startedAt);
        if (frameAge > FRAME_STALL_MS) {
          entry.close('VIDEO_UPSTREAM_STALLED', '云端视频长时间未出帧'); return;
        }
        if (frameAge > 6000) entry.refresh();
        if (entry.closed) return;
      }
      for (const viewer of entry.viewers) {
        if (Date.now() - viewer.pongAt > 10000) { viewer.ws.terminate(); continue; }
        if (viewer.ws.readyState === WebSocket.OPEN) {
          viewer.ws.ping(undefined, undefined, error => { if (error) viewer.ws.terminate(); });
          viewer.ws.send(JSON.stringify({ type: 'heartbeat' }));
        }
      }
    }, 2000);
    entry.timer.unref();

    entry.ready = control.connect({ timeoutMs: 12000 }).then(() => {
      if (entry.closed) throw new Error('视频连接已关闭');
      entry.startedAt = entry.lastPingAt = Date.now();
      entry.upstream = control.socket;
      entry.onPong = () => { entry.pingAt = 0; };
      entry.upstream.on('pong', entry.onPong);
      return control;
    }).catch(error => { entry.close('VIDEO_CONNECT_FAILED', '云手机视频连接失败'); throw error; });
    entry.ready.catch(() => {});
    return entry;
  }

  return {
    subscribe,
    hold,
    captureScreenshot,
    getSettings: control => {
      const settings = control?.videoSettings || SETTINGS;
      return { ...settings, bounds: { ...settings.bounds } };
    },
    async closeAll() {
      const entries = [...streams.values()];
      for (const entry of entries) entry.close('VIDEO_CLOSED', '视频会话已关闭');
      await Promise.all(entries.map(entry => entry.closing));
    }
  };
}

module.exports = { createVideoStreams };
