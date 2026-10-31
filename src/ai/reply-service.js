'use strict';

/**
 * 纯回复生成服务 (AI Reply Generation Service)
 *
 * 遵循计划第 5.3 节与 P2 门禁：
 * 1. 纯 API 调用：不接触手机控制或截图，只负责将格式化上下文发送给模型并返回解析后的结果。
 * 2. 模型按固定输出契约返回 JSON：{stage, readyForContactScript, summary, reply}；
 *    解析带容错降级：模型未按契约输出时整段原文作为普通回复，意图记为未知，绝不阻断主链路。
 * 3. 绑定本地不可变元数据：provider='deepseek', model, requestId, usage, contextVersion, configRevision。
 * 4. 严格错误归一化：将各类异常映射为明确的机器可读 code。
 */

const { buildChatContext } = require('./context');
const { DeepSeekProvider } = require('./provider');
const { getEffectiveConfig } = require('./config');

// JSON 输出比纯文本多占 token，历史契约的 150 上限可能截断 JSON 导致解析失败，这里抬高下限
const MIN_INTENT_MAX_TOKENS = 320;

/**
 * 从模型原始输出中提取意图 JSON（容忍代码围栏与前后杂文字），失败返回 null
 */
function extractIntentJson(rawText) {
  const raw = String(rawText || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return {
    stage: typeof parsed.stage === 'string' && parsed.stage.trim() ? parsed.stage.trim() : '未知',
    readyForContactScript: parsed.readyForContactScript === true,
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    reply: typeof parsed.reply === 'string' ? parsed.reply.trim() : '',
    formatValid: true
  };
}

async function generateReply(rawMessages = [], config = null, options = {}) {
  const effectiveConfig = config || getEffectiveConfig(options.deviceId);

  if (!effectiveConfig.apiKey || !effectiveConfig.apiKey.trim()) {
    const err = new Error('AI API Key 未配置，请联系管理员在后台设置');
    err.code = 'CONFIG_INCOMPLETE';
    throw err;
  }

  // 1. 构建对话上下文并检查字数/条数预算（progress：代码侧统计的对话进度，用于句数门槛回复策略）
  const context = buildChatContext(rawMessages, effectiveConfig, {
    maxTotalChars: options.maxTotalChars,
    progress: options.progress
  });

  // 2. 调用模型生成（JSON 契约下抬高 max_tokens 下限避免截断；responseFormat 让 API 层强制 JSON 输出）
  const callConfig = {
    ...effectiveConfig,
    maxTokens: Math.max(Number(effectiveConfig.maxTokens ?? 0) || 0, MIN_INTENT_MAX_TOKENS),
    responseFormat: 'json_object'
  };
  const result = await DeepSeekProvider.chat(context.messages, callConfig, {
    signal: options.signal,
    fetchFn: options.fetchFn
  });

  // 3. 解析意图 JSON；解析失败时降级：整段原文作为普通回复，意图未知
  const intent = extractIntentJson(result.text) || {
    stage: '未知',
    readyForContactScript: false,
    summary: '',
    reply: '',
    formatValid: false
  };
  const replyText = intent.formatValid ? intent.reply : result.text;

  return {
    ok: true,
    text: replyText,
    intent,
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
