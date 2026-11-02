'use strict';

// 管理员独立的提示词测试历史；仅在当前浏览器标签页的 sessionStorage 保存。
// 模型调用由后端复用 momo-ai-reply 相同 generateReply()，不调用云机 API。
const AI_DEBUG_HISTORY_KEY = 'yunmomo.admin.ai-debug.v1';
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

function aiDebugReadHistory() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(AI_DEBUG_HISTORY_KEY) || '[]');
    if (!Array.isArray(stored) || stored.length > 60) return [];
    if (!stored.every(m => m && ['peer', 'self'].includes(m.sender) &&
      typeof m.text === 'string' && m.text.length > 0 && m.text.length <= 1200)) return [];
    return stored;
  } catch { return []; }
}

function aiDebugPersist() {
  try {
    if (aiDebugHistory.length) sessionStorage.setItem(AI_DEBUG_HISTORY_KEY, JSON.stringify(aiDebugHistory));
    else sessionStorage.removeItem(AI_DEBUG_HISTORY_KEY);
  } catch { /* 无存储权限时仅在页面内保留历史 */ }
}

function aiDebugSetStatus(message, isError = false) {
  const el = document.getElementById('aiDebugStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = isError ? 'error' : 'normal';
}

function aiDebugRender() {
  const list = document.getElementById('aiDebugMessages');
  if (!list) return;
  list.replaceChildren();
  if (!aiDebugHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'admin-ai-lab-empty';
    empty.textContent = '输入一条对方的消息，查看实际 AI 回复内容。';
    list.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const message of aiDebugHistory) {
    const bubble = document.createElement('article');
    bubble.className = 'admin-ai-lab-bubble ' +
      (message.sender === 'peer' ? 'admin-ai-lab-bubble-user' : 'admin-ai-lab-bubble-ai');
    const label = document.createElement('div');
    label.className = 'admin-ai-lab-bubble-label';
    label.textContent = message.sender === 'peer' ? '模拟对方' : '实际生成回复';
    const body = document.createElement('div');
    body.className = 'admin-ai-lab-bubble-text';
    body.textContent = message.text;
    bubble.append(label, body);
    fragment.append(bubble);
  }
  list.append(fragment);
  list.scrollTop = list.scrollHeight;
}

function aiDebugSetBusy(busy) {
  aiDebugBusy = busy;
  const send = document.getElementById('aiDebugSend');
  if (send) {
    send.disabled = busy || !aiDebugConfig?.hasApiKey;
    send.textContent = busy ? '正在生成…' : '生成回复';
  }
}

async function aiDebugLoadConfig(force = false) {
  if (aiDebugLoading && !force) return aiDebugLoading;
  const promptInput = document.getElementById('aiDebugPrompt');
  const provider = document.getElementById('aiDebugProvider');
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
      if (provider) {
        provider.textContent = '当前供应商：' + (result.provider || '未知') +
          ' · 模型：' + (result.model || '未指定') +
          (result.hasApiKey ? '' : ' · 未配置 API Key');
      }
      aiDebugSetStatus('测试历史仅存于当前浏览器标签页。草稿测试不会修改正式提示词。');
      aiDebugSetBusy(aiDebugBusy);
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
  if (!message || message.length > 1200) {
    aiDebugSetStatus('请输入不超过 1200 字的对方消息。', true);
    return;
  }
  if (!prompt || prompt.length > 6000) {
    aiDebugSetStatus('请输入不超过 6000 字的系统提示词。', true);
    return;
  }
  if (!aiDebugConfig?.hasApiKey) {
    aiDebugSetStatus('当前 AI 供应商没有配置 API Key，请先在 AI 服务设置中配置。', true);
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
      body: JSON.stringify({ systemPrompt: prompt, history: nextHistory })
    });
    const data = await response.json();
    if (version !== aiDebugVersion) return;
    if (!response.ok || !data.ok || typeof data.reply !== 'string' || !data.reply.trim()) {
      throw new Error(data.error || 'AI 未返回有效回复');
    }
    aiDebugHistory = [...nextHistory, { sender: 'self', text: data.reply }];
    aiDebugPersist();
    aiDebugRender();
    if (input) input.value = '';
    aiDebugSetStatus('回复生成完成。显示的是正式生成服务提取的 reply 字段。');
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
  aiDebugRender();

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
  document.getElementById('aiDebugClear')?.addEventListener('click', () => {
    ++aiDebugVersion;
    aiDebugController?.abort();
    aiDebugController = null;
    aiDebugHistory = [];
    aiDebugPersist();
    aiDebugSetBusy(false);
    aiDebugRender();
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
