'use strict';

// Local-only control console. The browser talks to this process instead of
// receiving the Yunmomo token or calling the cloud APIs directly.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { readFile, writeFile, access } = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');
const { YunmomoClient } = require('../index');
const { attachManualControl } = require('./manual-control');
const { STEPS: STEPS_V2 } = require('../../flows/v2/_common');
const { STEPS: STEPS_V3 } = require('../../flows/v3/_common');
const { parseVpcData } = require('../workflows/add-vpc-network');
const { RapidOcrWorker } = require('../automation/ocr');
const { handleAiReplyRoutes } = require('./ai-reply-routes');
const { handleMomoBrainRoutes } = require('./momo-brain-routes');
const { defaultArbiter } = require('./device-arbiter');
const { BrainManager } = require('../brain/manager');
const { activeRuns } = require('./ai-reply-routes');
const { getAuthService } = require('./auth/service');
const authService = getAuthService();

const { PROJECT_ROOT } = require('../automation/runtime');
const APP_ROOT = path.join(PROJECT_ROOT, 'app');
const LOCAL_ENV_FILE = path.join(PROJECT_ROOT, '.env.local');
const HOST = process.env.YUNMOMO_APP_HOST || '127.0.0.1';
const DEFAULT_PORT = 4318;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 120000;

// Website sessions live in ignored local configuration, never in distributable code.
let runtimeToken = null;
let localEnv = Object.create(null);
const busyDevices = new Set();
const busyAccountScripts = new Set();
const manualBridges = new Set();
const screenshotJobs = new Map();
const activeScriptRuns = new Map();
const pendingScriptStops = new Map();
const completedScriptRuns = new Map();
const SCRIPT_STOP_INTENT_TTL_MS = 30000;
const SCRIPT_STOP_INTENT_MAX = 256;
let deviceCache = null;
let sharedClient = null;
let sharedBrainManager = null;

function brainManager() {
  return sharedBrainManager ||= new BrainManager({ client: client() });
}

// 自动轮询到期云机并执行实时连接熔断
setInterval(() => {
  try {
    authService.sweepExpiredAllocations(deviceId => {
      console.log(`[Sweeper] 云机 ${deviceId} 租期已到期，执行实时切断与回收`);
      for (const bridge of manualBridges) {
        bridge.closeDevice?.(deviceId);
      }
    });
  } catch (err) {
    console.error('[Sweeper Error]', err.message);
  }
}, 10000).unref();

