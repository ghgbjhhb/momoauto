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
  const st = state.deviceStates?.[deviceId];
  if (st && ['starting', 'running', 'stopping'].includes(st.status)) return true;
  return (state.runtimeState?.runs || []).some(run => run.deviceId === deviceId);
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
window.STATUS_TEXT = STATUS_TEXT;
window.deviceStatusKey = deviceStatusKey;
window.deviceIndexLabel = deviceIndexLabel;

// 状态仅在变化时刷新徽章/统计，避免直播每帧触发 DOM 重排
let lastStatusSnapshot = '';


function switchToView(view) {
  state.view = view;
  const panel = byId('ovDevicePanel') || elements.ovDevicePanel;
  if (panel) panel.dataset.view = view;
  const overview = byId('page-overview');
  if (overview) overview.dataset.view = view;
  for (const seg of document.querySelectorAll('#viewToggle .segment')) {
    seg.classList.toggle('active', seg.dataset.view === view);
  }
  renderViewer();
}
window.switchToView = switchToView;

function updateViewerControls() {
  const isGrid = state.view === 'grid';
  const quickWrap = byId('ovDevQuickWrap');
  if (quickWrap) quickWrap.hidden = isGrid;
  const refreshBtn = byId('ovRefreshShotsBtn');
  if (refreshBtn) refreshBtn.hidden = !isGrid;
  const countBadge = byId('ovDeviceCountBadge');
  if (countBadge) {
    const onlineCount = state.devices.filter(d => isOnline(d)).length;
    countBadge.textContent = onlineCount + '台在线';
    countBadge.hidden = isGrid || !state.devices.length;
  }
  updateGridBatchTools();
}

function updateGridBatchTools() {
  const isGrid = state.view === 'grid';
  const tools = byId('ovGridBatchTools');
  if (tools) tools.hidden = !isGrid;
  const badge = byId('ovBatchCountBadge');
  if (badge) {
    const count = (state.batchDevices || []).length;
    badge.textContent = `已选 ${count} 台`;
  }
}
window.updateGridBatchTools = updateGridBatchTools;

function notifyBatchSelectionChanged() {
  eventBus.dispatchEvent(new CustomEvent('device:batch-changed'));
  if (typeof window.updateOverviewWorkbenchFooter === 'function') {
    window.updateOverviewWorkbenchFooter();
  }
  if (typeof window.updateOverviewRunSummary === 'function') {
    window.updateOverviewRunSummary();
  }
}
window.notifyBatchSelectionChanged = notifyBatchSelectionChanged;

function renderDeviceQuickSelect() {
  const select = byId('ovDevQuickSelect');
  if (!select) return;
  const currentId = state.selectedDeviceId;
  const optionsHtml = state.devices.map(d => {
    const key = deviceStatusKey(d);
    return '<option value="' + escapeHtml(d.deviceId) + '">' + deviceIndexLabel(d) + ' (' + STATUS_TEXT[key] + ')</option>';
  }).join('');
  if (select.innerHTML !== optionsHtml) {
    select.innerHTML = optionsHtml;
  }
  if (currentId) select.value = currentId;
}

function renderStatusBadges(force = false) {
  const device = currentDevice();
  const snapshot = state.devices.map(d => deviceStatusKey(d)).join(',') + '|' + (device ? deviceStatusKey(device) : '');
  if (!force && snapshot === lastStatusSnapshot) return;
  lastStatusSnapshot = snapshot;
  renderStatusBar();
  renderDeviceChips();
  renderDeviceQuickSelect();
  if (typeof renderShell === 'function') renderShell();
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
  if (typeof syncCurrentDeviceLogView === 'function') syncCurrentDeviceLogView();
  renderDeviceChips();
  renderViewer();
  renderStatusBar();
  renderRecentActivity();
  renderDeviceTable();
  if (typeof renderShell === 'function') renderShell();
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
  const html = state.devices.map(device => {
    const key = deviceStatusKey(device);
    return `<button class="device-chip ${state.selectedDeviceId === device.deviceId ? 'selected' : ''} ${key === 'down' ? 'down' : key === 'busy' ? 'running' : ''}" data-chip-device="${escapeHtml(device.deviceId)}" title="${escapeHtml(deviceLabel(device))}"><b>${deviceIndexLabel(device)}</b><small>${STATUS_TEXT[key]}</small></button>`;
  }).join('');
  renderMarkupIfChanged(wrap, html);
}

