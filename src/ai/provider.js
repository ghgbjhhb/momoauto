'use strict';
const { redact } = require('../automation/runtime');
const { checkSignal, waitFor } = require('../automation/cancellation');
const urlGuard = require('../automation/url-guard');
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
      // JSON 结构化输出：API 层强制返回合法 JSON（契约靠提示词会被用户人设指令压过）。
      // 部分第三方 OpenAI 兼容网关不支持 response_format，收到 400 时降级为纯提示词约束重试一次。
      let attemptJsonMode = config.responseFormat === 'json_object';
      let response;
      for (;;) {
        const requestBody = { model: config.model || 'deepseek-chat', messages,
          temperature: Number(config.temperature ?? .7), max_tokens: Number(config.maxTokens ?? 150), stream: false };
        if (attemptJsonMode) requestBody.response_format = { type: 'json_object' };
        response = await bounded((options.fetchFn || globalThis.fetch)(
          targetUrl, {
            method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
            body: JSON.stringify(requestBody)
          }));
        if (response.status === 400 && attemptJsonMode) {
          attemptJsonMode = false;
          continue;
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
      if (error.code?.startsWith('API_') || error.code === 'EMPTY_RESPONSE') throw error;
      throw Object.assign(new Error('API network failure: ' + redact(error.message, [apiKey])), { code: 'API_UNAVAILABLE' });
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', forward); }
  }
}
DeepSeekProvider.chat = require('../automation/timing').timed('ai.provider.request', DeepSeekProvider.chat);
module.exports = { DeepSeekProvider };
