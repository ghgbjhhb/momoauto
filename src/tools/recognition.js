'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { ToolFailure, keys, number, boolean } = require('./runtime');

const MODELS = Object.freeze(['chatList', 'chatDetail', 'page', 'ocr']);
const ROOT = path.resolve(__dirname, '../..');
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

class RecognitionError extends Error {
  constructor(code, message, stage = 'queue', details = {}) {
    super(message);
    this.name = 'RecognitionError';
    Object.assign(this, { code, stage, details });
  }
}

function errorOf(error, stage = 'validate') {
  if (error instanceof RecognitionError) return error;
  if (error instanceof ToolFailure) return new RecognitionError(error.code, error.message, stage, error.details);
  return new RecognitionError('INTERNAL_ERROR', 'Recognition operation failed', stage,
    { exceptionType: error?.name ?? 'Error' });
}

function text(value, field) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new RecognitionError('INVALID_ARGUMENT', field + ' must be a non-empty single-line string', 'validate');
  }
  return value;
}

function wslPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) ? '/mnt/' + value[0].toLowerCase() + '/' + value.slice(3).replace(/\\/g, '/') : value;
}

function configuration(input) {
  keys(input, ['runtime', 'pythonPath', 'distribution', 'listWeights', 'detailWeights', 'workers',
    'maxInFlight', 'maxQueueSize', 'maxPendingBytes', 'timeoutMs', 'startupTimeoutMs', 'warmupSizes', 'logger'], 'recognition');
  const runtime = input.runtime ?? (process.platform === 'win32' ? 'wsl' : 'native');
  if (!['wsl', 'native'].includes(runtime)) throw new RecognitionError('INVALID_ARGUMENT', 'runtime must be wsl or native', 'validate');
  keys(input.workers ?? {}, MODELS, 'workers');
  const workers = Object.freeze(Object.fromEntries(MODELS.map(model => [model,
    number(input.workers?.[model] ?? (model === 'chatDetail' ? 3 : 2), 'workers.' + model, 1, 8)])));
  const total = Object.values(workers).reduce((a, b) => a + b, 0);
  number(total, 'total workers', 4, 16);
  const warmupSizes = input.warmupSizes ?? [[360, 640], [720, 1280]];
  if (!Array.isArray(warmupSizes) || !warmupSizes.length || warmupSizes.length > 8) {
    throw new RecognitionError('INVALID_ARGUMENT', 'warmupSizes requires 1 to 8 [width,height] pairs', 'validate');
  }
  const sizes = Object.freeze(warmupSizes.map(pair => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new RecognitionError('INVALID_ARGUMENT', 'Invalid warmup size', 'validate');
    const width = number(pair[0], 'warmup width', 100, 4096), height = number(pair[1], 'warmup height', 200, 4096);
    number(width * height, 'warmup pixels', 1, 4_000_000);
    return Object.freeze([width, height]);
  }));
  if (input.logger !== undefined && typeof input.logger !== 'function') throw new RecognitionError('INVALID_ARGUMENT', 'logger must be a function', 'validate');
  const options = { runtime, workers, warmupSizes: sizes,
    pythonPath: text(input.pythonPath ?? (runtime === 'wsl' ? '/root/screenparser/venv/bin/python' : 'python3'), 'pythonPath'),
    distribution: text(input.distribution ?? 'Ubuntu', 'distribution'),
    maxInFlight: number(input.maxInFlight ?? Math.min(3, total), 'maxInFlight', 1, total),
    maxQueueSize: number(input.maxQueueSize ?? 32, 'maxQueueSize', 1, 1024),
    maxPendingBytes: number(input.maxPendingBytes ?? 64 * 1024 * 1024, 'maxPendingBytes', 1, 1024 * 1024 * 1024),
    timeoutMs: number(input.timeoutMs ?? 30000, 'timeoutMs', 1, 300000),
    startupTimeoutMs: number(input.startupTimeoutMs ?? 120000, 'startupTimeoutMs', 1000, 600000), logger: input.logger };
  for (const [key, fallback] of [['listWeights', 'models/01_消息列表页识别模型/weights/best.pt'],
    ['detailWeights', 'models/02_聊天详情页识别模型/weights/best.pt']]) {
    const value = text(input[key] ?? path.join(ROOT, fallback), key);
    options[key] = runtime === 'wsl' && value.startsWith('/') ? value : path.resolve(value);
  }
  return Object.freeze(options);
}

