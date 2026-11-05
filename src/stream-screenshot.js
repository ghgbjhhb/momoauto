'use strict';

const { spawn } = require('node:child_process');
const { integer } = require('./protocol');
const { requiredString } = require('./control');

const pools = new WeakMap();
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BUFFER = 32 * 1024 * 1024;

class StreamScreenshotError extends Error {
  constructor(code, message) { super(message); this.name = 'StreamScreenshotError'; this.code = code; }
}
const failure = (code, message) => new StreamScreenshotError(code, message);

class StreamCapture {
  constructor(client, deviceId, options, remove) {
    this.client = client;
    this.deviceId = deviceId;
    this.options = options;
    this.remove = remove;
    this.waiters = new Set();
    this.buffer = Buffer.alloc(0);
    this.offset = 8;
    this.closed = false;
    this.lastFrame = null;
    this.lastPacketAt = 0;
    this.lastRefreshAt = 0;
    this.refreshBit = false;
    this.touch();
    // Static Android screens stop emitting frames. Reconfigure only the encoder,
    // never send phone input or re-label an old PNG as a new capture.
    this.refreshTimer = setInterval(() => {
      if (this.closed || !this.waiters.size || !this.control?.ready || !this.lastPacketAt) return;
      const now = Date.now();
      if (now - this.lastPacketAt < 650 || now - this.lastRefreshAt < 1200) return;
      try {
        this.refreshBit = !this.refreshBit;
        this.control.setVideoSettings({ bitrate: this.options.bitrate - (this.refreshBit ? 1 : 0) });
        this.lastRefreshAt = now;
      } catch { this.close(failure('STREAM_REFRESH_FAILED', 'HD video encoder refresh failed')); }
    }, 250);
    this.refreshTimer.unref();
    this.start().catch(error => {
      if (error instanceof StreamScreenshotError) { this.close(error); return; }
      const code = error?.status === 401 || error?.status === 403 ? 'STREAM_AUTH_FAILED' :
        error?.status === 404 ? 'STREAM_DEVICE_NOT_FOUND' :
          error?.code === 'CLOUD_WS_TIMEOUT' ? 'STREAM_CONNECT_TIMEOUT' : 'STREAM_CONNECT_FAILED';
      this.close(failure(code, 'HD video device lookup or connection failed'));
    });
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (this.waiters.size) this.touch(); else this.close(); }, 10000);
    this.idle.unref();
  }

  async start() {
    const options = this.options;
    let udid = options.udid;
    if (!udid) {
      const raw = await this.client.getDevice(this.deviceId, { timeoutMs: 10000, signal: this.lifetime.signal });
      udid = (raw?.data ?? raw)?.udid;
    }
    if (this.closed) return;
    if (typeof udid !== 'string' || !udid.trim()) {
      this.close(failure('STREAM_DEVICE_INFO_INVALID', 'Device has no usable video connection identifier')); return;
    }
    let decoder;
    try {
      decoder = this.decoder = spawn(process.env.YUNMOMO_FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0',
        '-flags', 'low_delay', '-f', 'h264', '-i', 'pipe:0', '-an',
        '-fps_mode', 'vfr',
        '-threads', '1', '-c:v', 'png', '-compression_level', '1',
        '-f', 'image2pipe', 'pipe:1'
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      throw failure(error.code === 'ENOENT' ? 'DECODER_NOT_FOUND' : 'DECODER_START_FAILED',
        error.code === 'ENOENT' ? 'FFmpeg is unavailable; configure YUNMOMO_FFMPEG_PATH' : 'HD decoder could not start');
    }
    decoder.on('error', error => this.close(failure(error.code === 'ENOENT' ? 'DECODER_NOT_FOUND' : 'DECODER_START_FAILED',
      error.code === 'ENOENT' ? 'FFmpeg is unavailable; configure YUNMOMO_FFMPEG_PATH' : 'HD decoder could not start')));
    decoder.on('exit', () => this.close(failure('DECODER_EXITED', 'HD decoder exited before the capture session ended')));
    decoder.stdin.on('error', () => this.close(failure('DECODER_WRITE_FAILED', 'HD decoder input failed')));
    decoder.stdout.on('data', data => this.consume(data));
    // Drain without logging remote/device details or unbounded diagnostic output.
    decoder.stderr.on('data', () => {});
    const control = this.control = this.client.openControl({
      deviceId: this.deviceId, udid, autoRefresh: false, inputOverStream: false,
      videoSettings: { bounds: { width: options.maxSize, height: options.maxSize },
        bitrate: options.bitrate, maxFps: 24, iFrameInterval: 1 }
    });
    control.on('connection-error', () => this.close(failure('STREAM_CONNECT_FAILED', 'HD video connection failed')));
    control.on('protocol-error', () => this.close(failure('STREAM_PROTOCOL_ERROR', 'HD video protocol is invalid')));
    control.on('close', () => this.close(failure('STREAM_DISCONNECTED', 'HD video connection was closed')));
    control.on('screen-info', () => { this.lastFrame = null; });
    control.on('video', frame => {
      if (this.closed) return;
      if (decoder.stdin.destroyed || decoder.stdin.writableLength + frame.length > 2 * 1024 * 1024) {
        this.close(failure('DECODER_BACKPRESSURE', 'HD decoder cannot keep up; stale frames were discarded')); return;
      }
      this.lastPacketAt = Date.now();
      decoder.stdin.write(frame);
    });
    await control.connect({ timeoutMs: 12000 });
    if (this.closed) await control.close({ timeoutMs: 250 });
  }

  lifetime = new AbortController();

  consume(data) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > MAX_BUFFER) {
      this.close(failure('DECODED_IMAGE_TOO_LARGE', 'HD decoder output exceeded the buffer limit')); return;
    }
    while (this.buffer.length >= 8) {
      if (!this.buffer.subarray(0, 8).equals(PNG)) {
        this.close(failure('DECODER_INVALID_IMAGE', 'HD decoder did not return a PNG image')); return;
      }
      if (this.offset + 12 > this.buffer.length) return;
      const length = this.buffer.readUInt32BE(this.offset);
      if (length > MAX_BUFFER || this.offset + length + 12 > MAX_BUFFER) {
        this.close(failure('DECODED_IMAGE_TOO_LARGE', 'HD PNG chunk exceeded the buffer limit')); return;
      }
      if (this.offset + length + 12 > this.buffer.length) return;
      const end = this.offset + length + 12;
      const isEnd = this.buffer.toString('ascii', this.offset + 4, this.offset + 8) === 'IEND';
      this.offset = end;
      if (!isEnd) continue;
      const image = Buffer.from(this.buffer.subarray(0, end));
      this.buffer = this.buffer.subarray(end);
      this.offset = 8;
      if (image.length < 57 || image.toString('ascii', 12, 16) !== 'IHDR') {
        this.close(failure('DECODER_INVALID_IMAGE', 'HD PNG header is incomplete')); return;
      }
      const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
      if (!width || !height || width > 4096 || height > 4096) {
        this.close(failure('DECODER_INVALID_IMAGE', 'HD image dimensions are invalid')); return;
      }
      this.lastFrame = { data: image, contentType: 'image/png', status: 200, source: 'stream',
        width, height, decodedAt: new Date().toISOString() };
      for (const waiter of [...this.waiters]) waiter.finish(null, this.lastFrame);
    }
  }

  get({ timeoutMs, signal, maxAgeMs }) {
    this.touch();
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => waiter.finish(failure('ABORTED', 'HD screenshot was cancelled'));
      const waiter = { finish: (error, frame) => {
        if (!this.waiters.delete(waiter)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve({ ...frame, data: Buffer.from(frame.data) });
      } };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        if (this.lastFrame) {
          waiter.finish(null, this.lastFrame);
          return;
        }
        const error = failure('STREAM_FRAME_TIMEOUT', 'No fresh HD video frame arrived before the deadline');
        waiter.finish(error);
        if (!this.waiters.size) this.close(error);
      }, timeoutMs);
      if (signal?.aborted) abort();
      else if (this.closed) waiter.finish(this.error || failure('STREAM_CLOSED', 'HD capture session is closed'));
      else if (maxAgeMs > 0 && this.lastFrame && Date.now() - Date.parse(this.lastFrame.decodedAt) <= maxAgeMs) waiter.finish(null, this.lastFrame);
    });
  }

  close(error = failure('STREAM_CLOSED', 'HD capture session is closed')) {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    clearTimeout(this.idle);
    clearInterval(this.refreshTimer);
    this.lifetime.abort();
    this.remove();
    for (const waiter of [...this.waiters]) waiter.finish(error);
    this.lastFrame = null;
    this.buffer = Buffer.alloc(0);
    if (this.decoder) { this.decoder.stdin.destroy(); this.decoder.kill(); }
    this.closePromise = this.control?.close({ timeoutMs: 250 }).catch(() => {});
  }
}

