'use strict';

// 管理员独立的提示词测试历史；仅在当前浏览器标签页的 sessionStorage 保存。
// 模型调用由后端复用 momo-ai-reply 相同 generateReply()，不调用云机 API。
const AI_DEBUG_HISTORY_KEY = 'yunmomo.admin.ai-debug.v1';
const AI_DEBUG_TRACE_KEY = 'yunmomo.admin.ai-debug-trace.v1';
const AI_DEBUG_MODEL_KEY = 'yunmomo.admin.ai-debug-model.v1';
let aiDebugReady = false;
let aiDebugLoading = null;
let aiDebugHistory = [];
let aiDebugConfig = null;
let aiDebugBusy = false;
let aiDebugVersion = 0;
let aiDebugController = null;
let aiDebugPromptChanged = false;
let aiDebugPromptEditVersion = 0;
let aiDebugConfigVersion = 0;
let aiDebugSelectedModelId = '';
let aiDebugTraces = [];
let aiDebugStickyIntent = false;
let aiDebugHandoffState = '';

function aiDebugReadHistory() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(AI_DEBUG_HISTORY_KEY) || '[]');
    if (!Array.isArray(stored) || stored.length > 60) return [];
    if (!stored.every(m => m && ['peer', 'self'].includes(m.sender) &&
      typeof m.text === 'string' && m.text.length > 0 &&
      m.text.length <= (m.sender === 'peer' ? 1200 : 6000))) return [];
    return stored;
  } catch { return []; }
}

function aiDebugReadTraces() {
  try {
    const data = JSON.parse(sessionStorage.getItem(AI_DEBUG_TRACE_KEY) || '{}');
    if (!data || !Array.isArray(data.traces)) return;
    aiDebugTraces = data.traces.slice(-30).filter(x => x && typeof x === 'object');
    aiDebugStickyIntent = data.stickyIntent === true;
    aiDebugHandoffState = ['sent', 'uncertain', 'blocked'].includes(data.handoffState)
      ? data.handoffState : '';
  } catch { /* 非法记录不影响回复生成 */ }
}

function aiDebugPersist() {
  try {
    if (aiDebugHistory.length) {
      sessionStorage.setItem(AI_DEBUG_HISTORY_KEY, JSON.stringify(aiDebugHistory));
      sessionStorage.setItem(AI_DEBUG_TRACE_KEY, JSON.stringify({
        traces: aiDebugTraces.slice(-30),
        stickyIntent: aiDebugStickyIntent,
        handoffState: aiDebugHandoffState
      }));
    } else {
      sessionStorage.removeItem(AI_DEBUG_HISTORY_KEY);
      sessionStorage.removeItem(AI_DEBUG_TRACE_KEY);
    }
  } catch { /* 无存储权限时仅在页面内保留历史 */ }
}

