'use strict';

/**
 * 4318 本地控制台 AI 回复路由网关 (AI Reply HTTP Routes)
 *
 * 遵循计划第 12 节与 P5 门禁：
 * 1. GET /api/ai-reply/settings: 返回脱敏配置、有效 revision，禁止明文返回 API Key。
 * 2. POST /api/ai-reply/settings: 校验并保存，校验 expectedRevision 避免并发覆盖。
 * 3. POST /api/ai-reply/test: 纯 API 连通性测试（使用固定无副作用的测试 Prompt），不操作手机。
 * 4. POST /api/ai-reply/run: 创建异步有界任务 (draft/execute)，返回 202 Accepted 与 runId。
 * 5. GET /api/ai-reply/runs/:runId: 轮询查询任务阶段、联系人结果、错误与耗时。
 * 6. POST /api/ai-reply/runs/:runId/cancel: 幂等请求取消。
 */

const { randomUUID } = require('node:crypto');
const { getSanitizedSettings, saveSettings, saveUserSettings, getEffectiveConfig } = require('../ai/config');
const { DeepSeekProvider } = require('../ai/provider');
const { runMomoAiReplyOnce } = require('../workflows/momo-ai-reply');
const { YunmomoClient } = require('../index');

// 内存中活跃任务记录 (In-Memory Runs Store)
const activeRuns = new Map();
// 仅清理已结算的结果；running/cancelling 即使超时也不能误删。
const FINISHED_RUN_TTL_MS = 30 * 60 * 1000;
const MAX_FINISHED_RUNS = 256;
function pruneFinishedAiRuns(now = Date.now()) {
  const retained = [];
  for (const [id, run] of activeRuns) {
    if (!run.finishedAt) continue;
    if (Date.parse(run.finishedAt) + FINISHED_RUN_TTL_MS <= now) {
      activeRuns.delete(id);
    } else {
      retained.push(id);
    }
  }
  for (const id of retained.slice(0, Math.max(0, retained.length - MAX_FINISHED_RUNS))) {
    activeRuns.delete(id);
  }
}
setInterval(pruneFinishedAiRuns, 60 * 1000).unref();

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });
  res.end(JSON.stringify(data));
}

