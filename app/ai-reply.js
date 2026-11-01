'use strict';

// MOMO AI 自动回复：消息回复页的配置读写。
// 所有用户均可配置提示词与话术（无角色限制）。

(function () {
  let currentRevision = 1;

  const els = {
    systemPrompt: document.getElementById('aiSystemPrompt'),
    handoffEnabled: document.getElementById('aiHandoffEnabled'),
    handoffSegments: document.getElementById('aiHandoffSegments'),
    btnSave: document.getElementById('btnSaveAiConfig'),
    btnTest: document.getElementById('btnTestAiApi'),
    statusBadge: document.getElementById('aiReplyStatusBadge'),
    saveBadge: document.getElementById('aiSaveBadge'),
    note: document.getElementById('aiReplyNote')
  };

  function getAuthHeaders() {
    return { 'Content-Type': 'application/json' };
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

  function applyRole() {
    // 所有登录用户均可自由编辑与保存
    if (els.systemPrompt) els.systemPrompt.removeAttribute('readonly');
    if (els.handoffEnabled) els.handoffEnabled.disabled = false;
    if (els.handoffSegments) els.handoffSegments.removeAttribute('readonly');
    if (els.btnSave) els.btnSave.hidden = false;
    if (els.btnTest) els.btnTest.hidden = false;
    if (els.note) els.note.hidden = true;
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
        if (els.handoffEnabled) els.handoffEnabled.value = s.handoffEnabled === true ? 'on' : 'off';
        if (els.handoffSegments) els.handoffSegments.value = Array.isArray(s.handoffSegments) ? s.handoffSegments.join('\n\n') : '';
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
        showToast('回复配置已保存');
      } else {
        setSaveBadge('保存失败', 'err');
        showToast(data.error?.message || data.error || '保存提示词失败');
      }
    } catch (err) {
      setSaveBadge('保存出错', 'err');
      showToast('保存出错: ' + err.message);
    }
  }

  async function testApi() {
    try {
      setSaveBadge('测试连接…', 'run');
      const res = await fetch('/api/ai-reply/test', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (data.ok) {
        setSaveBadge('连接正常', 'ok');
        showToast(`AI 接口握手成功 · 模型: ${data.model}`);
      } else {
        setSaveBadge('连接失败', 'err');
        showToast(data.error?.message || '测试失败，请联系管理员检查后台 AI 接口');
      }
    } catch (err) {
      setSaveBadge('连接异常', 'err');
      showToast('连接异常: ' + err.message);
    }
  }

  els.btnSave?.addEventListener('click', saveConfig);
  els.btnTest?.addEventListener('click', testApi);

  window.YunMomo?.store?.on?.('auth:changed', () => { applyRole(); loadSettings(); });

  applyRole();
  loadSettings();
})();
