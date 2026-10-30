'use strict';

// MOMO 持续监听与调度中枢：消息回复页的策略配置 + 任务页的调度控制卡片。

(function () {
  let currentBrainRevision = 1;
  let statusPollTimer = null;
  let configRequest = 0;
  let activePoll = null;
  let lastStatus = null;

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

  function setRunningBadge(text, tone = '') {
    if (cardEls.badge) { cardEls.badge.textContent = text; cardEls.badge.className = 'badge' + (tone ? ' ' + tone : ''); }
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

  /* ---------- 任务页调度控制卡片 ---------- */

  const cardEls = {};

  function renderBrainCard() {
    const host = document.getElementById('brainCardHost');
    if (!host) return;
    host.innerHTML = `
      <section class="panel sub-card">
        <div class="panel-head"><h2>持续监听与调度</h2><span class="badge" id="brainRunBadge">待命</span></div>
        <div class="block">
          <div class="phase-text" id="brainPhaseDisplay">请先选择目标云手机</div>
          <div class="save-row" style="border-top:0; padding-top:0; margin-top:0;">
            <button class="btn primary" id="btnBrainStart" type="button">启动调度</button>
            <button class="btn" id="btnBrainPause" type="button" disabled>暂停</button>
            <button class="btn" id="btnBrainResume" type="button" disabled>恢复</button>
            <button class="btn danger" id="btnBrainStop" type="button" disabled>停止</button>
          </div>
          <div class="result-box"><pre id="brainEventLogPre">等待启动调度…</pre></div>
        </div>
      </section>`;
    cardEls.badge = document.getElementById('brainRunBadge');
    cardEls.phase = document.getElementById('brainPhaseDisplay');
    cardEls.start = document.getElementById('btnBrainStart');
    cardEls.pause = document.getElementById('btnBrainPause');
    cardEls.resume = document.getElementById('btnBrainResume');
    cardEls.stop = document.getElementById('btnBrainStop');
    cardEls.events = document.getElementById('brainEventLogPre');
    cardEls.start?.addEventListener('click', () => postAction('/api/momo-brain/start'));
    cardEls.pause?.addEventListener('click', () => postAction('/api/momo-brain/pause'));
    cardEls.resume?.addEventListener('click', () => postAction('/api/momo-brain/resume'));
    cardEls.stop?.addEventListener('click', () => postAction('/api/momo-brain/stop'));
    if (lastStatus) applyStatus(lastStatus);
    pollStatus();
  }

  async function pollStatus() {
    const devId = getSelectedDeviceId();
    const pollKey = devId + ':' + configRequest;
    if (activePoll === pollKey) return;
    if (!devId) {
      setRunningBadge('未选云机', 'warn');
      if (cardEls.phase) cardEls.phase.textContent = '请先在「设备」页选择目标云手机';
      return;
    }
    activePoll = pollKey;
    try {
      const res = await fetch(`/api/momo-brain/status?deviceId=${encodeURIComponent(devId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.status) {
          lastStatus = data.status;
          applyStatus(data.status);
        }
      }
      const evtRes = await fetch(`/api/momo-brain/events?deviceId=${encodeURIComponent(devId)}&limit=10`);
      if (evtRes.ok && cardEls.events) {
        const evtData = await evtRes.json();
        if (evtData.ok) {
          cardEls.events.textContent = (evtData.events || [])
            .map(e => `[${String(e.createdAt).slice(11, 19)}] ${e.eventType}: ${e.detailsJson}`).join('\n') || '暂无事件记录';
        }
      }
    } catch { /* 静默 */ }
    finally { if (activePoll === pollKey) activePoll = null; }
  }

  function applyStatus(s) {
    if (s.quarantined) setRunningBadge('已隔离(保护)', 'err');
    else if (s.running) {
      if (s.desiredState === 'paused' || s.actualState === 'paused_manual') setRunningBadge('已暂停(人工占用)', 'warn');
      else setRunningBadge(`巡检中 (${s.mode})`, 'run');
    } else setRunningBadge('已停止', '');

    if (cardEls.phase) {
      cardEls.phase.textContent = `状态: ${s.actualState} | 阶段: ${s.currentPhase} | 互斥锁: ${s.busy ? '占用中' : '空闲'}`;
    }
    if (cardEls.start) cardEls.start.disabled = Boolean(s.running);
    if (cardEls.pause) cardEls.pause.disabled = !s.running || s.desiredState === 'paused';
    if (cardEls.resume) cardEls.resume.disabled = !s.running || s.desiredState === 'running';
    if (cardEls.stop) cardEls.stop.disabled = !s.running;
  }

  async function postAction(actionPath) {
    const devId = getSelectedDeviceId();
    if (!devId) { showToast('请先选择目标云机'); return; }
    try {
      const response = await fetch(actionPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: devId, mode: currentMode() })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error?.message || data.error || '操作失败');
      showToast('调度指令已下发');
      pollStatus();
    } catch (err) {
      showToast('操作失败: ' + err.message);
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

  const handleDeviceChange = () => { loadBrainConfig(); pollStatus(); };
  window.addEventListener('device:selected', handleDeviceChange);
  window.YunMomo?.store?.on?.('device:selected', handleDeviceChange);
  window.YunMomo?.store?.on?.('tasks:rendered', renderBrainCard);
  window.YunMomo?.store?.on?.('auth:changed', () => { applyRole(); loadBrainConfig(); });

  applyRole();
  loadBrainConfig();
  pollStatus();
  statusPollTimer = setInterval(pollStatus, 2000);
})();
