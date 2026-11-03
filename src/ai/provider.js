'use strict';
const { redact } = require('../automation/runtime');
const { checkSignal, waitFor } = require('../automation/cancellation');
const urlGuard = require('../automation/url-guard');

// Only models with documented Chat Completions reasoning support appear in
// the administrator selector. Unknown gateways/models stay on their defaults.
const GPT_REASONING_MODELS = new Set([
  'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol',
  'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'
]);
const GPT_NO_NONE = new Set(['gpt-6.1-sol', 'gpt-6-astra']);
const GPT_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEEPSEEK_EFFORTS = ['none', 'low', 'high', 'max'];

function supportedReasoningEfforts(config = {}) {
  const model = String(config.model || '').toLowerCase().split('/').pop();
  if (config.provider === 'openai' && GPT_REASONING_MODELS.has(model)) {
    return GPT_NO_NONE.has(model) ? GPT_EFFORTS.slice(1) : [...GPT_EFFORTS];
  }
  try {
    if (config.provider === 'deepseek' &&
        new URL(config.endpoint).hostname.toLowerCase() === 'api.deepseek.com' &&
        (model === 'deepseek-flash' || model === 'deepseek-v4-pro')) {
      return [...DEEPSEEK_EFFORTS];
    }
  } catch {}
  return [];
}

