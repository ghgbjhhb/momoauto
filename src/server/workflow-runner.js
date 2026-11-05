'use strict';

// 组合和批量任务的服务端调度。Windows 进程重启后的恢复不在本模块范围内。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { getAuthService } = require('./auth/service');
const { scriptById } = require('./script-catalog');
const { executeScript, stopActiveScript, assertScriptVisibleToUser, configureScript } = require('./script-runner');
const { defaultArbiter } = require('./device-arbiter');
const { PROJECT_ROOT, busyDevices, manualBridges, activeScriptRuns } = require('./context');
const { redact } = require('./http');
const authService = getAuthService();
const workflows = new Map();
function safeOutput(userId, output) {
  let value = redact(output);
  const userToken = authService.getUserPlatformToken(userId);
  if (userToken) value = value.split(userToken).join('[redacted]');
  return value;
}

function resolveDeviceVpcData(vpcData, deviceIndex) {
  if (!vpcData || typeof vpcData !== 'string') return vpcData;
  const raw = vpcData.replace(/^\uFEFF/, '').trim();
  if (!raw) return vpcData;

  // 1. JSON 数组格式
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 1) {
        const safeIdx = Number.isInteger(deviceIndex) && deviceIndex >= 0 ? deviceIndex : 0;
        return JSON.stringify(parsed[safeIdx % parsed.length]);
      }
      return vpcData;
    } catch {}
  }

  // 2. 多行文本格式（每行一条代理）
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length <= 1) return raw;

  // 多条代理按设备在选定列表中的序号（0, 1, 2...）一对一分配，若代理行数少于设备数则循环轮询复用
  const safeIdx = Number.isInteger(deviceIndex) && deviceIndex >= 0 ? deviceIndex : 0;
  return lines[safeIdx % lines.length];
}
const RETENTION_MS = 30 * 60 * 1000;
const FINISHED_LIMIT = 128;
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, 'storage', 'workflows');

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function persistWorkflow(run) {
  if (!run || !run.id) return;
  try {
    fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
    const targetFile = path.join(WORKFLOWS_DIR, `${run.id}.json`);
    const tempFile = path.join(WORKFLOWS_DIR, `${run.id}.${process.pid}.tmp`);
    const payload = {
      id: run.id,
      ownerUserId: run.ownerUserId,
      kind: run.kind,
      title: run.title,
      state: run.state,
      stopRequested: Boolean(run.stopRequested),
      stopUnconfirmed: Boolean(run.stopUnconfirmed),
      currentStep: run.currentStep,
      totalSteps: run.totalSteps,
      results: run.results,
      message: run.message,
      lastOutput: run.lastOutput,
      createdAt: run.createdAt || Date.now(),
      updatedAt: Date.now(),
      finishedAt: run.finishedAt,
      rawSpec: run.rawSpec
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempFile, targetFile);
  } catch {}
}

function loadWorkflowFromDisk(id) {
  const filePath = path.join(WORKFLOWS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const run = {
      ...data,
      activeDeviceRuns: new Map(),
      deviceOutputs: new Map(),
      done: null
    };
    // 调和 (Reconciliation): 若任务在磁盘上是 running，但主服务重启导致内存丢失
    if (run.state === 'running') {
      let anyChildAlive = false;
      for (const item of (run.results || [])) {
        if (item.pid && isPidAlive(item.pid)) {
          anyChildAlive = true;
        } else if (item.status === 'running') {
          item.status = 'interrupted';
          item.message = '服务重启导致执行中断';
        }
      }
      if (!anyChildAlive) {
        run.state = 'interrupted';
        run.message = '服务重启中断任务执行，已保存断点，可点击【断点恢复】继续执行剩余步骤';
        run.finishedAt = Date.now();
        persistWorkflow(run);
      }
    }
    return run;
  } catch {
    return null;
  }
}

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function pruneWorkflows() {
  const now = Date.now();
  const retained = [];
  for (const [id, run] of workflows) {
    if (!run.finishedAt) continue;
    if (run.finishedAt + RETENTION_MS <= now) workflows.delete(id);
    else retained.push(id);
  }
  for (const id of retained.slice(0, Math.max(0, retained.length - FINISHED_LIMIT))) workflows.delete(id);
}
setInterval(pruneWorkflows, 60 * 1000).unref();

