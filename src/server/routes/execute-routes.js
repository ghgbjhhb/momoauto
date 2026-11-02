'use strict';

const { json, readJsonBody, redact } = require('../http');
const { getAuthService } = require('../auth/service');
const { YunmomoClient } = require('../../index');
const { handleMomoBrainRoutes } = require('../momo-brain-routes');
const { handleAiReplyRoutes, activeRuns } = require('../ai-reply-routes');
const { defaultArbiter } = require('../device-arbiter');
const { executeScript, stopActiveScript, launchWebScript, getWebScriptState } = require('../script-runner');
const { launchWorkflow, stopWorkflow, getWorkflowStatus } = require('../workflow-runner');
const {
  busyDevices,
  busyAccountScripts,
  manualBridges,
  activeScriptRuns,
  brainManager,
  getSharedBrainManager,
  resetSharedBrainManager,
  resetSharedClient,
  persistToken,
  setRuntimeToken,
  clearDeviceCache,
  client
} = require('../context');

const authService = getAuthService();

function requireAdmin(user, response) {
  if (!user || user.role !== 'admin') {
    json(response, 403, { ok: false, error: '无管理员访问权限' });
    return false;
  }
  return true;
}

async function handleExecuteRoutes(ctx, request, response, url) {
  const { user } = ctx;

  // --- Automation: Momo Brain & AI Reply ---
  if (url.pathname.startsWith('/api/momo-brain/') || url.pathname.startsWith('/api/ai-reply/')) {
    let bodyJson = null;
    if (request.method === 'POST') {
      bodyJson = await readJsonBody(request);
    }
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }

    const deviceId = String(bodyJson?.deviceId || url.searchParams.get('deviceId') || '').trim();
    const effectiveDeviceId = deviceId || String(process.env.YUNMOMO_DEVICE_ID || '').trim();
    const actsOnDevice = url.pathname === '/api/momo-brain/start'
      || url.pathname === '/api/momo-brain/pause'
      || url.pathname === '/api/momo-brain/resume'
      || url.pathname === '/api/momo-brain/stop'
      || url.pathname === '/api/momo-brain/events'
      || url.pathname === '/api/momo-brain/status'
      || url.pathname === '/api/ai-reply/run';
    const targetDevice = deviceId || (actsOnDevice ? effectiveDeviceId : '');
    if (targetDevice && !await authService.ensureDeviceAccess(user, targetDevice)) {
      json(response, 403, { ok: false, error: '无该设备的访问权限' });
      return true;
    }

    const isGlobalWrite = request.method === 'POST' && (
      url.pathname === '/api/momo-brain/config'
    );
    const isAggregateRead = request.method === 'GET' && (
      (url.pathname === '/api/momo-brain/status' || url.pathname === '/api/momo-brain/config') && !deviceId
    );
    if ((isGlobalWrite || isAggregateRead) && user.role !== 'admin') {
      json(response, 403, { ok: false, error: '无管理员访问权限' });
      return true;
    }

    if (url.pathname.startsWith('/api/ai-reply/runs/')) {
      const runRecord = activeRuns.get(url.pathname.split('/')[4]);
      if (runRecord && !await authService.ensureDeviceAccess(user, runRecord.deviceId)) {
        json(response, 403, { ok: false, error: '无该任务的访问权限' });
        return true;
      }
    }

    if (url.pathname.startsWith('/api/momo-brain/')) {
      const handled = handleMomoBrainRoutes(request, response, url, bodyJson, brainManager(), user);
      if (handled) return true;
    } else {
      const handled = handleAiReplyRoutes(request, response, url, bodyJson, client(), user);
      if (handled) return true;
    }
  }

  // --- Execution Output ---
  if (request.method === 'GET' && url.pathname === '/api/execute/output') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const scriptRunId = String(url.searchParams.get('scriptRunId') || '');
    const run = activeScriptRuns.get(scriptRunId);
    if (run && user.role !== 'admin' && run.ownerUserId !== user.id) {
      json(response, 403, { ok: false, error: '无权查看其他用户的脚本输出' });
      return true;
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
      // 内存中查不到不等于已经完成；历史终态必须有明确的落盘证据。
      const state = await getWebScriptState(scriptRunId, user);
      const found = state.state !== 'not_found';
      json(response, found ? 200 : 404, {
        ok: found,
        active: state.state === 'running',
        scriptRunId,
        state: state.state,
        status: state.state,
        logFile: state.result?.logFile || null,
        stdout: state.stdout || '',
        stderr: state.stderr || '',
        result: state.result || null,
        message: state.message || ''
      });
    }
    return true;
  }

  // --- Platform Session Switch (per-user) ---
  if (request.method === 'POST' && url.pathname === '/api/session') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const body = await readJsonBody(request);
    if (typeof body?.token !== 'string' || !body.token.trim() || body.token.length > 4096 || /[\r\n]/.test(body.token)) {
      throw new Error('会话令牌无效');
    }
    const token = body.token.trim();
    // 验证 Token 可用（试调 listDevices）
    await new YunmomoClient({ token, timeoutMs: 12000 }).listDevices({ current: 1, size: 1 });
    // 管理员须先确认系统空闲，不能出现“返回失败但数据库 Token 已更新”。
    // 普通用户仍只更新本人独立的会话。
    if (user.role === 'admin') {
      if (busyDevices.size || busyAccountScripts.size) throw new Error('设备或账号正在执行脚本，请等待结束后切换会话');
      const brainMgr = getSharedBrainManager();
      if (defaultArbiter.locks.size || [...activeRuns.values()].some(run => ['running','cancelling'].includes(run.status)) || brainMgr?.actors.size) {
        throw new Error('自动化会话尚未停止，不能切换账号');
      }
      for (const bridge of manualBridges) await bridge.closeAll();
      await resetSharedClient();
      await resetSharedBrainManager();
      await persistToken(token);
      authService.setUserPlatformToken(user.id, token);
      setRuntimeToken(token);
      clearDeviceCache();
    } else {
      authService.setUserPlatformToken(user.id, token);
    }
    json(response, 200, { ok: true, tokenConfigured: true, storage: 'user-db' });
    return true;
  }
  // 组合/批量任务由 Windows 服务器继续派发后续步骤，不依赖浏览器保持连接。
  if (request.method === 'POST' && url.pathname === '/api/workflows/start') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    json(response, 202, launchWorkflow(await readJsonBody(request), user));
    return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/workflows/status') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    json(response, 200, getWorkflowStatus(url.searchParams.get('workflowRunId'), user));
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/workflows/stop') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const body = await readJsonBody(request);
    json(response, 200, await stopWorkflow(body?.workflowRunId, user));
    return true;
  }

  // 网页采用后台任务 + 状态查询，HTTP/FRP 连接不承担任务生命周期。
  if (request.method === 'GET' && url.pathname === '/api/execute/status') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const result = await getWebScriptState(String(url.searchParams.get('scriptRunId') || ''), user);
    json(response, result.state === 'not_found' ? 404 : 200, result);
    return true;
  }
  if (request.method === 'POST' && url.pathname === '/api/execute/start') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const body = await readJsonBody(request);
    if (user.role !== 'admin' && body?.deviceId && !await authService.ensureDeviceAccess(user, body.deviceId)) {
      json(response, 403, { ok: false, error: '无权操作此设备或该设备已到期回收' });
      return true;
    }
    json(response, 202, launchWebScript(body, user));
    return true;
  }

  // --- Script Execution (兼容原有同步接口) ---
  if (request.method === 'POST' && url.pathname === '/api/execute') {
    const body = await readJsonBody(request);
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    if (user.role !== 'admin' && body?.deviceId && !await authService.ensureDeviceAccess(user, body.deviceId)) {
      json(response, 403, { ok: false, error: '无权操作此设备或该设备已到期回收' });
      return true;
    }
    const result = await executeScript(body, user);
    clearDeviceCache();
    json(response, 200, result);
    return true;
  }

  // --- Script Stop ---
  if (request.method === 'POST' && (url.pathname === '/api/execute/stop' || url.pathname === '/api/scripts/stop')) {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const result = await stopActiveScript(await readJsonBody(request), user);
    if (result && result.forbidden) { json(response, 403, { ok: false, error: result.message }); return true; }
    json(response, 200, result);
    return true;
  }

  return false;
}

module.exports = {
  handleExecuteRoutes
};
