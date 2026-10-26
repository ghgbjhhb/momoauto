'use strict';

const { performance } = require('node:perf_hooks');
const { begin } = require('../automation/timing');

class ToolFailure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolFailure';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) { throw new ToolFailure(code, message, details); }
function object(value, field = 'options') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('INVALID_ARGUMENT', field + ' must be a plain object', { field });
  }
  return value;
}
function keys(value, allowed, field = 'options') {
  object(value, field);
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    fail('INVALID_ARGUMENT', field + ' contains an unsupported parameter', { field, allowed });
  }
}
function number(value, field, min, max, integral = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integral && !Number.isInteger(value)) ||
      value < min || value > max) {
    fail('INVALID_ARGUMENT', field + ' is outside its permitted range', { field, min, max, integral });
  }
  return value;
}
function boolean(value, field) {
  if (typeof value !== 'boolean') fail('INVALID_ARGUMENT', field + ' must be boolean', { field });
  return value;
}
function size(value, field) {
  keys(value, ['width', 'height'], field);
  return { width: number(value.width, field + '.width', 1, 65535),
    height: number(value.height, field + '.height', 1, 65535) };
}

// Snapshot queued arguments so a caller cannot accidentally change a pending action.
function snapshot(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 5) fail('INVALID_ARGUMENT', 'Arguments are nested too deeply or contain a cycle');
  if (Array.isArray(value)) {
    if (value.length > 4096) fail('INVALID_ARGUMENT', 'Argument array is too large');
    return Array.from(value, item => snapshot(item, depth + 1));
  }
  object(value, 'argument');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, depth + 1)]));
}

// Neither raw exceptions nor backend payloads are copied into public results/logs.
function describeError(error, ctx) {
  if (error instanceof ToolFailure) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof require('../stream-screenshot').StreamScreenshotError) {
    return { code: error.code, message: error.message, details: { source: 'stream' } };
  }
  const status = Number.isInteger(error?.status) ? error.status : undefined;
  if (status !== undefined) {
    const code = status === 401 ? 'AUTH_FAILED' : status === 403 ? 'PERMISSION_DENIED' :
      status === 404 ? 'DEVICE_NOT_FOUND' : status === 429 ? 'RATE_LIMITED' :
        status >= 500 ? 'BACKEND_UNAVAILABLE' : status >= 200 && status < 300 ? 'BACKEND_REJECTED' : 'HTTP_ERROR';
    return { code, message: 'Cloud backend request failed', details: { httpStatus: status } };
  }
  if (error?.message === 'Screenshot endpoint did not return an image') {
    return { code: 'INVALID_IMAGE', message: 'Screenshot endpoint returned non-image data', details: {} };
  }
  if (error?.message === 'Cloud phone connection/initialization timed out') {
    return { code: 'CONNECT_TIMEOUT', message: 'Control connection did not become ready in time', details: {} };
  }
  const code = ctx.stage === 'connect' ? 'CONNECT_FAILED' : ctx.stage === 'capture' || ctx.stage === 'device_info' ?
    'NETWORK_ERROR' : ctx.stage === 'flush' ? 'WRITE_FAILED' : ctx.stage === 'dispatch' ? 'DISPATCH_FAILED' : 'INTERNAL_ERROR';
  const causeMessage = error?.message || 'Tool operation failed; inspect code and stage';
  const causeName = error?.name || 'Error';
  const rawStack = typeof error?.stack === 'string' ? error.stack : '';
  const stack = rawStack.split(/\r?\n/).slice(0, 5).join('\n');
  return {
    code,
    message: `${causeName}: ${causeMessage}`,
    details: {
      causeName,
      causeMessage,
      ...(stack ? { stack } : {}),
    },
  };
}

class OperationContext {
  constructor(timeoutMs, signal, lifetimeSignal) {
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      fail('INVALID_ARGUMENT', 'signal must be an AbortSignal', { field: 'signal' });
    }
    this.stage = 'queue';
    this.started = performance.now();
    this.deadline = this.started + timeoutMs;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.execution = { state: 'not_started', framesSent: 0, completedClicks: 0,
      release: 'not_needed', localWriteConfirmed: false, deviceConfirmed: false };
    this.attempt = 0;
    this.reason = null;
    this.abort = reason => {
      if (!this.signal.aborted) { this.reason = reason; this.controller.abort(); }
    };
    this.cancel = () => this.abort('ABORTED');
    this.closed = () => this.abort('TOOLS_CLOSED');
    signal?.addEventListener('abort', this.cancel, { once: true });
    lifetimeSignal.addEventListener('abort', this.closed, { once: true });
    this.cleanup = error => {
      this._stageSpan?.end(error ? { ok: false, error } : undefined);
      clearTimeout(this.timer);
      signal?.removeEventListener('abort', this.cancel);
      lifetimeSignal.removeEventListener('abort', this.closed);
    };
    this.timer = setTimeout(() => this.abort('TIMEOUT'), timeoutMs);
    if (signal?.aborted) this.cancel();
    if (lifetimeSignal.aborted) this.closed();
  }
  get stage() { return this._stage; }
  set stage(value) {
    this._stageSpan?.end();
    this._stage = value;
    this._stageSpan = begin('tool.stage.' + value);
  }
  check() {
    if (!this.signal.aborted && performance.now() >= this.deadline) this.abort('TIMEOUT');
    if (this.signal.aborted) fail(this.reason, 'Operation cancelled or deadline exceeded');
  }
  remaining() { this.check(); return Math.max(1, Math.ceil(this.deadline - performance.now())); }
  wait(pending) {
    // Attach rejection handlers even if already aborted: no unhandled late rejects.
    return new Promise((resolve, reject) => {
      const cleanup = () => this.signal.removeEventListener('abort', abort);
      const abort = () => { cleanup(); reject(new ToolFailure(this.reason, 'Operation cancelled or deadline exceeded')); };
      Promise.resolve(pending).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
    });
  }
  sleep(ms) {
    return require('../automation/timing').measure('tool.wait', {}, () => this._sleepMeasured(ms));
  }
  _sleepMeasured(ms) {
    this.check();
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(new ToolFailure(this.reason, 'Operation cancelled or deadline exceeded')); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
    });
  }
}

module.exports = { ToolFailure, fail, object, keys, number, boolean, size, snapshot, describeError, OperationContext };
