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
const { getSanitizedSettings, saveSettings, getEffectiveConfig } = require('../ai/config');
const { DeepSeekProvider } = require('../ai/provider');
const { runMomoAiReplyOnce } = require('../workflows/momo-ai-reply');
const { YunmomoClient } = require('../index');

// 内存中活跃任务记录 (In-Memory Runs Store)
const activeRuns = new Map();

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });
  res.end(JSON.stringify(data));
}

function handleAiReplyRoutes(req, res, urlObj, bodyJson = null, clientInstance = null) {
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

  // 1. GET /api/ai-reply/settings
  if (pathname === '/api/ai-reply/settings' && method === 'GET') {
    const deviceId = urlObj.searchParams.get('deviceId');
    const settings = getSanitizedSettings(deviceId);
    sendJson(res, 200, { ok: true, settings });
    return true;
  }

  // 2. POST /api/ai-reply/settings
  if (pathname === '/api/ai-reply/settings' && method === 'POST') {
    const { expectedRevision, ...updates } = bodyJson || {};
    try {
      const saved = saveSettings(updates, expectedRevision);
      const sanitized = getSanitizedSettings();
      sendJson(res, 200, { ok: true, settings: sanitized });
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
    const configSnapshot = getEffectiveConfig(bodyJson?.deviceId);
    const apiKey = bodyJson?.apiKey || configSnapshot.apiKey;
    const endpoint = bodyJson?.endpoint || configSnapshot.endpoint;
    const model = bodyJson?.model || configSnapshot.model;

    const testConfig = {
      ...configSnapshot,
      apiKey,
      endpoint,
      model
    };

    (async () => {
      try {
        const testRes = await DeepSeekProvider.chat([
          { role: 'user', content: '测试API连接，请回复：连接成功' }
        ], testConfig);
        sendJson(res, 200, {
          ok: true,
          message: 'DeepSeek API connection successful',
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
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      abortController: new AbortController(),
      result: null,
      error: null
    };

    activeRuns.set(runId, runRecord);
    const timingStarted = require('node:perf_hooks').performance.now();

    const client = clientInstance || new YunmomoClient();

    // 异步执行，不阻塞当前 HTTP 响应
    (async () => {
      try {
        const resObj = await runMomoAiReplyOnce(client, deviceId, {
          mode,
          runId,
          contactName,
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
      }
    })();

    sendJson(res, 202, { ok: true, runId, mode, status: 'running' });
    return true;
  }

  // 5. GET /api/ai-reply/runs/:runId
  if (pathname.startsWith('/api/ai-reply/runs/') && method === 'GET') {
    const parts = pathname.split('/');
    const runId = parts[4];
    const runRecord = activeRuns.get(runId);

    if (!runRecord) {
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
    const runRecord = activeRuns.get(runId);

    if (!runRecord) {
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

module.exports = {
  handleAiReplyRoutes,
  activeRuns
};