/* ---------- 画面预览 ---------- */

function renderViewer() {
  const stage = elements.viewerStage;
  if (!stage) return;
  lastStatusSnapshot = '';
  const panel = byId('ovDevicePanel') || elements.ovDevicePanel;
  if (panel) panel.dataset.view = state.view;
  const overview = byId('page-overview');
  if (overview) overview.dataset.view = state.view;
  updateViewerControls();
  renderDeviceQuickSelect();
  if (state.view === 'grid') { renderGridViewer(); }
  else { renderSingleViewer(); }
  updateDeviceMeta(currentDevice());
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
    let frame = stage.querySelector('.device-frame');
    if (!frame) {
      stage.innerHTML = `
        <div class="phone-stage">
          <div class="device-frame" style="aspect-ratio: 720 / 1280;"><canvas class="device-canvas" aria-label="云手机实时画面" hidden></canvas></div>
          <div class="viewer-hint">${state.tokenConfigured ? '暂无云机，请先兑换卡密' : '尚未连接云机平台'}</div>
          <div class="offline-cover" hidden>设备离线</div>
        </div>
      `;
    } else {
      const hint = stage.querySelector('.viewer-hint');
      if (hint) {
        hint.textContent = state.tokenConfigured ? '暂无云机，请先兑换卡密' : '尚未连接云机平台';
        hint.hidden = false;
      }
      const canvas = frame.querySelector('canvas');
      if (canvas) canvas.hidden = true;
    }
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
        <div class="device-frame" style="aspect-ratio: 720 / 1280;"><canvas class="device-canvas" aria-label="云手机实时画面" hidden></canvas></div>
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
  const modeTag = byId('metaModeTag');
  if (modeTag) modeTag.hidden = state.view !== 'grid';
  const switchSingleBtn = byId('metaSwitchSingleBtn');
  if (switchSingleBtn) switchSingleBtn.hidden = state.view !== 'grid';
  const nameEl = byId('metaDevName');
  if (nameEl) {
    const label = deviceIndexLabel(device);
    if (nameEl.textContent !== label) nameEl.textContent = label;
  }

  const ipEl = byId('metaDevIp');
  if (ipEl) {
    const ipText = device.currentIp || '局域网';
    const ipTitle = `当前 IP / 代理: ${device.currentIp || '自动分配'}`;
    if (ipEl.textContent !== ipText) ipEl.textContent = ipText;
    if (ipEl.title !== ipTitle) ipEl.title = ipTitle;
  }

  const resEl = byId('metaDevRes');
  if (resEl) {
    const resolution = '720×1280 (原画)';
    if (resEl.textContent !== resolution) resEl.textContent = resolution;
  }

  // 直播帧可达 30fps；按钮只渲染一次，否则按下和释放鼠标期间重建 SVG
  // 会导致点击事件丢失。事件只绑定在稳定的父容器上。
  const copyBtn = byId('metaCopyIdBtn');
  if (copyBtn && !copyBtn.dataset.ready) {
    copyBtn.innerHTML = ic('copy', 12);
    copyBtn.dataset.ready = '1';
    copyBtn.setAttribute('aria-label', '复制设备 ID');
  }
  const manualBtn = byId('metaManualBtn');
  if (manualBtn && !manualBtn.dataset.ready) {
    manualBtn.innerHTML = `${ic('maximize', 12)} 手动控制`;
    manualBtn.dataset.ready = '1';
  }
}
window.updateDeviceMeta = updateDeviceMeta;

byId('ovDeviceMeta')?.addEventListener('click', event => {
  const switchSingle = event.target.closest('#metaSwitchSingleBtn');
  if (switchSingle) {
    if (typeof window.switchToView === 'function') window.switchToView('single');
    return;
  }
  const copy = event.target.closest('#metaCopyIdBtn');
  const manual = event.target.closest('#metaManualBtn');
  if (!copy && !manual) return;
  const device = currentDevice();
  if (!device) { showToast('请先选择云手机'); return; }
  if (copy) {
    copyToClipboard(device.deviceId, `已复制虚拟机 ID: ${device.deviceId}`);
    return;
  }
  if (typeof window.openManualControl === 'function') {
    window.openManualControl(device);
  } else {
    showToast('手动控制组件尚未就绪，请刷新页面');
  }
});

