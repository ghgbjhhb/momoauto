'use strict';

// V3 设备模块：画面预览（单台直播 / 宫格截图）、设备表格、状态栏与最近活动。

const TILE_SHOT_TTL = 12000;
const SHOT_CONCURRENCY = 2;
let shotActive = 0;
const shotQueue = [];

function deviceIndexLabel(device) {
  const index = state.devices.indexOf(device) + 1;
  return '#' + String(index > 0 ? index : 1).padStart(2, '0');
}

function deviceRunning(deviceId) {
  return state.runtimeState.runs.some(run => run.deviceId === deviceId);
}

// 画面流健康度：平台接口不回报在线状态，徽章状态以「显式离线信号 + 直播流实测」为准
const streamHealth = new Map(); // deviceId -> { ok, at }

function deviceStatusKey(device) {
  const id = device.deviceId;
  if (!isOnline(device)) return 'down';
  if (deviceRunning(id)) return 'busy';
  const health = streamHealth.get(id);
  if (health && !health.ok && Date.now() - health.at < 20000) return 'down';
  return 'online';
}

const STATUS_TEXT = { online: '在线', busy: '运行中', down: '离线' };

// 状态仅在变化时刷新徽章/统计，避免直播每帧触发 DOM 重排
let lastStatusSnapshot = '';

function renderStatusBadges(force = false) {
  const device = currentDevice();
  const snapshot = state.devices.map(d => deviceStatusKey(d)).join(',') + '|' + (device ? deviceStatusKey(device) : '');
  if (!force && snapshot === lastStatusSnapshot) return;
  lastStatusSnapshot = snapshot;
  renderStatusBar();
  renderDeviceChips();
  if (state.view === 'single') { renderViewerCaption(); updateDeviceMeta(device); }
  if (state.page === 'devices') renderDeviceTable();
}

function deviceStatusBadge(device) {
  const key = deviceStatusKey(device);
  const cls = key === 'online' ? 'ok' : key === 'busy' ? 'run' : 'err';
  return `<span class="badge ${cls}">${STATUS_TEXT[key]}</span>`;
}

function selectDevice(deviceId) {
  if (!state.devices.some(device => device.deviceId === deviceId)) return;
  const changed = state.selectedDeviceId !== deviceId;
  state.selectedDeviceId = deviceId;
  renderDeviceChips();
  renderViewer();
  renderStatusBar();
  renderRecentActivity();
  renderDeviceTable();
  if (changed) {
    eventBus.dispatchEvent(new CustomEvent('device:selected', { detail: { deviceId } }));
    window.dispatchEvent(new CustomEvent('device:selected', { detail: { deviceId } }));
  }
}
window.selectDevice = selectDevice;

/* ---------- 顶部统计 ---------- */

function renderStatusBar() {
  const bar = elements.statusBar;
  if (!bar) return;
  const total = state.devices.length;
  const offline = state.devices.filter(d => deviceStatusKey(d) === 'down').length;
  const running = state.runtimeState.runs.length;
  const online = total - offline;
  bar.innerHTML = `
    <div class="stat"><span class="stat-label">全部设备</span><span class="stat-val">${total}</span></div>
    <div class="stat"><span class="stat-label">在线</span><span class="stat-val good">${online}</span></div>
    <div class="stat"><span class="stat-label">正在运行</span><span class="stat-val">${running}</span></div>
    <div class="stat"><span class="stat-label">离线</span><span class="stat-val warn">${offline}</span></div>
  `;
}

/* ---------- 设备切换条 ---------- */

function renderDeviceChips() {
  const wrap = elements.deviceChips;
  if (!wrap) return;
  wrap.innerHTML = state.devices.map(device => {
    const key = deviceStatusKey(device);
    return `<button class="device-chip ${state.selectedDeviceId === device.deviceId ? 'selected' : ''} ${key === 'down' ? 'down' : key === 'busy' ? 'running' : ''}" data-chip-device="${escapeHtml(device.deviceId)}" title="${escapeHtml(deviceLabel(device))}"><b>${deviceIndexLabel(device)} ${escapeHtml(device.name)}</b><small>${STATUS_TEXT[key]}</small></button>`;
  }).join('');
}

