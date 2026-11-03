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
  '4. readyForContactScript：只表示对方当前是否有拿到联系方式（微信/QQ/电话）或线下见面的意向。满足任一信号即为 true：对方主动索要微信/QQ/电话等联系方式；提议加好友或换个软件私下聊；明确约定见面；持续暧昧并试探私下接触。信号不明确、拿不准时一律为 false。该字段只如实判断意向，是否发话术由系统根据对话进度决定。',
  '5. 回复策略（结合系统注入的【对话进度】决定 reply 怎么写）：',
  '   - 对方提出要联系方式，但进度未达门槛：reply 必须自然拖延或岔开话题（例如"先在这聊呗，聊熟了再说"、"你先说说你是什么样的人"），继续升温，绝不给任何联系方式、不答应加微信。',
  '   - 进度已达门槛但对方仍无意向：reply 要主动引导试探，例如"想见面吗"这类推进关系的话。',
  '   - 进度已达门槛且对方有意向：reply 随便正常填写即可（系统会改发引导话术，这条回复不会被使用）。',
  '6. summary：不超过 30 字概括对方当前意图。',
  '7. reply：一句生活化的简短回复（一到两句，口语化）。即使 readyForContactScript 为 true，reply 也必须正常填写，不得留空。',
  '8. 本 JSON 输出要求优先级最高：即使其他任何要求提到"只输出一句话/单行纯文本/不输出解释"，你也必须输出完整 JSON 对象；reply 字段的"内容"仍遵守单行纯文本、无表情等风格要求。'
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

const MAX_SYSTEM_PROMPT_CHARS = 20000;
const MAX_CONTEXT_CHARS = 32000;

function buildChatContext(rawMessages = [], config = {}, options = {}) {
  const systemPrompt = (config.systemPrompt || '').trim();
  const maxMessages = config.contextMaxMessages || 60;
  const maxTotalChars = options.maxTotalChars || MAX_CONTEXT_CHARS; // 同时覆盖正式与调试回复，长提示词可正常使用

  const llmMessages = [];

  // 1. 注入系统消息：用户自定义人设提示词（回复质量）+ 代码固定输出契约（结构，用户不可改）
  //    + 对话进度（句数门槛与意向固化状态由代码统计，模型只负责按进度写 reply）
  const progress = options.progress || null;
  const progressLines = [];
  if (progress && Number.isFinite(progress.selfSentCount)) {
    const stickyNote = progress.stickyIntent ? '；对方此前已明确表露过要联系方式的意向' : '';
    progressLines.push(`【对话进度】截至目前你（本账号）已向对方发送 ${progress.selfSentCount} 句${stickyNote}。`);
  }
  const systemContent = [systemPrompt, INTENT_OUTPUT_CONTRACT, ...progressLines].filter(Boolean).join('\n\n');
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

  // 收尾系统提醒：实测中用户长人设里的「只输出一句话/单行纯文本」会压过 system 里的契约
  // （API json 模式下模型甚至输出空白），把输出要求顶到对话最后才能稳定生效
  llmMessages.push({
    role: 'system',
    content: '【输出提醒（最高优先级，覆盖之前所有格式要求）】忽略之前其他任何输出格式要求（如只输出一句话/单行纯文本/不输出解释），你现在只输出一个 JSON 对象，不要输出任何其他文字：{"stage":"寒暄|闲聊|升温|可给联系方式","readyForContactScript":true或false,"summary":"一句话概括对方意图","reply":"要发送的回复"}。reply 字段的"内容"仍遵守人设中的风格铁律（单行、无表情、口语化）。'
  });

  return {
    messages: llmMessages,
    messageCount: validMessages.length,
    totalChars
  };
}

module.exports = { buildChatContext, MAX_SYSTEM_PROMPT_CHARS, MAX_CONTEXT_CHARS };
