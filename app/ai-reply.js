'use strict';

// MOMO AI 自动回复：消息回复页的配置读写。
// 所有用户均可配置提示词与话术（无角色限制）。

(function () {
  let currentRevision = 1;

  const DEFAULT_SYSTEM_PROMPT = `你是一个友好自然的真人，正在与朋友在社交App上聊天。
【回复要求】：
1. 语言简短真实、口语生活化，每次只回复一两句话，严禁出现AI助手或客服腔调。
2. 务必使用常见高频的日常字词（例如用"躺着/歇着/呆着/玩呢"代替低频生僻字，避免使用"瘫/憩"等非首屏汉字），便于手机输入法直接输入。
3. 严禁使用生僻词、文言词、成语或火星文。`;

  const els = {
    systemPrompt: document.getElementById('aiSystemPrompt'),
    promptCharCount: document.getElementById('promptCharCount'),
    btnResetDefault: document.getElementById('btnResetDefaultPrompt'),
    saveBadge: document.getElementById('aiSaveBadge'),

    handoffEnabled: document.getElementById('aiHandoffEnabled'),
    handoffBadge: document.getElementById('handoffStateBadge'),
    handoffSegments: document.getElementById('aiHandoffSegments'),
    segmentsCountBadge: document.getElementById('segmentsCountBadge'),
    segmentsPreviewList: document.getElementById('segmentsPreviewList'),

    aiPingIndicator: document.getElementById('aiPingIndicator'),
    aiModelLabel: document.getElementById('aiModelLabel'),
    btnTest: document.getElementById('btnTestAiApi'),
    btnSave: document.getElementById('btnSaveAiConfig'),
    btnSaveTop: document.getElementById('btnSaveAiConfigTop'),

    statusBadge: document.getElementById('aiReplyStatusBadge')
  };

  const toast = (msg, type) => {
    if (typeof showToast === 'function') {
      showToast(msg, type);
    } else if (window.showToast) {
      window.showToast(msg, type);
    } else {
      console.log(msg);
    }
  };

  function getAuthHeaders() {
    return { 'Content-Type': 'application/json' };
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setSaveBadge(text, tone = '') {
    if (!els.saveBadge) return;
    els.saveBadge.textContent = text;
    els.saveBadge.className = 'badge' + (tone ? ' ' + tone : '');
  }

  function setStatus(text, tone = '') {
    if (!els.statusBadge) return;
    els.statusBadge.textContent = text;
    els.statusBadge.className = 'badge' + (tone ? ' ' + tone : '');
  }

  function syncHandoffBadge() {
    if (!els.handoffBadge || !els.handoffEnabled) return;
    const on = els.handoffEnabled.value === 'on';
    els.handoffBadge.textContent = on ? '连发开启' : '连发关闭';
    els.handoffBadge.className = 'badge' + (on ? ' ok' : '');
  }

  function updatePromptCharCount() {
    if (!els.promptCharCount || !els.systemPrompt) return;
    const len = (els.systemPrompt.value || '').length;
    els.promptCharCount.textContent = `${len} 字`;
  }

  function updateSegmentsPreview() {
    if (!els.segmentsPreviewList) return;
    const raw = els.handoffSegments ? els.handoffSegments.value : '';
    const segments = raw
      .split(/\n\s*\n/)
      .map(s => s.trim())
      .filter(Boolean);

    if (els.segmentsCountBadge) {
      els.segmentsCountBadge.textContent = `共 ${segments.length} 段`;
    }

    if (!segments.length) {
      els.segmentsPreviewList.innerHTML = '<div class="empty-preview">暂无话术段落，在上方输入并空行分隔</div>';
      return;
    }

    els.segmentsPreviewList.innerHTML = segments.map((seg, idx) => `
      <div class="preview-segment-item">
        <span class="segment-order">#${idx + 1}</span>
        <span class="segment-text">${escapeHtml(seg)}</span>
        <span class="segment-meta">${seg.length} 字</span>
      </div>
    `).join('');
  }

  function updateServiceStatus(ready, modelName) {
    if (els.aiModelLabel) {
      els.aiModelLabel.textContent = modelName ? `模型: ${modelName}` : (ready ? 'AI 就绪' : '未配 Key');
    }
    if (els.aiPingIndicator) {
      els.aiPingIndicator.className = 'ai-ping-indicator' + (ready ? ' online' : '');
      els.aiPingIndicator.title = ready ? '服务正常就绪' : '后台未配 Key';
    }
  }

  function resetDefaultPrompt() {
    if (!els.systemPrompt) return;
    const current = (els.systemPrompt.value || '').trim();
    if (current && current !== DEFAULT_SYSTEM_PROMPT.trim()) {
      if (!confirm('确定载入默认人设模板吗？当前输入框中的内容将被替换，点击保存后生效。')) {
        return;
      }
    }
    els.systemPrompt.value = DEFAULT_SYSTEM_PROMPT;
    updatePromptCharCount();
    setSaveBadge('未保存修改', 'warn');
    toast('已载入默认模板，点击保存后生效');
  }

  function applyRole() {
    // 所有登录用户均可自由编辑与保存
    if (els.systemPrompt) els.systemPrompt.removeAttribute('readonly');
    if (els.handoffEnabled) els.handoffEnabled.disabled = false;
    if (els.handoffSegments) els.handoffSegments.removeAttribute('readonly');
    if (els.btnSave) els.btnSave.hidden = false;
    if (els.btnSaveTop) els.btnSaveTop.hidden = false;
    if (els.btnTest) els.btnTest.hidden = false;
    if (els.btnResetDefault) els.btnResetDefault.hidden = false;
  }

  async function loadSettings() {
    try {
      const res = await fetch('/api/ai-reply/settings', { headers: getAuthHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && data.settings) {
        const s = data.settings;
        currentRevision = s.revision || 1;
        if (els.systemPrompt) els.systemPrompt.value = s.systemPrompt || '';
        if (els.handoffEnabled) {
          els.handoffEnabled.value = s.handoffEnabled === true ? 'on' : 'off';
          syncHandoffBadge();
        }
        if (els.handoffSegments) {
          els.handoffSegments.value = Array.isArray(s.handoffSegments) ? s.handoffSegments.join('\n\n') : '';
        }
        updatePromptCharCount();
        updateSegmentsPreview();
        updateServiceStatus(Boolean(s.ready), s.model);
        setStatus(s.ready ? 'AI 已就绪' : '后台未配 Key', s.ready ? 'ok' : 'warn');
        setSaveBadge('已加载');
      }
    } catch { /* 未登录或网络异常时静默，稍后由 auth:changed 触发重载 */ }
  }

  async function saveConfig() {
    try {
      setSaveBadge('保存中…', 'run');
      const payload = {
        expectedRevision: currentRevision,
        systemPrompt: els.systemPrompt?.value?.trim() || '',
        handoffEnabled: els.handoffEnabled ? els.handoffEnabled.value === 'on' : false,
        handoffSegments: els.handoffSegments?.value || ''
      };
      const res = await fetch('/api/ai-reply/settings', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok && data.settings) {
        currentRevision = data.settings.revision;
        setSaveBadge('已保存', 'ok');
        setStatus('AI 已就绪', 'ok');
        syncHandoffBadge();
        updateSegmentsPreview();
        toast('回复配置已保存');
      } else {
        setSaveBadge('保存失败', 'err');
        toast(data.error?.message || data.error || '保存提示词失败');
      }
    } catch (err) {
      setSaveBadge('保存出错', 'err');
      toast('保存出错: ' + err.message);
    }
  }

  async function testApi() {
    try {
      setSaveBadge('测试中…', 'run');
      if (els.aiPingIndicator) els.aiPingIndicator.className = 'ai-ping-indicator';
      const res = await fetch('/api/ai-reply/test', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (data.ok) {
        setSaveBadge('连接正常', 'ok');
        updateServiceStatus(true, data.model);
        setStatus('AI 已就绪', 'ok');
        toast(`AI 接口握手成功 · 模型: ${data.model || 'deepseek'}`);
      } else {
        setSaveBadge('连接失败', 'err');
        updateServiceStatus(false, '');
        if (els.aiPingIndicator) els.aiPingIndicator.className = 'ai-ping-indicator error';
        toast(data.error?.message || '测试失败，请联系管理员检查后台 AI 接口');
      }
    } catch (err) {
      setSaveBadge('连接异常', 'err');
      if (els.aiPingIndicator) els.aiPingIndicator.className = 'ai-ping-indicator error';
      toast('连接异常: ' + err.message);
    }
  }

  els.btnSave?.addEventListener('click', saveConfig);
  els.btnSaveTop?.addEventListener('click', saveConfig);
  els.btnTest?.addEventListener('click', testApi);
  els.btnResetDefault?.addEventListener('click', resetDefaultPrompt);

  els.systemPrompt?.addEventListener('input', () => {
    updatePromptCharCount();
    setSaveBadge('未保存修改', 'warn');
  });

  els.handoffSegments?.addEventListener('input', () => {
    updateSegmentsPreview();
    setSaveBadge('未保存修改', 'warn');
  });

  els.handoffEnabled?.addEventListener('change', () => {
    syncHandoffBadge();
    setSaveBadge('未保存修改', 'warn');
  });

  window.YunMomo?.store?.on?.('auth:changed', () => { applyRole(); loadSettings(); });

  applyRole();
  loadSettings();
})();
