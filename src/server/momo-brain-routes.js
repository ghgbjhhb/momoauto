'use strict';

/**
 * MOMO 调度中枢 HTTP 路由网关 (Brain HTTP Routes)
 *
 * 遵循中枢执行计划第 16 节与 B7 门禁：
 * 1. GET /api/momo-brain/config: 返回当前脱敏配置与 revision。
 * 2. POST /api/momo-brain/config: 乐观并发校验 expectedRevision，保存中枢调度配置。
 * 3. POST /api/momo-brain/start: 启动指定云机的后台持久化调度 Actor，返回当前状态。
 * 4. POST /api/momo-brain/pause: 幂等安全请求暂停，让出设备。
 * 5. POST /api/momo-brain/resume: 恢复自动巡检与任务执行。
 * 6. POST /api/momo-brain/stop: 优雅停止 Actor，释放占用。
 * 7. GET /api/momo-brain/status: 轮询查询设备会话、任务阶段、页面与隔离状态。
 * 8. GET /api/momo-brain/events: 查询近期脱敏调度事件。
 */

const { getEffectiveBrainConfig, saveBrainConfig } = require('../brain/config');
const { getDefaultBrainManager } = require('../brain/manager');

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });
  res.end(JSON.stringify(data));
}

function handleMomoBrainRoutes(req, res, urlObj, bodyJson = null, brainManager = null, user = null) {
  const pathname = urlObj.pathname;
  const method = req.method.toUpperCase();

  // 1. GET /api/momo-brain/config
  if (pathname === '/api/momo-brain/config' && method === 'GET') {
    const deviceId = urlObj.searchParams.get('deviceId');
    const config = getEffectiveBrainConfig(deviceId);
    sendJson(res, 200, { ok: true, config });
    return true;
  }

  // 2. POST /api/momo-brain/config
  if (pathname === '/api/momo-brain/config' && method === 'POST') {
    const { expectedRevision, ...updates } = bodyJson || {};
    try {
      const saved = (brainManager || getDefaultBrainManager()).updateConfigAndNotify(updates, expectedRevision);
      sendJson(res, 200, { ok: true, config: saved });
    } catch (err) {
      if (err.code === 'REVISION_CONFLICT') {
        sendJson(res, 409, { ok: false, error: { code: 'REVISION_CONFLICT', message: err.message } });
      } else {
        sendJson(res, 400, { ok: false, error: { code: 'INVALID_CONFIG', message: err.message } });
      }
    }
    return true;
  }

  if (!pathname.startsWith('/api/momo-brain/')) return false;
  brainManager ||= getDefaultBrainManager();

  // 3. POST /api/momo-brain/start
  if (pathname === '/api/momo-brain/start' && method === 'POST') {
    const deviceId = bodyJson?.deviceId || urlObj.searchParams.get('deviceId') || process.env.YUNMOMO_DEVICE_ID;
    if (!deviceId) {
      sendJson(res, 400, { ok: false, error: { code: 'DEVICE_REQUIRED', message: 'deviceId is required' } });
      return true;
    }

    (async () => {
      try {
        const { getAuthService } = require('./auth/service');
        const accessToken = user?.role === 'admin' ? '' : getAuthService().getDeviceAccessToken(user, deviceId);
        const status = await brainManager.startDevice(deviceId, {
          ...bodyJson, ownerUserId: user?.id, accessToken
        });
        sendJson(res, 200, { ok: true, status });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: { code: 'START_FAILED', message: err.message } });
      }
    })();
    return true;
  }

  // 4. POST /api/momo-brain/pause
  if (pathname === '/api/momo-brain/pause' && method === 'POST') {
    const deviceId = bodyJson?.deviceId || urlObj.searchParams.get('deviceId');
    if (!deviceId) {
      sendJson(res, 400, { ok: false, error: { code: 'DEVICE_REQUIRED', message: 'deviceId is required' } });
      return true;
    }

    (async () => {
      try {
        const status = await brainManager.pauseDevice(deviceId);
        sendJson(res, 200, { ok: true, status });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: { code: 'PAUSE_FAILED', message: err.message } });
      }
    })();
    return true;
  }

  // 5. POST /api/momo-brain/resume
  if (pathname === '/api/momo-brain/resume' && method === 'POST') {
    const deviceId = bodyJson?.deviceId || urlObj.searchParams.get('deviceId');
    if (!deviceId) {
      sendJson(res, 400, { ok: false, error: { code: 'DEVICE_REQUIRED', message: 'deviceId is required' } });
      return true;
    }

    (async () => {
      try {
        const { getAuthService } = require('./auth/service');
        const accessToken = user?.role === 'admin' ? '' : getAuthService().getDeviceAccessToken(user, deviceId);
        const status = await brainManager.resumeDevice(deviceId, {
          ownerUserId: user?.id, accessToken
        });
        sendJson(res, 200, { ok: true, status });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: { code: 'RESUME_FAILED', message: err.message } });
      }
    })();
    return true;
  }

  // 6. POST /api/momo-brain/stop
  if (pathname === '/api/momo-brain/stop' && method === 'POST') {
    const deviceId = bodyJson?.deviceId || urlObj.searchParams.get('deviceId');
    if (!deviceId) {
      sendJson(res, 400, { ok: false, error: { code: 'DEVICE_REQUIRED', message: 'deviceId is required' } });
      return true;
    }

    (async () => {
      try {
        const status = await brainManager.stopDevice(deviceId, bodyJson?.reason || 'API requested stop');
        sendJson(res, 200, { ok: true, status });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: { code: 'STOP_FAILED', message: err.message } });
      }
    })();
    return true;
  }

  // 7. GET /api/momo-brain/status
  if (pathname === '/api/momo-brain/status' && method === 'GET') {
    const deviceId = urlObj.searchParams.get('deviceId');
    if (deviceId) {
      const status = brainManager.getStatus(deviceId);
      sendJson(res, 200, { ok: true, status });
    } else {
      const statuses = brainManager.getAllStatuses();
      sendJson(res, 200, { ok: true, statuses });
    }
    return true;
  }

  // 8. GET /api/momo-brain/events
  if (pathname === '/api/momo-brain/events' && method === 'GET') {
    const deviceId = urlObj.searchParams.get('deviceId');
    if (!deviceId) {
      sendJson(res, 400, { ok: false, error: { code: 'DEVICE_REQUIRED', message: 'deviceId is required' } });
      return true;
    }
    const limit = Math.min(Number(urlObj.searchParams.get('limit') || 50), 200);
    const events = brainManager.store.getRecentEvents(deviceId, limit);
    sendJson(res, 200, { ok: true, events });
    return true;
  }

  return false;
}

module.exports = {
  handleMomoBrainRoutes
};