function parseLocalEnv(source) {
  const values = Object.create(null);
  for (const line of String(source).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadLocalEnv() {
  try {
    localEnv = parseLocalEnv(await readFile(LOCAL_ENV_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    localEnv = Object.create(null);
  }
}

function configuredValue(name) {
  return process.env[name] || localEnv[name] || '';
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value ?? ''));
}

async function persistToken(token) {
  const values = { ...localEnv, YUNMOMO_TOKEN: token };
  const source = Object.entries(values)
    .map(([name, value]) => name + '=' + quoteEnvValue(value))
    .join('\n') + '\n';
  await writeFile(LOCAL_ENV_FILE, source, { encoding: 'utf8', mode: 0o600 });
  localEnv = parseLocalEnv(source);
}

const SCRIPT_DEFINITIONS = Object.freeze([
  // V2 版本初始化脚本 (01~09)
  ...STEPS_V2.map(step => ({
    id: 'flow-' + String(step.order).padStart(2, '0') + '-v2',
    order: step.order,
    version: 'v2',
    category: 'v2',
    title: step.name,
    file: 'flows/v2/' + step.entry,
    args: ['--execute'],
    requiresDevice: true,
    requiresCertificate: step.order === 2
  })),
  {
    id: 'flow-09-v2', order: 9, version: 'v2', category: 'v2', title: '改机重置v2',
    file: 'flows/v2/09-改机重置.js', args: ['--execute', '--v2'], requiresDevice: true,
    destructive: true,
    parameters: [
      { name: 'androidVersion', label: '安卓版本', choices: ['16', '14', '10', 'all'], defaultValue: '16' },
      { name: 'countryCode', label: '国家代码', defaultValue: 'CN', maxLength: 2 }
    ]
  },
  {
    id: 'flow-all-v2', title: '执行全流程 (V2)', file: 'flows/v2/执行全部.js', args: ['--execute'],
    requiresDevice: true, requiresCertificate: true, batch: true, category: 'v2', version: 'v2'
  },

  // V3 版本初始化脚本 (01~09)
  ...STEPS_V3.map(step => ({
    id: 'flow-' + String(step.order).padStart(2, '0') + '-v3',
    order: step.order,
    version: 'v3',
    category: 'v3',
    title: step.name,
    file: 'flows/v3/' + step.entry,
    args: ['--execute'],
    requiresDevice: true,
    requiresCertificate: step.order === 2
  })),
  {
    id: 'flow-09-v3', order: 9, title: '改机重置v3',
    file: 'flows/v3/09-改机重置.js', args: ['--execute', '--v3'], requiresDevice: true,
    destructive: true,
    version: 'v3',
    category: 'v3',
    parameters: [
      { name: 'androidVersion', label: '安卓版本', choices: ['16', '14', '10', 'all'], defaultValue: '16' },
      { name: 'countryCode', label: '国家代码', defaultValue: 'CN', maxLength: 2 }
    ]
  },

  // MOMO 业务自动化 (11~15)
  {
    id: 'flow-11', order: 11, title: 'MOMO首页养号',
    file: 'flows/momo/11-momo首页养号.js', args: ['--execute'], requiresDevice: true,
    category: 'momo',
    parameters: [
      { name: 'cycles', label: '循环轮数', choices: ['1', '2', '3', '5', '10'], defaultValue: '1' },
      { name: 'mode', label: '刷新方式', choices: ['random', 'button', 'pull'], defaultValue: 'random' }
    ]
  },
  {
    id: 'flow-12', order: 12, title: 'MOMO收到的招呼处理',
    file: 'flows/momo/12-momo招呼处理.js', args: ['--execute'], requiresDevice: true,
    category: 'momo',
    parameters: [
      { name: 'maxApproved', label: '目标通过人数', choices: ['3', '5', '6', '10', '15', '20'], defaultValue: '6' },
      { name: 'maxDistance', label: '距离筛选', choices: ['none', '3', '5', '10', '20', '50'], defaultValue: 'none' },
      { name: 'approveProbability', label: '通过概率', choices: ['0.9', '0.8', '0.95', '1.0'], defaultValue: '0.9' }
    ]
  },
  {
    id: 'flow-13', order: 13, title: 'MOMO联系人及消息入库',
    file: 'flows/momo/13-momo联系人及消息入库.js', args: [], requiresDevice: true,
    category: 'momo',
    parameters: [
      { name: 'contactName', label: '当前聊天联系人姓名（必填）', required: true, maxLength: 120 }
    ]
  },
  {
    id: 'flow-14', order: 14, title: 'MOMO AI 自动回复',
    file: 'flows/momo/14-momoAI回复.js', args: [], requiresDevice: true,
    category: 'momo',
    parameters: [
      { name: 'mode', label: '运行模式', choices: ['execute', 'draft'], defaultValue: 'execute' },
      { name: 'contactName', label: '指定联系人姓名', defaultValue: '', maxLength: 120 }
    ]
  },
  {
    id: 'flow-15', order: 15, title: 'MOMO监听中枢',
    file: 'flows/momo/15-momo监听中枢.js', args: [], requiresDevice: true,
    category: 'momo',
    parameters: [
      { name: 'mode', label: '运行模式', choices: ['watch', 'drain'], defaultValue: 'watch' },
      { name: 'maxContacts', label: '处理人数上限', choices: ['xx', '1', '3', '5', '10'], defaultValue: 'xx' },
      { name: 'maxGreetings', label: '招呼处理单次上限', choices: ['3', '5', '10'], defaultValue: '5' },
      { name: 'warmupInterval', label: '首页养号间隔', choices: ['default', '0', '60000', '300000'], defaultValue: 'default' },
      { name: 'greetingsInterval', label: '招呼处理间隔', choices: ['0', '1200000', '1800000'], defaultValue: '0' }
    ]
  },
  {
    id: 'flow-all', title: '执行全流程 (V3)', file: 'flows/v3/执行全部.js', args: ['--execute'],
    requiresDevice: true, requiresCertificate: true, batch: true, category: 'all', version: 'v3'
  }
].map(Object.freeze));

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
});

function portValue(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('YUNMOMO_APP_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function activeToken() {
  return runtimeToken || configuredValue('YUNMOMO_TOKEN');
}

function client() {
  const token = activeToken() || '';
  if (!sharedClient || sharedClient.token !== token) {
    sharedClient?.closeScreenshots().catch(() => {});
    sharedClient = new YunmomoClient({ token, timeoutMs: 100000 });
  }
  return sharedClient;
}

function deviceIdOf(record) {
  return String(record?.deviceId ?? record?.id ?? '');
}

function deviceNameOf(record) {
  return String(record?.deviceName ?? record?.name ?? record?.cloudNo ?? 'SF');
}

function publicDevice(record) {
  return {
    deviceId: deviceIdOf(record),
    name: deviceNameOf(record),
    udid: String(record?.udid ?? ''),
    status: record?.status ?? null,
    online: record?.online ?? null,
    cloudNo: record?.cloudNo ?? record?.cloudNumber ?? null
  };
}

let deviceListing = null;
async function listDevices() {
  if (deviceCache && deviceCache.expires > Date.now()) return deviceCache.records;
  const owner = client();
  if (deviceListing?.owner === owner) return deviceListing.pending;
  const listing = { owner };
  listing.pending = (async () => {
    const result = await owner.listDevices({ current: 1, size: 50000 });
    const records = result.records.map(publicDevice).filter(record => record.deviceId);
    if (sharedClient === owner) deviceCache = { records, expires: Date.now() + 3000 };
    return records;
  })().finally(() => { if (deviceListing === listing) deviceListing = null; });
  deviceListing = listing;
  return listing.pending;
}

async function selectedDevice(deviceId) {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throw new Error('请选择一台云机');
  }
  const records = await listDevices();
  const record = records.find(item => item.deviceId === deviceId);
  if (!record) throw new Error('所选云机不在当前账号设备列表中');
  if (!record.udid) {
    const raw = await client().getDevice(deviceId);
    const data = raw?.data ?? raw;
    record.udid = String(data?.udid ?? '');
  }
  if (!record.udid) throw new Error('所选云机没有可用 UDID');
  return record;
}