function getWorkflow(id, user) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw bad('任务编号无效');
  pruneWorkflows();
  let run = workflows.get(id);
  if (!run) {
    run = loadWorkflowFromDisk(id);
    if (run) workflows.set(id, run);
  }
  if (!run) throw bad('任务编号不存在或已过期', 404);
  if (user.role !== 'admin' && run.ownerUserId !== user.id) throw bad('无权查看其他用户的任务', 403);
  return run;
}
function statusSnapshot(run) {
  let logText = run.lastOutput || '';
  if (run.deviceOutputs && run.deviceOutputs.size > 0) {
    const entries = [];
    for (const [devId, out] of run.deviceOutputs) {
      if (out && out.trim()) {
        const shortId = devId.length > 8 ? devId.slice(-6) : devId;
        entries.push(`[设备 ${shortId}]\n` + out.trim().split('\n').slice(-15).join('\n'));
      }
    }
    if (entries.length > 0) logText = entries.join('\n\n');
  }
  const completedSteps = run.results.reduce((sum, item) => sum + (item.completedSteps || 0), 0);
  const activeDevices = run.activeDeviceRuns ? [...run.activeDeviceRuns.keys()] : [];
  return {
    output: safeOutput(run.ownerUserId, logText).slice(-4000),
    ok: true, workflowRunId: run.id, state: run.state, kind: run.kind,
    title: run.title, stopRequested: run.stopRequested,
    currentDeviceId: activeDevices.join(','),
    currentStep: completedSteps,
    totalSteps: run.totalSteps,
    results: run.results.map(item => ({
      deviceId: item.deviceId, status: item.status, completedSteps: item.completedSteps,
      totalSteps: item.totalSteps, message: item.message
    })), message: run.message
  };
}

function buildSteps(body, user) {
  let steps, title;
  if (body?.kind === 'script') {
    const script = scriptById(body.scriptId);
    assertScriptVisibleToUser(script, user);
    steps = [{ script, options: body.options || {} }];
    title = script.title;
  } else if (body?.kind === 'bundle') {
    const bundle = authService.db.getScriptBundles().find(item => item.id === body.bundleId);
    if (!bundle || bundle.enabled === false) throw bad('组合任务不存在或已停用', 404);
    const visibility = authService.db.getScriptVisibility();
    if (user.role !== 'admin' && visibility.groups.custom === false) throw bad('组合任务已关闭', 403);
    if (!Array.isArray(bundle.stepIds) || !bundle.stepIds.length || bundle.stepIds.length > 32) {
      throw bad('组合步骤数量无效');
    }
    if (body.stepOptions !== undefined &&
        (!Array.isArray(body.stepOptions) || body.stepOptions.length !== bundle.stepIds.length)) {
      throw bad('组合参数与保存的步骤不一致');
    }
    steps = bundle.stepIds.map((id, index) => {
      const script = scriptById(id);
      if (script.batch) throw bad('组合中不能包含全流程入口');
      assertScriptVisibleToUser(script, user);
      return { script, options: body.stepOptions ? body.stepOptions[index] : bundle.stepOptions?.[index] || {} };
    });
    title = bundle.name;
  } else {
    throw bad('任务类型无效');
  }

  const confirmations = body.confirmedSteps || [];
  if (!Array.isArray(confirmations) || confirmations.some(index => !Number.isInteger(index))) {
    throw bad('危险操作确认格式无效');
  }
  // 下发第一个设备动作之前必须完成全部步骤的参数和危险操作验证。
  steps.forEach((step, index) => {
    if (!step.options || typeof step.options !== 'object' || Array.isArray(step.options)) {
      throw bad('步骤参数格式无效');
    }
    const { resetConfirmed, ...options } = step.options;
    step.options = options;
    const confirmed = confirmations.includes(index);
    if (step.script.destructive && !confirmed) throw bad('请先确认第 ' + (index + 1) + ' 步的破坏性操作');
    configureScript(step.script, { options, resetConfirmed: confirmed }, {});
  });
  return { steps, title };
}