function aiDebugSetStatus(message, isError = false) {
  const el = document.getElementById('aiDebugStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = isError ? 'error' : 'normal';
}

function aiDebugRender(visibleHistory = aiDebugHistory) {
  const list = document.getElementById('aiDebugMessages');
  if (!list) return;
  list.replaceChildren();
  if (!visibleHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'admin-ai-lab-empty';
    empty.textContent = '输入一条对方的消息，查看实际 AI 回复内容。';
    list.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const message of visibleHistory) {
    const bubble = document.createElement('article');
    bubble.className = 'admin-ai-lab-bubble ' +
      (message.sender === 'peer' ? 'admin-ai-lab-bubble-user' : 'admin-ai-lab-bubble-ai') +
      (message.kind === 'handoff' ? ' admin-ai-lab-bubble-handoff' : '');
    const label = document.createElement('div');
    label.className = 'admin-ai-lab-bubble-label';
    label.textContent = message.sender === 'peer' ? '模拟对方' :
      message.kind === 'handoff' ? `后台联系方式话术 ${message.segmentIndex}/${message.segmentTotal} · 仅模拟` :
        'AI 生成回复';
    const body = document.createElement('div');
    body.className = 'admin-ai-lab-bubble-text';
    body.textContent = message.text;
    bubble.append(label, body);
    fragment.append(bubble);
  }
  list.append(fragment);
  list.scrollTop = list.scrollHeight;
}

// 右侧仅展示真实 AI 本轮返回的意图与生成回复，以及代码侧的话术选择。
// 所有动态数据使用 textContent，不将模型内容当成 HTML 执行。
function aiDebugRenderTraces() {
  const list = document.getElementById('aiDebugTrace');
  if (!list) return;
  list.replaceChildren();
  if (!aiDebugTraces.length) {
    const empty = document.createElement('div');
    empty.className = 'admin-ai-lab-empty';
    empty.textContent = '生成回复后在这里查看意图、回复和触发原因。';
    list.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const trace of [...aiDebugTraces].reverse()) {
    const card = document.createElement('article');
    card.className = 'admin-ai-lab-trace-entry';
    const heading = document.createElement('h4');
    heading.textContent = `#${trace.round} · ${trace.time} · ${trace.intent?.stage || '未知'}`;
    card.append(heading);
    const addLine = (title, value, className = '') => {
      const line = document.createElement('div');
      line.className = 'admin-ai-lab-trace-line' + (className ? ' ' + className : '');
      const strong = document.createElement('strong');
      strong.textContent = title + '：';
      line.append(strong, document.createTextNode(String(value ?? '—')));
      card.append(line);
    };
    addLine('对方意图', trace.intent?.summary || '未提供');
    addLine('联系方式意向', trace.intent?.readyForContactScript ? '是' : '否');
    addLine('意向已固化', trace.decision?.stickyIntent ? '是' : '否');
    addLine('JSON 意图解析', trace.intent?.formatValid ? '有效' : '降级为普通回复');
    addLine('模型 reply 字段', trace.reply || '');
    addLine('最终分流', trace.decision?.reason || '普通 AI 回复',
      trace.decision?.shouldHandoff ? 'admin-ai-lab-trace-alert' : '');
    addLine('已发送句数 / 门槛', `${trace.decision?.selfSentCount ?? 0} / ${trace.decision?.minSelfMessages ?? 7}`);
    addLine('实际采用', trace.decision?.shouldHandoff ?
      `后台预设话术 ${trace.decision?.sentCount ?? 0} 段（仅测试窗口模拟显示，未真实发送；生产流程会尝试拉黑）` :
      'AI 生成的 reply');
    addLine('模型', trace.call?.model || '未返回', 'admin-ai-lab-trace-muted');
    const usage = trace.call?.usage;
    if (usage) {
      addLine('Tokens', `输入 ${usage.prompt_tokens ?? '—'} / 输出 ${usage.completion_tokens ?? '—'} / 合计 ${usage.total_tokens ?? '—'}`,
        'admin-ai-lab-trace-muted');
    }
    fragment.append(card);
  }
  list.append(fragment);
}

function aiDebugGetSelectedModel() {
  return aiDebugConfig?.models?.find(item => item.id === aiDebugSelectedModelId) || null;
}

function aiDebugSetBusy(busy) {
  aiDebugBusy = busy;
  const select = document.getElementById('aiDebugModelSelect');
  if (select) select.disabled = busy || !Array.isArray(aiDebugConfig?.models) || !aiDebugConfig.models.length;
  const send = document.getElementById('aiDebugSend');
  if (send) {
    send.disabled = busy || !aiDebugGetSelectedModel()?.hasApiKey || aiDebugHandoffState === 'sent';
    send.textContent = busy ? '正在生成…' : '生成回复';
  }
}

function aiDebugRenderModelOptions(config) {
  const select = document.getElementById('aiDebugModelSelect');
  if (!select) return;
  const choices = Array.isArray(config.models) ? config.models : [];
  select.replaceChildren();
  if (!choices.length) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '没有可选模型，请更新并重启服务';
    select.append(placeholder);
    aiDebugSelectedModelId = '';
    aiDebugSetStatus('当前服务端尚未提供模型选择列表，请确认已重启最新版 Node 服务。', true);
    return;
  }
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = choice.providerName + ' · ' + choice.model +
      (choice.isDefault ? '（线上默认）' : '') +
      (!choice.hasApiKey ? '（未配置 Key）' : '');
    select.append(option);
  }
  const previous = choices.find(choice => choice.id === aiDebugSelectedModelId);
  const selected = previous || choices.find(choice => choice.isDefault) || choices[0];
  aiDebugSelectedModelId = selected.id;
  select.value = selected.id;
  aiDebugSetBusy(aiDebugBusy);
}

async function aiDebugLoadConfig(force = false) {
  if (aiDebugLoading && !force) return aiDebugLoading;
  const promptInput = document.getElementById('aiDebugPrompt');
  const providerMeta = document.getElementById('aiDebugProviderMeta');
  const configVersion = ++aiDebugConfigVersion;
  const promptVersion = aiDebugPromptEditVersion;
  const currentLoad = (async () => {
    try {
      const response = await fetch('/api/admin/ai-debug/config', { cache: 'no-store' });
      const result = await response.json();
      if (configVersion !== aiDebugConfigVersion) return;
      if (!response.ok || !result.ok) throw new Error(result.error || '无法加载当前 AI 配置');
      aiDebugConfig = result;
      if (promptInput && aiDebugPromptEditVersion === promptVersion &&
        (force || !aiDebugPromptChanged)) {
        promptInput.value = result.systemPrompt || '';
        aiDebugPromptChanged = false;
      }
      if (providerMeta) {
        providerMeta.textContent = '线上默认：' + (result.provider || '未知') +
          ' · ' + (result.model || '未指定');
      }
      aiDebugRenderModelOptions(result);
      if (Array.isArray(result.models) && result.models.length) {
        aiDebugSetStatus('切换测试模型不会修改线上默认模型；测试历史仅留在当前浏览器标签页。');
      }
    } catch (error) {
      if (configVersion === aiDebugConfigVersion) {
        aiDebugSetStatus('读取 AI 配置失败：' + error.message, true);
      }
    }
  })();
  aiDebugLoading = currentLoad;
  try { await currentLoad; }
  finally { if (aiDebugLoading === currentLoad) aiDebugLoading = null; }
}