function scriptById(id) {
  let script = SCRIPT_DEFINITIONS.find(item => item.id === id);
  if (!script && id && /^flow-0[1-9]$/.test(id)) {
    // 兼容旧版不带后缀的 id，默认匹配 v3
    script = SCRIPT_DEFINITIONS.find(item => item.id === id + '-v3');
  }
  if (!script) throw new Error('未知脚本');
  return script;
}

function appendOutput(current, chunk) {
  const value = current + String(chunk);
  return value.length > MAX_OUTPUT_BYTES
    ? value.slice(0, MAX_OUTPUT_BYTES) + '\n[输出已截断]'
    : value;
}

function redact(value) {
  let output = String(value ?? '');
  const token = activeToken();
  if (token) output = output.split(token).join('<redacted>');
  return output.replace(/([?&]token=)[^&\s]+/gi, '$1<redacted>');
}

function createScriptRunRecord(scriptRunId, script) {
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  return {
    scriptRunId,
    scriptId: script.id,
    deviceId: '',
    ownerId: 'script_run_' + scriptRunId,
    child: null,
    childClosedPromise: null,
    childCloseResult: null,
    status: 'starting',
    stopRequested: false,
    stopPromise: null,
    stdout: '',
    stderr: '',
    done,
    resolveDone
  };
}

function pruneScriptStopState(now = Date.now()) {
  for (const [scriptRunId, expiresAt] of pendingScriptStops) {
    if (expiresAt <= now) pendingScriptStops.delete(scriptRunId);
  }
  for (const [scriptRunId, expiresAt] of completedScriptRuns) {
    if (expiresAt <= now) completedScriptRuns.delete(scriptRunId);
  }
}

function rememberScriptRun(map, scriptRunId, expiresAt) {
  map.delete(scriptRunId);
  map.set(scriptRunId, expiresAt);
  while (map.size > SCRIPT_STOP_INTENT_MAX) map.delete(map.keys().next().value);
}

function settleScriptChild(run, result) {
  if (run.childCloseResult) return;
  run.childCloseResult = result;
  run.resolveChildClosed(result);
}

function runTaskkill(pid) {
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.once('error', reject);
    killer.once('close', code => resolve(code));
  });
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function terminateScriptProcess(run) {
  const child = run.child;
  if (!child || run.childCloseResult) return;
  if (!Number.isInteger(child.pid)) {
    await run.childClosedPromise;
    return;
  }

  if (process.platform === 'win32') {
    const code = await runTaskkill(child.pid);
    if (code !== 0 && !run.childCloseResult && child.exitCode === null && child.signalCode === null) {
      throw new Error('无法终止脚本进程树（taskkill 退出码 ' + code + '）');
    }
  } else {
    signalProcessGroup(child.pid, 'SIGTERM');
    let timer;
    await Promise.race([
      run.childClosedPromise,
      new Promise(resolve => { timer = setTimeout(resolve, 1000); })
    ]);
    if (timer) clearTimeout(timer);
    if (!run.childCloseResult) signalProcessGroup(child.pid, 'SIGKILL');
  }

  await run.childClosedPromise;
}

async function runScript(script, env, run) {
  return require('../automation/timing').measure('script.child', { scriptId: script.id, deviceId: env.YUNMOMO_DEVICE_ID },
    () => runScriptMeasured(script, env, run));
}

async function runScriptMeasured(script, env, run) {
  const isV2 = script.version === 'v2' || script.id.endsWith('-v2');
  const stepList = isV2 ? STEPS_V2 : STEPS_V3;
  const step = stepList.find(item => script.id === 'flow-' + String(item.order).padStart(2, '0') + (isV2 ? '-v2' : '-v3') ||
                                     script.id === 'flow-' + String(item.order).padStart(2, '0'));
  const file = path.join(PROJECT_ROOT, script.file || step?.source);
  if (step) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(env.YUNMOMO_DEVICE_ID || ''))) throw new Error('请用 YUNMOMO_DEVICE_ID 指定目标云机');
    if (!env.YUNMOMO_TOKEN) throw new Error('请通过 YUNMOMO_TOKEN 提供当前登录令牌');
    env = {
      ...env,
      [step.confirmation]: 'YES',
      YUNMOMO_VERIFY_ONLY: '0',
      YUNMOMO_SDK_VERSION: script.version || (isV2 ? 'v2' : 'v3'),
    };
  }
  await access(file);
  if (run.stopRequested) return { exitCode: null, stdout: '', stderr: '', cancelled: true };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...(script.args ?? [])], {
      cwd: PROJECT_ROOT,
      env: require('../automation/timing').childEnv(env),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    run.child = child;
    run.status = run.stopRequested ? 'stopping' : 'running';
    run.childClosedPromise = new Promise(resolveClose => { run.resolveChildClosed = resolveClose; });

    let stdout = '';
    let stderr = '';
    run.stdout = stdout;
    run.stderr = stderr;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout = appendOutput(stdout, chunk);
      run.stdout = stdout;
    });
    child.stderr.on('data', chunk => {
      stderr = appendOutput(stderr, chunk);
      run.stderr = stderr;
    });
    child.on('error', err => {
      settleScriptChild(run, { error: err });
      reject(err);
    });
    child.on('close', code => {
      settleScriptChild(run, { code });
      resolve({
        exitCode: step && code === 0 && /"ok"\s*:\s*false/.test(stdout + stderr) ? 1 : typeof code === 'number' ? code : -1,
        stdout: redact(stdout),
        stderr: redact(stderr),
        cancelled: run.stopRequested
      });
    });
  });
}

