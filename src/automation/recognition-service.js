'use strict';

// One loopback service per project, shared by the console and all flow processes.
// The discovery secret is private runtime state, never a cloud login credential.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { RecognitionError } = require('../tools/recognition');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 4329;
const SESSION = path.join(ROOT, '.runtime', 'recognition', 'service.json');
let launching, endpoint;

function rpc(session, route, body, { timeoutMs = 30000, signal, settings } = {}) {
  return new Promise((resolve, reject) => {
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      reject(new RecognitionError('INVALID_ARGUMENT', 'signal must be an AbortSignal', 'validate')); return;
    }
    if (signal?.aborted) { reject(new RecognitionError('ABORTED', 'Recognition request cancelled', 'transport')); return; }
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const headers = { authorization: 'Bearer ' + session.token };
    if (data) { headers['content-length'] = data.length; headers['content-type'] = 'application/octet-stream'; }
    if (settings) headers['x-recognition-options'] = Buffer.from(JSON.stringify(settings)).toString('base64url');
    let timer;
    const fail = error => {
      const reason = error instanceof RecognitionError ? error :
        new RecognitionError(signal?.aborted ? 'ABORTED' : 'SERVICE_UNAVAILABLE',
          signal?.aborted ? 'Recognition request cancelled' : 'Local recognition service disconnected', 'transport');
      if (['SERVICE_UNAVAILABLE', 'SERVICE_AUTH_FAILED'].includes(reason.code)) endpoint = null;
      reject(reason);
    };
    const request = http.request({ host: '127.0.0.1', port: PORT, path: route, method: data ? 'POST' : 'GET', headers }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { request.destroy(new RecognitionError('WORKER_PROTOCOL_ERROR', 'Service response exceeds limit', 'transport')); return; }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200) throw new RecognitionError(value.error?.code ?? 'SERVICE_FAILED',
            value.error?.message ?? 'Local recognition service rejected request', value.error?.stage ?? 'transport', value.error?.details ?? {});
          resolve(value);
        } catch (error) { fail(error); }
      });
    });
    const abort = () => request.destroy(new RecognitionError('ABORTED', 'Recognition request cancelled', 'transport'));
    request.on('error', fail);
    request.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => request.destroy(new RecognitionError('TIMEOUT', 'Local recognition deadline exceeded', 'transport')), timeoutMs);
    if (signal?.aborted) abort();
    request.end(data);
  });
}

async function discovery() {
  const session = JSON.parse(await fs.readFile(SESSION, 'utf8'));
  if (session.port !== PORT || session.protocol !== 1 || !/^[a-f0-9]{64}$/.test(session.token)) {
    throw new RecognitionError('SERVICE_DISCOVERY_INVALID', 'Invalid local service discovery file', 'startup');
  }
  const value = await rpc(session, '/status', undefined, { timeoutMs: 1500 });
  if (value?.service !== 'yunmomo-recognition' || value.pid !== session.pid) {
    throw new RecognitionError('SERVICE_DISCOVERY_INVALID', 'Service identity does not match discovery', 'startup');
  }
  return session;
}