async function aiDebugSendMessage() {
  const input = document.getElementById('aiDebugInput');
  const promptInput = document.getElementById('aiDebugPrompt');
  const message = input?.value.trim() || '';
  const prompt = promptInput?.value.trim() || '';
  if (aiDebugBusy) return;
  if (aiDebugHandoffState === 'sent') {
    aiDebugSetStatus('本轮测试已模拟完成话术连发及后续拉黑流程，请清空测试聊天后开始新会话。', true);
    return;
  }
  if (!message || message.length > 1200) {
    aiDebugSetStatus('请输入不超过 1200 字的对方消息。', true);
    return;
  }
  if (!prompt || prompt.length > 6000) {
    aiDebugSetStatus('请输入不超过 6000 字的系统提示词。', true);
    return;
  }
  const selectedModel = aiDebugGetSelectedModel();
  if (!selectedModel) {
    aiDebugSetStatus('请先选择一个测试模型。', true);
    return;
  }
  if (!selectedModel.hasApiKey) {
    aiDebugSetStatus('所选模型的供应商没有配置 API Key，请先在 AI 服务设置中配置。', true);
    return;
  }
  const nextHistory = [...aiDebugHistory, { sender: 'peer', text: message }];
  const maxMessages = Math.min(60, Number(aiDebugConfig.contextMaxMessages) || 60);
  const totalChars = prompt.length + nextHistory.reduce((total, item) => total + item.text.length, 0);
  if (nextHistory.length > maxMessages || totalChars > 8000) {
    aiDebugSetStatus('已达到真实模型的上下文预算，请清空测试聊天后继续。', true);
    return;
  }

  const version = ++aiDebugVersion;
  const controller = new AbortController();
  aiDebugController = controller;
  aiDebugSetBusy(true);
  aiDebugSetStatus('正在通过正式 AI 回复生成流程处理…');
  try {
    const response = await fetch('/api/admin/ai-debug/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemPrompt: prompt,
        modelSelection: selectedModel.id,
        history: nextHistory.map(({ sender, text }) => ({ sender, text })),
        debugState: { stickyIntent: aiDebugStickyIntent, handoffState: aiDebugHandoffState }
      })
    });
    const data = await response.json();
    if (version !== aiDebugVersion) return;
    if (!response.ok || !data.ok || typeof data.reply !== 'string' || !data.reply.trim()) {
      throw new Error(data.error || 'AI 未返回有效回复');
    }
    if (!Array.isArray(data.messages) || !data.messages.length ||
      !data.messages.every(line => typeof line === 'string' && line.trim() && line.length <= 6000)) {
      throw new Error('服务端没有返回可用于测试的完整回复或话术');
    }
    const trace = {
      round: aiDebugTraces.length + 1,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      reply: data.reply,
      intent: data.intent,
      decision: data.decision,
      call: data.call
    };
    aiDebugTraces.push(trace);
    aiDebugTraces = aiDebugTraces.slice(-30);
    aiDebugRenderTraces();

    const displayed = [...nextHistory];
    for (const [index, text] of data.messages.entries()) {
      if (version !== aiDebugVersion) return;
      if (index > 0 && data.decision?.shouldHandoff) {
        // 正式云机连发段间等待 1500–3000ms；这里只计时显示，不进行设备输入。
        aiDebugSetStatus(`模拟联系方式连发：正在等待第 ${index + 1}/${data.messages.length} 段…`);
        await new Promise(resolve => setTimeout(resolve, 1500 + Math.floor(Math.random() * 1501)));
        if (version !== aiDebugVersion) return;
      }
      displayed.push({
        sender: 'self', text,
        ...(data.decision?.shouldHandoff ?
          { kind: 'handoff', segmentIndex: index + 1, segmentTotal: data.messages.length } : {})
      });
      aiDebugRender(displayed);
      if (data.decision?.shouldHandoff) {
        aiDebugSetStatus(`模拟联系方式连发：已展示第 ${index + 1}/${data.messages.length} 段（未向云机实际发送）`);
      }
    }
    if (version !== aiDebugVersion) return;
    aiDebugHistory = displayed;
    aiDebugStickyIntent = data.decision?.stickyIntent === true;
    aiDebugHandoffState = data.decision?.handoffState || '';
    aiDebugPersist();
    if (input) input.value = '';
    aiDebugSetStatus(data.decision?.shouldHandoff ?
      '已按后台话术顺序模拟连发；正式流程随后会尝试拉黑，此处没有真实设备操作。清空测试聊天可重新开始。' :
      '回复生成完成。右侧显示 AI 意图、模型回复和代码分流原因。');
  } catch (error) {
    if (version === aiDebugVersion && error.name !== 'AbortError') {
      aiDebugSetStatus('生成失败：' + error.message + '。历史未增加本轮消息，可以修改后重试。', true);
    }
  } finally {
    if (version === aiDebugVersion) {
      aiDebugController = null;
      aiDebugSetBusy(false);
    }
  }
}