/* ---------- 画面预览 ---------- */

function renderViewer() {
  const stage = elements.viewerStage;
  if (!stage) return;
  lastStatusSnapshot = '';
  if (state.view === 'grid') { renderGridViewer(); return; }
  renderSingleViewer();
}

function closeAllPlayers() {
  for (const timer of state.previewRetry.values()) clearTimeout(timer);
  state.previewRetry.clear();
  for (const [deviceId, player] of state.previewPlayers) {
    state.previewPlayers.delete(deviceId);
    window.dispatchEvent(new CustomEvent('device-preview:closed', { detail: { deviceId, player } }));
    try { player.close(); } catch {}
  }
  streamHealth.clear();
}

function stopPreview() {
  closeAllPlayers();
}
window.stopPreview = stopPreview;

function hasLiveFrame(player) {
  const at = player?.stats?.frameAt || 0;
  return Boolean(at) && Date.now() - at < 5000;
}

function renderSingleViewer() {
  const stage = elements.viewerStage;
  const device = currentDevice();
  const id = device ? device.deviceId : '';

  if (!device) {
    stage.dataset.viewerDevice = '';
    stage.innerHTML = `<div class="viewer-hint">${state.tokenConfigured ? '暂无云机，请先兑换卡密' : '尚未连接云机平台'}</div>`;
    renderViewerCaption();
    return;
  }

  // 关闭非当前设备的直播占用
  for (const [pid, player] of state.previewPlayers) {
    if (pid !== id) {
      state.previewPlayers.delete(pid);
      try { player.close(); } catch {}
    }
  }

  // 保留已渲染的 DOM 与画布（保留最后一帧），仅设备切换时重建
  let frame = stage.querySelector('.device-frame');
  if (!frame || stage.dataset.viewerDevice !== id) {
    stage.dataset.viewerDevice = id;
    stage.innerHTML = `
      <div class="phone-stage">
        <div class="device-frame" style="aspect-ratio: 9/16;"><canvas class="device-canvas" aria-label="云手机实时画面" hidden></canvas></div>
        <div class="viewer-hint" hidden>正在连接画面…</div>
        <div class="offline-cover" hidden>设备离线</div>
      </div>
    `;
    frame = stage.querySelector('.device-frame');
  }

  updateDeviceMeta(device);

  const canvas = frame.querySelector('canvas');
  const hint = stage.querySelector('.viewer-hint');
  const cover = stage.querySelector('.offline-cover');

  if (!state.previewPlayers.has(id)) {
    clearTimeout(state.previewRetry.get(id));
    state.previewRetry.delete(id);
    if (hint) { hint.textContent = '正在连接画面…'; hint.hidden = false; }
    createPreviewPlayer(device, canvas, hint, cover);
  } else if (hasLiveFrame(state.previewPlayers.get(id))) {
    // 直播流仍在出帧：即使平台声明离线也以画面实测为准，不遮挡
    if (cover) cover.hidden = true;
    if (hint) hint.hidden = true;
  } else if (!isOnline(device)) {
    // 平台明确回报离线且无直播帧时才显示「设备离线」遮罩，与徽章状态同口径
    if (cover) cover.hidden = false;
    if (hint) hint.hidden = true;
  } else if (hint) {
    // 在线但直播流短暂断帧（画面静止/切回页面后解码器重建），watchdog 正在要关键帧自动恢复
    if (cover) cover.hidden = true;
    hint.textContent = '画面恢复中…';
    hint.hidden = false;
  }
  renderViewerCaption();
}