async function stopActiveScript(body = {}) {
  const scriptRunId = String(body.scriptRunId || '');
  pruneScriptStopState();
  let run = scriptRunId ? activeScriptRuns.get(scriptRunId) : null;
  if (!scriptRunId) {
    const scriptId = String(body.scriptId || '');
    const requestedDeviceId = String(body.deviceId || '');
    const matchingRuns = [...activeScriptRuns.values()].filter(item => item.scriptId === scriptId);
    if (matchingRuns.length === 1 && (!requestedDeviceId || !matchingRuns[0].deviceId || matchingRuns[0].deviceId === requestedDeviceId)) {
      run = matchingRuns[0];
    }
  }
  if (!run) {
    if (scriptRunId && /^[A-Za-z0-9_-]{8,128}$/.test(scriptRunId) && !completedScriptRuns.has(scriptRunId)) {
      rememberScriptRun(pendingScriptStops, scriptRunId, Date.now() + SCRIPT_STOP_INTENT_TTL_MS);
      return {
        ok: true,
        stopped: true,
        pending: true,
        scriptRunId,
        message: '停止请求已登记，启动中的脚本将直接取消'
      };
    }
    return { ok: true, stopped: false, message: scriptRunId ? '当前没有正在执行的脚本' : '停止目标缺失或不唯一，未停止其他脚本' };
  }

  if (!run.stopPromise) {
    run.stopRequested = true;
    run.status = 'stopping';
    run.stopPromise = (async () => {
      try {
        if (run.child && !run.childCloseResult) await terminateScriptProcess(run);
        await run.done;
      } catch (error) {
        run.stopPromise = null;
        if (run.status !== 'finished') {
          run.stopRequested = false;
          run.status = run.child ? 'running' : 'starting';
        }
        throw error;
      }
    })();
  }
  await run.stopPromise;

  return {
    ok: true,
    stopped: true,
    scriptRunId: run.scriptRunId,
    scriptId: run.scriptId,
    deviceId: run.deviceId,
    message: '脚本进程已退出，设备占用已释放'
  };
}

async function executeScript(body) {
  const knownScriptId = SCRIPT_DEFINITIONS.some(script => script.id === body?.scriptId) ? body.scriptId : undefined;
  const span = require('../automation/timing').begin('script.request', { root: true, scriptId: knownScriptId, deviceId: body?.deviceId });
  return span.run(async () => {
    try {
      const result = await executeScriptMeasured(body);
      const { runId, startedAt, finishedAt, durationMs } = span.end(result);
      return { ...result, runId, startedAt, finishedAt, durationMs };
    } catch (error) {
      const { runId, startedAt, finishedAt, durationMs } = span.end(undefined, error);
      error.timing = { runId, startedAt, finishedAt, durationMs }; throw error;
    }
  });
}

