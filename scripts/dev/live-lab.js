'use strict';

// Ephemeral loopback test console. Credentials exist only in this process's memory.
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../../src');

async function startLiveLab({ deviceId, outputDir = path.resolve('.local-output/live-third') }) {
  if (!/^\d+$/.test(deviceId)) throw new TypeError('An exact deviceId is required');
  const nonce = randomBytes(24).toString('hex');
  const records = [];
  let client, phone, control, origin, busy = false;
  const redact = error => String(error?.message ?? error).replace(/token=[^&\s]+/gi, 'token=<redacted>');
  const page = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>云机实测台</title>
  <style>body{font:16px system-ui;max-width:1000px;margin:30px auto}label{display:block;margin:12px 0}input{width:500px}button{margin:4px;padding:8px}pre{white-space:pre-wrap;background:#eee;padding:15px}img{max-height:680px}section{display:flex;gap:20px}</style>
  <h1>云机接口实测</h1><p>固定设备：${deviceId}。Token 只保留在本地进程内存，不写日志或报告。</p>
  <form id="session"><label>Token <input id="token" type="password" autocomplete="off"></label><label>UDID <input id="udid" autocomplete="off"></label><button>连接并检查</button></form>
  <label>动作 <input id="action" placeholder="home / screenshot / clipboard / tap"></label>
  <label>参数 JSON <input id="args" value="{}"></label><button id="run">执行动作</button><button id="clear">清除凭据并关闭连接</button>
  <section><pre id="result">尚未连接</pre><img id="screen" alt="接口返回的手机截图"></section>
  <script>const key=${JSON.stringify(nonce)};
  async function request(route,data){document.querySelector('#result').textContent='执行中';try{let response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json','X-Lab-Key':key},body:JSON.stringify(data)});let result=await response.json();document.querySelector('#result').textContent=JSON.stringify(result,null,2);if(result.image)document.querySelector('#screen').src=result.image+'?t='+Date.now();}catch(e){document.querySelector('#result').textContent='本地测试请求失败';}}
  document.querySelector('#session').onsubmit=async e=>{e.preventDefault();const t=document.querySelector('#token');let data={token:t.value,udid:document.querySelector('#udid').value};t.value='';await request('/session',data);data=null;};
  document.querySelector('#run').onclick=()=>request('/action',{action:document.querySelector('#action').value,args:JSON.parse(document.querySelector('#args').value)});
  document.querySelector('#clear').onclick=()=>request('/clear',{});</script></html>`;

  async function snapshot(label) {
    await new Promise(resolve => setTimeout(resolve, 800));
    const shot = await phone.screenshot();
    const filename = `${String(records.length + 1).padStart(2, '0')}-${label.replace(/[^\w-]/g, '_')}.jpg`;
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, filename), shot.data);
    return { image: '/image/' + filename, bytes: shot.data.length, contentType: shot.contentType };
  }
  async function save(record) {
    records.push({ at: new Date().toISOString(), ...record });
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'results.json'), JSON.stringify({ deviceId, records }, null, 2));
  }
  async function clear() {
    if (control) await control.close();
    if (control) control.token = '';
    if (client) client.token = '';
    client = phone = control = undefined;
  }
  async function action(name, args) {
    if (!phone || !control) throw new Error('Connect the fixed device first');
    let detail = {};
    switch (name) {
      case 'screenshot': break;
      case 'home': control.home(); break;
      case 'back': control.back(); break;
      case 'overview': control.overview(); break;
      case 'tap': await control.tap(args.x, args.y); break;
      case 'longPress': await control.longPress(args.x, args.y); break;
      case 'swipe': await control.swipe(args.from, args.to, { durationMs: args.durationMs ?? 450 }); break;
      case 'scroll': control.scroll(args.x, args.y, { vScroll: args.vScroll ?? -1, hScroll: args.hScroll ?? 0 }); break;
      case 'text': control.text(args.text); break;
      case 'paste': control.paste(args.text); break;
      case 'volume-up': control.volumeUp(); break;
      case 'volume-down': control.volumeDown(); break;
      case 'notifications': control.expandNotifications(); break;
      case 'quick-settings': control.expandSettings(); break;
      case 'collapse': control.collapsePanels(); break;
      case 'rotate': control.rotate(); break;
      case 'power-off': control.screenPower(false); break;
      case 'power-on': control.screenPower(true); break;
      case 'stream-size': control.setStreamSize(args.size); break;
      case 'refresh': await control.refresh(); break;
      case 'clipboard': {
        const original = await control.getClipboard({ timeoutMs: 5000 });
        const testText = 'codex-live-clipboard-测试';
        try {
          control.setClipboard(testText);
          await new Promise(resolve => setTimeout(resolve, 250));
          const actual = await control.getClipboard({ timeoutMs: 5000 });
          if (actual !== testText) throw new Error('Clipboard round trip mismatch');
          detail = { roundTrip: true, originalContentLogged: false };
        } finally { control.setClipboard(original); }
        break;
      }
      case 'list-files': {
        const raw = await phone.listFiles(args.path ?? '/sdcard/');
        const data = raw?.data ?? raw;
        detail = { success: raw?.success, shape: Array.isArray(data) ? 'array' : typeof data,
          count: Array.isArray(data) ? data.length : undefined, keys: data && !Array.isArray(data) ? Object.keys(data) : undefined };
        break;
      }
      case 'proxy': { const raw = await phone.getProxy(); detail = { success: raw?.success, dataPresent: !!raw?.data }; break; }
      case 'country-codes': { const raw = await phone.countryCodes(); const data = raw?.data ?? raw;
        detail = { count: data?.count, listLength: Array.isArray(data?.list) ? data.list.length : undefined }; break; }
      default: throw new Error('Unknown or unapproved live action');
    }
    if (control.connected) await control.flush();
    const shot = await snapshot(name);
    return { ok: true, action: name, ...detail, ...control.toJSON(), ...shot };
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== new URL(origin).host) return json(403, { error: 'Unexpected host' });
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page); }
    if (req.method === 'GET' && /^\/image\/[\w-]+\.jpg(?:\?t=\d+)?$/.test(req.url)) {
      const filename = req.url.split('?')[0].slice(7);
      try { const { readFile } = require('node:fs/promises'); res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(await readFile(path.join(outputDir, filename))); }
      catch { return res.end(); }
    }
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-lab-key'] !== nonce) return json(403, { error: 'Local test origin/key required' });
    if (busy) return json(409, { error: 'One live action at a time' });
    busy = true;
    let label = 'request';
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Request too large'); }
      const data = JSON.parse(body); body = '';
      let result;
      if (req.url === '/session') {
        label = 'connect'; await clear();
        client = new YunmomoClient({ token: data.token, timeoutMs: 15000 }); data.token = '';
        const listed = await client.listDevices();
        const record = listed.records.find(d => String(d.deviceId ?? d.id) === deviceId);
        if (!record) throw new Error('Fixed test device not in authenticated device list');
        phone = client.device(deviceId);
        const info = await phone.getInfo();
        const actualUdid = (info?.data ?? info)?.udid ?? record.udid;
        if (actualUdid && actualUdid !== data.udid) throw new Error('UDID does not match fixed test device');
        control = await phone.openControl({ udid: data.udid });
        control.on('connection-error', () => {});
        control.on('protocol-error', () => {});
        await control.connect();
        result = { ok: true, action: label, deviceCount: listed.records.length, getInfo: true,
          ...control.toJSON(), ...(await snapshot(label)) };
      } else if (req.url === '/clear') { label = 'clear'; await clear(); result = { ok: true, credentialsCleared: true }; }
      else if (req.url === '/action') { label = data.action; result = await action(data.action, data.args ?? {}); }
      else throw new Error('Unknown route');
      await save(result); json(200, result);
    } catch (error) {
      const result = { ok: false, action: label, error: redact(error), status: error.status };
      await save(result); json(500, result);
    } finally { busy = false; }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  return { url: origin, outputDir, records, close: async () => { await clear(); await new Promise(resolve => server.close(resolve)); } };
}

module.exports = { startLiveLab };