function updateDeviceMeta(device, stats = null) {
  const metaEl = byId('ovDeviceMeta');
  if (!metaEl || !device) return;
  const nameEl = byId('metaDevName');
  if (nameEl) nameEl.textContent = `${deviceIndexLabel(device)} ${device.name}`;

  const ipEl = byId('metaDevIp');
  if (ipEl) {
    ipEl.textContent = device.currentIp || '局域网';
    ipEl.title = `当前 IP / 代理: ${device.currentIp || '自动分配'}`;
  }

  const resEl = byId('metaDevRes');
  if (resEl) {
    resEl.textContent = stats?.width && stats?.height ? `${stats.width}×${stats.height}` : '720×1280';
  }

  const copyBtn = byId('metaCopyIdBtn');
  if (copyBtn) {
    copyBtn.innerHTML = ic('copy', 12);
    copyBtn.onclick = () => copyToClipboard(device.deviceId, `已复制虚拟机 ID: ${device.deviceId}`);
  }

  const manualBtn = byId('metaManualBtn');
  if (manualBtn) {
    manualBtn.innerHTML = `${ic('maximize', 12)} 手动控制`;
    manualBtn.onclick = () => {
      if (typeof window.openManualControl === 'function') window.openManualControl(device);
      else showToast('控制台组件加载中，请稍候');
    };
  }
}
window.updateDeviceMeta = updateDeviceMeta;

function createPreviewPlayer(device, canvas, hint, cover) {
  const id = device.deviceId;
  const markHealth = ok => streamHealth.set(id, { ok, at: Date.now() });
  const player = new CloudVideoPlayer({
    canvas,
    deviceId: id,
    onFrame(stats) {
      markHealth(true);
      canvas.hidden = false;
      if (hint) hint.hidden = true;
      if (cover) cover.hidden = true;
      renderStatusBadges();

      const stage = elements.viewerStage;
      const currentFrame = stage?.querySelector('.device-frame');
      const w = stats?.width || canvas.width;
      const h = stats?.height || canvas.height;
      if (w && h && currentFrame) {
        currentFrame.style.aspectRatio = `${w} / ${h}`;
        updateDeviceMeta(device, { width: w, height: h });
      }
    },
    onMessage(message) {
      if (message.type === 'error' && hint) { hint.hidden = false; hint.textContent = message.message; }
    },
    onError(error) {
      markHealth(false);
      if (hint) { hint.hidden = false; hint.textContent = error.message; }
      renderStatusBadges();
    },
    onClose(code) {
      if (state.previewPlayers.get(id) !== player) return;
      state.previewPlayers.delete(id);
      markHealth(false);
      window.dispatchEvent(new CustomEvent('device-preview:closed', { detail: { deviceId: id, player } }));
      // 保留最后一帧画面，仅叠加提示；状态徽章随之切为「离线」直到重连成功
      if (hint) { hint.hidden = false; hint.textContent = code ? '画面连接中断，正在重连…' : '画面已暂停'; }
      if (cover) cover.hidden = true;
      renderStatusBadges();
      if (CloudVideoPlayer.canReconnect(code) && state.page === 'overview' && state.view === 'single' && state.selectedDeviceId === id) {
        state.previewRetry.set(id, setTimeout(() => renderSingleViewer(), 3000));
      }
    }
  });
  state.previewPlayers.set(id, player);
}

function renderViewerCaption() {
  const caption = elements.viewerCaption;
  const actions = elements.viewerActions;
  const device = currentDevice();
  if (caption) {
    caption.innerHTML = state.view === 'grid'
      ? `<strong>设备概览</strong><span class="badge">${state.devices.length} 台</span>`
      : device
        ? `<strong>${deviceIndexLabel(device)} ${escapeHtml(device.name)}</strong>${deviceStatusBadge(device)}<span class="cell-mono">${escapeHtml(device.deviceId)}</span>`
        : '<strong>未选择设备</strong>';
  }
  if (actions) {
    actions.innerHTML = state.view === 'grid'
      ? '<span class="hint">点击卡片切换当前设备</span>'
      : `<button class="btn sm" id="viewerCopyIdBtn" type="button">${ic('copy', 14)} 复制ID</button>
         <button class="btn sm primary" id="viewerManualBtn" type="button" ${!device ? 'disabled' : ''}>${ic('maximize', 14)} 手动控制</button>`;
    const copyBtn = byId('viewerCopyIdBtn');
    if (copyBtn && device) copyBtn.addEventListener('click', () => copyToClipboard(device.deviceId, `已复制虚拟机 ID: ${device.deviceId}`));
    const manualBtn = byId('viewerManualBtn');
    if (manualBtn && device) manualBtn.addEventListener('click', () => {
      if (typeof window.openManualControl === 'function') window.openManualControl(device);
      else showToast('控制台组件加载中，请稍候');
    });
  }
}

