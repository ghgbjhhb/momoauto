'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { RecognitionError } = require('../tools/recognition');
const ROOT = path.resolve(__dirname, '../..');

class PersistentPlanner {
  constructor() {
    this.pending = new Map();
    this.buffer = '';
    this.stderrBuffer = '';
    this.closed = false;
  }
  start() {
    if (this.child) return;
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
    for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|COOKIE|API_KEY|AUTHORIZATION/i.test(key)) delete env[key];
    const python = process.env.YUNMOMO_TYPING_PYTHON || path.join(ROOT, '.venv-zhtyping', 'Scripts', 'python.exe');
    this.child = spawn(python, ['-B', '-u', '-X', 'utf8', path.join(ROOT, 'python_workers/typing/plan.py'), '--serve'],
      { cwd: ROOT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8192);
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 4 * 1024 * 1024) return this.fail('TYPING_PLAN_PROTOCOL_ERROR');
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { this.fail('TYPING_PLAN_PROTOCOL_ERROR'); return; }
        const job = this.pending.get(value.id);
        if (!job) continue; // Never assign a timed-out reply to a different message.
        this.pending.delete(value.id); clearTimeout(job.timer);
        if (value.ok) job.resolve(value.data);
        else {
          const detail = this.stderrBuffer ? `Pinyin planning failed: ${this.stderrBuffer.trim()}` : 'Pinyin planning failed';
          job.reject(new RecognitionError('TYPING_PLAN_FAILED', detail, 'typing_plan'));
        }
      }
    });
    for (const stream of [this.child.stdin, this.child.stdout]) stream.on('error', () => this.fail('TYPING_PLAN_PIPE_FAILED'));
    this.child.on('error', () => this.fail('TYPING_PLAN_START_FAILED'));
    this.exited = new Promise(resolve => this.child.once('close', () => { this.fail('TYPING_PLAN_EXITED'); resolve(); }));
  }
  plan(text) {
    if (this.closed) return Promise.reject(new RecognitionError('TYPING_PLAN_CLOSED', 'Planner is closed', 'typing_plan'));
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) return Promise.reject(new RecognitionError('INVALID_ARGUMENT', 'Text must be at most 64 KiB', 'typing_plan'));
    if (this.pending.size >= 32) return Promise.reject(new RecognitionError('QUEUE_FULL', 'Pinyin planner queue is full', 'typing_plan'));
    this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RecognitionError('TIMEOUT', 'Pinyin planner deadline exceeded', 'typing_plan')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, text }) + '\n', error => { if (error) this.fail('TYPING_PLAN_PIPE_FAILED'); });
    });
  }
  fail(code) {
    this.closed = true;
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new RecognitionError(code, 'Persistent pinyin planner failed', 'typing_plan')); }
    this.pending.clear();
    this.child?.stdin.end();
    if (code === 'TYPING_PLAN_PROTOCOL_ERROR') this.child?.kill();
  }
  async close() {
    this.fail('TYPING_PLAN_CLOSED');
    if (!this.child) return;
    this.child.stdin.end();
    let timer;
    await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(() => { this.child.kill(); resolve(); }, 1000); })]);
    clearTimeout(timer);
  }
}
module.exports = { PersistentPlanner };
