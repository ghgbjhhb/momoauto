'use strict';

// Local-only control console. The browser talks to this process instead of
// receiving the Yunmomo token or calling the cloud APIs directly.
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
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
const urlGuard = require('../automation/url-guard');
const { handleMomoBrainRoutes } = require('./momo-brain-routes');
const { defaultArbiter } = require('./device-arbiter');
const { BrainManager } = require('../brain/manager');
const { activeRuns } = require('./ai-reply-routes');
const { getAuthService } = require('./auth/service');
const authGuard = require('./auth/guard');
const authService = getAuthService();
const { getSmsService } = require('./sms/service');
const { extractDeviceInfo } = require('../workflows/v2/import-real-params');

const { PROJECT_ROOT } = require('../automation/runtime');
const { appendLogLine } = require('../automation/log-file');
const APP_ROOT = path.join(PROJECT_ROOT, 'app');
const CLOUD_DISK_ROOT = path.join(PROJECT_ROOT, 'storage', 'cloud-disk');
try {
  fs.mkdirSync(path.join(CLOUD_DISK_ROOT, '真参'), { recursive: true });
  fs.mkdirSync(path.join(CLOUD_DISK_ROOT, '头像'), { recursive: true });
} catch {}
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
    id: 'flow-' + (Number.isInteger(step.order) ? String(step.order).padStart(2, '0') : String(step.order)) + '-v2',
    order: step.order,
    version: 'v2',
    category: 'v2',
    title: step.name,
    file: 'flows/v2/' + step.entry,
    args: ['--execute'],
    requiresDevice: true,
    requiresCertificate: step.order === 2,
    ...(step.order === 2.1 ? {
      parameters: [
        { name: 'filePath', label: '云盘真参文件', defaultValue: '', placeholder: '留空默认自动获取云盘可用真参' }
      ]
    } : {}),
    ...(step.order === 3 ? {
      parameters: [
        { name: 'action', label: '代理操作', choices: ['set', 'show', 'close'], defaultValue: 'set' }
      ]
    } : {}),
    ...(step.order === 6 ? {
      parameters: [
        { name: 'mode', label: '定位模式', choices: ['ip', 'search'], defaultValue: 'ip' },
        { name: 'address', label: '目标搜索地址', defaultValue: '' }
      ]
    } : {})
  })),
  {
    id: 'flow-09-v2', order: 9, version: 'v2', category: 'v2', title: '重置数据v2',
    file: 'flows/v2/09-重置数据.js', args: ['--execute', '--v2'], requiresDevice: true,
    destructive: true
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
    requiresCertificate: step.order === 2,
    ...(step.order === 3 ? {
      parameters: [
        { name: 'action', label: '代理操作', choices: ['set', 'show', 'close'], defaultValue: 'set' }
      ]
    } : {})
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
    version: 'v2',
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
      { name: 'contactName', label: '指定联系人姓名', defaultValue: '', placeholder: '留空自动扫描未读联系人', maxLength: 120 }
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
    id: 'flow-16', order: 16, title: '陌陌一键上号',
    file: 'flows/momo/16-momo一键上号.js', args: ['--execute'], requiresDevice: true,
    category: 'momo',
    version: 'v2',
    parameters: [
      // TODO: 当前默认使用复扫模式 (relogin)，方便下次随时切换为直接一键授权 (direct)
      { name: 'yayaMode', label: '丫丫授权模式', choices: ['relogin', 'direct'], defaultValue: 'relogin' },
      { name: 'targetTime', label: '丫丫复扫订单时间', defaultValue: '16:05', placeholder: '如 16:05，匹配历史订单' }
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

function extractHost(address) {
  if (!address) return null;
  const str = String(address).trim();
  if (!str) return null;
  if (str.startsWith('[')) {
    const end = str.indexOf(']');
    if (end > 0) return str.slice(1, end);
  }
  const host = str.replace(/:\d+$/, '').trim();
  return host || str;
}

async function resolveDeviceProxy(owner, deviceId, useIpFallback = null) {
  try {
    const phone = owner.device(deviceId);
    const v1 = await phone.getProxy('v1').catch(() => null);
    if (v1 && (Number(v1.status) === 1 || v1.status === true) && v1.address) {
      const raw = String(v1.address).trim();
      const host = extractHost(raw);
      if (host) return { host, raw, source: 'v1' };
    }
  } catch {}

  try {
    const phone = owner.device(deviceId);
    const legacy = await phone.getProxy('legacy').catch(() => null);
    const addr = legacy?.addr || legacy?.address || legacy?.data?.addr;
    const status = Number(legacy?.status ?? legacy?.data?.status);
    if ((status === 1 || Boolean(addr)) && addr) {
      const raw = String(addr).trim();
      const host = extractHost(raw);
      if (host) return { host, raw, source: 'legacy' };
    }
  } catch {}

  if (useIpFallback) {
    const raw = String(useIpFallback).trim();
    const host = extractHost(raw);
    if (host) return { host, raw, source: 'useIp' };
  }

  return null;
}

function publicDevice(record) {
  return {
    deviceId: deviceIdOf(record),
    name: deviceNameOf(record),
    udid: String(record?.udid ?? ''),
    status: record?.status ?? null,
    online: record?.online ?? null,
    cloudNo: record?.cloudNo ?? record?.cloudNumber ?? null,
    sdkVersion: record?.sdkVersion ? String(record.sdkVersion).toLowerCase() : null,
    currentIp: record?.currentIp || null,
    proxyAddress: record?.proxyAddress || null
  };
}

let deviceListing = null;
async function listDevices() {
  if (deviceCache && deviceCache.expires > Date.now()) return deviceCache.records;
  const owner = client();
  if (deviceListing?.owner === owner) return deviceListing.pending;
  const listing = { owner };
  listing.pending = (async () => {
    let rawRecords = [];
    try {
      const result = await owner.listDevices({ current: 1, size: 50000 });
      rawRecords = Array.isArray(result?.records) ? result.records : [];
    } catch {}

    if (rawRecords.length === 0) {
      try {
        const allocatedDeviceIds = authService.db.getActiveAllocatedDeviceIds();
        if (Array.isArray(allocatedDeviceIds) && allocatedDeviceIds.length > 0) {
          const fetched = await Promise.all(allocatedDeviceIds.map(async id => {
            try { return await owner.getDevice(id); } catch { return null; }
          }));
          rawRecords = fetched.filter(Boolean);
        }
      } catch {}
    }

    const records = await Promise.all(rawRecords.map(async raw => {
      const base = publicDevice(raw);
      if (!base.deviceId) return null;
      try {
        const proxy = await resolveDeviceProxy(owner, base.deviceId, raw.useIp);
        base.currentIp = proxy?.host || null;
        base.proxyAddress = proxy?.raw || null;
      } catch {
        base.currentIp = null;
        base.proxyAddress = null;
      }
      return base;
    }));
    const validRecords = records.filter(Boolean);
    if (sharedClient === owner) deviceCache = { records: validRecords, expires: Date.now() + 2500 };
    return validRecords;
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

function createScriptRunRecord(scriptRunId, script, ownerUserId = '') {
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  return {
    id: scriptRunId,
    scriptRunId,
    scriptId: script.id,
    deviceId: '',
    ownerId: 'script_run_' + scriptRunId,
    ownerUserId,
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

// 运行归属侧车文件：进程退出后内存记录消失，日志文件仍需知道归属才能做越权控制
function runOwnerFilePath(scriptRunId) {
  return path.join(PROJECT_ROOT, 'logs', 'runs', `${scriptRunId}.owner`);
}

async function writeRunOwner(scriptRunId, ownerUserId) {
  if (!ownerUserId) return;
  try {
    const target = runOwnerFilePath(scriptRunId);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, ownerUserId, 'utf8');
  } catch {}
}

async function readRunOwner(scriptRunId) {
  try {
    return (await fs.promises.readFile(runOwnerFilePath(scriptRunId), 'utf8')).trim();
  } catch {
    return '';
  }
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
  const step = stepList.find(item => {
    const orderStr = Number.isInteger(item.order) ? String(item.order).padStart(2, '0') : String(item.order);
    return script.id === 'flow-' + orderStr + (isV2 ? '-v2' : '-v3') ||
           script.id === 'flow-' + orderStr;
  });
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

  const logsDir = path.join(PROJECT_ROOT, 'logs', 'runs');
  await fs.promises.mkdir(logsDir, { recursive: true });
  const logFilePath = path.join(logsDir, `${run.id}.log`);
  const logRelPath = path.relative(PROJECT_ROOT, logFilePath).replace(/\\/g, '/');
  run.logFile = logRelPath;

  const startTime = new Date();
  const logHeader = [
    '================================================================================',
    `[调用唯一ID] ${run.id}`,
    `[执行脚本]   ${script.id} (${script.title})`,
    `[目标设备]   ${env.YUNMOMO_DEVICE_ID || '无'}`,
    `[启动时间]   ${startTime.toLocaleString('zh-CN')} (${startTime.toISOString()})`,
    `[环境版本]   SDK=${env.YUNMOMO_SDK_VERSION || (isV2 ? 'v2' : 'v3')}`,
    '================================================================================',
    '',
    '--- 原始标准输出与错误 (STDOUT / STDERR) ---',
    ''
  ].join('\n');
  await fs.promises.writeFile(logFilePath, logHeader, 'utf8');

  env = {
    ...env,
    YUNMOMO_SCRIPT_RUN_ID: run.id,
  };

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
      fs.promises.appendFile(logFilePath, chunk).catch(() => {});
    });
    child.stderr.on('data', chunk => {
      stderr = appendOutput(stderr, chunk);
      run.stderr = stderr;
      fs.promises.appendFile(logFilePath, chunk).catch(() => {});
    });
    child.on('error', err => {
      const footer = [
        '',
        '================================================================================',
        `[异常失败]   ${err.message}`,
        `[结束时间]   ${new Date().toISOString()}`,
        '================================================================================'
      ].join('\n');
      fs.promises.appendFile(logFilePath, footer).catch(() => {});
      settleScriptChild(run, { error: err });
      reject(err);
    });
    child.on('close', code => {
      settleScriptChild(run, { code });
      const finishTime = new Date();
      const exitCode = step && code === 0 && /"ok"\s*:\s*false/.test(stdout + stderr) ? 1 : typeof code === 'number' ? code : -1;
      const logFooter = [
        '',
        '================================================================================',
        `[结束时间]   ${finishTime.toLocaleString('zh-CN')} (${finishTime.toISOString()})`,
        `[退出代码]   ${exitCode}`,
        `[执行耗时]   ${Date.now() - startTime.getTime()} ms`,
        '================================================================================'
      ].join('\n');
      fs.promises.appendFile(logFilePath, logFooter).catch(() => {});
      resolve({
        exitCode,
        stdout: redact(stdout),
        stderr: redact(stderr),
        cancelled: run.stopRequested,
        logFile: logRelPath,
        scriptRunId: run.id
      });
    });
  });
}

async function stopActiveScript(body = {}, user = null) {
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
  // 停止是写操作：非管理员只能停自己发起的运行，否则可打断他人云机上的脚本
  if (run && user && user.role !== 'admin' && run.ownerUserId && run.ownerUserId !== user.id) {
    return { ok: false, forbidden: true, message: '无权停止其他用户的脚本运行' };
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

async function executeScript(body, user = null) {
  const knownScriptId = SCRIPT_DEFINITIONS.some(script => script.id === body?.scriptId) ? body.scriptId : undefined;
  const span = require('../automation/timing').begin('script.request', { root: true, scriptId: knownScriptId, deviceId: body?.deviceId });
  return span.run(async () => {
    try {
      const result = await executeScriptMeasured(body, user);
      const { runId, startedAt, finishedAt, durationMs } = span.end(result);
      return { ...result, runId, startedAt, finishedAt, durationMs };
    } catch (error) {
      const { runId, startedAt, finishedAt, durationMs } = span.end(undefined, error);
      error.timing = { runId, startedAt, finishedAt, durationMs }; throw error;
    }
  });
}

async function executeScriptMeasured(body, user = null) {
  const ownerUserId = user?.id || '';
  const script = scriptById(body?.scriptId);
  assertScriptVisibleToUser(script, user);
  const requestedScriptRunId = String(body?.scriptRunId || '');
  if (requestedScriptRunId && !/^[A-Za-z0-9_-]{8,128}$/.test(requestedScriptRunId)) throw invalidOptions('网页脚本运行编号无效');
  const scriptRunId = requestedScriptRunId || randomUUID();
  const pageId = String(body?.pageId || '');
  if (pageId && !/^[A-Za-z0-9_-]{8,128}$/.test(pageId)) throw invalidOptions('网页编号无效');
  pruneScriptStopState();
  if (completedScriptRuns.has(scriptRunId)) throw Object.assign(new Error('脚本运行编号已结束，请重新执行'), { status: 409 });
  if (activeScriptRuns.has(scriptRunId)) throw Object.assign(new Error('脚本运行编号已被使用，请重新执行'), { status: 409 });

  const run = createScriptRunRecord(scriptRunId, script, ownerUserId);
  run.pageId = pageId;
  run.deviceId = script.requiresDevice ? String(body?.deviceId || '') : '';
  run.stopRequested = pendingScriptStops.delete(scriptRunId);
  activeScriptRuns.set(scriptRunId, run);
  writeRunOwner(scriptRunId, ownerUserId);
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
    if (ownerUserId) {
      env.YUNMOMO_USER_ID = ownerUserId;
      env.YUNMOMO_USER_ROLE = user?.role || 'user';
    }
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
      stderr: result.stderr,
      logFile: result.logFile || run.logFile || `logs/runs/${scriptRunId}.log`
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

// 管理员的脚本显隐配置此前只作用于前端渲染，普通用户直接提交被隐藏的 scriptId 照样能执行；
// 这里把它下沉到服务端，分组判定与 app.js 的 createVersionSection 分组保持一致（category 'all' 归入 momo 组）。
function assertScriptVisibleToUser(script, user) {
  if (!script || !user || user.role === 'admin') return;
  const visibility = authService.db.getScriptVisibility();
  if (visibility.scripts[script.id] === false) {
    throw Object.assign(new Error('该脚本已被管理员关闭，无权执行'), { status: 403 });
  }
  const groupKey = script.category === 'v2' || script.category === 'v3' ? script.category : 'momo';
  if (visibility.groups[groupKey] === false) {
    throw Object.assign(new Error('该脚本分组已被管理员关闭，无权执行'), { status: 403 });
  }
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
  if (script.destructive && body.resetConfirmed !== true) throw invalidOptions('重置/改机会清除设备数据，请先确认目标设备及操作');
  if (script.id.startsWith('flow-02.1') || script.id.startsWith('flow-2.1')) {
    const rawVal = (options.filePath || options.fileName || '').trim();
    if (rawVal && rawVal.toLowerCase() !== 'todo' && rawVal.toLowerCase() !== 'auto') {
      const fileName = path.basename(rawVal);
      const targetInDisk = path.join(CLOUD_DISK_ROOT, '真参', fileName);
      if (!fs.existsSync(targetInDisk)) {
        throw invalidOptions(`云盘真参文件不存在：[${fileName}]。本脚本必须获取系统后台云盘参数，严禁任何第三方或外部路径导入！`);
      }
      env.YUNMOMO_REAL_PARAMS_FILE = fileName;
    }
  }
  if (script.id.startsWith('flow-03')) {
    if (options.vpcData?.trim()) {
      env.YUNMOMO_VPC_DATA = options.vpcData.trim();
    }
    if (options.action?.trim()) {
      env.YUNMOMO_PROXY_ACTION = options.action.trim();
    }
  }
  if (script.id.startsWith('flow-06')) {
    const mode = options.mode?.trim() || 'ip';
    env.YUNMOMO_LOCATION_MODE = mode;
    if (mode === 'search') {
      if (!options.address?.trim()) {
        throw invalidOptions('搜索模式下必须提供目标搜索地址');
      }
      env.YUNMOMO_LOCATION_ADDRESS = options.address.trim();
    } else if (options.address?.trim()) {
      env.YUNMOMO_LOCATION_ADDRESS = options.address.trim();
    }
  }
  if (script.id === 'flow-09-v2') {
    env.YUNMOMO_SDK_VERSION = 'v2';
  } else if (script.id.startsWith('flow-09')) {
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
  if (script.id === 'flow-16') {
    if (options.targetTime?.trim()) env.YAYA_TARGET_TIME = options.targetTime.trim();
  }
  if (script.id === 'flow-15') {
    if (options.mode?.trim()) env.YUNMOMO_MOMO_WATCH_MODE = options.mode.trim();
    if (options.maxContacts?.trim()) env.YUNMOMO_MOMO_MAX_CONTACTS = options.maxContacts.trim();
    if (options.maxGreetings?.trim()) env.YUNMOMO_MOMO_MAX_GREETINGS = options.maxGreetings.trim();
    if (options.warmupInterval?.trim()) env.YUNMOMO_MOMO_WARMUP_INTERVAL = options.warmupInterval.trim();
    if (options.greetingsInterval?.trim()) env.YUNMOMO_MOMO_GREETINGS_INTERVAL = options.greetingsInterval.trim();
  }
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
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

function safeCloudDiskDir(dir) {
  return dir === '头像' ? '头像' : '真参';
}

function getCloudDiskFiles(dirName) {
  const dir = safeCloudDiskDir(dirName);
  const dirPath = path.join(CLOUD_DISK_ROOT, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dirPath, entry.name);
    try {
      const stat = fs.statSync(filePath);
      const ext = path.extname(entry.name).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext);
      const isText = ['.txt', '.json', '.xml', '.log', '.csv'].includes(ext);
      let previewInfo = null;
      if (dir === '真参' && (ext === '.txt' || ext === '.json')) {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          const info = extractDeviceInfo(parsed);
          if (info.brand || info.model) {
            previewInfo = info;
          }
        } catch {}
      }
      let zhencanStatus = null;
      if (dir === '真参') {
        const rec = authService.getZhencanFileRecord(entry.name);
        zhencanStatus = {
          status: rec?.status || 'available',
          isUsed: rec?.status === 'used',
          usedAt: rec?.used_at || null,
          usedAtFormatted: rec?.used_at ? new Date(rec.used_at).toLocaleString('zh-CN') : '',
          usedOnDeviceId: rec?.used_on_device_id || '',
          usedOnDeviceName: rec?.used_on_device_name || ''
        };
      }
      files.push({
        name: entry.name,
        size: stat.size,
        sizeFormatted: stat.size > 1024 * 1024
          ? (stat.size / (1024 * 1024)).toFixed(2) + ' MB'
          : (stat.size / 1024).toFixed(1) + ' KB',
        mtime: stat.mtimeMs,
        ext,
        isImage,
        isText,
        previewInfo,
        zhencanStatus
      });
    } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

// 页面大量使用内联 script 与 onclick 属性，script-src 只能放宽到 unsafe-inline；
// 但 object/base/form-action/frame-ancestors 仍收紧，配合同源-only 的 Host/Origin 校验阻断点击劫持与外链注入。
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:*",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; ')
};

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers
  });
  response.end(body);
}

async function staticFile(response, pathname) {
  let requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (pathname === '/login' || pathname === '/login/') requested = 'login.html';
  if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/')) requested = 'admin.html';
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
      ...SECURITY_HEADERS
    });
    response.end(data);
  } catch {
    json(response, 404, { ok: false, error: '页面不存在' });
  }
}

