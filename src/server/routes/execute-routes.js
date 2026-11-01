'use strict';

const { json, readJsonBody, redact } = require('../http');
const { getAuthService } = require('../auth/service');
const { YunmomoClient } = require('../../index');
const { handleMomoBrainRoutes } = require('../momo-brain-routes');
const { handleAiReplyRoutes, activeRuns } = require('../ai-reply-routes');
const { defaultArbiter } = require('../device-arbiter');
const { executeScript, stopActiveScript } = require('../script-runner');
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
    if (targetDevice && !authService.canAccessDevice(user, targetDevice)) {
      json(response, 403, { ok: false, error: '无该设备的访问权限' });
      return true;
    }

    const isGlobalWrite = request.method === 'POST' && (
      url.pathname === '/api/momo-brain/config'
      || url.pathname === '/api/ai-reply/settings'
      || url.pathname === '/api/ai-reply/test'
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
      if (runRecord && !authService.canAccessDevice(user, runRecord.deviceId)) {
        json(response, 403, { ok: false, error: '无该任务的访问权限' });
        return true;
      }
    }

    if (url.pathname.startsWith('/api/momo-brain/')) {
      const handled = handleMomoBrainRoutes(request, response, url, bodyJson, brainManager());
      if (handled) return true;
    } else {
      const handled = handleAiReplyRoutes(request, response, url, bodyJson, client());
      if (handled) return true;
    }
  }

  // --- Execution Output ---
  if (request.method === 'GET' && url.pathname === '/api/execute/output') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const scriptRunId = String(url.searchParams.get('scriptRunId') || '');
    const run = activeScriptRuns.get(scriptRunId);
    if (run && user.role !== 'admin' && run.ownerUserId && run.ownerUserId !== user.id) {
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
    // 每用户独立保存
    authService.setUserPlatformToken(user.id, token);
    // admin 额外同步到全局（保持向后兼容：全局 client/脚本 fallback 用）
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
      setRuntimeToken(token);
      clearDeviceCache();
    }
    json(response, 200, { ok: true, tokenConfigured: true, storage: 'user-db' });
    return true;
  }
  // --- Script Execution ---
  if (request.method === 'POST' && url.pathname === '/api/execute') {
    const body = await readJsonBody(request);
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    if (user.role !== 'admin' && body?.deviceId && !authService.canAccessDevice(user, body.deviceId)) {
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
