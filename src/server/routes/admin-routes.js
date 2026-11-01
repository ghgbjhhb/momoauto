'use strict';

const { json, readJsonBody } = require('../http');
const { getAuthService } = require('../auth/service');
const { getSmsService } = require('../sms/service');
const urlGuard = require('../../automation/url-guard');
const { listDevices, revokeDeviceAccess, revokeUserAccess } = require('../context');

const authService = getAuthService();

function requireAdmin(user, response) {
  if (!user || user.role !== 'admin') {
    json(response, 403, { ok: false, error: '无管理员访问权限' });
    return false;
  }
  return true;
}

async function handleAdminRoutes(ctx, request, response, url) {
  const { user } = ctx;

  if (request.method === 'GET' && url.pathname === '/api/admin/users') {
    if (!requireAdmin(user, response)) return true;
    json(response, 200, { ok: true, users: authService.db.listUsers() });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/users/status') {
    if (!requireAdmin(user, response)) return true;
    try {
      const body = await readJsonBody(request);
      if (!['active', 'banned'].includes(body?.status)) throw new Error('无效的账号状态');
      const target = authService.db.getUserById(body?.userId);
      if (!target) throw new Error('用户不存在');
      if (target.role === 'admin') throw new Error('管理员账号不可通过该接口封禁');
      authService.db.updateUserStatus(target.id, body.status);
      if (body.status === 'banned') {
        try {
          await revokeUserAccess(target.id);
        } catch (error) {
          console.error('[Admin] 封禁已生效，但会话回收失败:', error);
          json(response, 503, { ok: false, statusApplied: true,
            error: '账号已封禁，但部分运行任务未成功停止，请检查设备隔离状态' });
          return true;
        }
      }
      json(response, 200, { ok: true });
    } catch (err) {
      json(response, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/cards') {
    if (!requireAdmin(user, response)) return true;
    const status = url.searchParams.get('status') || '';
    const batchTag = url.searchParams.get('batchTag') || '';
    const type = url.searchParams.get('type') || '';
    const cards = authService.listCards({ status, batchTag, type });
    json(response, 200, { ok: true, cards });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/cards/generate') {
    if (!requireAdmin(user, response)) return true;
    try {
      const body = await readJsonBody(request);
      const cards = authService.generateCards(body || {});
      json(response, 200, { ok: true, cards });
    } catch (err) {
      json(response, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/cards/revoke') {
    if (!requireAdmin(user, response)) return true;
    try {
      const body = await readJsonBody(request);
      authService.revokeCard(body?.cardId);
      json(response, 200, { ok: true });
    } catch (err) {
      json(response, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/pool') {
    if (!requireAdmin(user, response)) return true;
    const master = await listDevices();
    const allocations = authService.db.getAllActiveAllocations();
    const allocMap = new Map(allocations.map(a => [a.device_id, a]));
    const pool = master.map(dev => {
      const alloc = allocMap.get(dev.deviceId);
      return {
        ...dev,
        allocated: Boolean(alloc),
        allocationId: alloc?.id || null,
        userEmail: alloc?.user_email || null,
        expireAt: alloc?.expire_at || null,
        remainingMs: alloc ? Math.max(0, alloc.expire_at - Date.now()) : null
      };
    });
    json(response, 200, {
      ok: true,
      total: master.length,
      allocatedCount: allocations.length,
      idleCount: Math.max(0, master.length - allocations.length),
      pool
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/devices/recycle') {
    if (!requireAdmin(user, response)) return true;
    const body = await readJsonBody(request);
    const allocation = authService.db.getAllocationById(body?.allocationId);
    if (!allocation) { json(response, 404, { ok: false, error: '设备租赁记录不存在' }); return true; }
    authService.db.recycleAllocationManually(allocation.id);
    try {
      await revokeDeviceAccess(allocation.device_id, allocation.user_id);
    } catch (error) {
      console.error('[Admin] 设备权益已回收，但会话关闭失败:', error);
      json(response, 503, { ok: false, statusApplied: true,
        error: '设备权益已回收，但仍有运行任务未成功停止，请检查设备隔离状态' });
      return true;
    }
    json(response, 200, { ok: true });
    return true;
  }

  // --- 管理员 AI 设置与多供应商管理 API ---
  if (request.method === 'GET' && url.pathname === '/api/admin/ai-settings') {
    if (!requireAdmin(user, response)) return true;
    const { getEffectiveConfig, listProviders, loadSettings, maskApiKey } = require('../../ai/config');
    const cfg = getEffectiveConfig();
    const settings = loadSettings();
    json(response, 200, {
      ok: true,
      activeProviderId: settings.activeProviderId,
      providers: listProviders(),
      systemPrompt: cfg.systemPrompt || '',
      settings: {
        activeProviderId: settings.activeProviderId,
        provider: cfg.provider || 'openai',
        endpoint: cfg.endpoint || 'https://api.deepseek.com',
        model: cfg.model || 'deepseek-chat',
        apiKeyMasked: maskApiKey(cfg.apiKey),
        hasApiKey: Boolean(cfg.apiKey && cfg.apiKey.trim())
      }
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/ai-providers') {
    if (!requireAdmin(user, response)) return true;
    try {
      const body = await readJsonBody(request);
      const { saveProvider, listProviders } = require('../../ai/config');
      saveProvider(body);
      json(response, 200, { ok: true, providers: listProviders() });
    } catch (err) {
      json(response, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname.startsWith('/api/admin/ai-providers/') && url.pathname.endsWith('/set-default')) {
    if (!requireAdmin(user, response)) return true;
    try {
      const parts = url.pathname.split('/');
      const id = parts[4];
      const { setDefaultProvider, listProviders } = require('../../ai/config');
      setDefaultProvider(id);
      json(response, 200, { ok: true, providers: listProviders() });
    } catch (err) {
      json(response, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (request.method === 'DELETE' && url.pathname.startsWith('/api/admin/ai-providers/')) {
    if (!requireAdmin(user, response)) return true;
    try {
      const parts = url.pathname.split('/');
      const id = parts[4];
      const { deleteProvider, listProviders } = require('../../ai/config');
      deleteProvider(id);
      json(response, 200, { ok: true, providers: listProviders() });
    } catch (err) {
      json(response, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/ai-settings') {
    if (!requireAdmin(user, response)) return true;
    try {
      const body = await readJsonBody(request);
      const { saveSettings, getSanitizedSettings, listProviders } = require('../../ai/config');
      const updates = {};
      if (body.systemPrompt !== undefined) updates.systemPrompt = String(body.systemPrompt).trim();
      saveSettings(updates, body.expectedRevision);
      json(response, 200, { ok: true, settings: getSanitizedSettings(), providers: listProviders() });
    } catch (err) {
      json(response, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/ai-settings/test') {
    if (!requireAdmin(user, response)) return true;
    try {
      const body = await readJsonBody(request);
      const { getEffectiveConfig, loadSettings } = require('../../ai/config');
      const { DeepSeekProvider } = require('../../ai/provider');
      let testConfig;
      if (body?.id) {
        const settings = loadSettings();
        const found = (settings.providers || []).find(p => p.id === body.id);
        if (!found) throw new Error('供应商不存在');
        testConfig = {
          provider: found.provider,
          endpoint: found.endpoint,
          apiKey: found.apiKey,
          model: found.model,
          timeoutMs: found.timeoutMs || 15000
        };
      } else {
        const current = getEffectiveConfig();
        let apiKey = '';
        if (body?.apiKey && !body.apiKey.includes('***')) {
          apiKey = body.apiKey.trim();
        } else if (body?.providerId) {
          const settings = loadSettings();
          const found = (settings.providers || []).find(p => p.id === body.providerId);
          apiKey = found ? found.apiKey : current.apiKey;
        } else {
          apiKey = current.apiKey;
        }
        testConfig = {
          provider: body?.provider || current.provider || 'openai',
          endpoint: body?.endpoint || current.endpoint || 'https://api.deepseek.com',
          apiKey,
          model: body?.model || current.model || 'deepseek-chat',
          temperature: 0.7,
          maxTokens: 50,
          timeoutMs: 15000
        };
      }
      if (!testConfig.apiKey) {
        throw new Error('未配置 API Key，无法测试连接');
      }
      await urlGuard.assertSafeOutboundUrl(testConfig.endpoint, {
        allowLoopback: true,
        allowPrivate: String(process.env.YUNMOMO_AI_ALLOW_PRIVATE || '').trim() === '1'
      });
      const testRes = await DeepSeekProvider.chat([
        { role: 'user', content: '测试API连接，请回复：连接成功' }
      ], testConfig);
      json(response, 200, {
        ok: true,
        message: '连接测试成功',
        reply: testRes.text,
        model: testRes.model,
        requestId: testRes.requestId
      });
    } catch (err) {
      json(response, 200, {
        ok: false,
        error: err.message || '连接测试失败',
        code: err.code || null
      });
    }
    return true;
  }

  // --- 接码平台管理 (玄武 OpenAPI) ---
  if (url.pathname.startsWith('/api/admin/sms/')) {
    if (!requireAdmin(user, response)) return true;
    const smsService = getSmsService();

    try {
      if (request.method === 'GET' && url.pathname === '/api/admin/sms/config') {
        json(response, 200, { ok: true, config: smsService.getConfig() });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/sms/config') {
        const body = await readJsonBody(request);
        const config = smsService.saveConfig(body);
        json(response, 200, { ok: true, config });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/sms/test') {
        const body = await readJsonBody(request);
        const result = await smsService.testConnection(body);
        json(response, 200, result);
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/sms/projects') {
        const page = url.searchParams.get('page') || 1;
        const limit = url.searchParams.get('limit') || 100;
        const data = await smsService.listProjects({ page, limit });
        json(response, 200, { ok: true, ...data });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/sms/phone/get') {
        const body = await readJsonBody(request);
        const result = await smsService.grabPhone(body);
        json(response, 200, result);
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/sms/code/get') {
        const body = await readJsonBody(request);
        const result = await smsService.querySmsCode(body);
        json(response, 200, result);
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/sms/record/status') {
        const body = await readJsonBody(request);
        smsService.markRecordStatus(body.recordId, body.status, body.message);
        json(response, 200, { ok: true });
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/sms/records') {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
        const offset = parseInt(url.searchParams.get('offset'), 10) || 0;
        const status = url.searchParams.get('status') || '';
        let search = (url.searchParams.get('search') || '').trim();
        if (search && user && user.email && search.toLowerCase() === user.email.toLowerCase()) {
          search = '';
        }
        const data = smsService.listRecords({ limit, offset, status, search });
        const stats = smsService.getStats();
        json(response, 200, { ok: true, ...data, stats });
        return true;
      }

      if (request.method === 'GET' && url.pathname === '/api/admin/sms/logs') {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 100;
        const offset = parseInt(url.searchParams.get('offset'), 10) || 0;
        const status = url.searchParams.get('status') || '';
        let search = (url.searchParams.get('search') || '').trim();
        if (search && user && user.email && search.toLowerCase() === user.email.toLowerCase()) {
          search = '';
        }
        const data = smsService.listCallLogs({ limit, offset, status, search });
        json(response, 200, { ok: true, ...data });
        return true;
      }

      if (request.method === 'DELETE' && url.pathname === '/api/admin/sms/logs') {
        smsService.clearCallLogs();
        json(response, 200, { ok: true });
        return true;
      }

      if (request.method === 'DELETE' && url.pathname === '/api/admin/sms/records') {
        smsService.clearRecords();
        json(response, 200, { ok: true });
        return true;
      }
    } catch (err) {
      json(response, 400, { ok: false, error: err.message, code: err.code || null });
      return true;
    }
  }

  // --- 脚本显隐控制与自定义脚本组合 (Admin Only) ---
  if (url.pathname.startsWith('/api/admin/scripts/')) {
    if (!requireAdmin(user, response)) return true;
    const db = authService.db;

    try {
      if (request.method === 'GET' && url.pathname === '/api/admin/scripts/config') {
        json(response, 200, {
          ok: true,
          visibility: db.getScriptVisibility(),
          bundles: db.getScriptBundles()
        });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/scripts/visibility') {
        const body = await readJsonBody(request);
        const updated = db.setScriptVisibility(body);
        json(response, 200, { ok: true, visibility: updated });
        return true;
      }

      if (request.method === 'POST' && url.pathname === '/api/admin/scripts/bundles') {
        const body = await readJsonBody(request);
        const bundle = db.saveScriptBundle(body);
        json(response, 200, { ok: true, bundle });
        return true;
      }

      if (request.method === 'DELETE' && url.pathname === '/api/admin/scripts/bundles') {
        const body = await readJsonBody(request);
        db.deleteScriptBundle(body?.id);
        json(response, 200, { ok: true });
        return true;
      }
    } catch (err) {
      json(response, 400, { ok: false, error: err.message });
      return true;
    }
  }

  return false;
}

module.exports = { handleAdminRoutes, requireAdmin };
