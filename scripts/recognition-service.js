'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { createRecognitionPool } = require('../src/tools/recognition');
const { PersistentPlanner } = require('../src/automation/planner');
const { ResidentMomoVision } = require('../src/tools/shared-momo-vision');
const { PORT, SESSION, serviceCommand } = require('../src/automation/recognition-service');

async function serve() {
  const token = randomBytes(32).toString('hex');
  const pool = createRecognitionPool();
  const planner = new PersistentPlanner();
  const momo = new ResidentMomoVision();
  let receivingBytes = 0, receiving = 0, closing;
  const json = (response, status, value) => {
    if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
  };
  const server = http.createServer((request, response) => require('../src/automation/timing').detached(async () => {
    try {
      const supplied = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + token);
      if (request.headers.origin || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) ||
          supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        request.resume();
        json(response, 403, { error: { code: 'SERVICE_AUTH_FAILED', message: 'Local service authorization failed' } }); return;
      }
      if (request.method === 'GET' && request.url === '/status') {
        json(response, 200, { service: 'yunmomo-recognition', pid: process.pid, data: { ...pool.status(), launcherVision: momo.status() } }); return;
      }
      if (request.method !== 'POST') throw Object.assign(new Error('Unsupported service request'), { code: 'INVALID_ARGUMENT' });
      const allowed = /^\/recognize\/(chatList|chatDetail|page|ocr)$/.exec(request.url);
      const launcher = /^\/momo\/(start|inspect)$/.exec(request.url);
      if (!allowed && !launcher && !['/start', '/stop', '/plan'].includes(request.url)) throw Object.assign(new Error('Unknown service route'), { code: 'INVALID_ARGUMENT' });
      const length = Number(request.headers['content-length']);
      const max = allowed || launcher?.[1] === 'inspect' ? 32 * 1024 * 1024 : 128 * 1024;
      if (!Number.isInteger(length) || length < 0 || length > max || receiving >= 32 || receivingBytes + length > 64 * 1024 * 1024) {
        throw Object.assign(new Error('Service ingress budget exceeded'), { code: 'QUEUE_BYTES_EXCEEDED' });
      }
      receiving++; receivingBytes += length;
      let data;
      try {
        const parts = []; let received = 0;
        for await (const chunk of request) {
          received += chunk.length;
          if (received > length) throw Object.assign(new Error('Invalid request size'), { code: 'INVALID_ARGUMENT' });
          parts.push(chunk);
        }
        if (received !== length) throw Object.assign(new Error('Incomplete request body'), { code: 'INVALID_ARGUMENT' });
        data = Buffer.concat(parts);
      } finally { receiving--; receivingBytes -= length; }
      if (request.url === '/start') { json(response, 200, { ok: true, data: await pool.start() }); return; }
      if (request.url === '/stop') { json(response, 200, { ok: true }); setImmediate(close); return; }
      if (request.url === '/plan') {
        const body = JSON.parse(data);
        json(response, 200, { ok: true, data: await planner.plan(body.text) }); return;
      }
      const settings = JSON.parse(Buffer.from(request.headers['x-recognition-options'] ?? 'e30', 'base64url').toString('utf8'));
      const abort = new AbortController();
      const cancel = () => { if (!response.writableEnded) abort.abort(); };
      response.on('close', cancel);
      if (response.destroyed) abort.abort();
      try { json(response, 200, launcher ? { ok: true, data: await momo.run(launcher[1], data, settings, abort.signal) } :
        await pool.recognize(allowed[1], data, { ...settings, signal: abort.signal })); }
      finally { response.removeListener('close', cancel); }
    } catch (error) {
      request.resume();
      json(response, 400, { error: { code: error.code ?? 'INVALID_ARGUMENT', message: error.code ? error.message : 'Invalid service request',
        stage: error.stage ?? 'transport', details: error.details ?? {} } });
    }
  }));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      server.close();
      await Promise.allSettled([pool.close(), planner.close(), momo.close()]);
      try { const current = JSON.parse(await fs.readFile(SESSION, 'utf8')); if (current.pid === process.pid) await fs.unlink(SESSION); } catch { /* No broad cleanup. */ }
      server.closeAllConnections();
    })();
    return closing;
  }
  process.once('SIGINT', close); process.once('SIGTERM', close);
  const listening = await new Promise((resolve, reject) => {
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(PORT, '127.0.0.1', () => resolve(true));
  });
  if (!listening) return; // Another process won the simultaneous-start race.
  const temporary = SESSION + '.' + process.pid;
  try {
    await fs.mkdir(path.dirname(SESSION), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify({ protocol: 1, port: PORT, token, pid: process.pid }), { mode: 0o600 });
    await fs.rename(temporary, SESSION);
  } catch (error) { await close(); await fs.unlink(temporary).catch(() => {}); throw error; }
  // A failed GPU start stays failed and visible in /status; no hidden CPU fallback/replay.
  pool.start().then(() => momo.run('start')).catch(error => console.error(JSON.stringify({ code: error.code, stage: error.stage })));
  planner.plan('你好').catch(error => console.error(JSON.stringify({ code: error.code, stage: 'planner_warmup' })));
}

if (require.main === module) {
  const command = process.argv[2] ?? 'start';
  const work = require('../src/automation/timing').timedScript('service.recognition.command', () =>
    command === 'serve' ? serve() : ['start', 'status', 'stop'].includes(command) ?
      serviceCommand(command).then(value => console.log(JSON.stringify(value))) : Promise.reject(new Error('Use start, status or stop')))();
  work.catch(error => { console.error(JSON.stringify({ code: error.code ?? 'SERVICE_FAILED', message: error.message })); process.exitCode = 1; });
}
module.exports = { serve };
