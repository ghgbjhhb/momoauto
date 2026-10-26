'use strict';

/**
 * 纯回复生成服务 (AI Reply Generation Service)
 *
 * 遵循计划第 5.3 节与 P2 门禁：
 * 1. 纯 API 调用：不接触手机控制或截图，只负责将格式化上下文发送给模型并返回纯文本回复。
 * 2. 绑定本地不可变元数据：provider='deepseek', model, requestId, usage, contextVersion, configRevision。
 * 3. 严格错误归一化：将各类异常映射为明确的机器可读 code。
 */

const { buildChatContext } = require('./context');
const { DeepSeekProvider } = require('./provider');
const { getEffectiveConfig } = require('./config');

async function generateReply(rawMessages = [], config = null, options = {}) {
  const effectiveConfig = config || getEffectiveConfig(options.deviceId);

  if (!effectiveConfig.apiKey || !effectiveConfig.apiKey.trim()) {
    const err = new Error('DeepSeek API Key is not configured');
    err.code = 'CONFIG_INCOMPLETE';
    throw err;
  }

  // 1. 构建对话上下文并检查字数/条数预算
  const context = buildChatContext(rawMessages, effectiveConfig, {
    maxTotalChars: options.maxTotalChars
  });

  // 2. 调用 DeepSeek 模型生成回复
  const result = await DeepSeekProvider.chat(context.messages, effectiveConfig, {
    signal: options.signal,
    fetchFn: options.fetchFn
  });

  return {
    ok: true,
    text: result.text,
    provider: 'deepseek',
    model: result.model,
    requestId: result.requestId,
    usage: result.usage,
    finishReason: result.finishReason,
    configRevision: effectiveConfig.revision || 1,
    contextVersion: options.contextVersion || 1,
    messageCountUsed: context.messageCount
  };
}

module.exports = { generateReply: require('../automation/timing').timed('ai.generateReply', generateReply,
  (_messages, _config, options) => ({ deviceId: options?.deviceId })) };