function errorStatus(error) {
  if (error.status === 400) return 400;
  if (/正在执行脚本|手动控制/.test(error.message)) return 409;
  if (error.status === 401) return 401;
  // 403 不能并入 401：前端把 401 当作「登录态失效」处理并触发重新登录，权限不足应当直接呈现错误原因
  if (error.status === 403) return 403;
  if (/请选择|未知脚本|YUNMOMO_CERT_PATH|请求内容|请求 JSON|浏览器会话令牌|邮箱或密码不正确|卡密|验证码/.test(error.message)) return 400;
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

async function appendServerLog(level, message, details = '') {
  const logLine = `[Server ${level.toUpperCase()}] ${new Date().toISOString()} ${message}${details ? ' ' + details : ''}\n`;
  await appendLogLine(path.join(PROJECT_ROOT, 'logs', 'server.log'), logLine);
}

async function handler(request, response) {
  const reqStart = Date.now();
  const reqMethod = request.method;
  const reqUrl = request.url;
  const isApi = typeof reqUrl === 'string' && reqUrl.startsWith('/api/');
  let currentUser = null;

  if (isApi) {
    response.on('finish', () => {
      const duration = Date.now() - reqStart;
      const status = response.statusCode;
      const userTag = currentUser ? `[${currentUser.email}]` : '[guest]';
      const logLine = `${reqMethod} ${authGuard.redact(reqUrl)} -> ${status} (${duration}ms) ${userTag}`;

      // 忽略日志自轮询等无意义的噪音请求
      if (reqUrl.includes('/api/client-logs') || reqUrl.includes('/api/server-logs')) {
        return;
      }

      // 未登录游客访问受保护接口（如打开网页时自动探测设备列表），属正常未认证拦截，静默避免刷屏
      const isGuestAuthProbe = !currentUser && (status === 401 || status === 403) && (reqUrl.startsWith('/api/devices') || reqUrl.startsWith('/api/cloud-disk') || reqUrl.startsWith('/api/user'));

      if (status >= 500) {
        // 5xx 属于真正的服务端系统错误
        console.error(`[API ERROR] ${logLine}`);
        appendServerLog('ERROR', logLine);
      } else if (status >= 400) {
        // 4xx 属于客户端行为、业务校验不通过或安全防护拦截，归为 WARN
        if (!isGuestAuthProbe) {
          console.warn(`[API WARN] ${logLine}`);
          appendServerLog('WARN', logLine);
        }
      } else {
        console.log(`[API] ${logLine}`);
      }
    });
  }

  try {
    if (!allowedRequest(request)) { json(response, 403, { ok: false, error: '仅允许本地控制台同源访问' }); return; }
    const url = new URL(request.url, 'http://' + (request.headers.host || HOST));
    const user = currentUser = authService.getUserFromRequest(request);

    function requireAdmin(res) {
      if (!user || user.role !== 'admin') {
        json(res, 403, { ok: false, error: '无管理员访问权限' });
        return false;
      }
      return true;
    }

    // --- 认证与会话 API ---
    const authClientIp = authGuard.clientIp(request);
    const rejectBruteForce = (waitSeconds) => {
      json(response, 429, {
        ok: false,
        error: `尝试过于频繁，请 ${Math.max(1, Math.ceil(waitSeconds / 60))} 分钟后再试`,
        retryAfterSeconds: waitSeconds
      }, { 'Retry-After': String(waitSeconds) });
    };

    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = await readJsonBody(request);
      const waitSeconds = authGuard.inspect(body?.email, authClientIp);
      if (waitSeconds > 0) { rejectBruteForce(waitSeconds); return; }
      try {
        const result = await authService.register(body?.email, body?.password);
        authGuard.registerSuccess(result.user?.email);
        json(response, 200, { ok: true, user: result.user, token: result.token }, {
          'Set-Cookie': `ym_auth_token=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
        });
      } catch (err) {
        authGuard.registerFailure(body?.email, authClientIp);
        json(response, 400, { ok: false, error: err.message });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readJsonBody(request);
      const waitSeconds = authGuard.inspect(body?.email, authClientIp);
      if (waitSeconds > 0) { rejectBruteForce(waitSeconds); return; }
      try {
        const result = await authService.login(body?.email, body?.password);
        authGuard.registerSuccess(result.user?.email || body?.email);
        json(response, 200, { ok: true, user: result.user, token: result.token }, {
          'Set-Cookie': `ym_auth_token=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
        });
      } catch (err) {
        authGuard.registerFailure(body?.email, authClientIp);
        json(response, 401, { ok: false, error: err.message });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/change-password') {
      if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
      const body = await readJsonBody(request);
      const waitSeconds = authGuard.inspect(user.email, authClientIp);
      if (waitSeconds > 0) { rejectBruteForce(waitSeconds); return; }
      try {
        await authService.changePassword(user.id, body?.currentPassword, body?.newPassword);
        authGuard.registerSuccess(user.email);
        // 改密已递增令牌版本，旧 cookie 立即失效，强制在所有设备上重新登录
        json(response, 200, { ok: true, message: '密码已更新，请重新登录' }, {
          'Set-Cookie': 'ym_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
        });
      } catch (err) {
        authGuard.registerFailure(user.email, authClientIp);
        json(response, 400, { ok: false, error: err.message });
      }
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
        const zhencanBalance = authService.getUserZhencanBalance(user.id);
        const ipStatus = authService.db.getUserIpStatus(user.id);
        json(response, 200, {
          ok: true,
          user: {
            ...user,
            zhencanBalance,
            ipStatus
          }
        });
      }
      return;
    }

    // --- 客户端日志与远程诊断遥测 API ---
    if (request.method === 'POST' && url.pathname === '/api/client-logs') {
      const body = await readJsonBody(request);
      const level = String(body?.level || 'info').toUpperCase();
      // 换行必须压平：否则客户端可借 message 伪造整行日志（含冒充其他用户/管理员的记录）
      const flatten = value => String(value).replace(/[\r\n]+/g, ' | ');
      const message = flatten(body?.message || '').slice(0, 500);
      const rawDetails = body?.details ? (typeof body.details === 'string' ? body.details : JSON.stringify(body.details)) : '';
      const details = flatten(rawDetails).slice(0, 2000);
      const userTag = user ? `[${user.email}]` : '[guest]';
      const logLine = `[Client ${level}] ${new Date().toISOString()} ${userTag} ${message} ${details}\n`;
      await appendLogLine(path.join(PROJECT_ROOT, 'logs', 'client.log'), logLine);
      console.log(`[ClientLog] ${level} ${userTag}: ${message}`);
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/client-logs') {
      if (!requireAdmin(response)) return;
      try {
        const logPath = path.join(PROJECT_ROOT, 'logs', 'client.log');
        const content = await fs.promises.readFile(logPath, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean).slice(-100);
        json(response, 200, { ok: true, logs: lines });
      } catch {
        json(response, 200, { ok: true, logs: [] });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/server-logs') {
      if (!requireAdmin(response)) return;
      try {
        const logPath = path.join(PROJECT_ROOT, 'logs', 'server.log');
        const content = await fs.promises.readFile(logPath, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean).slice(-300);
        json(response, 200, { ok: true, logs: lines });
      } catch {
        json(response, 200, { ok: true, logs: [] });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/server-logs/clear') {
      if (!requireAdmin(response)) return;
      try {
        const logPath = path.join(PROJECT_ROOT, 'logs', 'server.log');
        await fs.promises.writeFile(logPath, '', 'utf8');
      } catch {}
      json(response, 200, { ok: true, message: '系统运行日志已清空' });
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
    if (request.method === 'GET' && url.pathname === '/api/user/assets') {
      if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
      const assets = authService.db.getUserAssets(user.id);
      json(response, 200, { ok: true, assets });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/user/redeem') {
      if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
      const waitSeconds = authGuard.inspect(user.email, authClientIp, 'redeem');
      if (waitSeconds > 0) { rejectBruteForce(waitSeconds); return; }
      try {
        const body = await readJsonBody(request);
        const master = await listDevices();
        const result = authService.redeemCard({
          userId: user.id,
          cardCode: body?.cardCode,
          masterDevices: master
        });
        authGuard.registerSuccess(user.email, 'redeem');
        json(response, 200, { ok: true, result });
      } catch (err) {
        authGuard.registerFailure(user.email, authClientIp, 'redeem');
        console.warn(`[User Redeem Failed] user=${user.username || user.id} reason=${err.message}`);
        json(response, 400, { ok: false, error: '兑换失败，请联系客服', detail: err.message });
      }
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
      try {
        const body = await readJsonBody(request);
        authService.db.updateUserStatus(body.userId, body.status);
        json(response, 200, { ok: true });
      } catch (err) {
        json(response, 400, { ok: false, error: err.message });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/admin/cards') {
      if (!requireAdmin(response)) return;
      const status = url.searchParams.get('status') || '';
      const batchTag = url.searchParams.get('batchTag') || '';
      const type = url.searchParams.get('type') || '';
      const cards = authService.listCards({ status, batchTag, type });
      json(response, 200, { ok: true, cards });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/cards/generate') {
      if (!requireAdmin(response)) return;
      try {
        const body = await readJsonBody(request);
        const cards = authService.generateCards(body || {});
        json(response, 200, { ok: true, cards });
      } catch (err) {
        json(response, 400, { ok: false, error: err.message });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/admin/cards/revoke') {
      if (!requireAdmin(response)) return;
      try {
        const body = await readJsonBody(request);
        authService.revokeCard(body?.cardId);
        json(response, 200, { ok: true });
      } catch (err) {
        json(response, 400, { ok: false, error: err.message });
      }
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

    // --- 管理员 AI 设置与多供应商管理 API ---
    if (request.method === 'GET' && url.pathname === '/api/admin/ai-settings') {
      if (!requireAdmin(response)) return;
      const { getEffectiveConfig, listProviders, loadSettings, maskApiKey } = require('../ai/config');
      const cfg = getEffectiveConfig();
      const settings = loadSettings();
      json(response, 200, {
        ok: true,
        activeProviderId: settings.activeProviderId,
        providers: listProviders(),
        systemPrompt: cfg.systemPrompt || '',
        settings: {
          activeProviderId: settings.activeProviderId,
          provider: cfg.provider || 'openai',
          endpoint: cfg.endpoint || 'https://api.deepseek.com',
          model: cfg.model || 'deepseek-chat',
          apiKeyMasked: maskApiKey(cfg.apiKey),
          hasApiKey: Boolean(cfg.apiKey && cfg.apiKey.trim())
        }
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/ai-providers') {
      if (!requireAdmin(response)) return;
      try {
        const body = await readJsonBody(request);
        const { saveProvider, listProviders } = require('../ai/config');
        saveProvider(body);
        json(response, 200, { ok: true, providers: listProviders() });
      } catch (err) {
        json(response, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname.startsWith('/api/admin/ai-providers/') && url.pathname.endsWith('/set-default')) {
      if (!requireAdmin(response)) return;
      try {
        const parts = url.pathname.split('/');
        const id = parts[4];
        const { setDefaultProvider, listProviders } = require('../ai/config');
        setDefaultProvider(id);
        json(response, 200, { ok: true, providers: listProviders() });
      } catch (err) {
        json(response, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/api/admin/ai-providers/')) {
      if (!requireAdmin(response)) return;
      try {
        const parts = url.pathname.split('/');
        const id = parts[4];
        const { deleteProvider, listProviders } = require('../ai/config');
        deleteProvider(id);
        json(response, 200, { ok: true, providers: listProviders() });
      } catch (err) {
        json(response, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/ai-settings') {
      if (!requireAdmin(response)) return;
      try {
        const body = await readJsonBody(request);
        const { saveSettings, getSanitizedSettings, listProviders } = require('../ai/config');
        const updates = {};
        if (body.systemPrompt !== undefined) updates.systemPrompt = String(body.systemPrompt).trim();
        saveSettings(updates, body.expectedRevision);
        json(response, 200, { ok: true, settings: getSanitizedSettings(), providers: listProviders() });
      } catch (err) {
        json(response, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/ai-settings/test') {
      if (!requireAdmin(response)) return;
      try {
        const body = await readJsonBody(request);
        const { getEffectiveConfig, loadSettings } = require('../ai/config');
        const { DeepSeekProvider } = require('../ai/provider');
        let testConfig;
        if (body?.id) {
          const settings = loadSettings();
          const found = (settings.providers || []).find(p => p.id === body.id);
          if (!found) throw new Error('供应商不存在');
          testConfig = {
            provider: found.provider,
            endpoint: found.endpoint,
            apiKey: found.apiKey,
            model: found.model,
            timeoutMs: found.timeoutMs || 15000
          };
        } else {
          const current = getEffectiveConfig();
          let apiKey = '';
          if (body?.apiKey && !body.apiKey.includes('***')) {
            apiKey = body.apiKey.trim();
          } else if (body?.providerId) {
            const settings = loadSettings();
            const found = (settings.providers || []).find(p => p.id === body.providerId);
            apiKey = found ? found.apiKey : current.apiKey;
          } else {
            apiKey = current.apiKey;
          }
          testConfig = {
            provider: body?.provider || current.provider || 'openai',
            endpoint: body?.endpoint || current.endpoint || 'https://api.deepseek.com',
            apiKey,
            model: body?.model || current.model || 'deepseek-chat',
            temperature: 0.7,
            maxTokens: 50,
            timeoutMs: 15000
          };
        }
        if (!testConfig.apiKey) {
          throw new Error('未配置 API Key，无法测试连接');
        }
        // 管理员也不能把本机服务当成打内网的跳板：该请求会把 apiKey 一并发往 endpoint
        await urlGuard.assertSafeOutboundUrl(testConfig.endpoint, {
          allowLoopback: true,
          allowPrivate: String(process.env.YUNMOMO_AI_ALLOW_PRIVATE || '').trim() === '1'
        });
        const testRes = await DeepSeekProvider.chat([
          { role: 'user', content: '测试API连接，请回复：连接成功' }
        ], testConfig);
        json(response, 200, {
          ok: true,
          message: '连接测试成功',
          reply: testRes.text,
          model: testRes.model,
          requestId: testRes.requestId
        });
      } catch (err) {
        json(response, 200, {
          ok: false,
          error: err.message || '连接测试失败',
          code: err.code || null
        });
      }
      return;
    }

    // --- 接码平台管理 (玄武 OpenAPI) ---
    if (url.pathname.startsWith('/api/admin/sms/')) {
      if (!requireAdmin(response)) return;
      const smsService = getSmsService();

      try {
        if (request.method === 'GET' && url.pathname === '/api/admin/sms/config') {
          json(response, 200, { ok: true, config: smsService.getConfig() });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/admin/sms/config') {
          const body = await readJsonBody(request);
          const config = smsService.saveConfig(body);
          json(response, 200, { ok: true, config });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/admin/sms/test') {
          const body = await readJsonBody(request);
          const result = await smsService.testConnection(body);
          json(response, 200, result);
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/admin/sms/projects') {
          const page = url.searchParams.get('page') || 1;
          const limit = url.searchParams.get('limit') || 100;
          const data = await smsService.listProjects({ page, limit });
          json(response, 200, { ok: true, ...data });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/admin/sms/phone/get') {
          const body = await readJsonBody(request);
          const result = await smsService.grabPhone(body);
          json(response, 200, result);
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/admin/sms/code/get') {
          const body = await readJsonBody(request);
          const result = await smsService.querySmsCode(body);
          json(response, 200, result);
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/admin/sms/record/status') {
          const body = await readJsonBody(request);
          smsService.markRecordStatus(body.recordId, body.status, body.message);
          json(response, 200, { ok: true });
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/admin/sms/records') {
          const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
          const offset = parseInt(url.searchParams.get('offset'), 10) || 0;
          const status = url.searchParams.get('status') || '';
          let search = (url.searchParams.get('search') || '').trim();
          if (search && user && user.email && search.toLowerCase() === user.email.toLowerCase()) {
            search = '';
          }
          const data = smsService.listRecords({ limit, offset, status, search });
          const stats = smsService.getStats();
          json(response, 200, { ok: true, ...data, stats });
          return;
        }

        if (request.method === 'GET' && url.pathname === '/api/admin/sms/logs') {
          const limit = parseInt(url.searchParams.get('limit'), 10) || 100;
          const offset = parseInt(url.searchParams.get('offset'), 10) || 0;
          const status = url.searchParams.get('status') || '';
          let search = (url.searchParams.get('search') || '').trim();
          // 后端兜底防御：若搜索内容与管理员邮箱一致，忽略该搜索条件，避免由于浏览器自动填充返回空列表
          if (search && user && user.email && search.toLowerCase() === user.email.toLowerCase()) {
            search = '';
          }
          const data = smsService.listCallLogs({ limit, offset, status, search });
          json(response, 200, { ok: true, ...data });
          return;
        }

        if (request.method === 'DELETE' && url.pathname === '/api/admin/sms/logs') {
          smsService.clearCallLogs();
          json(response, 200, { ok: true });
          return;
        }

        if (request.method === 'DELETE' && url.pathname === '/api/admin/sms/records') {
          smsService.clearRecords();
          json(response, 200, { ok: true });
          return;
        }
      } catch (err) {
        json(response, 400, { ok: false, error: err.message, code: err.code || null });
        return;
      }
    }

    // --- 脚本显隐控制与自定义脚本组合 (Admin Only) ---
    if (url.pathname.startsWith('/api/admin/scripts/')) {
      if (!requireAdmin(response)) return;
      const db = authService.db;

      try {
        if (request.method === 'GET' && url.pathname === '/api/admin/scripts/config') {
          json(response, 200, {
            ok: true,
            visibility: db.getScriptVisibility(),
            bundles: db.getScriptBundles()
          });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/admin/scripts/visibility') {
          const body = await readJsonBody(request);
          const updated = db.setScriptVisibility(body);
          json(response, 200, { ok: true, visibility: updated });
          return;
        }

        if (request.method === 'POST' && url.pathname === '/api/admin/scripts/bundles') {
          const body = await readJsonBody(request);
          const bundle = db.saveScriptBundle(body);
          json(response, 200, { ok: true, bundle });
          return;
        }

        if (request.method === 'DELETE' && url.pathname === '/api/admin/scripts/bundles') {
          const body = await readJsonBody(request);
          db.deleteScriptBundle(body?.id);
          json(response, 200, { ok: true });
          return;
        }
      } catch (err) {
        json(response, 400, { ok: false, error: err.message });
        return;
      }
    }

    // --- 云机自动化路由（AI 回复 / 调度中枢）：默认全部要求登录并按设备归属授权 ---
    if (url.pathname.startsWith('/api/momo-brain/') || url.pathname.startsWith('/api/ai-reply/')) {
      let bodyJson = null;
      if (request.method === 'POST') {
        bodyJson = await readJsonBody(request);
      }
      if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }

      const deviceId = String(bodyJson?.deviceId || url.searchParams.get('deviceId') || '').trim();
      // 子路由在 deviceId 缺省时会回落到 process.env.YUNMOMO_DEVICE_ID，越权校验必须跟着这个回落值走
      const effectiveDeviceId = deviceId || String(process.env.YUNMOMO_DEVICE_ID || '').trim();
      const actsOnDevice = url.pathname === '/api/momo-brain/start'
        || url.pathname === '/api/momo-brain/pause'
        || url.pathname === '/api/momo-brain/resume'
        || url.pathname === '/api/momo-brain/stop'
        || url.pathname === '/api/momo-brain/events'
        || url.pathname === '/api/momo-brain/status'
        || url.pathname === '/api/ai-reply/run';
      const targetDevice = deviceId || (actsOnDevice ? effectiveDeviceId : '');
      if (targetDevice && !authService.canAccessDevice(user, targetDevice)) {
        json(response, 403, { ok: false, error: '无该设备的访问权限' });
        return;
      }

      // 这三处写入作用于全局配置或消耗共享 API 额度，普通用户改动会波及其他人，仅管理员可操作
      const isGlobalWrite = request.method === 'POST' && (
        url.pathname === '/api/momo-brain/config'
        || url.pathname === '/api/ai-reply/settings'
        || url.pathname === '/api/ai-reply/test'
      );
      // 不带 deviceId 的聚合读取会返回全部云机状态或含 deviceOverrides 的全局配置
      const isAggregateRead = request.method === 'GET' && (
        (url.pathname === '/api/momo-brain/status' || url.pathname === '/api/momo-brain/config') && !deviceId
      );
      if ((isGlobalWrite || isAggregateRead) && user.role !== 'admin') {
        json(response, 403, { ok: false, error: '无管理员访问权限' });
        return;
      }

      // runId 里含联系人聊天记录，必须按任务创建时的设备归属复检，避免越权读取或取消他人任务
      if (url.pathname.startsWith('/api/ai-reply/runs/')) {
        const runRecord = activeRuns.get(url.pathname.split('/')[4]);
        if (runRecord && !authService.canAccessDevice(user, runRecord.deviceId)) {
          json(response, 403, { ok: false, error: '无该任务的访问权限' });
          return;
        }
      }

      if (url.pathname.startsWith('/api/momo-brain/')) {
        const handled = handleMomoBrainRoutes(request, response, url, bodyJson, brainManager());
        if (handled) return;
      } else {
        const handled = handleAiReplyRoutes(request, response, url, bodyJson, client());
        if (handled) return;
      }
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
        if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
        const pageId = /^[A-Za-z0-9_-]{8,128}$/.test(url.searchParams.get('pageId') || '')
          ? url.searchParams.get('pageId') : '';
        const visibleRuns = [...activeScriptRuns.values()].filter(run =>
          user.role === 'admin' || (run.ownerUserId && run.ownerUserId === user.id));
        const runs = visibleRuns.map(run => ({
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
            if (user.role !== 'admin' && !authService.canAccessDevice(user, item.deviceId)) continue;
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
        if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
        const scriptRunId = String(url.searchParams.get('scriptRunId') || '');
        const run = activeScriptRuns.get(scriptRunId);
        if (run && user.role !== 'admin' && run.ownerUserId && run.ownerUserId !== user.id) {
          json(response, 403, { ok: false, error: '无权查看其他用户的脚本输出' });
          return;
        }
        if (run) {
          json(response, 200, {
            ok: true,
            active: true,
            scriptRunId: run.id,
            logFile: run.logFile || `logs/runs/${run.id}.log`,
            stdout: redact(run.stdout || ''),
            stderr: redact(run.stderr || ''),
            status: run.status
          });
        } else {
          json(response, 200, {
            ok: true,
            active: false,
            scriptRunId,
            logFile: `logs/runs/${scriptRunId}.log`,
            stdout: '',
            stderr: '',
            status: 'finished'
          });
        }
        return;
      }
      if (url.pathname === '/api/logs') {
        if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
        const scriptRunId = String(url.searchParams.get('scriptRunId') || url.searchParams.get('runId') || '').trim();
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(scriptRunId)) {
          json(response, 400, { ok: false, error: '无效的日志调用编号' });
          return;
        }
        const ownerUserId = await readRunOwner(scriptRunId);
        if (user.role !== 'admin' && ownerUserId && ownerUserId !== user.id) {
          json(response, 403, { ok: false, error: '无权读取其他用户的执行日志' });
          return;
        }
        const logPath = path.join(PROJECT_ROOT, 'logs', 'runs', `${scriptRunId}.log`);
        try {
          const content = await fs.promises.readFile(logPath, 'utf8');
          json(response, 200, { ok: true, scriptRunId, content: redact(content) });
        } catch {
          json(response, 404, { ok: false, error: '未找到指定调用的日志文件' });
        }
        return;
      }
      if (url.pathname === '/api/scripts') {
        if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
        const db = authService.db;
        const visibility = db.getScriptVisibility();
        const bundles = db.getScriptBundles();
        const isAdmin = Boolean(user && user.role === 'admin');

        json(response, 200, {
          ok: true,
          scripts: SCRIPT_DEFINITIONS,
          bundles,
          visibility,
          isAdmin
        });
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
      if (url.pathname === '/api/cloud-disk/files') {
        if (!requireAdmin(response)) return;
        const dir = safeCloudDiskDir(url.searchParams.get('dir'));
        const files = getCloudDiskFiles(dir);
        const counts = {
          '真参': getCloudDiskFiles('真参').length,
          '头像': getCloudDiskFiles('头像').length
        };
        json(response, 200, { ok: true, dir, files, counts });
        return;
      }
      if (url.pathname === '/api/cloud-disk/file' || url.pathname === '/api/cloud-disk/preview' || url.pathname === '/api/cloud-disk/download') {
        if (!requireAdmin(response)) return;
        const dir = safeCloudDiskDir(url.searchParams.get('dir'));
        const rawName = url.searchParams.get('name') || '';
        const name = path.basename(rawName);
        if (!name) {
          json(response, 400, { ok: false, error: '缺少文件名' });
          return;
        }
        const filePath = path.join(CLOUD_DISK_ROOT, dir, name);
        if (!fs.existsSync(filePath)) {
          json(response, 404, { ok: false, error: '文件不存在' });
          return;
        }
        const ext = path.extname(name).toLowerCase();
        const mimeTypes = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp',
          '.txt': 'text/plain; charset=utf-8',
          '.json': 'application/json; charset=utf-8'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const fileBuffer = fs.readFileSync(filePath);
        response.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': fileBuffer.length,
          'Cache-Control': 'public, max-age=3600',
          ...(url.pathname.includes('download') ? { 'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"` } : {})
        });
        response.end(fileBuffer);
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
      const result = await executeScript(body, user);
      deviceCache = null;
      json(response, 200, result);
      return;
    }
    if (request.method === 'POST' && (url.pathname === '/api/execute/stop' || url.pathname === '/api/scripts/stop')) {
      if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return; }
      const result = await stopActiveScript(await readJsonBody(request), user);
      if (result && result.forbidden) { json(response, 403, { ok: false, error: result.message }); return; }
      json(response, 200, result);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/cloud-disk/upload') {
      if (!requireAdmin(response)) return;
      const body = await readJsonBody(request, 50 * 1024 * 1024);
      const dir = safeCloudDiskDir(body?.dir);
      const rawName = body?.name || '';
      const name = path.basename(rawName.trim());
      const base64Data = body?.contentBase64 || '';
      if (!name || !base64Data) {
        json(response, 400, { ok: false, error: '缺少文件名或文件内容' });
        return;
      }
      const buffer = Buffer.from(base64Data, 'base64');
      const targetPath = path.join(CLOUD_DISK_ROOT, dir, name);
      fs.writeFileSync(targetPath, buffer);
      json(response, 200, { ok: true, name, dir, size: buffer.length });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/cloud-disk/delete') {
      if (!requireAdmin(response)) return;
      const body = await readJsonBody(request);
      const dir = safeCloudDiskDir(body?.dir);
      const rawName = body?.name || '';
      const name = path.basename(rawName.trim());
      if (!name) {
        json(response, 400, { ok: false, error: '缺少文件名' });
        return;
      }
      const targetPath = path.join(CLOUD_DISK_ROOT, dir, name);
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      json(response, 200, { ok: true, name, dir });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/cloud-disk/zhencan/toggle-status') {
      if (!requireAdmin(response)) return;
      const body = await readJsonBody(request);
      const rawName = body?.fileName || body?.name || '';
      const name = path.basename(String(rawName).trim());
      const targetStatus = body?.status === 'used' ? 'used' : 'available';
      if (!name) {
        json(response, 400, { ok: false, error: '缺少文件名' });
        return;
      }
      authService.setZhencanFileStatus(name, targetStatus);
      const statusLabel = targetStatus === 'available' ? '【可用】' : '【已使用】';
      json(response, 200, {
        ok: true,
        fileName: name,
        status: targetStatus,
        message: `真参配置 [${name}] 状态已变更为: ${statusLabel}`
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/cloud-disk/send-to-device') {
      if (!requireAdmin(response)) return;
      const body = await readJsonBody(request);
      const deviceId = String(body?.deviceId || '').trim();
      const dir = safeCloudDiskDir(body?.dir);
      const rawName = body?.name || '';
      const name = path.basename(rawName.trim());

      if (!deviceId) {
        json(response, 400, { ok: false, error: '请先选择目标云机' });
        return;
      }
      if (!name) {
        json(response, 400, { ok: false, error: '缺少目标文件名' });
        return;
      }
      if (user.role !== 'admin' && !authService.canAccessDevice(user, deviceId)) {
        json(response, 403, { ok: false, error: '无权操作此设备或该设备已到期回收' });
        return;
      }

      const filePath = path.join(CLOUD_DISK_ROOT, dir, name);
      if (!fs.existsSync(filePath)) {
        json(response, 404, { ok: false, error: `文件 [${name}] 在 ${dir} 目录中不存在` });
        return;
      }

      const c = client();
      if (!c.token) {
        json(response, 400, { ok: false, error: '平台会话令牌尚未配置，无法下发到云机' });
        return;
      }

      if (dir === '真参') {
        // 校验真参文件使用状态 (单机单参规则)
        const record = authService.getZhencanFileRecord(name);
        if (record && record.status === 'used' && !body?.force) {
          const dateText = record.used_at ? new Date(record.used_at).toLocaleString('zh-CN') : '此前';
          const devText = record.used_on_device_name || record.used_on_device_id || '其他云机';
          json(response, 400, {
            ok: false,
            error: `该真参文件已于 ${dateText} 导入过云机 (${devText})！默认每个参数只能使用一次。如需重新使用，请先将其状态重置为【启用】。`
          });
          return;
        }

        // 校验操作用户真参配额
        if (user.role !== 'admin') {
          const balance = authService.getUserZhencanBalance(user.id);
          if (balance <= 0) {
            json(response, 400, {
              ok: false,
              error: '真参额度不足（剩余 0 套）！请先通过卡密兑换真参配额后再执行推送。'
            });
            return;
          }
        }

        const fileContent = fs.readFileSync(filePath, 'utf8');
        let parsed;
        try {
          parsed = JSON.parse(fileContent);
        } catch (err) {
          json(response, 400, { ok: false, error: `真参文件不是合法的 JSON 格式: ${err.message}` });
          return;
        }
        const deviceInfo = extractDeviceInfo(parsed);
        if (!deviceInfo.brand || !deviceInfo.model) {
          json(response, 400, { ok: false, error: '真参文件中未解析到有效的手机品牌或型号' });
          return;
        }
        const cloudRes = await c.device(deviceId).setDeviceInfo({
          brand: deviceInfo.brand,
          marketName: deviceInfo.marketName,
          model: deviceInfo.model,
          androidVersion: deviceInfo.androidVersion,
          devinfo: fileContent
        });
        const replyMsg = typeof cloudRes === 'string' ? cloudRes : (cloudRes?.message || cloudRes?.data || '设置成功');

        // 标记真参为已使用并核销额度
        let targetDevName = 'SF'; try { const devList = await listDevices(); targetDevName = devList.find(d => d.deviceId === deviceId)?.name || 'SF'; } catch {}
        authService.markZhencanFileUsed(name, {
          userId: user.id,
          deviceId,
          deviceName: targetDevName
        });
        if (user.role !== 'admin') {
          authService.consumeZhencanQuota(user, 1, { fileName: name, deviceId, deviceName: targetDevName });
        }

        json(response, 200, {
          ok: true,
          message: `真参配置 [${name}] 已成功下发并应用到云机！已标记为已使用。品牌: ${deviceInfo.brand}, 型号: ${deviceInfo.model}`,
          deviceInfo,
          cloudResult: replyMsg
        });
        return;
      }

      if (dir === '头像') {
        const fileBuffer = fs.readFileSync(filePath);
        const disk = c.cloudDisk();
        let listRes = await disk.list({ name });
        let fileRecord = listRes.records?.find(r => r.name === name);
        if (!fileRecord) {
          await disk.upload(fileBuffer, { fileName: name });
          listRes = await disk.list({ name });
          fileRecord = listRes.records?.find(r => r.name === name);
        }
        if (!fileRecord || !fileRecord.url) {
          json(response, 500, { ok: false, error: `未能获取到中转站文件记录: ${name}` });
          return;
        }

        const sendRes = await disk.sendToDevices([deviceId], [fileRecord], { fileType: 'auto' });
        json(response, 200, {
          ok: true,
          message: `头像图片 [${name}] 已成功推送到云机相册！`,
          sendResult: sendRes
        });
        return;
      }

      json(response, 400, { ok: false, error: '不支持的目录类别' });
      return;
    }
    if (request.method !== 'GET') {
      json(response, 405, { ok: false, error: '只支持 GET 和 POST' });
      return;
    }
    await staticFile(response, url.pathname);
  } catch (error) {
    const message = redact(error?.message || error);
    const status = errorStatus({ message, status: error?.status });
    const level = status >= 500 ? 'ERROR' : 'WARN';
    const safeUrl = authGuard.redact(request.url || '');
    if (level === 'ERROR') {
      console.error(`[API UNHANDLED] ${request.method} ${safeUrl} -> ${status}:`, error);
      appendServerLog('ERROR', `UNHANDLED ${request.method} ${safeUrl} -> ${status}: ${message}`, error?.stack || '');
    } else {
      console.warn(`[API REJECTED] ${request.method} ${safeUrl} -> ${status}: ${message}`);
      appendServerLog('WARN', `REJECTED ${request.method} ${safeUrl} -> ${status}: ${message}`);
    }
    json(response, status, { ok: false, error: message,
      ...(error?.name === 'StreamScreenshotError' ? { code: error.code } : {}), ...(error?.timing || {}) });
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
