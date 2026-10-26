'use strict';

// MOMO 持续监听与调度中枢前端控制器 (Brain Dashboard Controller)
(function () {
  let currentBrainRevision = 1;
  let statusPollTimer = null;
  let selectionEpoch = 0, configRequest = 0, activePoll = null;

  const els = {
    card: document.getElementById('momoBrainCard'),
    statusBadge: document.getElementById('brainStatusBadge'),
    modeSelect: document.getElementById('brainModeSelect'),
    pollInterval: document.getElementById('brainPollInterval'),
    chkAutoReply: document.getElementById('brainAutoReply'),
    chkBrowse: document.getElementById('brainBrowse'),
    chkGreetings: document.getElementById('brainGreetings'),
    btnStart: document.getElementById('btnBrainStart'),
    btnPause: document.getElementById('btnBrainPause'),
    btnResume: document.getElementById('btnBrainResume'),
    btnStop: document.getElementById('btnBrainStop'),
    btnSaveConfig: document.getElementById('btnBrainSaveConfig'),
    phaseDisplay: document.getElementById('brainPhaseDisplay'),
    eventLogPre: document.getElementById('brainEventLogPre')
  };

  if (!els.card || !els.btnStart) return;

  function getSelectedDeviceId() {
    if (typeof window.getSelectedDeviceId === 'function') {
      const id = window.getSelectedDeviceId();
      if (id) return id;
    }
    const card = document.querySelector('.device-card.selected');
    if (card?.dataset?.deviceId) return card.dataset.deviceId;
    return null;
  }

  function setBadge(text, type = 'normal') {
    if (!els.statusBadge) return;
    els.statusBadge.textContent = text;
    els.statusBadge.className = 'badge ' + (type === 'running' ? 'badge-running' : type === 'paused' ? 'badge-warning' : type === 'error' ? 'badge-error' : '');
  }

  async function loadBrainConfig() {
    const request = ++configRequest;
    try {
      const devId = getSelectedDeviceId();
      const url = devId ? `/api/momo-brain/config?deviceId=${encodeURIComponent(devId)}` : '/api/momo-brain/config';
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (request !== configRequest || devId !== getSelectedDeviceId()) return;
      if (data.ok && data.config) {
        const c = data.config;
        currentBrainRevision = c.revision || 1;
        if (els.modeSelect) els.modeSelect.value = c.mode || 'observe';
        if (els.pollInterval) els.pollInterval.value = c.pollIntervalMs || 2000;
        if (els.chkAutoReply) els.chkAutoReply.checked = Boolean(c.autoReplyEnabled);
        if (els.chkBrowse) els.chkBrowse.checked = Boolean(c.browseEnabled);
        if (els.chkGreetings) els.chkGreetings.checked = Boolean(c.greetingsEnabled);
      }
    } catch {}
  }

  async function saveBrainConfig() {
    const devId = getSelectedDeviceId(), epoch = selectionEpoch;
    try {
      setBadge('保存中…', 'normal');
      const payload = {
        expectedRevision: currentBrainRevision,
        mode: els.modeSelect?.value || 'observe',
        pollIntervalMs: Number(els.pollInterval?.value || 2000),
        autoReplyEnabled: Boolean(els.chkAutoReply?.checked),
        browseEnabled: Boolean(els.chkBrowse?.checked),
        greetingsEnabled: Boolean(els.chkGreetings?.checked)
      };

      const res = await fetch('/api/momo-brain/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (epoch !== selectionEpoch || devId !== getSelectedDeviceId()) return;
      if (data.ok && data.config) {
        currentBrainRevision = data.config.revision;
        setBadge('配置已保存', 'normal');
      } else {
        alert(data.error?.message || '保存失败');
      }
    } catch (err) {
      alert('保存出错: ' + err.message);
    }
  }

  async function pollStatus() {
    const devId = getSelectedDeviceId();
    const epoch = selectionEpoch, pollKey = devId + ':' + epoch;
    if (activePoll === pollKey) return;
    if (!devId) {
      setBadge('未选云机', 'normal');
      if (els.phaseDisplay) els.phaseDisplay.textContent = '请先选择目标云手机';
      return;
    }

    activePoll = pollKey;
    const isCurrent = () => epoch === selectionEpoch && devId === getSelectedDeviceId();
    try {
      const res = await fetch(`/api/momo-brain/status?deviceId=${encodeURIComponent(devId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!isCurrent()) return;
      if (data.ok && data.status) {
        const s = data.status;
        if (s.quarantined) {
          setBadge('已隔离(保护)', 'error');
        } else if (s.running) {
          if (s.desiredState === 'paused' || s.actualState === 'paused_manual') {
            setBadge('已暂停(人工占用)', 'paused');
          } else {
            setBadge(`巡检中 (${s.mode})`, 'running');
          }
        } else {
          setBadge('已停止', 'normal');
        }

        if (els.phaseDisplay) {
          els.phaseDisplay.textContent = `状态: ${s.actualState} | 阶段: ${s.currentPhase} | 互斥锁: ${s.busy ? '占用中' : '空闲'}`;
        }

        // 更新按钮状态
        if (els.btnStart) els.btnStart.disabled = s.running;
        if (els.btnPause) els.btnPause.disabled = !s.running || s.desiredState === 'paused';
        if (els.btnResume) els.btnResume.disabled = !s.running || s.desiredState === 'running';
        if (els.btnStop) els.btnStop.disabled = !s.running;
      }

      // 获取近期日志
      const evtRes = await fetch(`/api/momo-brain/events?deviceId=${encodeURIComponent(devId)}&limit=10`);
      if (evtRes.ok) {
        const evtData = await evtRes.json();
        if (!isCurrent()) return;
        if (evtData.ok && els.eventLogPre) {
          els.eventLogPre.textContent = (evtData.events || []).map(e => `[${e.createdAt.slice(11, 19)}] ${e.eventType}: ${e.detailsJson}`).join('\n') || '暂无事件记录';
        }
      }
    } catch {} finally { if (activePoll === pollKey) activePoll = null; }
  }

  async function postAction(actionPath) {
    const devId = getSelectedDeviceId();
    if (!devId) {
      alert('请先选择目标云机');
      return;
    }
    try {
      const response = await fetch(actionPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: devId, mode: els.modeSelect?.value || 'observe' })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error?.message || '操作失败');
      if (devId === getSelectedDeviceId()) pollStatus();
    } catch (err) {
      alert('操作失败: ' + err.message);
    }
  }

  els.btnSaveConfig?.addEventListener('click', saveBrainConfig);
  els.btnStart?.addEventListener('click', () => postAction('/api/momo-brain/start'));
  els.btnPause?.addEventListener('click', () => postAction('/api/momo-brain/pause'));
  els.btnResume?.addEventListener('click', () => postAction('/api/momo-brain/resume'));
  els.btnStop?.addEventListener('click', () => postAction('/api/momo-brain/stop'));

  window.addEventListener('device:selected', () => { selectionEpoch++; loadBrainConfig(); pollStatus(); });
  loadBrainConfig();
  pollStatus();
  statusPollTimer = setInterval(pollStatus, 2000);
})();
