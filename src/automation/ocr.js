'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { PROJECT_ROOT } = require('./runtime');
const DEFAULT_OCR_TIMEOUT_MS = 30000;
function numberOr(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function toWslPath(filePath) {
  // Keep an explicitly configured Linux path intact on the Windows host.
  if (process.platform === 'win32' && String(filePath).startsWith('/')) return filePath;
  const resolved = path.resolve(filePath);
  if (process.platform !== 'win32') return resolved;
  if (/^[A-Za-z]:[\\/]/.test(resolved)) {
    return `/mnt/${resolved[0].toLowerCase()}${resolved.slice(2).replace(/\\/g, '/')}`;
  }
  return resolved.replace(/\\/g, '/');
}

function resolveOcrEnvironment({ runtime = process.platform === 'win32' ? 'wsl' : 'native' } = {}) {
  const runtimeDirectory = path.join(PROJECT_ROOT, '.runtime', 'ocr');
  const legacy = path.join(PROJECT_ROOT, '.local-output', 'vision-test');
  const root = fs.existsSync(path.join(runtimeDirectory, 'venv', 'pyvenv.cfg')) ? runtimeDirectory : legacy;
  const asset = value => runtime === 'wsl' ? toWslPath(value) : path.resolve(value);
  return {
    sitePackages: asset(process.env.YUNMOMO_OCR_SITE_PACKAGES || path.join(root, 'site-packages')),
    python: asset(process.env.YUNMOMO_OCR_PYTHON || path.join(root, 'venv', 'bin', 'python')),
  };
}

class LegacyRapidOcrWorker {
  constructor(options = {}) {
    const { sitePackages, python } = resolveOcrEnvironment();
    const worker = toWslPath(options.workerPath || path.join(PROJECT_ROOT, 'python_workers', 'ocr', 'rapidocr_worker.py'));
    const command = `YUNMOMO_OCR_SITE_PACKAGES=${shellQuote(sitePackages)} PYTHONPATH=${shellQuote(sitePackages)} ${shellQuote(python)} ${shellQuote(worker)}`;
    this.child = spawn('wsl.exe', ['bash', '-lc', command], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pending = [];
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.onStdout(chunk));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    const pipeFailed = error => { this.closed = true; this.failAll(error); };
    this.child.on('error', pipeFailed);
    this.child.stdin.on('error', pipeFailed);
    this.child.stdout.on('error', pipeFailed);
    this.child.on('close', code => {
      this.closed = true;
      if (code !== 0) {
        const suffix = this.stderr.trim() ? `: ${this.stderr.trim().slice(-800)}` : '';
        this.failAll(new Error(`RapidOCR worker exited with code ${code}${suffix}`));
      } else {
        this.failAll(new Error('RapidOCR worker closed'));
      }
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let response;
      try { response = JSON.parse(trimmed); } catch { continue; }
      const index = response?.id === undefined ? 0 : this.pending.findIndex(item => item.id === response.id);
      if (index < 0) continue;
      const request = this.pending.splice(index, 1)[0];
      if (!request) continue;
      request.cleanup();
      if (response?.ok === false) request.reject(new Error(response.error || 'RapidOCR failed'));
      else request.resolve(response);
    }
  }

  failAll(error) {
    while (this.pending.length) {
      const request = this.pending.shift();
      request.cleanup();
      request.reject(error);
    }
  }

  recognize(image, options = {}) {
    if (this.closed) return Promise.reject(new Error('RapidOCR worker is closed'));
    if (this.pending.length >= 32) return Promise.reject(Object.assign(new Error('OCR queue is full'), { code: 'QUEUE_FULL' }));
    const timeoutMs = numberOr(options.timeoutMs ?? process.env.YUNMOMO_OCR_TIMEOUT_MS, DEFAULT_OCR_TIMEOUT_MS);
    const { signal, timeoutMs: ignored, ...settings } = options;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
        (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean'))) {
      return Promise.reject(Object.assign(new Error('Invalid OCR timeout or signal'), { code: 'INVALID_ARGUMENT' }));
    }
    const payload = typeof image === 'string' ? { path: toWslPath(image) } :
      image instanceof Uint8Array && image.length && image.length <= 32 * 1024 * 1024 ? { image: Buffer.from(image).toString('base64') } : null;
    if (!payload) return Promise.reject(Object.assign(new Error('Invalid OCR image'), { code: 'IMAGE_INVALID' }));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('OCR aborted'), { code: 'ABORTED' }));
    return new Promise((resolve, reject) => {
      // Keep timed-out FIFO slots until the response arrives. Even custom legacy
      // workers without IDs must not assign a late result to another request.
      const abort = () => { request.cleanup(); reject(Object.assign(new Error('OCR aborted'), { code: 'ABORTED' })); };
      const request = { id: randomUUID(), resolve, reject,
        cleanup: () => { clearTimeout(request.timer); signal?.removeEventListener('abort', abort); } };
      request.timer = setTimeout(() => { request.cleanup(); reject(Object.assign(new Error('OCR deadline exceeded'), { code: 'TIMEOUT' })); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.push(request);
      this.child.stdin.write(JSON.stringify({ ...settings, ...payload, id: request.id }) + '\n');
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 1500);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}

// Compatibility facade: old callers keep their paths/fields, while image bytes
// go directly to the shared GPU queue. Explicit legacy mode is never automatic.
class RapidOcrWorker {
  constructor(options = {}) {
    const workerName = path.basename(options.workerPath ?? 'rapidocr_worker.py');
    if (process.env.YUNMOMO_OCR_LEGACY === '1' || !['rapidocr_worker.py', 'ime_ocr_worker.py'].includes(workerName)) {
      return new LegacyRapidOcrWorker(options);
    }
    this.mode = workerName === 'ime_ocr_worker.py' ? 'ime' : 'general';
    this.pool = options.recognitionPool ?? new (require('./recognition-service').SharedRecognitionClient)();
    this.owned = options.recognitionPool === undefined;
    this.closed = false;
    this.pending = new Set();
    this.ready = this.pool.start();
    this.ready.catch(() => {});
  }
  async recognize(image, options = {}) {
    if (this.closed) throw new Error('RapidOCR worker is closed');
    const timeoutMs = numberOr(options.timeoutMs ?? process.env.YUNMOMO_OCR_TIMEOUT_MS, DEFAULT_OCR_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 ||
        (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== 'function' ||
          typeof options.signal.removeEventListener !== 'function' || typeof options.signal.aborted !== 'boolean'))) {
      throw Object.assign(new Error('Invalid OCR timeout or signal'), { code: 'INVALID_ARGUMENT' });
    }
    const controller = new AbortController();
    this.pending.add(controller);
    let cancel;
    const aborted = new Promise((_, reject) => { cancel = () => reject(Object.assign(new Error('OCR cancelled or deadline exceeded'), { code: 'OCR_ABORTED' })); });
    controller.signal.addEventListener('abort', cancel, { once: true });
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    const began = Date.now();
    try {
      if (options.signal?.aborted) abort();
      await Promise.race([this.ready, aborted]);
      const bytes = typeof image === 'string' ? await require('node:fs/promises').readFile(image, { signal: controller.signal }) : image;
      const { signal, timeoutMs: ignored, ...settings } = options;
      const remaining = Math.max(1, timeoutMs - (Date.now() - began));
      const result = await this.pool.ocr(bytes, { ...settings, mode: this.mode, timeoutMs: remaining, signal: controller.signal });
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
      return result.data;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', cancel);
      options.signal?.removeEventListener('abort', abort);
      this.pending.delete(controller);
    }
  }
  async close() {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
    if (this.owned) await this.pool.close();
  }
}

for (const Worker of [RapidOcrWorker, LegacyRapidOcrWorker]) {
  Worker.prototype.recognize = require('./timing').timed('ocr.recognize', Worker.prototype.recognize);
}
module.exports = { RapidOcrWorker, LegacyRapidOcrWorker, shellQuote, toWslPath, resolveOcrEnvironment };