function requestOptions(model, options) {
  const fields = ['timeoutMs', 'signal'];
  if (model === 'chatList' || model === 'chatDetail') fields.push('confidence');
  if (model === 'chatList') fields.push('filterEdgeCards', 'returnAllWithStatus');
  if (model === 'ocr') fields.push('mode', 'input_roi', 'input_full_roi', 'candidate_roi', 'full_field', 'detected_candidates', 'regions');
  keys(options, fields, 'recognition request');
  if (options.signal !== undefined && (typeof options.signal?.aborted !== 'boolean' ||
      typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) {
    throw new RecognitionError('INVALID_ARGUMENT', 'signal must be an AbortSignal', 'validate');
  }
  const result = {};
  if (options.confidence !== undefined) result.confidence = number(options.confidence, 'confidence', 0, 1, false);
  for (const key of ['filterEdgeCards', 'returnAllWithStatus']) {
    if (options[key] !== undefined) result[key] = boolean(options[key], key);
  }
  if (model === 'ocr') {
    result.mode = options.mode ?? 'general';
    if (!['general', 'ime'].includes(result.mode)) throw new RecognitionError('INVALID_ARGUMENT', 'OCR mode must be general or ime', 'validate');
    if (options.regions !== undefined) {
      if (result.mode !== 'general' || !Array.isArray(options.regions) || !options.regions.length || options.regions.length > 8 ||
          !options.regions.every(roi => Array.isArray(roi) && roi.length === 4 &&
            roi.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) && roi[0] < roi[2] && roi[1] < roi[3])) {
        throw new RecognitionError('INVALID_ARGUMENT', 'regions requires 1 to 8 normalized OCR rectangles in general mode', 'validate');
      }
      result.regions = options.regions.map(roi => [...roi]);
    }
    for (const key of ['input_roi', 'input_full_roi', 'candidate_roi']) {
      if (options[key] === undefined) continue;
      const roi = options[key];
      if (!Array.isArray(roi) || roi.length !== 4 || !roi.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) ||
          roi[0] >= roi[2] || roi[1] >= roi[3]) throw new RecognitionError('INVALID_ARGUMENT', key + ' must be a normalized rectangle', 'validate');
      result[key] = [...roi];
    }
    for (const key of ['full_field', 'detected_candidates']) if (options[key] !== undefined) result[key] = boolean(options[key], key);
  }
  return result;
}

class GpuRecognitionPool {
  constructor(options = {}) {
    try { this.options = configuration(options); }
    catch (error) { throw errorOf(error); }
    this._state = 'idle';
    this._accepting = true;
    this._jobs = new Map();
    this._queues = Object.fromEntries(MODELS.map(model => [model, []]));
    this._lanes = Object.fromEntries(MODELS.map(model => [model,
      Array.from({ length: this.options.workers[model] }, (_, index) => ({ index, requestId: null }))]));
    this._active = 0;
    this._bytes = 0;
    this._cursor = 0;
    this._buffer = '';
    this._idleWaiters = new Set();
    this._metrics = { admitted: 0, completed: 0, failed: 0, rejected: 0, discardedLateResults: 0 };
    this.info = null;
    this._lastError = null;
  }

  get closed() { return !this._accepting || ['failed', 'closed'].includes(this._state); }

