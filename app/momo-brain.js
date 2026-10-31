'use strict';

// MOMO 持续监听与调度中枢：消息回复页的策略配置。

(function () {
  let currentBrainRevision = 1;
  let configRequest = 0;

  const els = {
    modeGroup: document.getElementById('brainModeGroup'),
    pollInterval: document.getElementById('brainPollInterval'),
    chkAutoReply: document.getElementById('brainAutoReply'),
    chkGreetings: document.getElementById('brainGreetings'),
    chkBrowse: document.getElementById('brainBrowse'),
    btnSave: document.getElementById('btnBrainSaveConfig'),
    note: document.getElementById('brainNote'),
    configBadge: document.getElementById('brainConfigBadge'),
    statusBadge: document.getElementById('aiReplyStatusBadge')
  };

  function getSelectedDeviceId() {
    if (window.YunMomo?.store?.getSelectedDeviceId) {
      const id = window.YunMomo.store.getSelectedDeviceId();
      if (id) return id;
    }
    if (window.state?.selectedDeviceId) return window.state.selectedDeviceId;
    return null;
  }

  function canManage() { return Boolean(state.isAdmin); }

  function currentMode() {
    return els.modeGroup?.querySelector('.mode-btn.active')?.dataset.mode || 'observe';
  }

  function setMode(mode) {
    for (const btn of els.modeGroup?.querySelectorAll('.mode-btn') || []) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }
  }

  function setSwitch(node, on) {
    if (node) node.classList.toggle('on', Boolean(on));
  }

  function setConfigBadge(text, tone = '') {
    if (els.configBadge) { els.configBadge.textContent = text; els.configBadge.className = 'badge' + (tone ? ' ' + tone : ''); }
  }

  function applyRole() {
    const manage = canManage();
    if (els.pollInterval) {
      if (manage) els.pollInterval.removeAttribute('readonly');
      else els.pollInterval.setAttribute('readonly', '');
    }
    if (els.btnSave) els.btnSave.hidden = !manage;
    if (els.note) els.note.hidden = manage;
  }

  /* ---------- 配置读写 ---------- */

  async function loadBrainConfig() {
    const request = ++configRequest;
    const devId = getSelectedDeviceId();
    try {
      const url = devId ? `/api/momo-brain/config?deviceId=${encodeURIComponent(devId)}` : '/api/momo-brain/config';
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (request !== configRequest || devId !== getSelectedDeviceId()) return;
      if (data.ok && data.config) {
        const c = data.config;
        currentBrainRevision = c.revision || 1;
        setMode(c.mode || 'observe');
        if (els.pollInterval) els.pollInterval.value = c.pollIntervalMs || 2000;
        setSwitch(els.chkAutoReply, c.autoReplyEnabled);
        setSwitch(els.chkGreetings, c.greetingsEnabled);
        setSwitch(els.chkBrowse, c.browseEnabled);
        setConfigBadge('已加载');
      }
    } catch { /* 未登录或网络异常时静默 */ }
  }

  async function saveBrainConfig() {
    if (!canManage()) return;
    try {
      setConfigBadge('保存中…', 'run');
      const payload = {
        expectedRevision: currentBrainRevision,
        mode: currentMode(),
        pollIntervalMs: Number(els.pollInterval?.value || 2000),
        autoReplyEnabled: els.chkAutoReply?.classList.contains('on') || false,
        browseEnabled: els.chkBrowse?.classList.contains('on') || false,
        greetingsEnabled: els.chkGreetings?.classList.contains('on') || false
      };
      const res = await fetch('/api/momo-brain/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok && data.config) {
        currentBrainRevision = data.config.revision;
        setConfigBadge('已保存', 'ok');
        showToast('回复策略已保存');
      } else {
        setConfigBadge('保存失败', 'err');
        showToast(data.error?.message || '保存失败');
      }
    } catch (err) {
      setConfigBadge('保存出错', 'err');
      showToast('保存出错: ' + err.message);
    }
  }

  /* ---------- 消息回复页交互 ---------- */

  els.modeGroup?.addEventListener('click', event => {
    const btn = event.target.closest('.mode-btn');
    if (!btn || !canManage()) return;
    setMode(btn.dataset.mode);
  });
  for (const node of [els.chkAutoReply, els.chkGreetings, els.chkBrowse]) {
    node?.addEventListener('click', () => { if (canManage()) node.classList.toggle('on'); });
  }
  els.btnSave?.addEventListener('click', saveBrainConfig);

  window.addEventListener('device:selected', loadBrainConfig);
  window.YunMomo?.store?.on?.('device:selected', loadBrainConfig);
  window.YunMomo?.store?.on?.('auth:changed', () => { applyRole(); loadBrainConfig(); });

  applyRole();
  loadBrainConfig();
})();
