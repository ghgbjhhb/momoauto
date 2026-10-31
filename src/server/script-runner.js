'use strict';

const fs = require('node:fs');
const { access } = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { STEPS: STEPS_V2 } = require('../../flows/v2/_common');
const { STEPS: STEPS_V3 } = require('../../flows/v3/_common');
const { defaultArbiter } = require('./device-arbiter');
const { getAuthService } = require('./auth/service');
const {
  PROJECT_ROOT,
  CLOUD_DISK_ROOT,
  MAX_OUTPUT_BYTES,
  SCRIPT_STOP_INTENT_TTL_MS,
  activeScriptRuns,
  pendingScriptStops,
  completedScriptRuns,
  busyDevices,
  busyAccountScripts,
  manualBridges,
  activeToken,
  configuredValue,
  selectedDevice
} = require('./context');
const { SCRIPT_DEFINITIONS, scriptById } = require('./script-catalog');
const { targetDeviceId } = require('../automation/runtime');
const { redact } = require('./http');

const authService = getAuthService();

function appendOutput(current, chunk) {
  const value = current + String(chunk);
  return value.length > MAX_OUTPUT_BYTES
    ? value.slice(0, MAX_OUTPUT_BYTES) + '\n[输出已截断]'
    : value;
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
  while (map.size > 256) map.delete(map.keys().next().value);
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
    targetDeviceId(undefined, env);
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

    const env = { ...process.env };
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
  if (script.id === 'flow-15') {
    if (options.mode?.trim()) env.YUNMOMO_MOMO_WATCH_MODE = options.mode.trim();
    if (options.maxContacts?.trim()) env.YUNMOMO_MOMO_MAX_CONTACTS = options.maxContacts.trim();
    if (options.maxGreetings?.trim()) env.YUNMOMO_MOMO_MAX_GREETINGS = options.maxGreetings.trim();
    if (options.warmupInterval?.trim()) env.YUNMOMO_MOMO_WARMUP_INTERVAL = options.warmupInterval.trim();
    const rawDist = options.maxDistance ?? options.maxDistanceKm;
    if (rawDist && String(rawDist).trim() && String(rawDist).trim() !== 'none') {
      env.YUNMOMO_MOMO_MAX_DISTANCE = String(rawDist).trim();
    }
  }
  if (script.id === 'flow-18') {
    env.YUNMOMO_MOMO_CONTACT_NAME = options.contactName.trim();
  }
}

module.exports = {
  runOwnerFilePath,
  readRunOwner,
  writeRunOwner,
  stopActiveScript,
  executeScript,
  executeScriptMeasured,
  invalidOptions,
  assertScriptVisibleToUser,
  configureScript
};