async function executeScriptMeasured(body) {
  const script = scriptById(body?.scriptId);
  const requestedScriptRunId = String(body?.scriptRunId || '');
  if (requestedScriptRunId && !/^[A-Za-z0-9_-]{8,128}$/.test(requestedScriptRunId)) throw invalidOptions('网页脚本运行编号无效');
  const scriptRunId = requestedScriptRunId || randomUUID();
  const pageId = String(body?.pageId || '');
  if (pageId && !/^[A-Za-z0-9_-]{8,128}$/.test(pageId)) throw invalidOptions('网页编号无效');
  pruneScriptStopState();
  if (completedScriptRuns.has(scriptRunId)) throw Object.assign(new Error('脚本运行编号已结束，请重新执行'), { status: 409 });
  if (activeScriptRuns.has(scriptRunId)) throw Object.assign(new Error('脚本运行编号已被使用，请重新执行'), { status: 409 });

  const run = createScriptRunRecord(scriptRunId, script);
  run.pageId = pageId;
  run.deviceId = script.requiresDevice ? String(body?.deviceId || '') : '';
  run.stopRequested = pendingScriptStops.delete(scriptRunId);
  activeScriptRuns.set(scriptRunId, run);
  let selected = null;
  let lockedDeviceId = '';
  let accountScriptLocked = false;
  try {
    if (run.stopRequested) {
      return { ok: false, cancelled: true, scriptRunId, scriptId: script.id, title: script.title,
        exitCode: null, stdout: '', stderr: '' };
    }
    if (script.requiresCertificate && !configuredValue('YUNMOMO_CERT_PATH')) {
      throw new Error('请先在启动软件前设置 YUNMOMO_CERT_PATH');
    }

    const env = { ...localEnv, ...process.env };
    const token = activeToken();
    if (token) env.YUNMOMO_TOKEN = token;
    configureScript(script, body, env);
    if (!script.requiresDevice && busyAccountScripts.has(script.id)) {
      throw new Error('该账号正在执行脚本，请等待结束');
    }
    if (script.requiresDevice) {
      const requestedDeviceId = String(body?.deviceId || '');
      if (!requestedDeviceId) throw new Error('请先选择目标云机');
      if (busyDevices.has(requestedDeviceId) || defaultArbiter.isDeviceBusy(requestedDeviceId) || [...manualBridges].some(bridge => bridge.isBusy(requestedDeviceId))) throw new Error('该设备正在执行脚本或手动控制，请先关闭操作窗');
      lockedDeviceId = requestedDeviceId;
      run.deviceId = requestedDeviceId;
      busyDevices.add(requestedDeviceId);
      if (!defaultArbiter.acquireDevice(requestedDeviceId, run.ownerId, { scriptId: script.id })) {
        throw new Error('该设备当前不可用，请稍后重试');
      }
      selected = await selectedDevice(requestedDeviceId);
      if (run.stopRequested) {
        return { ok: false, cancelled: true, scriptRunId, scriptId: script.id, title: script.title,
          selectedDevice: selected, exitCode: null, stdout: '', stderr: '' };
      }
      env.YUNMOMO_DEVICE_ID = selected.deviceId;
      env.YUNMOMO_UDID = selected.udid;
    } else {
      busyAccountScripts.add(script.id);
      accountScriptLocked = true;
    }

    const result = run.stopRequested
      ? { exitCode: null, stdout: '', stderr: '', cancelled: true }
      : await runScript(script, env, run);
    const cancelled = Boolean(result.cancelled || run.stopRequested);
    return {
      ok: !cancelled && result.exitCode === 0,
      cancelled,
      scriptRunId,
      scriptId: script.id,
      title: script.title,
      selectedDevice: selected,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } finally {
    if (lockedDeviceId) {
      busyDevices.delete(lockedDeviceId);
      defaultArbiter.releaseDevice(lockedDeviceId, run.ownerId);
    }
    if (accountScriptLocked) busyAccountScripts.delete(script.id);
    run.status = 'finished';
    pruneScriptStopState();
    rememberScriptRun(completedScriptRuns, scriptRunId, Date.now() + SCRIPT_STOP_INTENT_TTL_MS);
    if (activeScriptRuns.get(scriptRunId) === run) activeScriptRuns.delete(scriptRunId);
    run.resolveDone();
  }
}

function invalidOptions(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function configureScript(script, body, env) {
  const options = body.options ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalidOptions('脚本参数必须为对象');
  const definitions = script.parameters ?? [];
  const allowed = new Set(definitions.map(field => field.name));
  if (script.id.startsWith('flow-03')) allowed.add('vpcData');
  if (Object.keys(options).some(name => !allowed.has(name))) throw invalidOptions('存在未知脚本参数');
  for (const field of definitions) {
    const value = options[field.name];
    if (field.required && (typeof value !== 'string' || !value.trim())) {
      throw invalidOptions('脚本参数必填：' + field.label);
    }
    if (value !== undefined && (typeof value !== 'string' || value.includes('\0') ||
      (field.maxLength && value.length > field.maxLength) || (field.choices && !field.choices.includes(value)))) {
      throw invalidOptions('脚本参数无效：' + field.label);
    }
  }
  if (script.destructive && body.resetConfirmed !== true) throw invalidOptions('改机重置会清除数据，请先确认目标设备及清数据操作');
  if (script.id.startsWith('flow-03')) {
    if (options.vpcData?.trim()) {
      env.YUNMOMO_VPC_DATA = options.vpcData.trim();
    }
  }
  if (script.id.startsWith('flow-09')) {
    const countryCode = String(options.countryCode ?? 'CN').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) throw invalidOptions('国家代码应为CN、US等两位字母');
    env.YUNMOMO_COUNTRY_CODE = countryCode;
    env.YUNMOMO_ANDROID_VERSION = options.androidVersion ?? '16';
    env.YUNMOMO_SDK_VERSION = script.version || 'v3';
  }
  if (script.id === 'flow-11') {
    if (options.cycles?.trim()) env.YUNMOMO_MOMO_CYCLES = options.cycles.trim();
    if (options.mode?.trim()) env.YUNMOMO_MOMO_REFRESH_MODE = options.mode.trim();
  }
  if (script.id === 'flow-12') {
    if (options.maxApproved?.trim()) env.YUNMOMO_MOMO_MAX_APPROVED = options.maxApproved.trim();
    if (options.approveProbability?.trim()) env.YUNMOMO_MOMO_APPROVE_PROBABILITY = options.approveProbability.trim();
    const rawDist = options.maxDistance ?? options.maxDistanceKm;
    if (rawDist && String(rawDist).trim() && String(rawDist).trim() !== 'none') {
      env.YUNMOMO_MOMO_MAX_DISTANCE = String(rawDist).trim();
    }
  }
  if (script.id === 'flow-13') {
    env.YUNMOMO_MOMO_CONTACT_NAME = options.contactName.trim();
  }
  if (script.id === 'flow-14') {
    const mode = options.mode?.trim() || 'execute';
    if (!['execute', 'draft'].includes(mode) || !options.contactName?.trim()) throw invalidOptions('执行 AI 回复前必须指定联系人，运行模式只能是 draft 或 execute');
    env.YUNMOMO_MOMO_AI_MODE = mode;
    if (options.contactName?.trim()) env.YUNMOMO_MOMO_CONTACT_NAME = options.contactName.trim();
  }
  if (script.id === 'flow-15') {
    if (options.mode?.trim()) env.YUNMOMO_MOMO_WATCH_MODE = options.mode.trim();
    if (options.maxContacts?.trim()) env.YUNMOMO_MOMO_MAX_CONTACTS = options.maxContacts.trim();
    if (options.maxGreetings?.trim()) env.YUNMOMO_MOMO_MAX_GREETINGS = options.maxGreetings.trim();
    if (options.warmupInterval?.trim()) env.YUNMOMO_MOMO_WARMUP_INTERVAL = options.warmupInterval.trim();
    if (options.greetingsInterval?.trim()) env.YUNMOMO_MOMO_GREETINGS_INTERVAL = options.greetingsInterval.trim();
  }
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      throw new Error('请求内容过大');
    }
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('请求 JSON 无效');
  }
}

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(body);
}

