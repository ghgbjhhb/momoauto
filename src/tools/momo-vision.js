'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { requiredString } = require('../control');
const { ToolFailure, fail, keys } = require('./runtime');

const ROOT = path.resolve(__dirname, '../..');

function wslPath(value) {
  if (/^[A-Za-z]:[\\/]/.test(value)) return '/mnt/' + value[0].toLowerCase() + '/' + value.slice(3).replace(/\\/g, '/');
  return value;
}

function visionOptions(options = {}) {
  keys(options, ['runtime', 'pythonPath', 'distribution', 'device', 'manifestPath', 'listWeights', 'detailWeights'], 'momoVision');
  const runtime = options.runtime ?? (process.platform === 'win32' ? 'wsl' : 'native');
  if (!['wsl', 'native'].includes(runtime)) fail('INVALID_ARGUMENT', 'momoVision.runtime must be wsl or native');
  const device = options.device ?? 'cuda:0';
  if (!['cuda:0', 'cpu'].includes(device)) fail('INVALID_ARGUMENT', 'momoVision.device must be cuda:0 or cpu');
  const result = { runtime, device,
    pythonPath: options.pythonPath ?? (runtime === 'wsl' ? '/root/screenparser/venv/bin/python' : 'python3'),
    distribution: options.distribution ?? 'Ubuntu',
    manifestPath: options.manifestPath ?? path.join(__dirname, 'vision/templates/manifest.json'),
    listWeights: options.listWeights ?? path.join(ROOT, 'models/01_消息列表页识别模型/weights/best.pt'),
    detailWeights: options.detailWeights ?? path.join(ROOT, 'models/02_聊天详情页识别模型/weights/best.pt') };
  for (const field of ['pythonPath', 'distribution', 'manifestPath', 'listWeights', 'detailWeights']) requiredString('momoVision.' + field, result[field]);
  for (const field of ['manifestPath', 'listWeights', 'detailWeights']) {
    if (!(runtime === 'wsl' && result[field].startsWith('/'))) result[field] = path.resolve(result[field]);
  }
  return result;
}

class MomoVision {
  constructor(options = {}) {
    this.options = visionOptions(options);
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.child = null;
    this.workerFile = 'momo_worker.py';
  }

  async start(ctx) {
    ctx.check();
    if (this.closed) fail('VISION_CLOSED', 'Vision worker is closed');
    if (!this.initializing) {
      const { runtime, pythonPath, distribution, ...settings } = this.options;
      const file = path.join(__dirname, 'vision', this.workerFile);
      const command = runtime === 'wsl' ? 'wsl.exe' : pythonPath;
      const args = runtime === 'wsl' ? ['-d', distribution, '-e', wslPath(pythonPath), '-u', wslPath(file)] : ['-u', file];
      const env = { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '2' };
      delete env.YUNMOMO_TOKEN;
      this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
      this.child.stdout.setEncoding('utf8');
      // Deliberately do not expose raw stderr: libraries may include local paths.
      this.child.stderr.on('data', () => {});
      this.child.stdout.on('data', chunk => this._receive(chunk));
      this.child.stdout.on('error', () => this._fail(new ToolFailure('VISION_PIPE_FAILED', 'Vision output pipe failed')));
      this.child.stdin.on('error', () => this._fail(new ToolFailure('VISION_PIPE_FAILED', 'Vision input pipe failed')));
      this.child.on('error', () => this._fail(new ToolFailure('VISION_START_FAILED', 'Could not start the configured Python/WSL runtime')));
      this.exited = new Promise(resolve => this.child.once('close', (code, signal) => {
        this._fail(new ToolFailure('VISION_EXITED', 'Vision worker exited', { exitCode: code, signal }));
        resolve();
      }));
      const payload = { ...settings };
      delete payload.device;
      for (const field of ['manifestPath', 'listWeights', 'detailWeights']) payload[field] = runtime === 'wsl' ? wslPath(settings[field]) : settings[field];
      payload.device = this.options.device;
      this.initializing = this._request('init', payload, ctx);
    }
    try { this.info = await this.initializing; ctx.check(); return this.info; }
    catch (error) { await this.close(); throw error; }
  }

  async inspect(image, settings, ctx) {
    ctx.check();
    if (!(image instanceof Uint8Array) || !image.length || image.length > 32 * 1024 * 1024) {
      fail('VISION_IMAGE_INVALID', 'Vision requires non-empty image bytes, at most 32 MiB');
    }
    return this._request('inspect', { image: Buffer.from(image.buffer, image.byteOffset, image.byteLength).toString('base64'),
      confidence: settings.confidence, iconThreshold: settings.iconThreshold, anchorThreshold: settings.anchorThreshold }, ctx);
  }