function launchWorkflow(body, user) {
  const id = String(body?.workflowRunId || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw bad('任务编号无效');
  if (workflows.has(id)) throw bad('任务编号已被使用，只能查询原任务，禁止重复下发', 409);
  const ownerPath = path.join(PROJECT_ROOT, 'logs', 'runs', 'workflow-' + id + '.owner');
  if (fs.existsSync(ownerPath)) throw bad('任务编号已被使用，禁止重复执行', 409);
  const ids = body?.deviceIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 32 ||
      ids.some(value => typeof value !== 'string' || !value.trim() || value.length > 160) ||
      new Set(ids).size !== ids.length) {
    throw bad('请选择 1 至 32 台不重复的设备');
  }
  const { steps, title } = buildSteps(body, user);
  // 这只是防重提交标记，不是运行状态恢复；即使 Windows 重启也不能重用编号。
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
  try {
    fs.writeFileSync(ownerPath, user.id, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw bad('任务编号已被使用，禁止重复执行', 409);
    throw error;
  }
  const run = {
    id, ownerUserId: user.id, kind: body.kind, title, state: 'running',
    stopRequested: false, stopUnconfirmed: false, currentDeviceId: '', currentScriptRunId: '',
    currentStep: 0, totalSteps: steps.length * ids.length,
    activeDeviceRuns: new Map(), deviceOutputs: new Map(),
    results: ids.map(deviceId => ({
      deviceId, status: 'pending', completedSteps: 0, totalSteps: steps.length, message: '', pid: null
    })), message: '', lastOutput: '', createdAt: Date.now(), finishedAt: null, done: null,
    rawSpec: body
  };
  workflows.set(id, run);
  persistWorkflow(run);
  run.done = executeWorkflow(run, steps, user).catch(error => {
    run.state = 'unknown';
    for (const entry of run.results) {
      if (entry.status === 'running') {
        entry.status = 'unknown';
        defaultArbiter.quarantineDevice(entry.deviceId, 'Workflow execution uncertain');
      }
    }
    run.message = redact(error.message || '流程异常，禁止直接重复执行');
  }).finally(() => {
    run.finishedAt = Date.now();
    if (run.state === 'running') run.state = run.stopRequested ? 'cancelled' : 'finished';
    persistWorkflow(run);
    pruneWorkflows();
  });
  return { ok: true, accepted: true, workflowRunId: id };
}

async function executeWorkflow(run, steps, user) {
  run.activeDeviceRuns = new Map();
  run.deviceOutputs = new Map();

  async function executeOneDevice(entry) {
    if (run.stopRequested) {
      entry.status = 'skipped';
      return;
    }
    const currentUser = authService.db.getUserById(user.id);
    if (!currentUser || currentUser.status !== 'active' ||
        (user.role !== 'admin' && !await authService.ensureDeviceAccess(user, entry.deviceId))) {
      entry.status = 'failed';
      entry.message = '账号或设备权限已失效';
      return;
    }
    if (busyDevices.has(entry.deviceId) ||
        [...manualBridges].some(bridge => bridge.isBusy(entry.deviceId))) {
      entry.status = 'skipped';
      entry.message = '设备正在执行其他任务或手动控制';
      return;
    }
    const ownerId = `workflow_${run.id}_${entry.deviceId}`;
    const claimed = defaultArbiter.acquireDevice(entry.deviceId, ownerId, { returnLease: true });
    if (!claimed.ok) {
      entry.status = 'skipped';
      entry.message = '设备已被占用或隔离';
      return;
    }
    const lease = claimed.lease;
    busyDevices.add(entry.deviceId);
    entry.status = 'running';

    try {
      if (steps.length > 1) {
        // 多步骤组合任务接入流水线 Worker，单次握手复用控制通道
        await executeDeviceBundle(run, entry, steps, user, lease);
      } else {
        // 单步骤任务
        for (let index = 0; index < steps.length; index++) {
          if (run.stopRequested) { entry.status = 'cancelled'; break; }
          const current = authService.db.getUserById(user.id);
          if (!current || current.status !== 'active' ||
              (user.role !== 'admin' && !await authService.ensureDeviceAccess(user, entry.deviceId))) {
            entry.status = 'cancelled';
            entry.message = '权限失效，已停止后续步骤';
            break;
          }
          if (run.stopRequested) { entry.status = 'cancelled'; break; }
          const step = steps[index];
          const scriptRunId = randomUUID();
          run.activeDeviceRuns.set(entry.deviceId, { type: 'script', scriptRunId });
          const deviceIndex = run.results.findIndex(r => r.deviceId === entry.deviceId);
          const stepOptions = { ...(step.options || {}) };
          if (stepOptions.vpcData) {
            stepOptions.vpcData = resolveDeviceVpcData(stepOptions.vpcData, deviceIndex);
          }
          let result;
          try {
            result = await executeScript({
              scriptRunId,
              scriptId: step.script.id,
              deviceId: entry.deviceId,
              options: stepOptions,
              resetConfirmed: Boolean(step.script.destructive)
            }, user, lease);
          } catch (error) {
            entry.status = 'unknown';
            entry.message = redact('步骤结果无法确认：' + error.message);
            defaultArbiter.quarantineDevice(entry.deviceId, 'Workflow step result uncertain');
            break;
          } finally {
            run.activeDeviceRuns.delete(entry.deviceId);
          }
          const out = (result?.stdout || '') + (result?.stderr || '');
          if (out) run.deviceOutputs.set(entry.deviceId, out);
          if (run.stopRequested || result?.cancelled) {
            entry.status = 'cancelled';
            entry.message = '已停止执行';
            break;
          }
          if (!result?.ok) {
            entry.status = 'failed';
            entry.message = result?.message || ('第 ' + (index + 1) + ' 步失败');
            break;
          }
          entry.completedSteps++;
        }
        if (entry.status === 'running') entry.status = 'ok';
      }
    } finally {
      run.activeDeviceRuns.delete(entry.deviceId);
      busyDevices.delete(entry.deviceId);
      defaultArbiter.releaseLease(lease);
    }
  }

  // 多设备调度策略：
  // 1. 若为单脚本且脚本属性标记为 exclusive（如单独执行 flow-01 导入云盘文件）：严格有序排队下发；
  // 2. 其余场景（组合流水线任务、可并发普通脚本）：全力并发执行（并发上限 4 台）；
  //    组合流水线内部的排他步骤（如步骤 1）由 bundle-runner 依据脚本属性自动互斥排队，实现流水线重叠并发！
  const isExclusiveSingleScript = (steps.length === 1 && Boolean(steps[0]?.script?.exclusive));
  const MAX_CONCURRENT_DEVICES = isExclusiveSingleScript ? 1 : 4;
  const queue = [...run.results];
  const workers = [];

  for (const entry of queue) {
    if (run.stopRequested) {
      entry.status = 'skipped';
      continue;
    }
    const workerPromise = executeOneDevice(entry).finally(() => {
      const idx = workers.indexOf(workerPromise);
      if (idx !== -1) workers.splice(idx, 1);
    });
    workers.push(workerPromise);
    if (workers.length >= MAX_CONCURRENT_DEVICES) {
      await Promise.race(workers);
    }
  }
  await Promise.allSettled(workers);

  const hasUnknown = run.results.some(r => r.status === 'unknown');
  run.state = hasUnknown ? 'unknown' : run.stopRequested ? 'cancelled' : 'finished';
  run.message = run.stopUnconfirmed
    ? '停止结果未能确认，设备已隔离，请先核查实际运行状态'
    : hasUnknown ? '部分设备结果未知，已停止；请核查云机'
    : run.stopRequested ? '任务已取消' : '所有已派发设备的任务已经结束';
}

function executeDeviceBundle(run, entry, steps, user, lease) {
  return new Promise((resolve) => {
    const userToken = authService.getUserPlatformToken(user.id);
    const workerScript = path.join(PROJECT_ROOT, 'src', 'server', 'bundle-runner.js');
    const deviceIndex = run.results.findIndex(r => r.deviceId === entry.deviceId);
    const deviceSteps = steps.map(s => {
      const opts = { ...(s.options || {}) };
      if (opts.vpcData) {
        opts.vpcData = resolveDeviceVpcData(opts.vpcData, deviceIndex);
      }
      return { scriptId: s.script.id, options: opts };
    });
    const bundleSpec = JSON.stringify(deviceSteps);

    const startStepIndex = entry.completedSteps || 0;
    const env = {
      ...process.env,
      YUNMOMO_DEVICE_ID: entry.deviceId,
      YUNMOMO_TOKEN: userToken,
      YUNMOMO_BUNDLE_RUN_ID: run.id,
      YUNMOMO_BUNDLE_SPEC: bundleSpec,
      YUNMOMO_START_STEP_INDEX: String(startStepIndex),
    };

    const child = spawn(process.execPath, [workerScript], {
      cwd: PROJECT_ROOT,
      env: require('../automation/timing').childEnv(env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    entry.pid = child.pid;
    persistWorkflow(run);

    run.activeDeviceRuns.set(entry.deviceId, { type: 'bundle', child });
    let fullOutput = '';

    const handleOutput = chunk => {
      const text = chunk.toString('utf8');
      fullOutput += text;
      run.deviceOutputs.set(entry.deviceId, fullOutput);

      const endMatch = text.match(/::step-end:(\d+):[^:]+:ok::/);
      if (endMatch) {
        const stepIdx = parseInt(endMatch[1], 10);
        entry.completedSteps = stepIdx + 1;
        persistWorkflow(run);
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('error', err => {
      entry.pid = null;
      run.activeDeviceRuns.delete(entry.deviceId);
      entry.status = 'failed';
      entry.message = '流水线启动异常: ' + err.message;
      persistWorkflow(run);
      resolve({ ok: false, error: err });
    });

    child.on('close', code => {
      entry.pid = null;
      run.activeDeviceRuns.delete(entry.deviceId);
      if (code === 0) {
        entry.status = 'ok';
        entry.completedSteps = steps.length;
        persistWorkflow(run);
        resolve({ ok: true });
      } else {
        if (run.stopRequested) {
          entry.status = 'cancelled';
          entry.message = '已停止执行';
        } else {
          entry.status = 'failed';
          entry.message = `组合执行失败 (退出代码: ${code})`;
        }
        persistWorkflow(run);
        resolve({ ok: false, exitCode: code });
      }
    });
  });
}

async function stopWorkflow(id, user) {
  const run = getWorkflow(id, user);
  if (run.finishedAt) return statusSnapshot(run);
  run.stopRequested = true;
  run.state = 'stopping';
  if (run.activeDeviceRuns) {
    for (const [deviceId, active] of run.activeDeviceRuns) {
      if (active.type === 'bundle' && active.child) {
        try { active.child.kill('SIGTERM'); } catch {}
      }
      if (active.type === 'script' && active.scriptRunId) {
        try {
          await stopActiveScript({ scriptRunId: active.scriptRunId }, { role: 'admin' });
        } catch (error) {
          run.stopUnconfirmed = true;
          defaultArbiter.quarantineDevice(deviceId, 'Workflow cancellation unconfirmed');
          run.message = redact('停止尚未确认：' + error.message);
        }
      }
    }
  }
  return statusSnapshot(run);
}

function getWorkflowStatus(id, user) {
  return statusSnapshot(getWorkflow(id, user));
}

async function resumeWorkflow(id, user) {
  const run = getWorkflow(id, user);
  if (run.state === 'running') {
    throw bad('任务当前正在运行中，无需恢复');
  }
  if (!run.rawSpec) {
    throw bad('缺少任务原始定义，无法执行断点恢复');
  }

  // 检查是否所有设备都已达到目标步数
  const unfinished = run.results.filter(r => (r.completedSteps || 0) < r.totalSteps);
  if (!unfinished.length) {
    run.state = 'finished';
    run.message = '所有设备全部步骤均已完成';
    persistWorkflow(run);
    return statusSnapshot(run);
  }

  const { steps, title } = buildSteps(run.rawSpec, user);
  run.state = 'running';
  run.stopRequested = false;
  run.message = '正在从断点恢复执行...';
  run.finishedAt = null;

  for (const entry of run.results) {
    if ((entry.completedSteps || 0) < entry.totalSteps) {
      entry.status = 'pending';
      entry.message = `准备从第 ${(entry.completedSteps || 0) + 1} 步接力`;
    }
  }

  persistWorkflow(run);

  run.done = executeWorkflow(run, steps, user).catch(error => {
    run.state = 'unknown';
    for (const entry of run.results) {
      if (entry.status === 'running') {
        entry.status = 'unknown';
        defaultArbiter.quarantineDevice(entry.deviceId, 'Workflow execution uncertain');
      }
    }
    run.message = redact(error.message || '流程异常，禁止直接重复执行');
  }).finally(() => {
    run.finishedAt = Date.now();
    if (run.state === 'running') run.state = run.stopRequested ? 'cancelled' : 'finished';
    persistWorkflow(run);
    pruneWorkflows();
  });

  return { ok: true, accepted: true, workflowRunId: id, resumed: true };
}

module.exports = { launchWorkflow, stopWorkflow, getWorkflowStatus, resumeWorkflow };