async function staticFile(response, pathname) {
  let requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (pathname === '/login' || pathname === '/login/') requested = 'login.html';
  if (pathname === '/admin' || pathname === '/admin/') requested = 'admin.html';
  if (!requested || requested.includes('..') || requested.includes('\\')) {
    json(response, 404, { ok: false, error: '页面不存在' });
    return;
  }
  const file = path.resolve(APP_ROOT, requested);
  if (!file.startsWith(APP_ROOT + path.sep)) {
    json(response, 403, { ok: false, error: '非法路径' });
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(data);
  } catch {
    json(response, 404, { ok: false, error: '页面不存在' });
  }
}

function errorStatus(error) {
  if (error.status === 400) return 400;
  if (/正在执行脚本|手动控制/.test(error.message)) return 409;
  if (error.status === 401 || error.status === 403) return 401;
  if (/请选择|未知脚本|YUNMOMO_CERT_PATH|请求内容|请求 JSON|浏览器会话令牌/.test(error.message)) return 400;
  if (/YUNMOMO_TOKEN/.test(error.message)) return 401;
  return 500;
}

function allowedRequest(request) {
  try {
    const host = new URL('http://' + request.headers.host);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) || host.username || host.password) return false;
    return !request.headers.origin || new URL(request.headers.origin).origin === host.origin;
  } catch { return false; }
}

async function previewImage(deviceId) {
  const device = await selectedDevice(deviceId);
  if (screenshotJobs.has(deviceId)) return screenshotJobs.get(deviceId);
  const pending = client().screenshot(deviceId, { source: 'stream', udid: device.udid || undefined,
    maxSize: 1280, bitrate: 4194304, maxAgeMs: 400, timeoutMs: 15000 });
  screenshotJobs.set(deviceId, pending);
  try { return await pending; }
  finally { if (screenshotJobs.get(deviceId) === pending) screenshotJobs.delete(deviceId); }
}

let sharedOcrWorker = null;
function getOcrWorker() {
  if (!sharedOcrWorker || sharedOcrWorker.closed) {
    sharedOcrWorker = new RapidOcrWorker();
  }
  return sharedOcrWorker;
}

async function inspectVision(deviceId) {
  const result = await previewImage(deviceId);
  try {
    const worker = getOcrWorker();
    const ocr = await worker.recognize(result.data);
    return {
      ok: true,
      deviceId,
      width: result.width || ocr.width || 720,
      height: result.height || ocr.height || 1280,
      count: (ocr.items || []).length,
      items: ocr.items || [],
      keyboardSwitches: ocr.keyboardSwitches || [],
      elapsed: ocr.elapsed || []
    };
  } catch (err) {
    return {
      ok: false,
      deviceId,
      error: err.message,
      items: []
    };
  }
}

