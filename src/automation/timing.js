'use strict';

// Timing is deliberately independent of application logging/configuration. Never
// serialize arguments, results, URLs, exception messages, or credentials here.
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs/promises');
const path = require('node:path');

const ID = /^[a-zA-Z0-9_.:-]{1,128}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const STATES = new Set(['failed', 'error', 'cancelled', 'aborted', 'timeout', 'partial', 'blocked',
  'needs_review', 'uncertain', 'needs_baseline', 'rate_limited']);
const NON_EXECUTED = new Set(['planned', 'dry_run', 'skipped', 'observed', 'drafted']);
const round = value => Math.round(Math.max(0, value) * 100) / 100;

function outcome(value, error) {
  const code = error?.code || value?.error?.code;
  const status = /TIMEOUT/.test(code || '') ? 'timeout' :
    /ABORT|CANCEL/.test(code || '') || error?.name === 'AbortError' ? 'cancelled' : error ? 'failed' :
    STATES.has(value?.status) ? value.status : value?.ok === false || value?.success === false ||
      (Number.isInteger(value?.exitCode) && value.exitCode !== 0) ? 'failed' :
      NON_EXECUTED.has(value?.status) ? value.status : 'completed';
  return { status, ...(CODE.test(code || '') ? { errorCode: code } : {}),
    ...(Number.isInteger(value?.exitCode) ? { exitCode: value.exitCode } : {}) };
}

function metadata(input = {}) {
  const data = {};
  if (['string', 'number'].includes(typeof input.deviceId) && /^\d{1,40}$/.test(String(input.deviceId))) data.deviceId = String(input.deviceId);
  for (const key of ['scriptId', 'taskId', 'operationId']) {
    if (typeof input[key] === 'string' && ID.test(input[key])) data[key] = input[key];
  }
  if (Number.isInteger(input.order) && input.order >= 0) data.order = input.order;
  return data;
}

function createTimingRecorder({ sink, clock = () => performance.now(), now = () => new Date(),
  env = process.env, enabled = true, warn = () => {} } = {}) {
  const storage = new AsyncLocalStorage();
  let warned = false;
  const emit = entry => {
    if (!enabled) return;
    try { sink?.(entry); }
    catch { if (!warned) { warned = true; try { warn(); } catch {} } }
  };
  function begin(name, info = {}) {
    const parent = info.root === true ? null : storage.getStore();
    const runId = parent?.runId || (typeof info.runId === 'string' && ID.test(info.runId) ? info.runId : null) ||
      (info.root !== true && ID.test(env.YUNMOMO_TIMING_RUN_ID || '') ? env.YUNMOMO_TIMING_RUN_ID : randomUUID());
    const spanId = randomUUID();
    const parentSpanId = parent?.spanId || (info.root !== true && ID.test(env.YUNMOMO_TIMING_PARENT_ID || '') ? env.YUNMOMO_TIMING_PARENT_ID : null);
    const started = clock(), startedAt = now().toISOString();
    const context = { runId, spanId, deviceId: info.deviceId || parent?.deviceId };
    const base = { version: 1, runId, spanId, parentSpanId, pid: process.pid,
      name, ...metadata({ deviceId: parent?.deviceId, ...info }), startedAt };
    emit({ ...base, event: 'start' });
    let ended;
    return {
      run: work => storage.run(context, work),
      end(value, error) {
        if (ended) return ended;
        const timings = {};
        for (const key of ['queueMs', 'decodeMs', 'predictMs', 'processingMs', 'totalMs']) {
          if (Number.isFinite(value?.timings?.[key]) && value.timings[key] >= 0) timings[key] = round(value.timings[key]);
        }
        ended = { ...base, event: 'end', finishedAt: now().toISOString(), durationMs: round(clock() - started),
          ...metadata({ operationId: value?.operationId }), ...outcome(value, error),
          ...(Object.keys(timings).length ? { timings } : {}) };
        emit(ended);
        return ended;
      },
      runId, spanId, startedAt
    };
  }
  function measure(name, info, work) {
    if (!enabled) return work();
    const span = begin(name, info);
    return span.run(() => {
      try {
        const result = work();
        if (result && typeof result.then === 'function') {
          return Promise.resolve(result).then(value => { span.end(value); return value; },
            error => { span.end(undefined, error); throw error; });
        }
        span.end(result); return result;
      } catch (error) { span.end(undefined, error); throw error; }
    });
  }
  function timed(name, fn, selectMetadata = () => ({})) {
    return function (...args) {
      // Metadata selection must never prevent the actual operation.
      let info = {};
      try { info = selectMetadata.apply(this, args) || {}; } catch {}
      return measure(name, info, () => fn.apply(this, args));
    };
  }
  return { begin, measure, timed, current: () => storage.getStore(), detached: work => storage.run(undefined, work), childEnv(original = process.env) {
    const current = storage.getStore();
    return current ? { ...original, YUNMOMO_TIMING_RUN_ID: current.runId, YUNMOMO_TIMING_PARENT_ID: current.spanId } : { ...original };
  } };
}

