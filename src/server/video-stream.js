'use strict';

const { WebSocket } = require('ws');
const { createHash } = require('node:crypto');
const { YunmomoClient } = require('../index');

// Public browser video is deliberately lower-detail: Windows negotiates a small
// H.264 stream before proxying it. Re-encoding each frame on Windows would add
// latency/CPU and would not reduce upstream bandwidth. Independent automation
// screenshots (src/stream-screenshot.js) do not use this profile.
const SETTINGS = Object.freeze({ bitrate: 900000, maxFps: 12, iFrameInterval: 1,
  bounds: Object.freeze({ width: 432, height: 768 }), sendFrameMeta: false });
const MAX_VIDEO_SHORT = 432;
const MAX_VIDEO_LONG = 768;
const MAX_BUFFER = 4 * 1024 * 1024;
const UPSTREAM_PING_MS = 15000;
const UPSTREAM_PONG_MS = 10000;
const FRAME_STALL_MS = 30000;

function publicVideoBounds(control) {
  const display = control.info?.displays?.find(item => item.displayId === control.displayId);
  // Physical dimensions are used only to preserve the screen's aspect ratio.
  // Do not overwrite the negotiated compression cap with the native size.
  const width = Number(display?.width);
  const height = Number(display?.height);
  if (![width, height].every(value => Number.isInteger(value) && value >= 16 && value <= 0x7fff)) return null;
  const portrait = height >= width;
  const limitWidth = portrait ? MAX_VIDEO_SHORT : MAX_VIDEO_LONG;
  const limitHeight = portrait ? MAX_VIDEO_LONG : MAX_VIDEO_SHORT;
  const scale = Math.min(1, limitWidth / width, limitHeight / height);
  // Common Android encoders need macroblock-aligned output dimensions.
  const align = dimension => Math.max(16, Math.floor(dimension * scale / 16) * 16);
  return { width: align(width), height: align(height) };
}

// Only authenticated/authorized callers in manual-control may subscribe. No
// upstream URL, token, initial protocol header or arbitrary SDK method is relayed.
function createVideoStreams({ client }) {
  const streams = new Map();

  function getOrCreate(device, token = null) {
    // 不同平台账号可能拥有相同 deviceId，视频源必须按凭据隔离。
    const key = device.deviceId + ':' + createHash('sha256').update(token || 'global').digest('hex');
    let entry = streams.get(key);
    if (!entry) {
      if (streams.size >= 16) throw Object.assign(new Error('视频连接数量已达上限'), { code: 'VIDEO_LIMIT' });
      entry = create(device, token, key);
      streams.set(key, entry);
    }
    return entry;
  }

  function scheduleIdleClose(entry) {
    if (entry.viewers.size || entry.holders.size || entry.closed) return;
    entry.idle = setTimeout(() => entry.close(), 1000);
    entry.idle.unref();
  }

  function subscribe(device, ws, { onSize, onClose, onError }, token = null) {
    const entry = getOrCreate(device, token);
    if (entry.viewers.size >= 8) throw Object.assign(new Error('该设备的视频观看连接已达上限，请关闭其他网页的预览后刷新'), { code: 'VIEWER_LIMIT' });
    clearTimeout(entry.idle);
    const viewer = { ws, onSize, onClose, onError, pongAt: Date.now() };
    viewer.onPong = () => { viewer.pongAt = Date.now(); };
    ws.on('pong', viewer.onPong);
    entry.viewers.add(viewer);
    if (entry.control.ready) onSize(entry.control);
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

  function create(device, token = null, key) {
    const c = token ? new YunmomoClient({ token, timeoutMs: 20000 }) : client();
    const control = c.openControl({ deviceId: device.deviceId, udid: device.udid,
      autoRefresh: false, inputOverStream: false, videoSettings: { ...SETTINGS, bounds: { ...SETTINGS.bounds } } });
    const entry = { control, viewers: new Set(), holders: new Set(), closed: false, lastPacketAt: 0, lastRefreshAt: 0,
      refreshBit: false, startedAt: 0, pingAt: 0, lastPingAt: 0 };
    // 'initial' is emitted before the first SETTINGS packet. Apply the low-bandwidth
    // resolution cap there, with correct portrait/landscape aspect ratio.
    control.on('initial', () => {
      const bounds = publicVideoBounds(control);
      if (bounds) control.videoSettings = { ...control.videoSettings, bounds };
    });
    entry.refresh = () => {
      // Keep refresh rate-limited to avoid encoder thrashing, but responsive for viewer setup.
      if (entry.closed || !control.ready || Date.now() - entry.lastRefreshAt < 1500) return;
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
      entry.viewers.clear();
      entry.holders.clear();
      entry.closing = control.close({ timeoutMs: 250 }).catch(() => {});
    };
    control.on('screen-info', () => {
      // This event also arrives after an encoder reconfiguration with the same
      // dimensions. Every viewer must discard its old reference chain, but the
      // size notification must not trigger another encoder refresh.
      for (const viewer of entry.viewers) viewer.onSize(control);
      for (const holder of entry.holders) holder.onSize(control);
    });
    control.on('video', frame => {
      if (entry.closed) return;
      if (!Buffer.isBuffer(frame) || frame.length > MAX_BUFFER) {
        entry.close('VIDEO_PACKET_INVALID', '视频数据超出限制'); return;
      }
      entry.lastPacketAt = Date.now();
      for (const viewer of entry.viewers) {
        if (viewer.ws.readyState !== WebSocket.OPEN) continue;
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
    // Android emits no frames on static screens. Reconfigure its encoder only;
    // input is never synthesized to get a frame, and old frames are not relabeled.
    entry.timer = setInterval(() => {
      if (entry.closed) return;
      const now = Date.now();
      if (entry.startedAt && (entry.viewers.size || entry.holders.size)) {
        // Heartbeat belongs to the upstream transport, not to phone input.
        // A successful local send is not proof that the remote peer is alive.
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