async function handler(request, response) {
  try {
    if (!allowedRequest(request)) { json(response, 403, { ok: false, error: '仅允许本地控制台同源访问' }); return; }
    const url = new URL(request.url, 'http://' + (request.headers.host || HOST));
    const user = authService.getUserFromRequest(request);

    function requireAdmin(res) {
      if (!user || user.role !== 'admin') {
        json(res, 403, { ok: false, error: '无管理员访问权限' });
        return false;
      }
      return true;
    }

    // --- 认证与会话 API ---
    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = await readJsonBody(request);
      const result = authService.register(body?.email, body?.password);
      json(response, 200, { ok: true, user: result.user, token: result.token }, {
        'Set-Cookie': `ym_auth_token=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readJsonBody(request);
      const result = authService.login(body?.email, body?.password);
      json(response, 200, { ok: true, user: result.user, token: result.token }, {
        'Set-Cookie': `ym_auth_token=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      json(response, 200, { ok: true }, {
        'Set-Cookie': 'ym_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      if (!user) {
        json(response, 200, { ok: false, user: null });
      } else {
        json(response, 200, { ok: true, user });
      }
      return;
    }

    // --- 用户专属 API ---
    if (request.method === 'GET' && url.pathname === '/api/user/devices') {
      if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
      const master = await listDevices();
      const devices = authService.getUserDevices(user.id, master);
      json(response, 200, { ok: true, devices });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/user/redeem') {
      if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
      const body = await readJsonBody(request);
      const master = await listDevices();
      const result = authService.redeemCardForNewDevice({
        userId: user.id,
        cardCode: body?.cardCode,
        masterDevices: master
      });
      json(response, 200, { ok: true, result });
      return;
    }

    // --- 管理员专属 API ---
    if (request.method === 'GET' && url.pathname === '/api/admin/users') {
      if (!requireAdmin(response)) return;
      json(response, 200, { ok: true, users: authService.db.listUsers() });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/users/status') {
      if (!requireAdmin(response)) return;
      const body = await readJsonBody(request);
      authService.db.updateUserStatus(body.userId, body.status);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/cards') {
      if (!requireAdmin(response)) return;
      const status = url.searchParams.get('status') || '';
      const batchTag = url.searchParams.get('batchTag') || '';
      const cards = authService.listCards({ status, batchTag });
      json(response, 200, { ok: true, cards });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/cards/generate') {
      if (!requireAdmin(response)) return;
      const body = await readJsonBody(request);
      const cards = authService.generateCards(body || {});
      json(response, 200, { ok: true, cards });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/cards/revoke') {
      if (!requireAdmin(response)) return;
      const body = await readJsonBody(request);
      authService.revokeCard(body?.cardId);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/pool') {
      if (!requireAdmin(response)) return;
      const master = await listDevices();
      const allocations = authService.db.getAllActiveAllocations();
      const allocMap = new Map(allocations.map(a => [a.device_id, a]));
      const pool = master.map(dev => {
        const alloc = allocMap.get(dev.deviceId);
        return {
          ...dev,
          allocated: Boolean(alloc),
          allocationId: alloc?.id || null,
          userEmail: alloc?.user_email || null,
          expireAt: alloc?.expire_at || null,
          remainingMs: alloc ? Math.max(0, alloc.expire_at - Date.now()) : null
        };
      });
      json(response, 200, {
        ok: true,
        total: master.length,
        allocatedCount: allocations.length,
        idleCount: Math.max(0, master.length - allocations.length),
        pool
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/devices/recycle') {
      if (!requireAdmin(response)) return;
      const body = await readJsonBody(request);
      authService.db.recycleAllocationManually(body?.allocationId);
      if (body?.deviceId) {
        for (const bridge of manualBridges) bridge.closeDevice?.(body.deviceId);
      }
      json(response, 200, { ok: true });
      return;
    }

    if (url.pathname.startsWith('/api/momo-brain/')) {
      let bodyJson = null;
      if (request.method === 'POST') {
        bodyJson = await readJsonBody(request);
      }
      const handled = handleMomoBrainRoutes(request, response, url, bodyJson, brainManager());
      if (handled) return;
    }
    if (url.pathname.startsWith('/api/ai-reply/')) {
      let bodyJson = null;
      if (request.method === 'POST') {
        bodyJson = await readJsonBody(request);
      }
      const handled = handleAiReplyRoutes(request, response, url, bodyJson, client());
      if (handled) return;
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/status') {
        json(response, 200, {
          ok: true,
          tokenConfigured: Boolean(activeToken()),
          sessionSource: runtimeToken || localEnv.YUNMOMO_TOKEN ? 'local-session' : activeToken() ? 'environment' : 'none',
          host: HOST
        });
        return;
      }
      if (url.pathname === '/api/runtime-state') {
        const pageId = /^[A-Za-z0-9_-]{8,128}$/.test(url.searchParams.get('pageId') || '')
          ? url.searchParams.get('pageId') : '';
        const runs = [...activeScriptRuns.values()].map(run => ({
          scriptRunId: run.scriptRunId,
          scriptId: run.scriptId,
          title: scriptById(run.scriptId)?.title || run.scriptId,
          deviceId: run.deviceId,
          status: run.status,
          currentPage: Boolean(pageId && run.pageId === pageId)
        }));
        const manualByDevice = new Map();
        for (const bridge of manualBridges) {
          for (const item of bridge.getState(pageId)) {
            const current = manualByDevice.get(item.deviceId);
            if (!current) manualByDevice.set(item.deviceId, item);
            else {
              current.windows += item.windows;
              if (item.lastInputAt > current.lastInputAt) {
                current.lastInputAt = item.lastInputAt;
                current.lastInputFromCurrentPage = item.lastInputFromCurrentPage;
              }
            }
          }
        }
        json(response, 200, { ok: true, runs, manualDevices: [...manualByDevice.values()] });
        return;
      }
      if (url.pathname === '/api/execute/output') {
        const scriptRunId = String(url.searchParams.get('scriptRunId') || '');
        const run = activeScriptRuns.get(scriptRunId);
        if (run) {
          json(response, 200, {
            ok: true,
            active: true,
            stdout: redact(run.stdout || ''),
            stderr: redact(run.stderr || ''),
            status: run.status
          });
        } else {
          json(response, 200, {
            ok: true,
            active: false,
            stdout: '',
            stderr: '',
            status: 'finished'
          });
        }
        return;
      }
      if (url.pathname === '/api/scripts') {
        json(response, 200, { ok: true, scripts: SCRIPT_DEFINITIONS });
        return;
      }
      if (url.pathname === '/api/devices') {
        if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
        if (user.role === 'admin') {
          json(response, 200, { ok: true, devices: await listDevices() });
        } else {
          const master = await listDevices();
          json(response, 200, { ok: true, devices: authService.getUserDevices(user.id, master) });
        }
        return;
      }
      if (url.pathname === '/api/vision-inspect') {
        const deviceId = url.searchParams.get('deviceId');
        if (!deviceId) throw new Error('缺少 deviceId 参数');
        if (!user || !authService.canAccessDevice(user, deviceId)) {
          json(response, 403, { ok: false, error: '无权查看此设备或该设备已到期回收' });
          return;
        }
        const inspection = await inspectVision(deviceId);
        json(response, 200, inspection);
        return;
      }
      if (url.pathname === '/api/screenshot') {
        const deviceId = url.searchParams.get('deviceId');
        if (!user || !authService.canAccessDevice(user, deviceId)) {
          json(response, 403, { ok: false, error: '无权查看此设备画面或该设备已到期回收' });
          return;
        }
        const result = await previewImage(deviceId);
        response.writeHead(200, {
          'Content-Type': result.contentType || 'image/jpeg',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Screenshot-Source': result.source,
          'X-Image-Width': String(result.width),
          'X-Image-Height': String(result.height),
          'X-Frame-Decoded-At': result.decodedAt
        });
        response.end(result.data);
        return;
      }
      json(response, 404, { ok: false, error: 'API 不存在' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/session') {
      if (!requireAdmin(response)) return;
      const body = await readJsonBody(request);
      if (typeof body?.token !== 'string' || !body.token.trim() || body.token.length > 4096 || /[\r\n]/.test(body.token)) {
        throw new Error('浏览器会话令牌无效');
      }
      if (busyDevices.size || busyAccountScripts.size) throw new Error('设备或账号正在执行脚本，请等待结束后切换会话');
      if (defaultArbiter.locks.size || [...activeRuns.values()].some(run => ['running','cancelling'].includes(run.status)) || sharedBrainManager?.actors.size) {
        throw new Error('自动化会话尚未停止，不能切换账号');
      }
      const token = body.token.trim();
      await new YunmomoClient({ token, timeoutMs: 12000 }).listDevices({ current: 1, size: 1 });
      for (const bridge of manualBridges) await bridge.closeAll();
      await sharedClient?.closeScreenshots();
      await sharedBrainManager?.close();
      sharedBrainManager = null;
      await persistToken(token);
      runtimeToken = token;
      deviceCache = null;
      json(response, 200, { ok: true, tokenConfigured: true, storage: 'local-env' });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/execute') {
      const body = await readJsonBody(request);
      if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
      if (user.role !== 'admin' && body?.deviceId && !authService.canAccessDevice(user, body.deviceId)) {
        json(response, 403, { ok: false, error: '无权操作此设备或该设备已到期回收' });
        return;
      }
      const result = await executeScript(body);
      json(response, 200, result);
      return;
    }
    if (request.method === 'POST' && (url.pathname === '/api/execute/stop' || url.pathname === '/api/scripts/stop')) {
      const result = await stopActiveScript(await readJsonBody(request));
      json(response, 200, result);
      return;
    }
    if (request.method !== 'GET') {
      json(response, 405, { ok: false, error: '只支持 GET 和 POST' });
      return;
    }
    await staticFile(response, url.pathname);
  } catch (error) {
    const message = redact(error?.message || error);
    json(response, errorStatus({ message, status: error.status }), { ok: false, error: message,
      ...(error?.name === 'StreamScreenshotError' ? { code: error.code } : {}), ...(error.timing || {}) });
  }
}

function createServer() {
  // A long-lived server must not make every future request a child of startup.
  const server = http.createServer((request, response) => require('../automation/timing').detached(() => handler(request, response)));
  const bridge = attachManualControl(server, { allowedRequest, selectedDevice, client, busyDevices, redact, authService });
  manualBridges.add(bridge);
  server.on('close', () => { manualBridges.delete(bridge); sharedBrainManager?.close().catch(() => {}); bridge.closeAll().catch(() => {}); sharedClient?.closeScreenshots().catch(() => {}); });
  server.closeManual = () => bridge.closeAll();
  return server;
}

async function start() {
  await loadLocalEnv();
  require('../automation/recognition-service').serviceCommand('start')
    .then(() => console.log('GPU recognition service ready'))
    .catch(error => console.error('GPU recognition startup failed: ' + (error.code ?? 'SERVICE_FAILED')));
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) throw new Error('测试控制台只允许绑定本机回环地址');
  const port = portValue(process.env.YUNMOMO_APP_PORT);
  const server = createServer();
  server.listen(port, HOST, () => {
    console.log('Yunmomo local console: http://' + HOST + ':' + port);
    if (!activeToken()) {
      console.log('提示：尚未导入网页登录态，请通过本地会话设置同步。');
    }
  });
  const close = () => {
    Promise.allSettled([sharedBrainManager?.close(), server.closeManual(), sharedClient?.closeScreenshots()])
      .finally(() => server.close(() => process.exit(0)));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return server;
}

if (require.main === module) {
  require('../automation/timing').timedScript('service.app.start', start)().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { start, createServer, SCRIPT_DEFINITIONS };