/* ---------- 宫格视图（截图快照） ---------- */

function renderGridViewer() {
  const stage = elements.viewerStage;
  stage.dataset.viewerDevice = '';
  closeAllPlayers();

  stage.innerHTML = `<div class="device-grid">${state.devices.map(device => {
    const key = deviceStatusKey(device);
    return `<button class="device-tile ${state.selectedDeviceId === device.deviceId ? 'selected' : ''}" data-tile-device="${escapeHtml(device.deviceId)}" type="button" title="切换到 ${escapeHtml(deviceLabel(device))}">
      <span class="tile-shot" data-shot-for="${escapeHtml(device.deviceId)}">${isOnline(device) ? '快照中…' : '离线'}</span>
      <span class="tile-bottom"><i class="small-dot ${key === 'down' ? 'down' : key === 'busy' ? 'busy' : ''}"></i>${deviceIndexLabel(device)} ${escapeHtml(device.name)}</span>
    </button>`;
  }).join('')}</div>`;

  for (const device of state.devices) {
    if (isOnline(device)) queueTileShot(device);
  }
}

function queueTileShot(device) {
  const cached = state.tileShots.get(device.deviceId);
  if (cached && Date.now() - cached.at < TILE_SHOT_TTL) {
    drawTileShot(device.deviceId, cached);
    return;
  }
  if (cached?.loading) return;
  if (shotActive >= SHOT_CONCURRENCY) {
    if (!shotQueue.some(item => item.deviceId === device.deviceId)) shotQueue.push(device);
    return;
  }
  fetchTileShot(device);
}

async function fetchTileShot(device) {
  const id = device.deviceId;
  const entry = { at: Date.now(), loading: true };
  state.tileShots.set(id, entry);
  shotActive++;
  try {
    const response = await fetch(`/api/screenshot?deviceId=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('yunmomo.auth_token') || ''}` }
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    entry.bitmap = bitmap;
    entry.at = Date.now();
    entry.loading = false;
    drawTileShot(id, entry);
  } catch {
    state.tileShots.delete(id);
    const slot = document.querySelector(`[data-shot-for="${CSS.escape(id)}"]`);
    if (slot) slot.textContent = '快照不可用';
  } finally {
    shotActive--;
    const next = shotQueue.shift();
    if (next) fetchTileShot(next);
  }
}

function drawTileShot(deviceId, entry) {
  const slot = document.querySelector(`[data-shot-for="${CSS.escape(deviceId)}"]`);
  if (!slot) return;
  let canvas = slot.querySelector('canvas');
  if (!canvas) {
    slot.textContent = '';
    canvas = document.createElement('canvas');
    slot.append(canvas);
  }
  canvas.width = entry.bitmap.width;
  canvas.height = entry.bitmap.height;
  canvas.getContext('2d').drawImage(entry.bitmap, 0, 0);
}

function refreshTileShots() {
  if (state.view !== 'grid' || state.page !== 'overview') return;
  for (const device of state.devices) {
    if (isOnline(device)) queueTileShot(device);
  }
}

/* ---------- 设备表格 ---------- */

