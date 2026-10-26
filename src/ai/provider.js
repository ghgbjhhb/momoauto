'use strict';
const { redact } = require('../automation/runtime');
const { checkSignal, waitFor } = require('../automation/cancellation');
class DeepSeekProvider {
  static async chat(messages, config = {}, options = {}) {
    checkSignal(options.signal);
    const apiKey = (config.apiKey || '').trim();
    if (!apiKey) throw Object.assign(new Error('DeepSeek API Key is not configured'), { code: 'CONFIG_INCOMPLETE' });
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
      const response = await bounded((options.fetchFn || globalThis.fetch)(
        (config.endpoint || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
          body: JSON.stringify({ model: config.model || 'deepseek-chat', messages,
            temperature: Number(config.temperature ?? .7), max_tokens: Number(config.maxTokens ?? 150), stream: false })
        }));
      if (!response.ok) {
        await bounded(response.text());
        const status = response.status;
        const code = [401, 403].includes(status) ? 'API_AUTH_FAILED' : status === 429 ? 'API_RATE_LIMITED' : status >= 500 ? 'API_UNAVAILABLE' : 'API_INVALID_RESPONSE';
        const err = Object.assign(new Error('DeepSeek request failed (' + status + ')'), { code, status });
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