function handleAiReplyRoutes(req, res, urlObj, bodyJson = null, clientInstance = null, user = null) {
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

  // 1. GET /api/ai-reply/settings (用户侧读取：仅暴露系统提示词、话术配置及可用状态，不暴露密钥与后端配置)
  if (pathname === '/api/ai-reply/settings' && method === 'GET') {
    const deviceId = urlObj.searchParams.get('deviceId');
    const settings = getSanitizedSettings(deviceId, user?.role === 'admin' ? null : user?.id);
    sendJson(res, 200, {
      ok: true,
      settings: {
        systemPrompt: settings.systemPrompt,
        revision: settings.revision,
        ready: Boolean(settings.hasApiKey),
        model: settings.model,
        handoffEnabled: settings.handoffEnabled === true,
        handoffSegments: Array.isArray(settings.handoffSegments) ? settings.handoffSegments : []
      }
    });
    return true;
  }

  // 2. POST /api/ai-reply/settings (用户侧保存：允许系统提示词与联系方式话术配置，禁止修改全局 API Key 与接口)
  if (pathname === '/api/ai-reply/settings' && method === 'POST') {
    const { expectedRevision, systemPrompt, handoffEnabled, handoffSegments } = bodyJson || {};
    try {
      const updates = {};
      if (typeof systemPrompt === 'string') {
        updates.systemPrompt = systemPrompt.trim();
      }
      if (handoffEnabled !== undefined) {
        updates.handoffEnabled = handoffEnabled === true || handoffEnabled === 'true' || handoffEnabled === 'on';
      }
      if (handoffSegments !== undefined) {
        // 接受数组或空行分段文本，归一化由 saveSettings/normalizeSettings 统一处理
        updates.handoffSegments = handoffSegments;
      }
      const saved = user?.role === 'admin'
        ? saveSettings(updates, expectedRevision)
        : saveUserSettings(user.id, updates, expectedRevision);
      sendJson(res, 200, {
        ok: true,
        settings: {
          systemPrompt: saved.systemPrompt,
          revision: saved.revision,
          ready: Boolean(saved.apiKey && saved.apiKey.trim()),
          handoffEnabled: saved.handoffEnabled === true,
          handoffSegments: Array.isArray(saved.handoffSegments) ? saved.handoffSegments : []
        }
      });
    } catch (err) {
      if (err.code === 'REVISION_CONFLICT') {
        sendJson(res, 409, { ok: false, error: { code: 'REVISION_CONFLICT', message: err.message } });
      } else {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_CONFIG', message: err.message } });
      }
    }
    return true;
  }

  // 3. POST /api/ai-reply/test
  if (pathname === '/api/ai-reply/test' && method === 'POST') {
    const configSnapshot = getEffectiveConfig(bodyJson?.deviceId, user?.role === 'admin' ? null : user?.id);
    const testConfig = {
      ...configSnapshot,
      apiKey: configSnapshot.apiKey,
      endpoint: configSnapshot.endpoint,
      model: configSnapshot.model
    };

    (async () => {
      try {
        const testRes = await DeepSeekProvider.chat([
          { role: 'user', content: '测试API连接，请回复：连接成功' }
        ], testConfig);
        sendJson(res, 200, {
          ok: true,
          message: 'AI API 连接测试成功',
          response: testRes.text,
          model: testRes.model,
          requestId: testRes.requestId
        });
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          error: {
            code: err.code || 'API_TEST_FAILED',
            message: err.message,
            status: err.status || null
          }
        });
      }
    })();
    return true;
  }

  // 4. POST /api/ai-reply/run
  if (pathname === '/api/ai-reply/run' && method === 'POST') {
    const deviceId = bodyJson?.deviceId || process.env.YUNMOMO_DEVICE_ID;
    if (!deviceId) {
      sendJson(res, 400, { ok: false, error: { code: 'DEVICE_REQUIRED', message: 'deviceId is required to start an AI reply run' } });
      return true;
    }

    const runId = 'run_' + randomUUID().replace(/-/g, '');
    const mode = bodyJson?.mode ?? 'execute'; // draft | execute
    const contactName = typeof bodyJson?.contactName === 'string' ? bodyJson.contactName.trim() : '';
    if (!['draft','execute'].includes(mode) || !contactName) {
      sendJson(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'mode must be draft or execute and contactName is required' } }); return true;
    }

    const runRecord = {
      runId,
      deviceId,
      mode,
      contactName,
      ownerUserId: user?.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      abortController: new AbortController(),
      result: null,
      error: null
    };

    pruneFinishedAiRuns();
    activeRuns.set(runId, runRecord);
    const timingStarted = require('node:perf_hooks').performance.now();

    const { getAuthService } = require('./auth/service');
    const accessToken = user?.role === 'admin' ? '' : getAuthService().getDeviceAccessToken(user, deviceId);
    const client = accessToken ? new YunmomoClient({ token: accessToken }) : clientInstance;

    // 异步执行，不阻塞当前 HTTP 响应
    runRecord.done = (async () => {
      try {
        const resObj = await runMomoAiReplyOnce(client, deviceId, {
          mode,
          runId,
          contactName,
          userId: user?.id,
          signal: runRecord.abortController.signal
        });
        runRecord.status = runRecord.abortController.signal.aborted ? 'cancelled' : resObj.status;
        runRecord.result = resObj.data;
        runRecord.updatedAt = new Date().toISOString();
      } catch (err) {
        runRecord.status = runRecord.abortController.signal.aborted ? 'cancelled' : 'failed';
        runRecord.error = { code: err.code || 'EXECUTION_FAILED', message: err.message };
        runRecord.updatedAt = new Date().toISOString();
      } finally {
        runRecord.finishedAt = new Date().toISOString();
        runRecord.durationMs = Math.round((require('node:perf_hooks').performance.now() - timingStarted) * 100) / 100;
        pruneFinishedAiRuns();
      }
    })();

    sendJson(res, 202, { ok: true, runId, mode, status: 'running' });
    return true;
  }

  // 5. GET /api/ai-reply/runs/:runId
  if (pathname.startsWith('/api/ai-reply/runs/') && method === 'GET') {
    const parts = pathname.split('/');
    const runId = parts[4];
    pruneFinishedAiRuns();
    const runRecord = activeRuns.get(runId);

    if (!runRecord || (user?.role !== 'admin' && runRecord.ownerUserId !== user?.id)) {
      sendJson(res, 404, { ok: false, error: { code: 'RUN_NOT_FOUND', message: `Run ${runId} not found` } });
      return true;
    }

    sendJson(res, 200, {
      ok: true,
      runId: runRecord.runId,
      deviceId: runRecord.deviceId,
      mode: runRecord.mode,
      status: runRecord.status,
      startedAt: runRecord.startedAt,
      updatedAt: runRecord.updatedAt,
      finishedAt: runRecord.finishedAt || null,
      durationMs: runRecord.durationMs ?? null,
      result: runRecord.result,
      error: runRecord.error
    });
    return true;
  }

  // 6. POST /api/ai-reply/runs/:runId/cancel
  if (pathname.startsWith('/api/ai-reply/runs/') && pathname.endsWith('/cancel') && method === 'POST') {
    const parts = pathname.split('/');
    const runId = parts[4];
    pruneFinishedAiRuns();
    const runRecord = activeRuns.get(runId);

    if (!runRecord || (user?.role !== 'admin' && runRecord.ownerUserId !== user?.id)) {
      sendJson(res, 404, { ok: false, error: { code: 'RUN_NOT_FOUND', message: `Run ${runId} not found` } });
      return true;
    }

    if (runRecord.status === 'running') {
      runRecord.abortController.abort(new Error('User cancelled run'));
      runRecord.status = 'cancelling';
      runRecord.updatedAt = new Date().toISOString();
    }

    sendJson(res, 200, { ok: true, runId, status: runRecord.status });
    return true;
  }

  return false;
}

// 权限撤销属于任务生命周期操作：等待运行结束，确认工作流已释放设备锁后才允许回收完成。
async function revokeAiReplyRuns(userId, deviceId = null) {
  const runs = [...activeRuns.values()].filter(run =>
    run.ownerUserId === userId && (!deviceId || run.deviceId === deviceId) &&
    (run.status === 'running' || run.status === 'cancelling'));
  for (const run of runs) {
    run.status = 'cancelling';
    run.updatedAt = new Date().toISOString();
    run.abortController.abort(new Error('Device access revoked'));
  }
  await Promise.all(runs.map(run => run.done));
}

module.exports = {
  handleAiReplyRoutes,
  revokeAiReplyRuns,
  activeRuns
};