function createFileJournal({ directory, maxBuffered = 8192, flushMs = 40,
  append = fs.appendFile, mkdir = fs.mkdir, warn = () => {} } = {}) {
  let buffer = [], timer, pending = Promise.resolve(), warned = false, outstanding = 0;
  const directories = new Set();
  function warning() { if (!warned) { warned = true; try { warn(); } catch {} } }
  function flush() {
    clearTimeout(timer); timer = null;
    if (!buffer.length) return pending;
    const entries = buffer; buffer = [];
    pending = pending.then(async () => {
      const groups = new Map();
      for (const entry of entries) {
        const day = entry.startedAt.slice(0, 10);
        if (!groups.has(day)) groups.set(day, []);
        groups.get(day).push(JSON.stringify(entry));
      }
      for (const [day, lines] of groups) {
        const folder = path.join(directory, day);
        if (!directories.has(folder)) { await mkdir(folder, { recursive: true }); directories.add(folder); }
        await append(path.join(folder, `timing-${process.pid}.jsonl`), lines.join('\n') + '\n', 'utf8');
      }
    }).catch(warning).finally(() => { outstanding -= entries.length; });
    return pending;
  }
  return { flush, write(entry) {
    if (outstanding >= maxBuffered) { warning(); return; }
    outstanding++;
    buffer.push(entry);
    if (!timer) { timer = setTimeout(flush, flushMs); timer.unref?.(); }
  } };
}

const enabled = process.env.YUNMOMO_TIMING !== '0';
const warn = () => console.error('[timing] TIMING_LOG_WRITE_FAILED_OR_BUFFER_FULL');
const journal = createFileJournal({ directory: process.env.YUNMOMO_TIMING_DIR || path.resolve(__dirname, '../../.runtime/timings'), warn });
const recorder = createTimingRecorder({ sink: entry => journal.write(entry), enabled, warn });
if (enabled) process.on('beforeExit', () => journal.flush());

function timedScript(name, fn) {
  return function (...args) {
    if (!enabled) return fn.apply(this, args);
    const span = recorder.begin(name, { deviceId: process.env.YUNMOMO_DEVICE_ID });
    const finish = (value, error) => {
      const entry = span.end(process.exitCode ? { ok: false, exitCode: process.exitCode } : value, error);
      if (enabled) console.error(`[timing] ${name} ${entry.status} ${entry.durationMs}ms runId=${entry.runId}`);
    };
    return span.run(async () => {
      try { const result = await fn.apply(this, args); finish(result); return result; }
      catch (error) { finish(undefined, error); throw error; }
      finally { await journal.flush(); }
    });
  };
}

module.exports = { ...recorder, timedScript, flushTimings: () => journal.flush(),
  createTimingRecorder, createFileJournal };