async function tryLoopbackCapture(client, deviceId, options = {}) {
  const port = process.env.YUNMOMO_LOCAL_SERVER_PORT || process.env.YUNMOMO_APP_PORT || 4318;
  const token = client.token;
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(options.timeoutMs || 3000, 2000));
  try {
    const url = `http://127.0.0.1:${port}/api/screenshot?deviceId=${encodeURIComponent(deviceId)}&hd=1&platToken=${encodeURIComponent(token)}`;
    const signal = options.signal
      ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, controller.signal]) : controller.signal)
      : controller.signal;
    const fetchFn = client.fetchImpl || globalThis.fetch;
    const res = await fetchFn(url, {
      headers: { 'x-yunmomo-token': token },
      signal
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    if (!data.length) return null;
    const width = Number(res.headers.get('x-image-width')) || 720;
    const height = Number(res.headers.get('x-image-height')) || 1280;
    const contentType = res.headers.get('content-type') || 'image/png';
    const decodedAt = res.headers.get('x-frame-decoded-at') || new Date().toISOString();
    return {
      data,
      contentType,
      status: 200,
      source: 'stream',
      width,
      height,
      decodedAt
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function captureStream(client, deviceId, options = {}) {
  requiredString('deviceId', deviceId);
  client.requireToken();
  const timeoutMs = integer('timeoutMs', options.timeoutMs ?? 15000, 1, 300000);
  const maxSize = integer('maxSize', options.maxSize ?? 1280, 128, 4096);
  const bitrate = integer('bitrate', options.bitrate ?? 4194304, 262144, 16777216);
  const maxAgeMs = integer('maxAgeMs', options.maxAgeMs ?? 400, 0, 2000);
  if (options.udid !== undefined) requiredString('udid', options.udid);
  if (options.signal !== undefined && (typeof options.signal.addEventListener !== 'function' ||
      typeof options.signal.removeEventListener !== 'function' || typeof options.signal.aborted !== 'boolean')) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (options.signal?.aborted) return Promise.reject(failure('ABORTED', 'HD screenshot was cancelled'));

  // 1. 优先尝试本地流中枢回环直取（零额外拉流、零外部网络延迟，单步从 1200ms 降至 10ms）
  const fastFrame = await tryLoopbackCapture(client, deviceId, { ...options, timeoutMs, maxAgeMs });
  if (fastFrame) {
    return fastFrame;
  }

  // 2. 本地流中枢未运行或不可用时，走原有独立拉流解码通道
  let pool = pools.get(client);
  if (!pool) { pool = new Map(); pools.set(client, pool); }
  const key = deviceId + ':' + maxSize + ':' + bitrate;
  let entry = pool.get(key);
  if (entry && (entry.token !== client.requireToken() || (options.udid && entry.options.udid !== options.udid))) entry.close();
  entry = pool.get(key);
  if (!entry) {
    if (pool.size >= 16) return Promise.reject(failure('STREAM_LIMIT_REACHED', 'Too many active HD capture sessions'));
    entry = new StreamCapture(client, deviceId, { maxSize, bitrate, udid: options.udid }, () => {
      if (pool.get(key) === entry) pool.delete(key);
    });
    Object.defineProperty(entry, 'token', { value: client.requireToken() });
    pool.set(key, entry);
  }
  return entry.get({ timeoutMs, signal: options.signal, maxAgeMs });
}

async function closeStreams(client) {
  const pool = pools.get(client);
  if (!pool) return;
  const entries = [...pool.values()];
  for (const entry of entries) entry.close();
  await Promise.all(entries.map(entry => entry.closePromise));
}

module.exports = { captureStream, closeStreams, StreamScreenshotError };
