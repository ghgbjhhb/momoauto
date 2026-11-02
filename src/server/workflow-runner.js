'use strict';

// 组合和批量任务的服务端调度。Windows 进程重启后的恢复不在本模块范围内。
const fs = require('node:fs');
const path = require('node:path');
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
const RETENTION_MS = 30 * 60 * 1000;
const FINISHED_LIMIT = 128;

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
  const run = workflows.get(id);
  if (!run) throw bad('任务编号不存在；可能已过期或服务已重启，请检查设备状态', 404);
  if (user.role !== 'admin' && run.ownerUserId !== user.id) throw bad('无权查看其他用户的任务', 403);
  return run;
}
function statusSnapshot(run) {
  const current = activeScriptRuns.get(run.currentScriptRunId);
  const logText = current ? (current.stdout || '') + (current.stderr || '') : run.lastOutput || '';
  return {
    output: safeOutput(run.ownerUserId, logText).slice(-4000),
    ok: true, workflowRunId: run.id, state: run.state, kind: run.kind,
    title: run.title, stopRequested: run.stopRequested,
    currentDeviceId: run.currentDeviceId, currentStep: run.currentStep,
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
    results: ids.map(deviceId => ({
      deviceId, status: 'pending', completedSteps: 0, totalSteps: steps.length, message: ''
    })), message: '', lastOutput: '', finishedAt: null, done: null
  };
  workflows.set(id, run);
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
    pruneWorkflows();
  });
  return { ok: true, accepted: true, workflowRunId: id };
}

async function executeWorkflow(run, steps, user) {
  let globalUnknown = false;
  for (const entry of run.results) {
    if (run.stopRequested || globalUnknown) {
      entry.status = 'skipped';
      continue;
    }
    const currentUser = authService.db.getUserById(user.id);
    if (!currentUser || currentUser.status !== 'active' ||
        (user.role !== 'admin' && !await authService.ensureDeviceAccess(user, entry.deviceId))) {
      entry.status = 'failed';
      entry.message = '账号或设备权限已失效';
      run.stopRequested = true;
      continue;
    }
    if (run.stopRequested) { entry.status = 'skipped'; continue; }
    if (busyDevices.has(entry.deviceId) ||
        [...manualBridges].some(bridge => bridge.isBusy(entry.deviceId))) {
      entry.status = 'skipped';
      entry.message = '设备正在执行其他任务或手动控制';
      continue;
    }
    const ownerId = 'workflow_' + run.id;
    const claimed = defaultArbiter.acquireDevice(entry.deviceId, ownerId, { returnLease: true });
    if (!claimed.ok) {
      entry.status = 'skipped';
      entry.message = '设备已被占用或隔离';
      continue;
    }
    const lease = claimed.lease;
    busyDevices.add(entry.deviceId);
    run.currentDeviceId = entry.deviceId;
    entry.status = 'running';
    try {
      for (let index = 0; index < steps.length; index++) {
        if (run.stopRequested) { entry.status = 'cancelled'; break; }
        const current = authService.db.getUserById(user.id);
        if (!current || current.status !== 'active' ||
            (user.role !== 'admin' && !await authService.ensureDeviceAccess(user, entry.deviceId))) {
          run.stopRequested = true;
          entry.status = 'cancelled';
          entry.message = '权限失效，已停止后续步骤';
          break;
        }
        if (run.stopRequested) { entry.status = 'cancelled'; break; }
        const step = steps[index];
        run.currentStep++;
        run.currentScriptRunId = randomUUID();
        let result;
        try {
          result = await executeScript({
            scriptRunId: run.currentScriptRunId, scriptId: step.script.id,
            deviceId: entry.deviceId, options: step.options,
            resetConfirmed: Boolean(step.script.destructive)
          }, user, lease);
        } catch (error) {
          entry.status = 'unknown';
          entry.message = redact('步骤结果无法确认：' + error.message);
          defaultArbiter.quarantineDevice(entry.deviceId, 'Workflow step result uncertain');
          globalUnknown = true;
          break;
        } finally {
          run.currentScriptRunId = '';
        }
        run.lastOutput = safeOutput(run.ownerUserId, (result.stdout || '') + (result.stderr || '')).slice(-4000);
        if (run.stopRequested || result.cancelled) {
          entry.status = 'cancelled';
          entry.message = '已停止执行';
          run.stopRequested = true;
          break;
        }
        if (!result.ok) {
          entry.status = 'failed';
          entry.message = '第 ' + (index + 1) + ' 步失败，当前设备剩余步骤已取消';
          break;
        }
        entry.completedSteps++;
      }
      if (entry.status === 'running') entry.status = 'ok';
    } finally {
      run.currentDeviceId = '';
      busyDevices.delete(entry.deviceId);
      defaultArbiter.releaseLease(lease);
    }
  }
  run.state = (globalUnknown || run.stopUnconfirmed) ? 'unknown'
    : run.stopRequested ? 'cancelled' : 'finished';
  run.message = run.stopUnconfirmed
    ? '停止结果未能确认，设备已隔离，请先核查实际运行状态'
    : globalUnknown ? '步骤结果未知，已停止后续调度；请核查云机'
      : run.stopRequested ? '任务已取消，未继续派发后续步骤' : '所有已派发设备的任务已经结束';
}

async function stopWorkflow(id, user) {
  const run = getWorkflow(id, user);
  if (run.finishedAt) return statusSnapshot(run);
  run.stopRequested = true;
  run.state = 'stopping';
  if (run.currentScriptRunId) {
    try {
      await stopActiveScript({ scriptRunId: run.currentScriptRunId }, { role: 'admin' });
    } catch (error) {
      run.stopUnconfirmed = true;
      if (run.currentDeviceId) {
        defaultArbiter.quarantineDevice(run.currentDeviceId, 'Workflow cancellation unconfirmed');
      }
      run.message = redact('停止尚未确认：' + error.message);
    }
  }
  return statusSnapshot(run);
}

function getWorkflowStatus(id, user) {
  return statusSnapshot(getWorkflow(id, user));
}

module.exports = { launchWorkflow, stopWorkflow, getWorkflowStatus };