  start() {
    if (this.closed) return Promise.reject(new RecognitionError('POOL_CLOSED', 'Recognition pool is not available', 'startup'));
    if (this._state === 'ready') return Promise.resolve(this.info);
    if (this._ready) return this._ready;
    this._state = 'starting';
    this._ready = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject; });
    const warmup = require('../automation/timing').begin('recognition.pool.warmup');
    this._ready.then(value => warmup.end(value), error => warmup.end(undefined, error));
    this._ready.catch(() => {});
    this._initId = randomUUID();
    try {
      const { runtime, pythonPath, distribution } = this.options;
      const file = path.join(__dirname, 'vision/recognition_worker.py');
      const env = { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '2' };
      for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|COOKIE|API_KEY|AUTHORIZATION/i.test(key)) delete env[key];
      const command = runtime === 'wsl' ? 'wsl.exe' : pythonPath;
      const args = runtime === 'wsl' ? ['-d', distribution, '-e', wslPath(pythonPath), '-B', '-u', wslPath(file)] : ['-B', '-u', file];
      this._child = spawn(command, args, { cwd: ROOT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this._child.stdout.setEncoding('utf8');
      this._child.stdout.on('data', chunk => this._receive(chunk));
      // Third-party stderr is intentionally not copied into results or application logs.
      this._child.stderr.on('data', () => {});
      this._child.stdout.on('error', () => this._fail(new RecognitionError('PIPE_FAILED', 'Recognition output pipe failed', 'transport')));
      this._child.stdin.on('error', () => this._fail(new RecognitionError('PIPE_FAILED', 'Recognition input pipe failed', 'transport')));
      this._child.stdin.on('drain', () => { this._blocked = false; this._pump(); });
      this._child.on('error', error => this._fail(new RecognitionError('WORKER_START_FAILED', 'Could not start Python/WSL', 'startup',
        { systemCode: error.code ?? null })));
      this._exited = new Promise(resolve => this._child.once('close', (exitCode, signal) => {
        clearTimeout(this._killTimer);
        if (!['closing', 'closed', 'failed'].includes(this._state)) {
          this._fail(new RecognitionError('WORKER_EXITED', 'Recognition worker exited', 'transport', { exitCode, signal }));
        }
        resolve({ exitCode, signal });
      }));
      this._startupTimer = setTimeout(() => this._fail(new RecognitionError('STARTUP_TIMEOUT', 'Model loading or warmup exceeded the startup deadline', 'startup')),
        this.options.startupTimeoutMs);
      const asset = value => runtime === 'wsl' ? wslPath(value) : value;
      this._write({ id: this._initId, command: 'init', payload: { listWeights: asset(this.options.listWeights),
        detailWeights: asset(this.options.detailWeights), workers: this.options.workers,
        legacyOcrSitePackages: require('../automation/ocr').resolveOcrEnvironment({ runtime }).sitePackages,
        warmupSizes: this.options.warmupSizes, maxInFlight: this.options.maxInFlight } });
    } catch (error) { this._fail(errorOf(error, 'startup')); }
    return this._ready;
  }

  chatList(image, options = {}) { return this.recognize('chatList', image, options); }
  chatDetail(image, options = {}) { return this.recognize('chatDetail', image, options); }
  page(image, options = {}) { return this.recognize('page', image, options); }
  ocr(image, options = {}) { return this.recognize('ocr', image, options); }

  recognize(model, image, options = {}) {
    const label = MODELS.includes(model) ? model : 'invalid';
    return require('../automation/timing').measure('recognition.pool.' + label, {},
      () => this._recognizeMeasured(model, image, options));
  }

  _recognizeMeasured(model, image, options = {}) {
    const id = randomUUID(), began = performance.now();
    let settings, timeout;
    try {
      if (!MODELS.includes(model)) throw new RecognitionError('INVALID_ARGUMENT', 'Unknown recognition model', 'validate', { model });
      settings = requestOptions(model, options);
      timeout = number(options.timeoutMs ?? this.options.timeoutMs, 'timeoutMs', 1, 300000);
      if (this.closed) throw new RecognitionError('POOL_CLOSED', 'Recognition pool is closing or unavailable', 'queue');
      if (options.signal?.aborted) throw new RecognitionError('ABORTED', 'Recognition request was cancelled', 'queue');
      if (!(image instanceof Uint8Array) || !image.byteLength || image.byteLength > MAX_IMAGE_BYTES) {
        throw new RecognitionError('IMAGE_INVALID', 'Recognition requires 1 byte to 32 MiB of image bytes', 'validate');
      }
      if (this._queues[model].length >= this.options.maxQueueSize) {
        throw new RecognitionError('QUEUE_FULL', 'Recognition model queue is full', 'queue', { model, limit: this.options.maxQueueSize });
      }
      if (this._bytes + image.byteLength > this.options.maxPendingBytes) {
        throw new RecognitionError('QUEUE_BYTES_EXCEEDED', 'Recognition image byte budget is exhausted', 'queue', { limit: this.options.maxPendingBytes });
      }
    } catch (error) {
      this._metrics.rejected++;
      return Promise.resolve(this._result({ id, model, began }, false, null, errorOf(error)));
    }
    return new Promise(resolve => {
      const job = { id, model, began, deadline: began + timeout, settings,
        image: Buffer.from(image), bytes: image.byteLength, resolve, state: 'queued', settled: false,
        signal: options.signal, cancel: null, timer: null };
      job.cancel = () => this._cancel(job, new RecognitionError('ABORTED', 'Recognition request was cancelled', job.state === 'queued' ? 'queue' : 'inference'));
      job.timer = setTimeout(() => this._cancel(job,
        new RecognitionError('TIMEOUT', 'Recognition request exceeded its total deadline', job.state === 'queued' ? 'queue' : 'inference')), timeout);
      this._jobs.set(id, job);
      this._queues[model].push(job);
      this._bytes += job.bytes;
      this._metrics.admitted++;
      job.signal?.addEventListener('abort', job.cancel, { once: true });
      this._log('queued', job);
      if (job.signal?.aborted) job.cancel();
      if (this._state === 'idle') this.start().catch(() => {});
      this._pump();
    });
  }

  status() {
    return { state: this._state, ready: this._state === 'ready', accepting: this._accepting,
      active: this._active, pending: this._jobs.size, pendingBytes: this._bytes,
      maxInFlight: this.options.maxInFlight, maxQueueSize: this.options.maxQueueSize,
      maxPendingBytes: this.options.maxPendingBytes,
      models: Object.fromEntries(MODELS.map(model => [model, { workers: this._lanes[model].length,
        active: this._lanes[model].filter(lane => lane.requestId !== null).length, queued: this._queues[model].length }])),
      metrics: { ...this._metrics }, lastError: this._lastError, info: this.info };
  }

  _write(message) {
    if (!this._child?.stdin.writable) throw new RecognitionError('PIPE_FAILED', 'Recognition input pipe is not writable', 'transport');
    const ready = this._child.stdin.write(JSON.stringify(message) + '\n', error => {
      if (error) this._fail(new RecognitionError('PIPE_FAILED', 'Could not write recognition request', 'transport'));
    });
    if (!ready) this._blocked = true;
  }

  _receive(chunk) {
    this._buffer += chunk;
    let end;
    while ((end = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, end).trim();
      this._buffer = this._buffer.slice(end + 1);
      if (!line) continue;
      if (line.length > 4 * 1024 * 1024) { this._protocolFailure(); return; }
      let reply;
      try { reply = JSON.parse(line); } catch { this._protocolFailure(); return; }
      if (!reply || typeof reply !== 'object' || Array.isArray(reply) || typeof reply.id !== 'string') {
        this._protocolFailure(); return;
      }
      if (reply.id === this._initId && this._state === 'starting') {
        clearTimeout(this._startupTimer);
        if (reply.ok !== true) {
          this._fail(new RecognitionError(reply.error?.code ?? 'MODEL_LOAD_FAILED', reply.error?.message ?? 'Recognition startup failed',
            reply.error?.stage ?? 'startup', reply.error?.details ?? {}));
          return;
        }
        if (reply.data?.ready !== true || reply.data.device !== 'cuda:0' ||
            MODELS.some(model => reply.data.models?.[model]?.workers !== this.options.workers[model])) {
          this._protocolFailure(); return;
        }
        this.info = reply.data;
        this._state = this._accepting ? 'ready' : 'draining';
        this._resolveReady(this.info);
        this._log('ready');
        this._pump();
        continue;
      }
      const job = this._jobs.get(reply.id);
      if (!job) {
        if (!['closed', 'closing', 'failed'].includes(this._state)) this._protocolFailure();
        continue;
      }
      if (job.state !== 'running' || (reply.model !== undefined && reply.model !== job.model) ||
          (reply.lane !== undefined && reply.lane !== job.lane.index)) { this._protocolFailure(); return; }
      if (reply.ok === true && reply.data && typeof reply.data === 'object' &&
          Number.isFinite(reply.timings?.processingMs) && reply.timings.processingMs >= 0) {
        this._complete(job, true, reply.data, null, reply.timings);
      } else if (reply.ok === false && typeof reply.error?.code === 'string') {
        const error = new RecognitionError(reply.error.code, reply.error.message ?? 'Recognition failed',
          reply.error.stage ?? 'inference', reply.error.details ?? {});
        if (reply.error.fatal) { this._fail(error); return; }
        this._complete(job, false, null, error);
      } else { this._protocolFailure(); return; }
    }
    if (this._buffer.length > 4 * 1024 * 1024) this._protocolFailure();
  }

  _protocolFailure() { this._fail(new RecognitionError('WORKER_PROTOCOL_ERROR', 'Recognition worker returned an invalid response', 'transport')); }

  _pump() {
    if (this._pumping || this._blocked || !['ready', 'draining'].includes(this._state)) return;
    this._pumping = true;
    try {
      while (!this._blocked && ['ready', 'draining'].includes(this._state) && this._active < this.options.maxInFlight) {
        let chosen = null;
        for (let offset = 0; offset < MODELS.length; offset++) {
          const index = (this._cursor + offset) % MODELS.length, model = MODELS[index];
          const lane = this._lanes[model].find(value => value.requestId === null);
          if (lane && this._queues[model].length) { chosen = { model, lane }; this._cursor = (index + 1) % MODELS.length; break; }
        }
        if (!chosen) break;
        const job = this._queues[chosen.model].shift();
        if (performance.now() >= job.deadline) {
          this._cancel(job, new RecognitionError('TIMEOUT', 'Recognition deadline expired in queue', 'queue'));
          continue;
        }
        job.state = 'running';
        job.dispatched = performance.now();
        job.lane = chosen.lane;
        chosen.lane.requestId = job.id;
        this._active++;
        this._log('dispatched', job);
        this._write({ id: job.id, command: 'recognize', payload: { model: job.model, lane: job.lane.index,
          image: job.image.toString('base64'), options: job.settings } });
        job.image = null;
      }
    } catch (error) { this._fail(errorOf(error, 'transport')); }
    finally { this._pumping = false; }
  }

  _cancel(job, error) {
    if (job.settled || job.released) return;
    if (job.state === 'queued') {
      const queue = this._queues[job.model], index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
      this._release(job);
    }
    // An in-flight CUDA call cannot be interrupted safely. Retain its lane until the real reply.
    this._settle(job, false, null, error);
    this._pump();
  }

  _complete(job, ok, data, error, timings) {
    this._release(job);
    if (job.settled) {
      this._metrics.discardedLateResults++;
      this._log('discarded_late_result', job);
    } else this._settle(job, ok, data, error, timings);
    this._pump();
  }

  _release(job) {
    if (job.released) return;
    job.released = true;
    this._jobs.delete(job.id);
    this._bytes -= job.bytes;
    job.image = null;
    if (job.lane?.requestId === job.id) { job.lane.requestId = null; this._active--; }
    if (!this._jobs.size) {
      for (const resolve of this._idleWaiters) resolve();
      this._idleWaiters.clear();
    }
  }

  _result(job, ok, data, error, workerTimings) {
    const now = performance.now();
    const queueMs = (job.dispatched ?? now) - job.began;
    return { ok, status: ok ? 'recognized' : 'failed', requestId: job.id, model: job.model,
      data, error: error ? { code: error.code, message: error.message, stage: error.stage, details: error.details } : null,
      timings: { queueMs: Math.round(queueMs * 100) / 100,
        processingMs: workerTimings?.processingMs ?? null, decodeMs: workerTimings?.decodeMs ?? null,
        predictMs: workerTimings?.predictMs ?? null, totalMs: Math.round((now - job.began) * 100) / 100 },
      worker: job.lane ? { lane: job.lane.index, device: 'cuda:0', pid: this.info?.pid ?? null } : null };
  }

  _settle(job, ok, data, error, timings) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.cancel);
    const result = this._result(job, ok, data, error, timings);
    this._metrics[ok ? 'completed' : 'failed']++;
    this._log(ok ? 'completed' : 'failed', job, result);
    job.resolve(result);
  }

  _log(event, job, result) {
    if (!this.options.logger) return;
    try {
      const pending = this.options.logger({ event, requestId: job?.id ?? null, model: job?.model ?? null,
        lane: job?.lane?.index ?? null, queued: job ? this._queues[job.model].length : null,
        active: this._active, ...(result ? { ok: result.ok, timings: result.timings,
          error: result.error ? { code: result.error.code, stage: result.error.stage } : null } : {}) });
      if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
    } catch { /* A diagnostic callback must not alter admission or inference. */ }
  }

  _fail(error) {
    if (['closing', 'closed', 'failed'].includes(this._state)) return;
    error = errorOf(error, 'transport');
    this._lastError = { code: error.code, message: error.message, stage: error.stage, details: error.details };
    this._state = 'failed';
    this._accepting = false;
    clearTimeout(this._startupTimer);
    this._rejectReady?.(error);
    for (const queue of Object.values(this._queues)) queue.length = 0;
    for (const job of [...this._jobs.values()]) { this._release(job); this._settle(job, false, null, error); }
    this._child?.stdin.end();
    if (this._child) {
      this._killTimer = setTimeout(() => this._child.kill('SIGKILL'), 6000);
      this._killTimer.unref();
    }
  }

  close(options = {}) {
    if (this._closing) return this._closing;
    let drain, timeoutMs;
    try {
      keys(options, ['drain', 'timeoutMs'], 'close');
      drain = boolean(options.drain ?? true, 'drain');
      timeoutMs = number(options.timeoutMs ?? 30000, 'close.timeoutMs', 1, 300000);
    } catch (error) { return Promise.reject(errorOf(error)); }
    this._accepting = false;
    this._closing = (async () => {
      let timer, timedOut = false;
      if (drain && this._jobs.size && !['failed', 'closed'].includes(this._state)) {
        if (this._state === 'ready') this._state = 'draining';
        const idle = new Promise(resolve => this._idleWaiters.add(resolve));
        await Promise.race([idle, new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); })]);
        clearTimeout(timer);
      }
      this._state = 'closing';
      clearTimeout(this._startupTimer);
      const cancelled = new RecognitionError('POOL_CLOSED', timedOut ? 'Recognition shutdown deadline exceeded' : 'Recognition pool closed', 'shutdown');
      this._rejectReady?.(cancelled);
      for (const queue of Object.values(this._queues)) queue.length = 0;
      for (const job of [...this._jobs.values()]) { this._release(job); this._settle(job, false, null, cancelled); }
      this._child?.stdin.end();
      if (this._child) {
        let stopTimer;
        const exited = await Promise.race([this._exited.then(() => true),
          new Promise(resolve => { stopTimer = setTimeout(() => resolve(false), 6500); })]);
        clearTimeout(stopTimer);
        if (!exited) {
          this._child.kill('SIGKILL');
          this._state = 'closed';
          throw new RecognitionError('WORKER_SHUTDOWN_TIMEOUT', 'Worker termination was not confirmed', 'shutdown');
        }
      }
      this._state = 'closed';
      this._buffer = '';
    })();
    return this._closing;
  }
}

