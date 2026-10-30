'use strict';

const { isConversationMessage } = require('../tools/momo/chat-detail-parser');

/**
 * 代码固定的输出契约（用户在网页上改不了）：JSON 结构 + 可发话术的判定信号。
 * 用户自定义 systemPrompt 只负责回复内容质量；这份契约负责输出结构，两者拼接后作为唯一 system 消息。
 */
const INTENT_OUTPUT_CONTRACT = [
  '【输出格式（必须严格遵守）】',
  '1. 你的回复必须且只能是一个 JSON 对象，禁止输出任何解释文字、Markdown 标记或代码块围栏。',
  '2. JSON 格式：{"stage":"寒暄|闲聊|升温|可给联系方式","readyForContactScript":false,"summary":"一句话概括对方当前意图","reply":"你要发送的回复"}',
  '3. stage：对方当前意向阶段，只能从"寒暄、闲聊、升温、可给联系方式"四个值中选一个，仅供监控展示。',
  '4. readyForContactScript：是否应立即发送联系方式引导话术。满足任一信号即为 true：对方主动索要微信/QQ/电话等联系方式；提议加好友或换个软件私下聊；明确约定见面；持续暧昧并试探私下接触。信号不明确、拿不准时一律为 false。',
  '5. summary：不超过 30 字概括对方当前意图。',
  '6. reply：一句生活化的简短回复（一到两句，口语化）。即使 readyForContactScript 为 true，reply 也必须正常填写，不得留空。'
].join('\n');

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

  // 1. 注入系统消息：用户自定义人设提示词（回复质量）+ 代码固定输出契约（结构，用户不可改）
  const systemContent = [systemPrompt, INTENT_OUTPUT_CONTRACT].filter(Boolean).join('\n\n');
  if (systemContent) {
    llmMessages.push({
      role: 'system',
      content: systemContent
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
