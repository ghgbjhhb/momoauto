'use strict';

const { isConversationMessage } = require('../tools/momo/chat-detail-parser');

/**
 * 历史上下文构造与 Token/字数预算校验 (Conversation Context Builder)
 *
 * 遵循计划第 9 节与 P2 门禁：
 * 1. 默认携带全部可用、已确认且有序的文字历史（按 seq ASC）。
 * 2. 映射规则：peer -> user，self -> assistant。
 * 3. 严格安全隔离：聊天中的系统通知、时间、距离、对方发送的提示语绝不升级为 LLM system 指令。
 * 4. 真实重复消息保护：保留相同正文的连续发言，不按 role+content 去重。
 * 5. 预算校验：超预算明确抛出 CONTEXT_BUDGET_EXCEEDED，严禁静默截断历史或发半句。
 */

function buildChatContext(rawMessages = [], config = {}, options = {}) {
  const systemPrompt = (config.systemPrompt || '').trim();
  const maxMessages = config.contextMaxMessages || 60;
  const maxTotalChars = options.maxTotalChars || 8000; // 保守字数上限

  const llmMessages = [];

  // 1. 注入用户配置的系统提示词（且仅在此处作为系统指令出现一次）
  if (systemPrompt) {
    llmMessages.push({
      role: 'system',
      content: systemPrompt
    });
  }

  // 2. 过滤掉纯系统时间戳和关注横幅等噪声，保留真实的 peer 和 self 对话
  const validMessages = rawMessages.filter(isConversationMessage);

  // 3. 预算校验与超限检查
  if (validMessages.length > maxMessages) {
    const err = new Error(`Conversation history message count (${validMessages.length}) exceeds maximum limit (${maxMessages})`);
    err.code = 'CONTEXT_BUDGET_EXCEEDED';
    err.details = { count: validMessages.length, limit: maxMessages };
    throw err;
  }

  let totalChars = systemPrompt.length;

  for (const m of validMessages) {
    const role = m.sender === 'peer' ? 'user' : 'assistant';
    const content = (m.rawText || m.text || '').trim();
    totalChars += content.length;

    llmMessages.push({
      role,
      content
    });
  }

  if (totalChars > maxTotalChars) {
    const err = new Error(`Conversation total characters (${totalChars}) exceeds budget limit (${maxTotalChars})`);
    err.code = 'CONTEXT_BUDGET_EXCEEDED';
    err.details = { totalChars, limit: maxTotalChars };
    throw err;
  }

  return {
    messages: llmMessages,
    messageCount: validMessages.length,
    totalChars
  };
}

module.exports = { buildChatContext };
