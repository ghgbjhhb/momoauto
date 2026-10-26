'use strict';

const { fail, keys, number, describeError } = require('./runtime');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

// Header/container checks, not a full pixel decoder. Keep original SDK bytes.
function imageInfo(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG)) {
    if (data.length < 57 || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.toString('ascii', data.length - 8, data.length - 4) !== 'IEND' || data.readUInt32BE(data.length - 12) !== 0) {
      fail('INVALID_IMAGE', 'PNG header or end marker is incomplete');
    }
    return { format: 'png', mimeType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length >= 4 && data.readUInt16BE(0) === 0xffd8) {
    if (data.readUInt16BE(data.length - 2) !== 0xffd9) fail('INVALID_IMAGE', 'JPEG end marker is missing');
    let offset = 2;
    while (offset < data.length - 2) {
      if (data[offset++] !== 0xff) break;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if (SOF.has(marker)) {
        if (length < 8) break;
        return { format: 'jpeg', mimeType: 'image/jpeg', height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
    fail('INVALID_IMAGE', 'JPEG dimensions could not be read');
  }
  fail('UNSUPPORTED_IMAGE_FORMAT', 'Screenshot must be PNG or JPEG');
}

async function screenshot(device, options, ctx) {
  keys(options, ['timeoutMs', 'signal', 'level', 'attempts', 'retryDelayMs', 'maxBytes', 'source', 'maxSize', 'bitrate', 'maxAgeMs']);
  const source = options.source ?? 'rest';
  if (!['rest', 'stream'].includes(source)) fail('INVALID_ARGUMENT', 'source must be rest or stream', { field: 'source' });
  if (source === 'rest' && ['maxSize', 'bitrate', 'maxAgeMs'].some(key => options[key] !== undefined)) {
    fail('INVALID_ARGUMENT', 'Video capture parameters require source: stream');
  }
  if (options.maxSize !== undefined) number(options.maxSize, 'maxSize', 128, 4096);
  if (options.bitrate !== undefined) number(options.bitrate, 'bitrate', 262144, 16777216);
  if (options.maxAgeMs !== undefined) number(options.maxAgeMs, 'maxAgeMs', 0, 2000);
  const level = number(options.level ?? 2, 'level', 1, 2);
  const attempts = number(options.attempts ?? 1, 'attempts', 1, 3);
  const retryDelayMs = number(options.retryDelayMs ?? 250, 'retryDelayMs', 0, 10000);
  const maxBytes = number(options.maxBytes ?? 32 * 1024 * 1024, 'maxBytes', 1, 128 * 1024 * 1024);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    ctx.attempt = attempt;
    ctx.stage = 'capture';
    ctx.check();
    let response;
    const requestTimeoutMs = Math.min(options.timeoutMs ?? 15000, ctx.remaining(), 300000);
    try {
      response = await ctx.wait(device.screenshot({ level, source, maxSize: options.maxSize,
        bitrate: options.bitrate, maxAgeMs: options.maxAgeMs, signal: ctx.signal, timeoutMs: requestTimeoutMs }));
      ctx.check();
    } catch (error) {
      ctx.check();
      const { code } = describeError(error, ctx);
      // 视频流静止或无新关键帧导致 STREAM_FRAME_TIMEOUT 时，自动降级为服务端物理 rest 截图兜底
      if (source === 'stream' && (code === 'STREAM_FRAME_TIMEOUT' || String(error?.message).includes('STREAM_FRAME_TIMEOUT'))) {
        try {
          response = await ctx.wait(device.screenshot({ level, source: 'rest', signal: ctx.signal, timeoutMs: requestTimeoutMs }));
          ctx.check();
          if (response?.data) break;
        } catch {}
      }
      if (attempt === attempts || !['NETWORK_ERROR', 'BACKEND_UNAVAILABLE', 'RATE_LIMITED', 'STREAM_FRAME_TIMEOUT'].includes(code)) throw error;
      ctx.stage = 'retry_wait';
      await ctx.sleep(retryDelayMs * attempt);
      continue;
    }
    ctx.stage = 'decode';
    if (!(response?.data instanceof Uint8Array) || !response.data.length) fail('EMPTY_IMAGE', 'Screenshot data is empty');
    const image = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
    if (image.length > maxBytes) fail('IMAGE_TOO_LARGE', 'Screenshot exceeds maxBytes', { bytes: image.length, maxBytes });
    const info = imageInfo(image);
    if (info.width < 1 || info.height < 1 || info.width > 65535 || info.height > 65535) {
      fail('INVALID_IMAGE', 'Screenshot dimensions are invalid', { width: info.width, height: info.height });
    }
    return { image, ...info, bytes: image.length, httpStatus: response.status, source,
      capturedAt: new Date().toISOString(), ...(response.decodedAt ? { decodedAt: response.decodedAt } : {}) };
  }
}

module.exports = { screenshot };