function renderDeviceTable() {
  const body = elements.deviceTableBody;
  if (!body) return;
  const filter = (byId('deviceSearch')?.value || '').trim().toLowerCase();
  const list = state.devices.filter(device =>
    !filter || device.name.toLowerCase().includes(filter) || String(device.deviceId).toLowerCase().includes(filter));

  const count = elements.deviceCount;
  if (count) count.textContent = state.devices.length ? `共 ${list.length} 台` : '';

  if (!state.devices.length) {
    body.innerHTML = `<tr><td colspan="7">
      <div class="empty">
        <p>您名下暂无已分配的云手机</p>
        <p class="hint">点击顶部「兑换卡密」输入管理员提供的卡密即可激活云机</p>
        <p style="margin-top:var(--sp-12)"><button class="btn primary" id="emptyRedeemBtn" type="button">兑换卡密</button></p>
      </div>
    </td></tr>`;
    byId('emptyRedeemBtn')?.addEventListener('click', () => elements.openRedeemModalBtn?.click());
    return;
  }

  if (!list.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">没有匹配的设备</td></tr>';
    return;
  }

  body.innerHTML = list.map(device => {
    const key = deviceStatusKey(device);
    const ver = String(device.sdkVersion || '').toUpperCase();
    const ip = device.currentIp
      ? `<button class="btn sm" data-copy-ip="${escapeHtml(device.deviceId)}" title="点击复制 ${escapeHtml(device.currentIp)}">${escapeHtml(device.currentIp)}</button>`
      : '<span class="hint">未配置</span>';
    const expire = device.expireAt
      ? `${new Date(device.expireAt).toLocaleDateString()}<span class="cell-sub">剩余 ${escapeHtml(device.remainingText || '…')}</span>`
      : '--';
    return `<tr data-row-device="${escapeHtml(device.deviceId)}" class="${state.selectedDeviceId === device.deviceId ? 'selected' : ''}">
      <td><b>${deviceIndexLabel(device)} ${escapeHtml(device.name)}</b><span class="cell-sub cell-mono">${escapeHtml(device.deviceId)}</span></td>
      <td>${deviceStatusBadge(device)}</td>
      <td>${ip}</td>
      <td>${ver ? `<span class="badge">${ver}</span>` : '--'}</td>
      <td>${expire}</td>
      <td>${renderMiniStepper(device)}</td>
      <td>
        <button class="btn sm" data-row-manual="${escapeHtml(device.deviceId)}" type="button">${ic('maximize', 13)} 手动操作</button>
        <button class="btn sm flat" data-row-target="${escapeHtml(device.deviceId)}" type="button" ${state.selectedDeviceId === device.deviceId ? 'disabled' : ''}>设为目标</button>
      </td>
    </tr>`;
  }).join('');
}

function renderMiniStepper(device) {
  const isV2 = String(device.sdkVersion || '').toLowerCase() === 'v2';
  const metaList = (window.STEPS_META || []).filter(step => isV2 ? step.order !== 8 : step.order !== 2.1);
  const dots = metaList.map(meta => {
    const st = getStepState(device.deviceId, meta.order);
    return `<i class="small-dot ${st === 'completed' ? '' : st === 'running' ? 'busy' : st === 'failed' || st === 'cancelled' ? 'down' : 'idle'}" title="${escapeHtml(meta.name)}: ${STATUS_LABELS[st] || '待执行'}"></i>`;
  }).join('');
  return `<span style="display:inline-flex; gap:var(--sp-4); align-items:center;">${dots}</span>`;
}

/* ---------- 最近活动 ---------- */

function renderRecentActivity() {
  const box = elements.recentActivity;
  if (!box) return;
  const rows = [];
  for (const run of state.runtimeState.runs.slice(0, 3)) {
    const device = state.devices.find(item => item.deviceId === run.deviceId);
    const target = device ? deviceLabel(device) : '设备 ' + String(run.deviceId || '').slice(-6);
    const status = run.status === 'cancelling' ? '正在停止' : run.status === 'starting' ? '准备执行' : '正在执行';
    rows.push({ time: '', text: `${target} · ${status}「${run.title}」${run.currentPage ? '' : '（其他网页）'}`, kind: 'busy' });
  }
  for (const entry of state.logFeed.slice(0, 4 - rows.length)) {
    rows.push({ time: entry.at, text: entry.title, kind: entry.title.includes('失败') ? 'warn' : 'ok' });
  }
  if (!rows.length) {
    box.innerHTML = '<div class="activity-row"><div class="activity-main"><b>暂无活动</b></div></div>';
    return;
  }
  box.innerHTML = rows.map(row => `<div class="activity-row">
    <i class="small-dot ${row.kind === 'warn' ? 'down' : row.kind === 'busy' ? 'busy' : ''}"></i>
    <div class="activity-main"><b>${escapeHtml(row.text)}</b></div>
    ${row.time ? `<span class="activity-time">${escapeHtml(row.time)}</span>` : ''}
  </div>`).join('');
}