function createPreviewPlayer(device, canvas, hint, cover) {
  const id = device.deviceId;
  const markHealth = ok => streamHealth.set(id, { ok, at: Date.now() });
  const player = new CloudVideoPlayer({
    canvas,
    deviceId: id,
    mode: 'single',
    onFrame(stats) {
      // 切换云机时旧解码器可能仍排队回调，不能用旧设备覆盖新设备的信息栏。
      if (state.selectedDeviceId !== id || state.page !== 'overview' || state.view !== 'single') return;
      markHealth(true);
      canvas.hidden = false;
      if (hint) hint.hidden = true;
      if (cover) cover.hidden = true;
      renderStatusBadges();

      const w = stats?.width || canvas.width || 720;
      const h = stats?.height || canvas.height || 1280;
      // 使用最新设备快照而非建立视频连接时的旧对象，避免刷新后 IP/名称被旧帧覆盖。
      updateDeviceMeta(currentDevice(), { width: w, height: h });
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
        ? `<strong>${deviceIndexLabel(device)}</strong>${deviceStatusBadge(device)}<span class="cell-mono">${escapeHtml(device.deviceId)}</span>`
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


function updateGridSelection() {
  const stage = elements.viewerStage;
  if (!stage) return false;
  const grid = stage.querySelector('.device-grid');
  if (!grid) return false;
  
  const tiles = grid.querySelectorAll('.device-tile');
  if (tiles.length !== state.devices.length) return false;
  for (const tile of tiles) {
    const id = tile.dataset.tileDevice;
    const isSelected = id === state.selectedDeviceId;
    const isBatchChecked = (state.batchDevices || []).includes(id);
    tile.classList.toggle('selected', isSelected);
    tile.classList.toggle('is-batch-checked', isBatchChecked);
    tile.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    const chk = tile.querySelector('.tile-checkbox');
    if (chk && chk.checked !== isBatchChecked) chk.checked = isBatchChecked;
  }
  updateGridBatchTools();
  return true;
}

function renderGridViewer(forceRebuild = false) {
  const stage = elements.viewerStage;
  stage.dataset.viewerDevice = '';
  // 若网格已在 DOM 中且设备结构未变，仅更新选中类，绝对不要销毁重建 DOM（保护 dblclick 事件与 canvas 缓存）
  if (!forceRebuild && updateGridSelection()) {
    return;
  }
  closeAllPlayers();

  if (!state.devices.length) {
    stage.innerHTML = '<div class="viewer-empty-box"><div class="empty-icon">📱</div><div class="empty-title">' + (state.tokenConfigured ? '暂无可预览云机' : '尚未连接云机平台') + '</div><div class="empty-sub">请先在管理后台或设置中配置设备</div></div>';
    return;
  }

  if (!state.batchDevices?.length && state.selectedDeviceId) {
    state.batchDevices = [state.selectedDeviceId];
  }
  stage.innerHTML = '<div class="device-grid" role="region" aria-label="设备监控矩阵">' + state.devices.map(device => {
    const key = deviceStatusKey(device);
    const online = isOnline(device);
    const isSelected = state.selectedDeviceId === device.deviceId;
    const isBatchChecked = (state.batchDevices || []).includes(device.deviceId);
    return '<div class="device-tile ' + (isSelected ? 'selected ' : '') + (isBatchChecked ? 'is-batch-checked ' : '') + (online ? '' : 'is-offline') + '" data-tile-device="' + escapeHtml(device.deviceId) + '" tabindex="0" role="button" aria-pressed="' + isSelected + '">' +
      '<div class="tile-header">' +
        '<div class="tile-id-badge">' +
          '<label class="tile-check-label" title="选择设备">' +
            '<input type="checkbox" class="tile-checkbox" data-tile-check="' + escapeHtml(device.deviceId) + '" ' + (isBatchChecked ? 'checked' : '') + '>' +
          '</label>' +
          '<i class="small-dot ' + (key === 'down' ? 'down' : key === 'busy' ? 'busy' : '') + '"></i>' +
          '<span class="tile-name" title="' + escapeHtml(device.name || '') + '">' + deviceIndexLabel(device) + '</span>' +
        '</div>' +
        '<div class="tile-actions">' +
          '<button class="tile-action-btn" type="button" data-tile-action="single" title="以单台全屏查看此设备" aria-label="进入单台大屏">' +
            '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>' +
          '</button>' +
          '<button class="tile-action-btn" type="button" data-tile-action="manual" title="打开手动控制" aria-label="打开手动控制">' +
            '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="tile-screen-wrap">' +
        '<div class="tile-screen" data-shot-for="' + escapeHtml(device.deviceId) + '">' +
          (online ? '<div class="tile-skeleton"><div class="tile-shimmer"></div><span class="tile-hint">获取快照…</span></div>' : '<div class="tile-offline"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="2" width="14" height="20" rx="2.5"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg><span>设备离线</span></div>') +
        '</div>' +
      '</div>' +
      '<div class="tile-footer">' +
        '<span class="tile-ip cell-mono" title="' + escapeHtml(device.currentIp || '自动分配') + '">' + escapeHtml(device.currentIp || '自动代理') + '</span>' +
        '<span class="tile-status-tag ' + key + '">' + STATUS_TEXT[key] + '</span>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';

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
    const response = await fetch(`/api/screenshot?deviceId=${encodeURIComponent(id)}`);
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
    if (slot) slot.innerHTML = '<div class="tile-shot-failed"><span>快照不可用</span><button class="tile-retry-btn" type="button" data-retry-shot="' + CSS.escape(id) + '" title="重试">重试</button></div>';
  } finally {
    shotActive--;
    const next = shotQueue.shift();
    if (next) fetchTileShot(next);
  }
}

function drawTileShot(deviceId, entry) {
  const slot = document.querySelector('[data-shot-for="' + CSS.escape(deviceId) + '"]');
  if (!slot) return;
  let canvas = slot.querySelector('canvas');
  if (!canvas) {
    slot.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.className = 'tile-canvas';
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
    const changed = renderMarkupIfChanged(body, `<tr><td colspan="7">
      <div class="empty">
        <p>您名下暂无已分配的云手机</p>
        <p class="hint">点击顶部「兑换卡密」输入管理员提供的卡密即可激活云机</p>
        <p style="margin-top:var(--sp-12)"><button class="btn primary" id="emptyRedeemBtn" type="button">兑换卡密</button></p>
      </div>
    </td></tr>`);
    if (changed) byId('emptyRedeemBtn')?.addEventListener('click', () => elements.openRedeemModalBtn?.click());
    return;
  }

  if (!list.length) {
    renderMarkupIfChanged(body, '<tr><td colspan="7" class="empty">没有匹配的设备</td></tr>');
    return;
  }

  const html = list.map(device => {
    const key = deviceStatusKey(device);
    const ver = String(device.sdkVersion || '').toUpperCase();
    const ip = device.currentIp
      ? `<button class="btn sm" data-copy-ip="${escapeHtml(device.deviceId)}" title="点击复制 ${escapeHtml(device.currentIp)}">${escapeHtml(device.currentIp)}</button>`
      : '<span class="hint">未配置</span>';
    const expire = device.expireAt
      ? `${new Date(device.expireAt).toLocaleDateString()}<span class="cell-sub">剩余 ${escapeHtml(device.remainingText || '…')}</span>`
      : '--';
    return `<tr data-row-device="${escapeHtml(device.deviceId)}" class="${state.selectedDeviceId === device.deviceId ? 'selected' : ''}">
      <td><b>${deviceIndexLabel(device)}</b><span class="cell-sub cell-mono">${escapeHtml(device.deviceId)}</span></td>
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
  renderMarkupIfChanged(body, html);
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

let lastTileClick = { deviceId: null, at: 0 };

function toggleTileBatchSelection(deviceId, forceState = null) {
  if (!Array.isArray(state.batchDevices)) state.batchDevices = [];
  const currentlyChecked = state.batchDevices.includes(deviceId);
  const nextChecked = forceState !== null ? Boolean(forceState) : !currentlyChecked;

  if (nextChecked) {
    if (!currentlyChecked) state.batchDevices.push(deviceId);
    selectDevice(deviceId);
  } else {
    state.batchDevices = state.batchDevices.filter(id => id !== deviceId);
    if (state.selectedDeviceId === deviceId) {
      if (state.batchDevices.length) {
        selectDevice(state.batchDevices[state.batchDevices.length - 1]);
      }
    }
  }
  updateGridSelection();
  notifyBatchSelectionChanged();
}
window.toggleTileBatchSelection = toggleTileBatchSelection;

elements.viewerStage?.addEventListener?.('click', event => {
  // 0. 复选框或其标签勾选 (多选设备)
  const check = event.target.closest('[data-tile-check]');
  if (check) {
    const id = check.dataset.tileCheck;
    toggleTileBatchSelection(id, check.checked);
    return;
  }
  const checkLabel = event.target.closest('.tile-check-label');
  if (checkLabel) {
    const input = checkLabel.querySelector('[data-tile-check]');
    if (input) toggleTileBatchSelection(input.dataset.tileCheck);
    return;
  }

  // 1. 重试快照
  const retryBtn = event.target.closest('[data-retry-shot]');
  if (retryBtn) {
    const dev = state.devices.find(d => d.deviceId === retryBtn.dataset.retryShot);
    if (dev) fetchTileShot(dev);
    return;
  }

  // 2. 卡片内的直达按钮（进入单台大屏 / 打开手动控制）
  const actionBtn = event.target.closest('[data-tile-action]');
  if (actionBtn) {
    event.stopPropagation();
    const tile = actionBtn.closest('[data-tile-device]');
    if (!tile) return;
    const deviceId = tile.dataset.tileDevice;
    const device = state.devices.find(d => d.deviceId === deviceId);
    if (!device) return;
    const action = actionBtn.dataset.tileAction;
    if (action === 'single') {
      selectDevice(deviceId);
      switchToView('single');
    } else if (action === 'manual') {
      if (typeof window.openManualControl === 'function') window.openManualControl(device);
      else showToast('控制台组件加载中，请稍候');
    }
    return;
  }

  // 3. 点击卡片主体：双击进入单台，单击直接切换多选勾选状态！
  const tile = event.target.closest('[data-tile-device]');
  if (tile) {
    const deviceId = tile.dataset.tileDevice;
    const now = Date.now();
    // 软件级连击判定：400ms 内连续两次点击同一卡片，平滑切入单台
    if (lastTileClick.deviceId === deviceId && (now - lastTileClick.at) < 400) {
      lastTileClick.at = 0;
      selectDevice(deviceId);
      switchToView('single');
      return;
    }
    lastTileClick.deviceId = deviceId;
    lastTileClick.at = now;

    // 单击卡片主体：直接切换勾选！
    toggleTileBatchSelection(deviceId);
    return;
  }

  // 5. 兼容旧导航按钮
  const nav = event.target.closest('[data-viewer-nav]');
  if (nav && state.devices.length) {
    const index = state.devices.findIndex(d => d.deviceId === state.selectedDeviceId);
    const next = state.devices[(index + Number(nav.dataset.viewerNav) + state.devices.length) % state.devices.length];
    selectDevice(next.deviceId);
    return;
  }
  const switchBtn = event.target.closest('[data-switch-device]');
  if (switchBtn) { selectDevice(switchBtn.dataset.switchDevice); return; }

  const oldActionBtn = event.target.closest('[data-vd-action]');
  if (oldActionBtn) {
    const action = oldActionBtn.dataset.vdAction;
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


// 双击卡片直达单台模式
elements.viewerStage?.addEventListener?.('dblclick', event => {
  if (event.target.closest('[data-tile-check], .tile-check-label, [data-tile-action]')) return;
  const tile = event.target.closest('[data-tile-device]');
  if (tile) {
    event.preventDefault();
    event.stopPropagation();
    selectDevice(tile.dataset.tileDevice);
    switchToView('single');
  }
});

// 单台模式快捷切机下拉
byId('ovDevQuickSelect')?.addEventListener('change', event => {
  if (event.target.value) selectDevice(event.target.value);
});

// 刷新快照按钮
byId('ovRefreshShotsBtn')?.addEventListener('click', () => {
  state.tileShots.clear();
  const btn = byId('ovRefreshShotsBtn');
  if (btn) btn.classList.add('is-refreshing');
  setTimeout(() => btn?.classList.remove('is-refreshing'), 700);
  for (const device of state.devices) {
    if (isOnline(device)) queueTileShot(device);
  }
  showToast('正在刷新全部设备快照…');
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



// 宫格模式全选/清空
byId('ovSelectAllBtn')?.addEventListener('click', () => {
  state.batchDevices = state.devices.map(d => d.deviceId);
  updateGridSelection();
  notifyBatchSelectionChanged();
});

byId('ovClearBatchBtn')?.addEventListener('click', () => {
  state.batchDevices = [];
  updateGridSelection();
  notifyBatchSelectionChanged();
});