async function ensureService() {
  if (endpoint) return endpoint;
  if (launching) return launching;
  launching = (async () => {
    try { return endpoint = await discovery(); } catch (error) {
      if (error.code === 'SERVICE_DISCOVERY_INVALID') throw error;
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|COOKIE|API_KEY|AUTHORIZATION/i.test(key)) delete env[key];
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/recognition-service.js'), 'serve'],
      { cwd: ROOT, env, detached: true, windowsHide: true, stdio: 'ignore' });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.unref();
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      if (spawnError) throw new RecognitionError('WORKER_START_FAILED', 'Could not launch recognition service', 'startup');
      try { return endpoint = await discovery(); } catch { /* Winner of simultaneous starts publishes discovery. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new RecognitionError('SERVICE_START_FAILED', 'Local recognition service could not bind port ' + PORT, 'startup');
  })().finally(() => { launching = null; });
  return launching;
}

class SharedRecognitionClient {
  constructor() { this._closed = false; this.info = null; this._pending = 0; this._bytes = 0; }
  get closed() { return this._closed; }
  async start() {
    return require('./timing').measure('recognition.warmup', {}, () => this._startMeasured());
  }
  async _startMeasured() {
    if (this.closed) throw new RecognitionError('POOL_CLOSED', 'Recognition client is closed', 'startup');
    const session = await ensureService();
    try { const response = await rpc(session, '/start', {}, { timeoutMs: 125000 }); return this.info = response.data; }
    catch (error) { endpoint = null; throw error; }
  }
  async recognize(model, image, options = {}) {
    const label = ['chatList', 'chatDetail', 'page', 'ocr'].includes(model) ? model : 'invalid';
    return require('./timing').measure('recognition.' + label, {}, () => this._recognizeMeasured(model, image, options));
  }
  async _recognizeMeasured(model, image, options = {}) {
    const began = performance.now();
    const requestId = randomUUID();
    let reserved = 0;
    try {
      if (this.closed) throw new RecognitionError('POOL_CLOSED', 'Recognition client is closed', 'queue');
      if (!['chatList', 'chatDetail', 'page', 'ocr'].includes(model)) throw new RecognitionError('INVALID_ARGUMENT', 'Unknown recognition model', 'validate');
      if (!(image instanceof Uint8Array) || !image.length || image.length > 32 * 1024 * 1024) {
        throw new RecognitionError('IMAGE_INVALID', 'Recognition requires 1 byte to 32 MiB of image bytes', 'validate');
      }
      const { signal, timeoutMs = 30000, ...inputSettings } = options;
      const settings = structuredClone(inputSettings);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new RecognitionError('INVALID_ARGUMENT', 'Invalid timeoutMs', 'validate');
      if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
        throw new RecognitionError('INVALID_ARGUMENT', 'signal must be an AbortSignal', 'validate');
      }
      if (signal?.aborted) throw new RecognitionError('ABORTED', 'Recognition request cancelled', 'queue');
      if (this._pending >= 32) throw new RecognitionError('QUEUE_FULL', 'Local client pending limit reached', 'queue');
      if (this._bytes + image.length > 64 * 1024 * 1024) throw new RecognitionError('QUEUE_BYTES_EXCEEDED', 'Local client image budget exceeded', 'queue');
      reserved = image.length; this._pending++; this._bytes += reserved;
      const bytes = Buffer.from(image);
      const session = await ensureService();
      const remaining = timeoutMs - (performance.now() - began);
      if (remaining <= 0) throw new RecognitionError('TIMEOUT', 'Recognition deadline expired during startup', 'startup');
      const result = await rpc(session, '/recognize/' + model, bytes, { signal, timeoutMs: Math.ceil(remaining),
        settings: { ...settings, timeoutMs: Math.ceil(remaining) } });
      result.timings.totalMs = Math.round((performance.now() - began) * 100) / 100;
      return result;
    } catch (error) {
      if (['SERVICE_UNAVAILABLE', 'SERVICE_AUTH_FAILED'].includes(error.code)) endpoint = null;
      return { ok: false, status: 'failed', model, requestId, data: null, worker: null,
        error: { code: error.code ?? 'INVALID_ARGUMENT', message: error.message, stage: error.stage ?? 'validate', details: error.details ?? {} },
        timings: { queueMs: 0, decodeMs: null, predictMs: null, processingMs: null, totalMs: performance.now() - began } };
    } finally { if (reserved) { this._pending--; this._bytes -= reserved; } }
  }
  chatList(image, options) { return this.recognize('chatList', image, options); }
  chatDetail(image, options) { return this.recognize('chatDetail', image, options); }
  page(image, options) { return this.recognize('page', image, options); }
  ocr(image, options) { return this.recognize('ocr', image, options); }
  async status() {
    if (this.closed) throw new RecognitionError('POOL_CLOSED', 'Recognition client is closed', 'transport');
    return (await rpc(await ensureService(), '/status')).data;
  }
  async close() { this._closed = true; } // Borrower cannot shut down other devices.
}

async function planShared(text, options = {}) {
  const response = await rpc(await ensureService(), '/plan', { text }, options);
  return response.data;
}

async function momoShared(route, image, settings, ctx) {
  ctx.check();
  const session = await ctx.wait(ensureService());
  return (await ctx.wait(rpc(session, '/momo/' + route, image ?? {},
    { timeoutMs: ctx.remaining(), signal: ctx.signal, settings }))).data;
}

async function serviceCommand(command) {
  const session = command === 'start' ? await ensureService() : await discovery();
  return rpc(session, '/' + command, command === 'status' ? undefined : {}, { timeoutMs: 125000 });
}

module.exports = { SharedRecognitionClient,
  planShared: require('./timing').timed('typing.sharedPlan', planShared),
  momoShared: require('./timing').timed('recognition.launcher', momoShared),
  serviceCommand: require('./timing').timed('recognition.serviceCommand', serviceCommand),
  ensureService, ROOT, PORT, SESSION };
