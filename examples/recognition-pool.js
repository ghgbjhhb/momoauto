'use strict';

// Long-lived local JSON-lines entry. No screenshots, phone input, or cloud credentials are required.
const readline = require('node:readline');
const { readFile, stat } = require('node:fs/promises');
const { SharedRecognitionClient } = require('../src');

async function main() {
  const pool = new SharedRecognitionClient();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  let closing, stopping = false;
  const pending = new Set();
  let fileBytes = 0;
  const output = value => process.stdout.write(JSON.stringify(value) + '\n');
  const close = () => {
    if (stopping) return closing;
    stopping = true;
    input.close();
    process.stdin.destroy();
    closing = (async () => {
      // Earlier lines may still be reading files and not yet be in the GPU queue.
      await Promise.allSettled([...pending]);
      await pool.close();
    })().catch(error => {
      output({ ok: false, error: { code: error.code, stage: error.stage, message: error.message } });
      process.exitCode = 1;
    });
    return closing;
  };
  input.on('line', line => {
    if (stopping || !line.trim()) return;
    let request = {};
    try {
      request = JSON.parse(line);
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        request = {};
        throw Object.assign(new Error('Request must be an object'), { code: 'INVALID_ARGUMENT' });
      }
      if (request.command === 'status') {
        pool.status().then(data => output({ id: request.id ?? null, ok: true, data }), error =>
          output({ id: request.id ?? null, ok: false, error: { code: error.code, stage: error.stage, message: error.message } }));
        return;
      }
      if (request.command === 'close') { close(); return; }
      if (typeof request.imagePath !== 'string' || !request.imagePath.trim()) {
        throw Object.assign(new Error('imagePath is required'), { code: 'INVALID_ARGUMENT' });
      }
      if (pending.size >= 32) throw Object.assign(new Error('CLI pending request limit reached'), { code: 'QUEUE_FULL' });
    } catch (error) {
      output({ id: request.id ?? null, ok: false, error: { code: error.code ?? 'INVALID_ARGUMENT',
        stage: error.stage ?? 'input', message: error.message } });
      return;
    }
    const task = (async () => {
      let reserved = 0;
      try {
        const info = await stat(request.imagePath);
        if (!info.isFile() || info.size > 32 * 1024 * 1024) {
          throw Object.assign(new Error('Image file must be at most 32 MiB'), { code: 'IMAGE_INVALID' });
        }
        if (fileBytes + info.size > 64 * 1024 * 1024) {
          throw Object.assign(new Error('CLI image byte budget exhausted'), { code: 'QUEUE_BYTES_EXCEEDED' });
        }
        reserved = info.size;
        fileBytes += reserved;
        const result = await pool.recognize(request.model, await readFile(request.imagePath), request.options ?? {});
        output({ id: request.id ?? null, ...result });
      } catch (error) {
        output({ id: request.id ?? null, ok: false, error: { code: error.code ?? 'INVALID_ARGUMENT',
          stage: error.stage ?? 'input', message: error.message } });
      } finally { fileBytes -= reserved; }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task)).catch(() => {});
  });
  input.once('close', () => { if (!stopping) close(); });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try { output({ event: 'ready', info: await pool.start() }); }
  catch (error) {
    output({ event: 'startup_failed', ok: false, error: { code: error.code, stage: error.stage, message: error.message, details: error.details } });
    process.exitCode = 1;
    await close();
  }
}

main = require('../src/automation/timing').timedScript('script.examples.recognition-pool', main);

main().catch(error => { console.error(error.message); process.exitCode = 1; });
