'use strict';

const { json, readJsonBody } = require('../http');
const { getAuthService } = require('../auth/service');
const authGuard = require('../auth/guard');
const { listDevices } = require('../context');

const authService = getAuthService();

async function handleAuthRoutes(ctx, request, response, url) {
  const { user } = ctx;
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
    if (waitSeconds > 0) { rejectBruteForce(waitSeconds); return true; }
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
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJsonBody(request);
    const waitSeconds = authGuard.inspect(body?.email, authClientIp);
    if (waitSeconds > 0) { rejectBruteForce(waitSeconds); return true; }
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
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/change-password') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const body = await readJsonBody(request);
    const waitSeconds = authGuard.inspect(user.email, authClientIp);
    if (waitSeconds > 0) { rejectBruteForce(waitSeconds); return true; }
    try {
      await authService.changePassword(user.id, body?.currentPassword, body?.newPassword);
      authGuard.registerSuccess(user.email);
      json(response, 200, { ok: true, message: '密码已更新，请重新登录' }, {
        'Set-Cookie': 'ym_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
      });
    } catch (err) {
      authGuard.registerFailure(user.email, authClientIp);
      json(response, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    json(response, 200, { ok: true }, {
      'Set-Cookie': 'ym_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    });
    return true;
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
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/user/devices') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const master = await listDevices();
    const devices = authService.getUserDevices(user.id, master);
    json(response, 200, { ok: true, devices });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/user/assets') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const assets = authService.db.getUserAssets(user.id);
    json(response, 200, { ok: true, assets });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/user/redeem') {
    if (!user) { json(response, 401, { ok: false, error: '请先登录' }); return true; }
    const waitSeconds = authGuard.inspect(user.email, authClientIp, 'redeem');
    if (waitSeconds > 0) { rejectBruteForce(waitSeconds); return true; }
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
    return true;
  }

  return false;
}

module.exports = { handleAuthRoutes };