  _receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) {
      this._fail(new ToolFailure('VISION_PROTOCOL_ERROR', 'Vision response exceeds limit'));
      this.close().catch(() => {});
      return;
    }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); }
      catch {
        this._fail(new ToolFailure('VISION_PROTOCOL_ERROR', 'Vision worker returned malformed JSON'));
        this.close().catch(() => {});
        return;
      }
      const request = this.pending.get(response?.id);
      if (!request) continue; // A cancelled/late response must never resolve the next request.
      this.pending.delete(response.id);
      if (response.ok === true && response.data && typeof response.data === 'object') request.resolve(response.data);
      else if (response.ok === false && typeof response.error?.code === 'string') {
        // Only fixed worker-authored error text is forwarded, never tracebacks.
        request.reject(new ToolFailure(response.error.code, response.error.message ?? 'Vision failed'));
      } else request.reject(new ToolFailure('VISION_PROTOCOL_ERROR', 'Vision response has an invalid shape'));
    }
  }

  async _request(command, payload, ctx) {
    ctx.check();
    if (this.closed || !this.child || !this.child.stdin.writable) fail('VISION_CLOSED', 'Vision worker is not available');
    const id = randomUUID();
    const pending = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, command, payload }) + '\n', error => {
        if (error) {
          this.pending.delete(id);
          reject(new ToolFailure('VISION_PIPE_FAILED', 'Could not submit vision request'));
        }
      });
    });
    try { const result = await ctx.wait(pending); ctx.check(); return result; }
    catch (error) { if (ctx.signal.aborted) await this.close(); throw error; }
    finally { this.pending.delete(id); }
  }

  _fail(error) {
    this.closed = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  close() {
    if (this.closing) return this.closing;
    this._fail(new ToolFailure('VISION_CLOSED', 'Vision worker was closed'));
    this.closing = (async () => {
      if (!this.child) return;
      this.child.stdin.end();
      let timer;
      try { await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(() => { this.child.kill(); resolve(); }, 500); })]); }
      finally { clearTimeout(timer); }
    })();
    return this.closing;
  }
}

class ChatDetailVision extends MomoVision {
  constructor(options) { super(options); this.workerFile = 'chat_detail_worker.py'; }
}

// Launcher/template recognition keeps its existing algorithm, but no longer
// reloads both YOLO weights each time a separate CLI process opens the app.
class SharedMomoVision {
  constructor() { this.closed = false; }
  async start(ctx) {
    if (this.closed) fail('VISION_CLOSED', 'Vision client is closed');
    this.info = await this._call('start', undefined, undefined, ctx);
    return this.info;
  }
  async inspect(image, settings, ctx) {
    if (this.closed) fail('VISION_CLOSED', 'Vision client is closed');
    if (!(image instanceof Uint8Array) || !image.length || image.length > 32 * 1024 * 1024) fail('VISION_IMAGE_INVALID', 'Invalid vision image');
    return this._call('inspect', Buffer.from(image), { confidence: settings.confidence,
      iconThreshold: settings.iconThreshold, anchorThreshold: settings.anchorThreshold }, ctx);
  }
  async _call(command, image, settings, ctx) {
    const { momoShared } = require('../automation/recognition-service');
    try { return await momoShared(command, image, settings, ctx); }
    catch (error) {
      ctx.check();
      if (error instanceof ToolFailure) throw error;
      throw new ToolFailure(error.code ?? 'VISION_FAILED', error.message,
        { ...error.details, recognitionStage: error.stage ?? 'transport' });
    }
  }
  async close() { this.closed = true; }
}

// Single auxiliary lane, independently bounded from the four inference queues.
// A cancelled request is never allowed to run late or close somebody else's job.
class ResidentMomoVision {
  constructor() { this.tail = Promise.resolve(); this.lifetime = new AbortController(); this.count = 0; this.bytes = 0; }
  async run(command, image, settings, signal) {
    if (this.lifetime.signal.aborted) fail('VISION_CLOSED', 'Resident launcher vision is closed');
    const bytes = image?.length ?? 0;
    if (this.count >= 32 || this.bytes + bytes > 64 * 1024 * 1024) fail('QUEUE_FULL', 'Launcher vision queue is full');
    if (command === 'inspect') {
      keys(settings, ['confidence', 'iconThreshold', 'anchorThreshold']);
      const { number } = require('./runtime');
      number(settings.confidence, 'confidence', .5, .99, false);
      number(settings.iconThreshold, 'iconThreshold', .75, .99, false);
      number(settings.anchorThreshold, 'anchorThreshold', .75, .99, false);
    }
    this.count++; this.bytes += bytes;
    const { OperationContext } = require('./runtime');
    const ctx = new OperationContext(120000, signal, this.lifetime.signal);
    let unlock;
    const previous = this.tail;
    const slot = new Promise(resolve => { unlock = resolve; });
    this.tail = previous.then(() => slot);
    try {
      await ctx.wait(previous); ctx.check();
      if (!this.worker || this.worker.closed) this.worker = new MomoVision();
      await this.worker.start(ctx);
      return command === 'start' ? this.worker.info : await this.worker.inspect(image, settings, ctx);
    } finally { ctx.cleanup(); unlock(); this.count--; this.bytes -= bytes; }
  }
  status() { return { queuedOrActive: this.count, resident: Boolean(this.worker?.info && !this.worker.closed), info: this.worker?.info ?? null }; }
  async close() { this.lifetime.abort(); await this.tail; await this.worker?.close(); }
}

module.exports = {
  MomoVision,
  ChatDetailVision,
  visionOptions,
  SharedMomoVision,
  ResidentMomoVision
};