/* ---------- 直播占用调度 ---------- */

function requestAllPreviews() {
  if (!state.tokenConfigured || !state.devices.length) return;
  if (state.page !== 'overview' || state.view !== 'single') {
    closeAllPlayers();
    return;
  }
  renderSingleViewer();
}
window.requestAllPreviews = requestAllPreviews;

/* ---------- 事件绑定 ---------- */

elements.deviceChips?.addEventListener?.('click', event => {
  const chip = event.target.closest('[data-chip-device]');
  if (chip) selectDevice(chip.dataset.chipDevice);
});

elements.viewerStage?.addEventListener?.('click', event => {
  const tile = event.target.closest('[data-tile-device]');
  if (tile) { selectDevice(tile.dataset.tileDevice); return; }
  const nav = event.target.closest('[data-viewer-nav]');
  if (nav && state.devices.length) {
    const index = state.devices.findIndex(d => d.deviceId === state.selectedDeviceId);
    const next = state.devices[(index + Number(nav.dataset.viewerNav) + state.devices.length) % state.devices.length];
    selectDevice(next.deviceId);
    return;
  }
  const switchBtn = event.target.closest('[data-switch-device]');
  if (switchBtn) { selectDevice(switchBtn.dataset.switchDevice); return; }

  const actionBtn = event.target.closest('[data-vd-action]');
  if (actionBtn) {
    const action = actionBtn.dataset.vdAction;
    const device = currentDevice();
    if (action === 'manual' && device) {
      if (typeof window.openManualControl === 'function') window.openManualControl(device);
      else showToast('控制台组件加载中，请稍候');
    } else if (action === 'copy-id' && device) {
      copyToClipboard(device.deviceId, `已复制虚拟机 ID: ${device.deviceId}`);
    } else if (action === 'refresh-stream' && device) {
      closeAllPlayers();
      renderSingleViewer();
      showToast('正在重新连接画面…');
    }
  }
});

byId('deviceSearch')?.addEventListener('input', renderDeviceTable);
byId('deviceRefreshBtn')?.addEventListener('click', async () => {
  await loadStatus();
  if (state.tokenConfigured) await loadDevices();
  refreshTileShots();
});

elements.deviceTableBody?.addEventListener?.('click', event => {
  const manual = event.target.closest('[data-row-manual]');
  if (manual) {
    const device = state.devices.find(d => d.deviceId === manual.dataset.rowManual);
    if (device && typeof window.openManualControl === 'function') window.openManualControl(device);
    return;
  }
  const target = event.target.closest('[data-row-target]');
  if (target) { selectDevice(target.dataset.rowTarget); return; }
  const copyIp = event.target.closest('[data-copy-ip]');
  if (copyIp) {
    const device = state.devices.find(d => d.deviceId === copyIp.dataset.copyIp);
    if (device?.currentIp) copyToClipboard(device.currentIp, `已复制当前 IP/域名: ${device.currentIp}`);
  }
});

eventBus.addEventListener('page:changed', event => {
  const page = event.detail.page;
  if (page === 'overview') {
    renderStatusBar();
    renderDeviceChips();
    renderViewer();
    renderRecentActivity();
    if (typeof renderQuickTasks === 'function') renderQuickTasks();
  } else if (page === 'devices') {
    renderDeviceTable();
  } else {
    stopPreview();
  }
});

eventBus.addEventListener('devices:changed', () => {
  renderStatusBadges(true);
  if (state.page === 'overview') { renderViewer(); renderRecentActivity(); }
});

eventBus.addEventListener('runtime:changed', () => {
  renderStatusBadges(true);
  if (state.page === 'overview') { renderViewerCaption(); renderRecentActivity(); }
});

setInterval(refreshTileShots, TILE_SHOT_TTL);
