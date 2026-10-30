'use strict';

// MOMO AI 自动回复：消息回复页的配置读写 + 任务页的单次执行卡片。
// 配置写入为管理员全局接口；普通用户只读并显示说明。

(function () {
  let currentRevision = 1;
  let activeRunId = null;
  let pollTimer = null;

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

  function canManage() { return Boolean(state.isAdmin); }

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
    const manage = canManage();
    if (els.systemPrompt) {
      if (manage) els.systemPrompt.removeAttribute('readonly');
      else els.systemPrompt.setAttribute('readonly', '');
    }
    if (els.handoffEnabled) els.handoffEnabled.disabled = !manage;
    if (els.handoffSegments) {
      if (manage) els.handoffSegments.removeAttribute('readonly');
      else els.handoffSegments.setAttribute('readonly', '');
    }
    if (els.btnSave) els.btnSave.hidden = !manage;
    if (els.btnTest) els.btnTest.hidden = !manage;
    if (els.note) els.note.hidden = manage;
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
        setStatus(s.ready ? 'AI 已就绪' : '后台未配 Key', s.ready ? 'ok' : 'warn');
        setSaveBadge('已加载');
      }
    } catch { /* 未登录或网络异常时静默，稍后由 auth:changed 触发重载 */ }
  }

  async function saveConfig() {
    if (!canManage()) return;
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
        headers: { 'Content-Type': 'application/json' },
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
        showToast(data.error || '保存提示词失败');
      }
    } catch (err) {
      setSaveBadge('保存出错', 'err');
      showToast('保存出错: ' + err.message);
    }
  }

  async function testApi() {
    if (!canManage()) return;
    try {
      setSaveBadge('测试连接…', 'run');
      const res = await fetch('/api/ai-reply/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  /* ---------- 任务页：AI 自动回复单次执行卡片 ---------- */

  const runEls = {
    host: null, mode: null, contact: null, max: null,
    run: null, cancel: null, badge: null, result: null
  };

  function renderRunCard() {
    const host = document.getElementById('aiRunCardHost');
    if (!host) return;
    runEls.host = host;
    host.innerHTML = `
      <section class="panel sub-card">
        <div class="panel-head"><h2>AI 自动回复 · 单次执行</h2><span class="badge" id="aiRunBadge">待命</span></div>
        <div class="block">
          <div class="field-row">
            <div class="field">
              <label for="aiRunMode">运行模式</label>
              <select class="select" id="aiRunMode">
                <option value="execute" selected>直接发送</option>
                <option value="draft">输入草稿 (不发送)</option>
              </select>
            </div>
            <div class="field">
              <label for="aiRunMaxContacts">处理人数</label>
              <input class="input" type="number" id="aiRunMaxContacts" value="1" min="1" max="5">
            </div>
          </div>
          <div class="field">
            <label for="aiRunContact">指定联系人</label>
            <input class="input" type="text" id="aiRunContact" placeholder="留空自动扫描未读联系人" autocomplete="off" spellcheck="false">
          </div>
          <div class="save-row" style="border-top:0; padding-top:0; margin-top:0;">
            <button class="btn primary" id="btnRunAiReply" type="button">${window.ic ? window.ic('play', 15) : ''} 执行一次</button>
            <button class="btn" id="btnCancelAiReply" type="button" hidden>取消</button>
          </div>
          <div class="result-box" id="aiRunResultBox" hidden><pre id="aiRunResultPre"></pre></div>
        </div>
      </section>`;
    runEls.mode = document.getElementById('aiRunMode');
    runEls.contact = document.getElementById('aiRunContact');
    runEls.max = document.getElementById('aiRunMaxContacts');
    runEls.run = document.getElementById('btnRunAiReply');
    runEls.cancel = document.getElementById('btnCancelAiReply');
    runEls.badge = document.getElementById('aiRunBadge');
    runEls.resultBox = document.getElementById('aiRunResultBox');
    runEls.resultPre = document.getElementById('aiRunResultPre');
    runEls.run?.addEventListener('click', runAiReply);
    runEls.cancel?.addEventListener('click', cancelRun);
    if (activeRunId) { if (runEls.run) runEls.run.disabled = true; if (runEls.cancel) runEls.cancel.hidden = false; }
  }

  function setRunBadge(text, tone = '') {
    if (runEls.badge) { runEls.badge.textContent = text; runEls.badge.className = 'badge' + (tone ? ' ' + tone : ''); }
  }

  function displayResult(content) {
    if (!runEls.resultBox || !runEls.resultPre) return;
    runEls.resultBox.hidden = false;
    runEls.resultPre.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  }

  function getSelectedDeviceId() {
    return window.YunMomo?.store?.getSelectedDeviceId?.() || window.state?.selectedDeviceId || null;
  }

  async function runAiReply() {
    const deviceId = getSelectedDeviceId();
    if (!deviceId) { showToast('请先选择目标云手机'); return; }
    try {
      setRunBadge('任务启动中…', 'run');
      if (runEls.cancel) runEls.cancel.hidden = false;
      if (runEls.run) runEls.run.disabled = true;
      const payload = {
        deviceId,
        mode: runEls.mode?.value || 'execute',
        contactName: runEls.contact?.value?.trim() || null,
        maxContacts: Number(runEls.max?.value || 1)
      };
      const res = await fetch('/api/ai-reply/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.ok) {
        setRunBadge('启动失败', 'err');
        displayResult(data.error?.message || data.error || '启动失败');
        if (runEls.cancel) runEls.cancel.hidden = true;
        if (runEls.run) runEls.run.disabled = false;
        return;
      }
      activeRunId = data.runId;
      setRunBadge(`执行中 (${payload.mode})`, 'run');
      displayResult({ status: 'running', runId: activeRunId, mode: payload.mode });
      pollStatus(activeRunId);
    } catch (err) {
      setRunBadge('执行异常', 'err');
      displayResult(err.message);
      if (runEls.cancel) runEls.cancel.hidden = true;
      if (runEls.run) runEls.run.disabled = false;
    }
  }

  function pollStatus(runId) {
    if (pollTimer) clearTimeout(pollTimer);
    const poll = async () => {
      if (activeRunId !== runId) return;
      try {
        const res = await fetch(`/api/ai-reply/runs/${runId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (activeRunId !== runId) return;
        if (['completed', 'failed', 'partial', 'cancelled'].includes(data.status)) {
          clearInterval(pollTimer);
          activeRunId = null;
          setRunBadge(
            data.status === 'completed' ? '执行完成' : data.status === 'cancelled' ? '已取消' : '执行结束',
            data.status === 'completed' ? 'ok' : data.status === 'failed' ? 'err' : ''
          );
          displayResult(data.error || data.result || '任务已取消');
          if (runEls.cancel) runEls.cancel.hidden = true;
          if (runEls.run) runEls.run.disabled = false;
          return;
        }
      } catch { /* 轮询异常忽略 */ }
      finally { if (activeRunId === runId) pollTimer = setTimeout(poll, 1000); }
    };
    pollTimer = setTimeout(poll, 1000);
  }

  async function cancelRun() {
    if (!activeRunId) return;
    try {
      const response = await fetch(`/api/ai-reply/runs/${activeRunId}/cancel`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error?.message || '取消失败');
      setRunBadge('已请求取消', 'warn');
    } catch (err) {
      showToast('取消失败: ' + err.message);
    }
  }

  window.addEventListener('device:selected', () => { if (activeRunId) cancelRun(); });

  window.YunMomo?.store?.on?.('tasks:rendered', renderRunCard);
  window.YunMomo?.store?.on?.('auth:changed', () => { applyRole(); loadSettings(); });

  applyRole();
  loadSettings();
})();
