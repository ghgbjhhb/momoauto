'use strict';

// MOMO AI 自动回复前端交互逻辑 (DeepSeek API 集成)
(function () {
  let currentRevision = 1;
  let activeRunId = null;
  let pollTimer = null;

  const els = {
    apiKey: document.getElementById('aiApiKey'),
    model: document.getElementById('aiModel'),
    mode: document.getElementById('aiMode'),
    systemPrompt: document.getElementById('aiSystemPrompt'),
    contactName: document.getElementById('aiContactName'),
    maxContacts: document.getElementById('aiMaxContacts'),
    btnSave: document.getElementById('btnSaveAiConfig'),
    btnTest: document.getElementById('btnTestAiApi'),
    btnRun: document.getElementById('btnRunAiReply'),
    btnCancel: document.getElementById('btnCancelAiReply'),
    statusBadge: document.getElementById('aiReplyStatusBadge'),
    resultBox: document.getElementById('aiReplyResultBox'),
    resultPre: document.getElementById('aiReplyResultPre')
  };

  if (!els.btnRun) return;

  function showStatus(text, type = 'normal') {
    if (!els.statusBadge) return;
    els.statusBadge.textContent = text;
    els.statusBadge.className = 'badge ' + (type === 'running' ? 'badge-running' : type === 'success' ? 'badge-success' : type === 'error' ? 'badge-error' : '');
  }

  function displayResult(content) {
    if (!els.resultBox || !els.resultPre) return;
    els.resultBox.hidden = false;
    els.resultPre.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  }

  async function loadSettings() {
    try {
      const res = await fetch('/api/ai-reply/settings');
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok && data.settings) {
        const s = data.settings;
        currentRevision = s.revision || 1;
        if (els.model) els.model.value = s.model || 'deepseek-chat';
        if (els.systemPrompt) els.systemPrompt.value = s.systemPrompt || '';
        if (els.apiKey) {
          els.apiKey.value = '';
          els.apiKey.placeholder = s.hasApiKey ? `已配置: ${s.apiKeyMasked} (留空保持)` : '请输入 DeepSeek API Key (sk-...)';
        }
      }
    } catch {}
  }

  async function saveConfig() {
    try {
      showStatus('正在保存…', 'running');
      const payload = {
        expectedRevision: currentRevision,
        model: els.model?.value?.trim() || 'deepseek-chat',
        systemPrompt: els.systemPrompt?.value?.trim() || ''
      };
      const keyVal = els.apiKey?.value?.trim();
      if (keyVal) payload.apiKey = keyVal;

      const res = await fetch('/api/ai-reply/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok && data.settings) {
        currentRevision = data.settings.revision;
        showStatus('已保存', 'success');
        if (els.apiKey) {
          els.apiKey.value = '';
          els.apiKey.placeholder = data.settings.hasApiKey ? `已配置: ${data.settings.apiKeyMasked}` : '请输入 API Key';
        }
      } else {
        showStatus('保存失败', 'error');
        displayResult(data.error || '保存配置失败');
      }
    } catch (err) {
      showStatus('保存出错', 'error');
      displayResult(err.message);
    }
  }

  async function testApi() {
    try {
      showStatus('测试连接…', 'running');
      displayResult('正在请求 DeepSeek API (https://api.deepseek.com)...');
      const payload = {
        model: els.model?.value?.trim() || 'deepseek-chat'
      };
      const keyVal = els.apiKey?.value?.trim();
      if (keyVal) payload.apiKey = keyVal;

      const res = await fetch('/api/ai-reply/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok) {
        showStatus('连接成功', 'success');
        displayResult(`DeepSeek 连接正常！\n模型: ${data.model}\n回复: ${data.response}\nRequest ID: ${data.requestId}`);
      } else {
        showStatus('连接失败', 'error');
        displayResult(data.error);
      }
    } catch (err) {
      showStatus('测试失败', 'error');
      displayResult(err.message);
    }
  }

  async function runAiReply() {
    let selectedDeviceId = window.YunMomo?.store?.getSelectedDeviceId?.() || window.state?.selectedDeviceId || null;
    if (!selectedDeviceId && typeof window.getSelectedDeviceId === 'function') {
      selectedDeviceId = window.getSelectedDeviceId();
    }
    if (!selectedDeviceId) {
      const card = document.querySelector('.device-card.selected');
      if (card?.dataset?.deviceId) selectedDeviceId = card.dataset.deviceId;
    }

    if (!selectedDeviceId || selectedDeviceId === '--') {
      if (typeof window.showToast === 'function') {
        window.showToast('请先在左侧选择目标云手机');
      } else {
        alert('请先在左侧选择目标云手机');
      }
      return;
    }

    try {
      showStatus('任务启动中…', 'running');
      if (els.btnCancel) els.btnCancel.hidden = false;
      if (els.btnRun) els.btnRun.disabled = true;

      const payload = {
        deviceId: selectedDeviceId,
        mode: els.mode?.value || 'execute',
        contactName: els.contactName?.value?.trim() || null,
        maxContacts: Number(els.maxContacts?.value || 1)
      };

      const res = await fetch('/api/ai-reply/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!data.ok) {
        showStatus('启动失败', 'error');
        displayResult(data.error);
        if (els.btnCancel) els.btnCancel.hidden = true;
        if (els.btnRun) els.btnRun.disabled = false;
        return;
      }

      activeRunId = data.runId;
      showStatus(`执行中 (${payload.mode})`, 'running');
      displayResult({ status: 'running', runId: activeRunId, mode: payload.mode });

      pollStatus(activeRunId);
    } catch (err) {
      showStatus('执行异常', 'error');
      displayResult(err.message);
      if (els.btnCancel) els.btnCancel.hidden = true;
      if (els.btnRun) els.btnRun.disabled = false;
    }
  }

  function pollStatus(runId) {
    if (pollTimer) clearInterval(pollTimer);
    const poll = async () => {
      if (activeRunId !== runId) return;
      try {
        const res = await fetch(`/api/ai-reply/runs/${runId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (activeRunId !== runId) return;
        if (data.status === 'completed') {
          clearInterval(pollTimer);
          activeRunId = null;
          showStatus('执行完成', 'success');
          displayResult(data.result);
          if (els.btnCancel) els.btnCancel.hidden = true;
          if (els.btnRun) els.btnRun.disabled = false;
        } else if (data.status === 'failed' || data.status === 'partial') {
          clearInterval(pollTimer);
          activeRunId = null;
          showStatus('执行结束', data.status === 'failed' ? 'error' : 'normal');
          displayResult(data.error || data.result);
          if (els.btnCancel) els.btnCancel.hidden = true;
          if (els.btnRun) els.btnRun.disabled = false;
        } else if (data.status === 'cancelled') {
          clearInterval(pollTimer);
          activeRunId = null;
          showStatus('已取消', 'normal');
          displayResult('任务已取消');
          if (els.btnCancel) els.btnCancel.hidden = true;
          if (els.btnRun) els.btnRun.disabled = false;
        }
      } catch {} finally { if (activeRunId === runId) pollTimer = setTimeout(poll, 1000); }
    };
    pollTimer = setTimeout(poll, 1000);
  }

  async function cancelRun() {
    if (!activeRunId) return;
    try {
      const response = await fetch(`/api/ai-reply/runs/${activeRunId}/cancel`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error?.message || '取消失败');
      showStatus('已请求取消', 'normal');
    } catch {}
  }

  els.btnSave?.addEventListener('click', saveConfig);
  els.btnTest?.addEventListener('click', testApi);
  els.btnRun?.addEventListener('click', runAiReply);
  els.btnCancel?.addEventListener('click', cancelRun);

  loadSettings();
})();
