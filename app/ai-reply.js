'use strict';

// MOMO AI 自动回复前端交互逻辑 (DeepSeek API 集成)
(function () {
  let currentRevision = 1;
  let activeRunId = null;
  let pollTimer = null;

  const els = {
    mode: document.getElementById('aiMode'),
    systemPrompt: document.getElementById('aiSystemPrompt'),
    handoffEnabled: document.getElementById('aiHandoffEnabled'),
    handoffSegments: document.getElementById('aiHandoffSegments'),
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
        if (els.systemPrompt) els.systemPrompt.value = s.systemPrompt || '';
        if (els.handoffEnabled) els.handoffEnabled.value = s.handoffEnabled === true ? 'on' : 'off';
        if (els.handoffSegments) els.handoffSegments.value = Array.isArray(s.handoffSegments) ? s.handoffSegments.join('\n\n') : '';
        showStatus(s.ready ? 'AI已就绪' : '后台未配Key', s.ready ? 'success' : 'normal');
      }
    } catch {}
  }

  async function saveConfig() {
    try {
      showStatus('正在保存…', 'running');
      const payload = {
        expectedRevision: currentRevision,
        systemPrompt: els.systemPrompt?.value?.trim() || '',
        handoffEnabled: els.handoffEnabled ? els.handoffEnabled.value === 'on' : false,
        handoffSegments: els.handoffSegments?.value || ''
      };

      const res = await fetch('/api/ai-reply/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok && data.settings) {
        currentRevision = data.settings.revision;
        showStatus('提示词已保存', 'success');
      } else {
        showStatus('保存失败', 'error');
        displayResult(data.error || '保存提示词失败');
      }
    } catch (err) {
      showStatus('保存出错', 'error');
      displayResult(err.message);
    }
  }

  async function testApi() {
    try {
      showStatus('测试连接…', 'running');
      displayResult('正在请求后台配置的统一全局 AI 接口进行握手测试...');

      const res = await fetch('/api/ai-reply/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (data.ok) {
        showStatus('连接正常', 'success');
        displayResult(`🎉 AI 接口握手成功！\n模型: ${data.model}\n测试回复: ${data.response}\n请求编号: ${data.requestId || 'ok'}`);
      } else {
        showStatus('连接失败', 'error');
        displayResult(data.error?.message || '测试失败，请联系管理员检查后台 AI 接口与 Key 配置');
      }
    } catch (err) {
      showStatus('连接异常', 'error');
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
        window.showToast('请先在左侧选择目标云手机', 'error');
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