async function aiDebugSavePrompt() {
  const promptInput = document.getElementById('aiDebugPrompt');
  const saveButton = document.getElementById('aiDebugSavePrompt');
  const prompt = promptInput?.value.trim() || '';
  if (!prompt || prompt.length > 6000 || !aiDebugConfig) {
    aiDebugSetStatus('系统提示词为空、过长或尚未加载，无法保存。', true);
    return;
  }
  if (saveButton?.disabled) return;
  const confirmed = await showConfirm({
    title: '确认更新正式系统提示词？',
    desc: '保存后，新的真实 AI 回复将使用这份系统提示词。当前调试聊天不会自动清空。',
    okText: '确认保存为正式提示词',
    cancelText: '继续编辑',
    isDanger: false,
    icon: '✎'
  });
  if (!confirmed || saveButton?.disabled) return;
  if (saveButton) saveButton.disabled = true;
  try {
    const response = await fetch('/api/admin/ai-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: prompt, expectedRevision: aiDebugConfig.revision })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '保存失败');
    aiDebugConfig.revision = data.settings.revision;
    aiDebugConfig.systemPrompt = data.settings.systemPrompt;
    aiDebugPromptChanged = false;
    aiDebugSetStatus('已保存为正式系统提示词；后续新生成的真实 AI 回复将读取新配置。');
    showToast('正式系统提示词已保存', 'success');
  } catch (error) {
    aiDebugSetStatus('保存失败：' + error.message + '。如其他管理员更新了配置，请先恢复线上提示词再编辑。', true);
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

function initAdminAiDebug() {
  if (aiDebugReady) {
    if (!aiDebugConfig && !aiDebugLoading) void aiDebugLoadConfig();
    return;
  }
  aiDebugReady = true;
  aiDebugHistory = aiDebugReadHistory();
  try { aiDebugSelectedModelId = sessionStorage.getItem(AI_DEBUG_MODEL_KEY) || ''; }
  catch { aiDebugSelectedModelId = ''; }
  if (aiDebugHistory.length) aiDebugReadTraces();
  aiDebugRender();
  aiDebugRenderTraces();

  const form = document.getElementById('aiDebugForm');
  const input = document.getElementById('aiDebugInput');
  const prompt = document.getElementById('aiDebugPrompt');
  form?.addEventListener('submit', event => {
    event.preventDefault();
    void aiDebugSendMessage();
  });
  input?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form?.requestSubmit();
    }
  });
  prompt?.addEventListener('input', () => {
    aiDebugPromptChanged = true;
    ++aiDebugPromptEditVersion;
  });
  document.getElementById('aiDebugModelSelect')?.addEventListener('change', event => {
    if (aiDebugBusy) return;
    const selected = aiDebugConfig?.models?.find(item => item.id === event.target.value);
    if (!selected) return;
    aiDebugSelectedModelId = selected.id;
    try { sessionStorage.setItem(AI_DEBUG_MODEL_KEY, selected.id); } catch {}
    aiDebugSetBusy(false);
    aiDebugSetStatus('已切换测试模型：' + selected.providerName + ' · ' + selected.model +
      '。仅影响调试对话，线上默认模型不变。');
  });
  document.getElementById('aiDebugClear')?.addEventListener('click', () => {
    ++aiDebugVersion;
    aiDebugController?.abort();
    aiDebugController = null;
    aiDebugHistory = [];
    aiDebugTraces = [];
    aiDebugStickyIntent = false;
    aiDebugHandoffState = '';
    aiDebugPersist();
    aiDebugSetBusy(false);
    aiDebugRender();
    aiDebugRenderTraces();
    aiDebugSetStatus('测试聊天历史已清空，真实联系人聊天记录未受影响。');
  });
  document.getElementById('aiDebugReloadPrompt')?.addEventListener('click', () => {
    void aiDebugLoadConfig(true);
  });
  document.getElementById('aiDebugSavePrompt')?.addEventListener('click', () => {
    void aiDebugSavePrompt();
  });

  aiDebugSetBusy(false);
  void aiDebugLoadConfig();
}
