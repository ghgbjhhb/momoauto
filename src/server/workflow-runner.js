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

  // 串行有序排队执行：逐台设备端到端闭环，彻底杜绝云端接口锁冲突(HTTP 400)及本地 OCR/推流并发资源雪崩
  for (let i = 0; i < run.results.length; i++) {
    const entry = run.results[i];
    if (run.stopRequested) {
      entry.status = 'skipped';
      continue;
    }
    await executeOneDevice(entry);
  }

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

    const env = {
      ...process.env,
      YUNMOMO_DEVICE_ID: entry.deviceId,
      YUNMOMO_TOKEN: userToken,
      YUNMOMO_BUNDLE_RUN_ID: run.id,
      YUNMOMO_BUNDLE_SPEC: bundleSpec,
    };

    const child = spawn(process.execPath, [workerScript], {
      cwd: PROJECT_ROOT,
      env: require('../automation/timing').childEnv(env),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

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
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('error', err => {
      run.activeDeviceRuns.delete(entry.deviceId);
      entry.status = 'failed';
      entry.message = '流水线启动异常: ' + err.message;
      resolve({ ok: false, error: err });
    });

    child.on('close', code => {
      run.activeDeviceRuns.delete(entry.deviceId);
      if (code === 0) {
        entry.status = 'ok';
        entry.completedSteps = steps.length;
        resolve({ ok: true });
      } else {
        if (run.stopRequested) {
          entry.status = 'cancelled';
          entry.message = '已停止执行';
        } else {
          entry.status = 'failed';
          entry.message = `组合执行失败 (退出代码: ${code})`;
        }
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

module.exports = { launchWorkflow, stopWorkflow, getWorkflowStatus };
