'use strict';

/**
 * MOMO 持续监听与调度中枢薄 CLI (MOMO Brain CLI Client)
 *
 * 遵循中枢执行计划第 13.3、16 节与 R9/B7 门禁：
 * 1. 薄客户端设计：仅通过 HTTP 与 4318 本地后台中枢通信，不另起独立控制进程，防止跨进程双重抢锁。
 * 2. 严格超时与状态码退出：带 15000ms 兜底超时控制；HTTP 4xx/5xx 或业务 ok:false 退出码非零。
 * 3. 严格参数校验：--mode 仅允许 plan | observe | draft | execute。
 */

const HOST = process.env.YUNMOMO_APP_HOST || '127.0.0.1';
const PORT = process.env.YUNMOMO_APP_PORT || 4318;
const BASE_URL = `http://${HOST}:${PORT}`;
const VALID_MODES = ['plan', 'observe', 'draft', 'execute'];

async function request(pathname, method = 'GET', body = null) {
  const url = `${BASE_URL}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('CLI request timeout after 15000ms')), 15000);

  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      process.exitCode = 1;
    }
    return { status: res.status, data };
  } catch (err) {
    console.error(`[momo-brain-cli] 请求失败 (${BASE_URL}): ${err.message}`);
    process.exitCode = 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'status';
  let deviceId = argv[1] && !argv[1].startsWith('--') ? argv[1] : process.env.YUNMOMO_DEVICE_ID;

  let mode = 'observe';
  const modeIdx = argv.indexOf('--mode');
  if (modeIdx !== -1 && argv[modeIdx + 1]) {
    mode = argv[modeIdx + 1];
    if (!VALID_MODES.includes(mode)) {
      console.error(`错误: 非法模式 "${mode}"。允许的模式: ${VALID_MODES.join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  if (command === 'status') {
    const path = deviceId ? `/api/momo-brain/status?deviceId=${encodeURIComponent(deviceId)}` : '/api/momo-brain/status';
    const res = await request(path, 'GET');
    if (res) console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  if (!deviceId) {
    console.error('错误: 请通过参数或 YUNMOMO_DEVICE_ID 环境变量提供目标云机 deviceId。');
    process.exitCode = 1;
    return;
  }

  if (command === 'start') {
    const res = await request('/api/momo-brain/start', 'POST', { deviceId, mode });
    if (res) console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  if (command === 'pause') {
    const res = await request('/api/momo-brain/pause', 'POST', { deviceId });
    if (res) console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  if (command === 'resume') {
    const res = await request('/api/momo-brain/resume', 'POST', { deviceId });
    if (res) console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  if (command === 'stop') {
    const res = await request('/api/momo-brain/stop', 'POST', { deviceId, reason: 'CLI requested stop' });
    if (res) console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  if (command === 'events') {
    const res = await request(`/api/momo-brain/events?deviceId=${encodeURIComponent(deviceId)}&limit=20`, 'GET');
    if (res) console.log(JSON.stringify(res.data, null, 2));
    return;
  }

  console.error(`未知命令: ${command}`);
  console.log('可用命令: status, start, pause, resume, stop, events');
  process.exitCode = 1;
}

main = require('../src/automation/timing').timedScript('script.scripts.momo-brain', main);

if (require.main === module) {
  main();
}

module.exports = { main, VALID_MODES };