function resolveChatCompletionsUrl(endpoint) {
  let url = String(endpoint || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (url.endsWith('/chat/completions')) return url;
  return url + '/chat/completions';
}

class DeepSeekProvider {
  static async chat(messages, config = {}, options = {}) {
    checkSignal(options.signal);
    const apiKey = (config.apiKey || '').trim();
    if (!apiKey) throw Object.assign(new Error('AI API Key 未配置，请联系管理员在后台设置'), { code: 'CONFIG_INCOMPLETE' });
    const timeoutMs = Number(config.timeoutMs ?? 15000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Object.assign(new Error('Invalid API timeout'), { code: 'INVALID_CONFIG' });
    const controller = new AbortController();
    const forward = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const bounded = pending => waitFor(pending, { signal: controller.signal, timeoutMs: deadline - Date.now(), timeoutCode: 'API_TIMEOUT' });
    try {
      checkSignal(options.signal);
      const targetUrl = resolveChatCompletionsUrl(config.endpoint);
      // 落盘时的同步校验拦不住「公网域名解析到内网 IP」，发请求前必须再做一次带 DNS 的异步校验
      await urlGuard.assertSafeOutboundUrl(targetUrl, {
        allowLoopback: true,
        allowPrivate: String(process.env.YUNMOMO_AI_ALLOW_PRIVATE || '').trim() === '1'
      });
      const modelEfforts = supportedReasoningEfforts(config);
      const requestedEffort = config.reasoningEffort;
      if (requestedEffort !== undefined && requestedEffort !== 'default' &&
          !modelEfforts.includes(requestedEffort)) {
        const error = new Error('当前模型不支持所选思考强度');
        error.code = 'INVALID_REASONING_EFFORT';
        throw error;
      }
      // The admin playground supplies reasoningEffort='default' even when the
      // field is omitted upstream. Production settings never get this field.
      const debugGptReasoning = requestedEffort !== undefined &&
        config.provider === 'openai' && modelEfforts.length > 0;
      // JSON 结构化输出：API 层强制返回合法 JSON（契约靠提示词会被用户人设指令压过）。
      // 部分第三方 OpenAI 兼容网关不支持 response_format，收到 400 时降级为纯提示词约束重试一次。
      let attemptJsonMode = config.responseFormat === 'json_object';
      let response;
      for (;;) {
        const requestBody = {
          model: config.model || 'deepseek-chat', messages, stream: false
        };
        if (debugGptReasoning) {
          // GPT-5.6/6 Chat Completions uses max_completion_tokens (includes
          // reasoning tokens), and reasoning models reject temperature.
          requestBody.max_completion_tokens = Number(config.maxTokens ?? 4096);
        } else {
          requestBody.temperature = Number(config.temperature ?? .7);
          requestBody.max_tokens = Number(config.maxTokens ?? 150);
        }
        if (requestedEffort && requestedEffort !== 'default') {
          requestBody.reasoning_effort = requestedEffort;
        }
        if (attemptJsonMode) requestBody.response_format = { type: 'json_object' };
        response = await bounded((options.fetchFn || globalThis.fetch)(
          targetUrl, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
            body: JSON.stringify(requestBody)
          }));
        if (response.status === 400 && attemptJsonMode) {
          // Preserve the old production JSON-mode fallback unchanged. Only
          // explicit reasoning requests distinguish unsupported effort from
          // an unsupported JSON response format.
          if (requestedEffort === undefined ||
              /response_format|json_object/i.test(await bounded(response.clone().text()))) {
            attemptJsonMode = false;
            continue;
          }
        }
        break;
      }
      if (!response.ok) {
        let serverErrorMsg = '';
        try {
          const rawErr = await bounded(response.text());
          const parsed = JSON.parse(rawErr);
          serverErrorMsg = parsed?.error?.message || parsed?.message || '';
        } catch {}

        const status = response.status;
        const code = [401, 403].includes(status) ? 'API_AUTH_FAILED' : status === 429 ? 'API_RATE_LIMITED' : status >= 500 ? 'API_UNAVAILABLE' : 'API_INVALID_RESPONSE';
        
        let friendlyDesc = `AI 接口请求失败 (${status})`;
        if (status === 401 || status === 403) {
          friendlyDesc = `API Key 鉴权失败 (${status})：密钥无效或未授权，请核对输入的 API Key`;
        } else if (status === 404) {
          friendlyDesc = `接口地址未找到 (404)：请核对请求链接`;
        } else if (status === 429) {
          friendlyDesc = `接口限流或余额不足 (429)`;
        }

        if (serverErrorMsg && serverErrorMsg.length < 150) {
          friendlyDesc += ` (${serverErrorMsg})`;
        }

        const err = Object.assign(new Error(friendlyDesc), { code, status, serverErrorMsg });
        if (status === 429) {
          const value = response.headers?.get('retry-after');
          err.retryAfter = value ? (Number.isFinite(Number(value)) ? Number(value) : Math.max(0, (Date.parse(value) - Date.now()) / 1000)) : null;
        }
        throw err;
      }
      let data;
      try { data = await bounded(response.json()); }
      catch (error) {
        if (controller.signal.aborted || error.code === 'API_TIMEOUT') throw error;
        throw Object.assign(new Error('DeepSeek returned invalid JSON'), { code: 'API_INVALID_RESPONSE' });
      }
      checkSignal(options.signal);
      const choice = data?.choices?.[0];
      if (typeof choice?.message?.content !== 'string') throw Object.assign(new Error('Missing reply content'), { code: 'API_INVALID_RESPONSE' });
      const text = choice.message.content.trim();
      if (!text) throw Object.assign(new Error('Empty reply content'), { code: 'EMPTY_RESPONSE' });
      return { text, model: data.model || config.model || 'deepseek-chat', requestId: data.id || response.headers?.get('x-request-id') || null,
        usage: data.usage || null, finishReason: choice.finish_reason || 'stop' };
    } catch (error) {
      if (options.signal?.aborted) throw Object.assign(new Error('API call cancelled'), { code: 'ABORTED' });
      if (controller.signal.aborted || error.code === 'API_TIMEOUT') throw Object.assign(new Error('API request timed out'), { code: 'API_TIMEOUT' });
      if (error.code?.startsWith('API_') || error.code === 'EMPTY_RESPONSE' ||
          error.code === 'INVALID_REASONING_EFFORT') throw error;
      throw Object.assign(new Error('API network failure: ' + redact(error.message, [apiKey])), { code: 'API_UNAVAILABLE' });
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', forward); }
  }
}
DeepSeekProvider.chat = require('../automation/timing').timed('ai.provider.request', DeepSeekProvider.chat);
module.exports = { DeepSeekProvider, supportedReasoningEfforts };