// Borrow a pool in device tools without letting a single phone close everybody's GPU worker.
class PooledChatDetailVision {
  constructor(pool) { this.pool = pool; this._closed = false; }
  get closed() { return this._closed || this.pool.closed; }
  async start(ctx) {
    ctx.check();
    try {
      const info = await ctx.wait(this.pool.start());
      ctx.check();
      this.info = { device: info.device, gpu: info.gpu, classes: info.models.chatDetail.lanes[0].classes,
        model: '02_聊天详情页识别模型', pooled: true };
      return this.info;
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
      const known = errorOf(error, 'startup');
      throw new ToolFailure(known.code, known.message, { ...known.details, recognitionStage: known.stage });
    }
  }
  async inspect(image, settings, ctx) {
    ctx.check();
    const result = await this.pool.chatDetail(image, { confidence: settings.confidence, timeoutMs: ctx.remaining(), signal: ctx.signal });
    ctx.check();
    if (!result.ok) throw new ToolFailure(result.error.code, result.error.message,
      { ...result.error.details, recognitionStage: result.error.stage, requestId: result.requestId });
    return result.data;
  }
  async close() { this._closed = true; }
}

function createRecognitionPool(options) { return new GpuRecognitionPool(options); }

module.exports = { GpuRecognitionPool, createRecognitionPool, RecognitionError, PooledChatDetailVision };
