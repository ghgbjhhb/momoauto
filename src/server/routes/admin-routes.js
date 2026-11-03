'use strict';

const { json, readJsonBody } = require('../http');
const { getAuthService } = require('../auth/service');
const { getSmsService } = require('../sms/service');
const urlGuard = require('../../automation/url-guard');
const { listDevices, revokeDeviceAccess, revokeUserAccess } = require('../context');

const authService = getAuthService();
const aiDebugInFlight = new Set();

// Keep the test threshold sourced from the same global configuration that the
// MOMO workflow uses; do not maintain a second magic number on the client.
function getDebugHandoffMinSelfMessages() {
  const { getEffectiveConfig } = require('../../ai/config');
  return Number(getEffectiveConfig().handoffMinSelfMessages) || 7;
}

// This is an allowlist sourced from trusted server configuration. Only an
// official DeepSeek endpoint gets additional model IDs documented by DeepSeek.
// No arbitrary model/endpoint/credential pair can be supplied by a browser.
function getAdminDebugModelChoices() {
  const { listProviders } = require('../../ai/config');
  const { supportedReasoningEfforts } = require('../../ai/provider');
  const result = [];
  for (const provider of listProviders()) {
    const models = Array.isArray(provider.models) && provider.models.length
      ? [...provider.models] : [provider.model];
    let officialDeepSeek = false;
    try {
      officialDeepSeek = provider.provider === 'deepseek' &&
        new URL(provider.endpoint).hostname.toLowerCase() === 'api.deepseek.com';
    } catch {}
    if (officialDeepSeek) models.push('deepseek-flash', 'deepseek-v4-pro');
    for (const model of new Set(models)) {
      result.push({
        id: provider.id + '::' + model,
        providerId: provider.id,
        providerName: provider.name,
        model,
        reasoningEfforts: supportedReasoningEfforts({ ...provider, model }),
        hasApiKey: provider.hasApiKey,
        isDefault: provider.isDefault && model === provider.model
      });
    }
  }
  return result;
}

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

  if (request.method === 'GET' && url.pathname === '/api/admin/users/detail') {
    if (!requireAdmin(user, response)) return true;
    const info = authService.db.getAdminUserOverview(url.searchParams.get('userId') || '');
    if (!info) { json(response, 404, { ok: false, error: '用户不存在' }); return true; }
    json(response, 200, { ok: true, ...info });
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
      const revoked = authService.revokeCard(body?.cardId);
      if (!revoked) {
        // 数据库的条件更新只对未使用卡密生效，不能把已兑换、已作废
        // 或已不存在的卡密伪装成“作废成功”。
        json(response, 409, { ok: false, error: '卡密已使用、已作废或不存在，请刷新列表确认状态' });
      } else {
        json(response, 200, { ok: true });
      }
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
        userId: alloc?.user_id || null,
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

  // 管理员 AI 调试：复用正式生成服务，不读取设备联系人数据库，也不向云机发送内容。
  // 浏览器维护独立的测试历史；API 只接收有限且已验证的纯文本消息。
  if (request.method === 'GET' && url.pathname === '/api/admin/ai-debug/config') {
    if (!requireAdmin(user, response)) return true;
    const { getSanitizedSettings } = require('../../ai/config');
    const cfg = getSanitizedSettings();
    const { MAX_SYSTEM_PROMPT_CHARS, MAX_CONTEXT_CHARS } = require('../../ai/context');
    json(response, 200, {
      ok: true, systemPrompt: cfg.systemPrompt,
      revision: cfg.revision, model: cfg.model, provider: cfg.provider,
      hasApiKey: cfg.hasApiKey, contextMaxMessages: cfg.contextMaxMessages,
      maxSystemPromptChars: MAX_SYSTEM_PROMPT_CHARS, maxTotalChars: MAX_CONTEXT_CHARS,
      models: getAdminDebugModelChoices(),
      handoffEnabled: cfg.handoffEnabled,
      handoffMinSelfMessages: getDebugHandoffMinSelfMessages(),
      handoffSegments: cfg.handoffSegments
    });
    return true;
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/ai-debug/reply') {
    if (!requireAdmin(user, response)) return true;
    const adminId = String(user.id);
    if (aiDebugInFlight.has(adminId)) {
      json(response, 409, { ok: false, error: '已有调试回复正在生成，请等待当前请求完成' });
      return true;
    }
    aiDebugInFlight.add(adminId);
    const controller = new AbortController();
    const abortOnClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.on('close', abortOnClose);
    try {
      const body = await readJsonBody(request, 160000);
      const { getEffectiveConfig, loadSettings } = require('../../ai/config');
      const { generateReply } = require('../../ai/reply-service');
      const { MAX_SYSTEM_PROMPT_CHARS, MAX_CONTEXT_CHARS } = require('../../ai/context');
      const config = getEffectiveConfig();
      const choices = getAdminDebugModelChoices();
      const modelSelection = body?.modelSelection;
      const choice = modelSelection === undefined
        ? choices.find(item => item.isDefault)
        : choices.find(item => item.id === modelSelection);
      if (!choice) {
        json(response, 400, { ok: false, error: '所选测试模型已失效，请重新打开模型选择列表' });
        return true;
      }
      const reasoningEffort = body?.reasoningEffort === undefined ? 'default' : body.reasoningEffort;
      if (reasoningEffort !== 'default' &&
          !choice.reasoningEfforts.includes(reasoningEffort)) {
        json(response, 400, { ok: false, error: '所选模型不支持该思考强度，请切换至可用档位' });
        return true;
      }
      const configuredProvider = loadSettings().providers.find(item => item.id === choice.providerId);
      if (!configuredProvider || !configuredProvider.apiKey?.trim()) {
        json(response, 422, { ok: false, error: '所选模型的供应商未配置有效 API Key' });
        return true;
      }
      // Select the provider's trusted endpoint and key, without persisting any
      // change to the default model used by real automation tasks.
      const testConfig = {
        ...config,
        provider: configuredProvider.provider,
        endpoint: configuredProvider.endpoint,
        apiKey: configuredProvider.apiKey,
        model: choice.model,
        temperature: configuredProvider.temperature,
        maxTokens: configuredProvider.maxTokens,
        timeoutMs: configuredProvider.timeoutMs
      };
      // Only this debug request receives reasoning control. The provider,
      // its production default model and all persisted settings stay intact.
      if (choice.reasoningEfforts.length) {
        testConfig.reasoningEffort = reasoningEffort;
        const tokenBudget = reasoningEffort === 'none' ? 1024 :
          reasoningEffort === 'max' ? 16384 :
            reasoningEffort === 'high' || reasoningEffort === 'xhigh' ? 8192 : 4096;
        testConfig.maxTokens = Math.max(Number(testConfig.maxTokens) || 0, tokenBudget);
        testConfig.timeoutMs = Math.max(Number(testConfig.timeoutMs) || 0,
          reasoningEffort === 'max' || reasoningEffort === 'xhigh' ? 180000 : 120000);
      }
      const prompt = body?.systemPrompt;
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_SYSTEM_PROMPT_CHARS) {
        json(response, 400, { ok: false, error: `请输入不超过 ${MAX_SYSTEM_PROMPT_CHARS} 字的系统提示词` });
        return true;
      }
      const source = body?.history;
      const previousIntent = body?.debugState?.stickyIntent === true;
      const previousHandoffState = ['sent', 'blocked', 'uncertain'].includes(body?.debugState?.handoffState)
        ? body.debugState.handoffState : '';
      const maxMessages = Math.min(60, Number(config.contextMaxMessages) || 60);
      if (!Array.isArray(source) || source.length < 1 || source.length > maxMessages) {
        json(response, 400, { ok: false, error: '测试对话条数超过模型上下文限制，请清空测试历史后重试' });
        return true;
      }
      let totalChars = prompt.length;
      const history = [];
      for (const message of source) {
        if (!message || !['peer', 'self'].includes(message.sender) ||
          typeof message.text !== 'string' || !message.text.trim() ||
          message.text.length > (message.sender === 'peer' ? 1200 : 6000)) {
          json(response, 400, { ok: false, error: '测试消息格式错误或单条消息过长' });
          return true;
        }
        totalChars += message.text.length;
        history.push({ sender: message.sender, text: message.text });
      }
      if (history[history.length - 1].sender !== 'peer' || totalChars > MAX_CONTEXT_CHARS) {
        json(response, 400, { ok: false, error: `对话必须以对方发言结束，且历史与提示词总字数不得超过 ${MAX_CONTEXT_CHARS}` });
        return true;
      }
      // 与 momo-ai-reply.js 调用相同的生成服务、上下文契约和进度统计。
      // 真实联系人的 stickyIntent 来自设备数据库，此调试对话完全隔离，不借用真实数据。
      const selfSentCount = history.filter(item => item.sender === 'self').length;
      const result = await generateReply(history, { ...testConfig, systemPrompt: prompt }, {
        signal: controller.signal,
        progress: {
          selfSentCount, minSelfMessages: config.handoffMinSelfMessages,
          stickyIntent: previousIntent
        }
      });

      // Mirror the actual post-generation branch in momo-ai-reply.js: the
      // generated reply is not what gets sent if all handoff gates pass.
      const intent = result.intent || {
        stage: '未知', readyForContactScript: false, summary: '', formatValid: false
      };
      const stickyIntent = previousIntent || intent.readyForContactScript === true;
      const minSelfMessages = Number(config.handoffMinSelfMessages) || 7;
      const segments = Array.isArray(config.handoffSegments) ? config.handoffSegments : [];
      let reason = '普通 AI 回复';
      let shouldHandoff = false;
      if (stickyIntent) {
        if (selfSentCount < minSelfMessages) {
          reason = `对方已有联系方式意向，但我方已发 ${selfSentCount}/${minSelfMessages} 句，未达到门槛`;
        } else if (config.handoffEnabled !== true || segments.length === 0) {
          reason = '意向及句数达标，但后台未启用联系方式话术或未配置段落';
        } else if (previousHandoffState === 'sent' || previousHandoffState === 'blocked') {
          reason = '联系方式话术此前已发送，不会重复连发';
        } else if (previousHandoffState === 'uncertain') {
          reason = '之前的话术发送状态待复核，禁止重复连发';
        } else {
          reason = `满足门槛，将按后台配置依次展示 ${segments.length} 段联系方式话术（仅模拟）`;
          shouldHandoff = true;
        }
      } else {
        reason = '本轮及此前未检测到联系方式意向，使用普通 AI 回复';
      }
      const messages = shouldHandoff ? segments : [result.text];
      if (!response.destroyed) {
        json(response, 200, {
          ok: true,
          reply: result.text,
          messages,
          intent: {
            stage: intent.stage, summary: intent.summary,
            readyForContactScript: intent.readyForContactScript === true,
            formatValid: intent.formatValid === true
          },
          decision: {
            shouldHandoff, reason, selfSentCount, minSelfMessages,
            stickyIntent, handoffState: shouldHandoff ? 'sent' : previousHandoffState,
            sentCount: messages.length
          },
          call: {
            model: result.model,
            providerName: choice.providerName,
            reasoningEffort: choice.reasoningEfforts.length ? reasoningEffort : 'unsupported',
            requestId: result.requestId,
            usage: result.usage,
            finishReason: result.finishReason,
            messageCountUsed: result.messageCountUsed
          }
        });
      }
    } catch (error) {
      const invalid = /请求内容过大|请求 JSON 格式不正确/.test(error.message);
      const status = invalid ? 400 : error.code === 'CONFIG_INCOMPLETE' ? 422 :
        error.code === 'CONTEXT_BUDGET_EXCEEDED' ? 400 : error.code === 'API_TIMEOUT' ? 504 : 503;
      if (!response.destroyed) {
        json(response, status, { ok: false,
          error: invalid ? '请求格式错误或超出上限' :
            error.code === 'CONFIG_INCOMPLETE' ? '当前 AI 供应商未配置 API Key' :
              error.code === 'CONTEXT_BUDGET_EXCEEDED' ? '聊天历史已超过模型上下文限制，请清空历史' :
                error.code === 'API_TIMEOUT' ? 'AI 生成超时，请稍后重试' :
                  'AI 回复生成失败，请检查当前供应商配置与连接状态' });
      }
    } finally {
      response.removeListener('close', abortOnClose);
      aiDebugInFlight.delete(adminId);
    }
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
