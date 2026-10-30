'use strict';

function isOnline(device) {
  return device.online === true || device.status === 1 || device.status === '1' || device.status === 'online';
}

function shortDeviceId(device) {
  return device.deviceId.length > 8 ? '…' + device.deviceId.slice(-6) : device.deviceId;
}

function deviceLabel(device) {
  return device.name + ' · ' + shortDeviceId(device);
}

function currentDevice() {
  return state.devices.find(device => device.deviceId === state.selectedDeviceId) || null;
}

function externalScriptForDevice(deviceId) {
  return state.runtimeState.runs.find(run => !run.currentPage && run.deviceId === deviceId) || null;
}

function manualWindowsForDevice(deviceId) {
  return state.runtimeState.manualDevices.find(item => item.deviceId === deviceId) || null;
}

function renderSharedActivity() {
  const messages = [];
  for (const run of state.runtimeState.runs) {
    if (run.currentPage) continue;
    const device = state.devices.find(item => item.deviceId === run.deviceId);
    const target = device ? deviceLabel(device) + '：' : '';
    const activity = run.status === 'cancelling' ? '正在停止' : run.status === 'starting' ? '准备执行' : '正在执行';
    messages.push(`${target}${activity}「${run.title}」(另一个网页)`);
  }
  for (const item of state.runtimeState.manualDevices) {
    const localWindow = state.manualDeviceId === item.deviceId ? 1 : 0;
    const otherWindows = Math.max(0, item.windows - localWindow);
    if (!otherWindows) continue;
    const device = state.devices.find(entry => entry.deviceId === item.deviceId);
    const target = device ? deviceLabel(device) : '设备 ' + item.deviceId.slice(-8);
    const recent = item.lastInputAt
      ? (item.lastInputFromCurrentPage ? '最近操作来自本网页' : '最近操作来自其他网页')
      : '尚无操作';
    messages.push(`${target}：另有 ${otherWindows} 个网页打开手动操作；${recent}，触控和按键由最后操作的网页接管`);
  }
  elements.sharedActivity.textContent = messages.join('\n');
  elements.sharedActivity.hidden = messages.length === 0;
}


function renderPreviewSummary() {
  const total = state.devices.length;
  const online = elements.deviceGrid.querySelectorAll('.device-status.online').length;
  const selected = currentDevice();
  const index = selected ? state.devices.indexOf(selected) + 1 : 0;
  const targetBadge = selected ? ('#' + String(index).padStart(2, '0') + ' ' + selected.name) : '未选择';

  elements.previewSummary.textContent = total
    ? `${total} 台云机 · 目标：${targetBadge}`
    : '暂无云机';
  elements.previewState.textContent = total
    ? (online ? `${online}/${total} 在线` : `${total} 台`)
    : '未连接';
  elements.previewState.classList.toggle('active', total > 0 && online > 0);

  if (elements.statTotal) elements.statTotal.textContent = total ? `${total} 台` : '--';
  if (elements.statOnline) elements.statOnline.textContent = total ? `${online} 台` : '--';
  if (elements.statTarget) elements.statTarget.textContent = targetBadge;
  if (elements.workbenchTarget) {
    elements.workbenchTarget.textContent = targetBadge;
    elements.workbenchTarget.title = selected ? selected.deviceId : '';
  }
  const remoteTargetTag = byId('remoteTargetTag');
  if (remoteTargetTag) {
    remoteTargetTag.textContent = selected ? `${selected.name} (${selected.deviceId})` : '未选择目标';
  }
}

window.getSelectedDeviceId = () => state.selectedDeviceId;

function selectDevice(deviceId) {
  if (!state.devices.some(device => device.deviceId === deviceId)) return;
  state.selectedDeviceId = deviceId;
  renderSelectedDevice();
  renderPreviewSummary();
  renderPipelineStepper();
  updateSharedRunControls();
  requestAllPreviews(); // 切换选中云机时即刻建立投屏，释放未选中机型闲置占用
  window.dispatchEvent(new CustomEvent('device:selected', { detail: { deviceId } }));
}

function renderSelectedDevice() {
  for (const card of elements.deviceGrid.querySelectorAll('.device-card')) {
    const selected = card.dataset.deviceId === state.selectedDeviceId;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  }
}

function createDeviceCard(device) {
  const index = state.devices.indexOf(device) + 1;
  const numBadgeText = '#' + String(index).padStart(2, '0');

  const card = document.createElement('article');
  card.className = 'device-card';
  card.dataset.deviceId = device.deviceId;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${numBadgeText} ${device.name} · ${device.deviceId}`);

  // 卡片头部：系统编号徽章 + 设备名称 + 在线呼吸灯状态
  const header = document.createElement('div');
  header.className = 'device-card-head device-card-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'device-title-wrap';

  const badge = document.createElement('span');
  badge.className = 'device-num-badge';
  badge.textContent = numBadgeText;

  titleWrap.append(badge);

  const ipBadge = document.createElement('span');
  ipBadge.className = 'device-ip-badge' + (device.currentIp ? ' configured' : ' unconfigured');
  if (device.currentIp) {
    ipBadge.innerHTML = `<span class="ip-text"></span>`;
    ipBadge.querySelector('.ip-text').textContent = device.currentIp;
    ipBadge.title = `当前正在使用的 IP / 域名: ${device.currentIp}${device.proxyAddress ? ` (完整代理: ${device.proxyAddress})` : ''} - 点击复制`;
    ipBadge.addEventListener('click', event => {
      event.stopPropagation();
      copyToClipboard(device.currentIp, `已复制当前 IP/域名: ${device.currentIp}`);
      const textEl = ipBadge.querySelector('.ip-text');
      if (textEl) {
        const orig = textEl.textContent;
        textEl.textContent = '已复制✓';
        setTimeout(() => { textEl.textContent = orig; }, 1500);
      }
    });
  } else {
    ipBadge.innerHTML = `<span class="ip-text">未配置</span>`;
    ipBadge.title = '当前云机未配置代理 IP 或域名';
  }
  titleWrap.append(ipBadge);

  const ver = String(device.sdkVersion || '').toUpperCase();
  if (ver) {
    const versionTag = document.createElement('span');
    versionTag.className = `device-version-tag ${ver.toLowerCase()}`;
    versionTag.textContent = ver;
    versionTag.title = `架构版本: ${ver}`;
    titleWrap.append(versionTag);
  }

  const status = document.createElement('span');
  status.className = 'device-status device-status-pill' + (isOnline(device) ? ' online' : '');
  status.innerHTML = `<span class="status-dot"></span><span class="status-label">${isOnline(device) ? '在线' : '连接中'}</span>`;

  header.append(titleWrap, status);

  // 云机租约与有效期倒计时指示条
  let expireBar = null;
  if (device.expireAt) {
    expireBar = document.createElement('div');
    expireBar.className = 'device-expire-bar ui-row-between ui-alert ui-alert--info';
    expireBar.style.margin = 'var(--sp-6) var(--sp-12)';
    const remainingText = device.remainingText || '计算中…';
    const expireDateStr = new Date(device.expireAt).toLocaleDateString();
    expireBar.innerHTML = `
      <span>到期: <strong>${expireDateStr}</strong></span>
      <strong>剩余 ${escapeHtml(remainingText)}</strong>
    `;
    expireBar.title = `到期具体物理时间: ${new Date(device.expireAt).toLocaleString()}`;
  }

  // 流程微型步进指示条
  const miniStepper = document.createElement('div');
  miniStepper.className = 'device-mini-stepper';
  miniStepper.dataset.deviceId = device.deviceId;
  miniStepper.title = '初始化全流程进度';
  const isV2 = String(device.sdkVersion || '').toLowerCase() === 'v2';
  const metaList = STEPS_META.filter(s => isV2 ? s.order !== 8 : s.order !== 2.1);
  for (const meta of metaList) {
    const dot = document.createElement('span');
    dot.className = 'mini-step-dot';
    dot.dataset.step = String(meta.order);
    const st = getStepState(device.deviceId, meta.order);
    if (st && st !== 'idle') dot.classList.add(st);
    dot.title = `${meta.name}: ${STATUS_LABELS[st] || '待执行'}`;
    miniStepper.append(dot);
  }

  // 手机屏幕预览区（带点击进入真机操作台的悬浮导引）
  const screen = document.createElement('div');
  screen.className = 'device-screen';
  screen.setAttribute('role', 'button');
  screen.setAttribute('aria-label', `放大操作 ${numBadgeText} (${device.name})`);
  screen.tabIndex = 0;
  screen.title = '点击进入真机控制台操作';
  function launchControl() {
    window.AppLogger?.info('ManualControl', `点击触发放大操作云机 [${device.name}] (${device.deviceId})`);
    if (typeof window.openManualControl === 'function') {
      window.openManualControl(device);
    } else if (typeof openManualControl === 'function') {
      openManualControl(device);
    } else {
      showToast('控制台组件加载中，请稍候');
    }
  }

  screen.addEventListener('click', event => {
    event.stopPropagation();
    launchControl();
  });
  screen.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      launchControl();
    }
  });

  const placeholder = document.createElement('strong');
  placeholder.className = 'device-screen-placeholder';
  placeholder.textContent = '加载中…';

  const image = document.createElement('canvas');
  image.className = 'device-screen-image';
  image.setAttribute('aria-label', `${numBadgeText} ${device.name} 画面`);
  image.hidden = true;

  const hoverHint = document.createElement('div');
  hoverHint.className = 'screen-hover-hint';
  hoverHint.setAttribute('aria-hidden', 'true');
  hoverHint.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>`;

  screen.append(placeholder, image, hoverHint);

  const operateBtn = document.createElement('button');
  operateBtn.className = 'device-operate-btn';
  operateBtn.type = 'button';
  operateBtn.textContent = '放大操作云机';
  operateBtn.title = '放大并进入全屏控制台操作';
  operateBtn.addEventListener('click', event => {
    event.stopPropagation();
    launchControl();
  });

  // 底部业务工具条：集成一键复制虚拟机 ID
  const footer = document.createElement('div');
  footer.className = 'device-card-footer';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'device-copy-btn';
  copyBtn.type = 'button';
  copyBtn.title = `一键复制完整虚拟机 ID (${device.deviceId})`;
  copyBtn.innerHTML = `
    <svg class="copy-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2"></rect>
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
    </svg>
    <span class="copy-text">复制ID</span>
  `;
  copyBtn.addEventListener('click', event => {
    event.stopPropagation();
    copyToClipboard(device.deviceId, `已复制 [${numBadgeText}] 虚拟机 ID: ${device.deviceId}`);
    copyBtn.classList.add('copied');
    copyBtn.querySelector('.copy-text').textContent = '已复制✓';
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.querySelector('.copy-text').textContent = '复制ID';
    }, 1800);
  });

  footer.append(copyBtn);

  // 目标标记
  const targetTag = document.createElement('div');
  targetTag.className = 'device-target-tag';
  targetTag.innerHTML = `<span>当前目标</span>`;

  if (expireBar) {
    card.append(header, expireBar, miniStepper, screen, operateBtn, footer, targetTag);
  } else {
    card.append(header, miniStepper, screen, operateBtn, footer, targetTag);
  }

  card.addEventListener('click', () => selectDevice(device.deviceId));
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectDevice(device.deviceId);
    }
  });
  return card;
}

function updateDeviceCard(card, device, index) {
  const numBadgeText = '#' + String(index + 1).padStart(2, '0');
  const badge = card.querySelector('.device-num-badge');
  if (badge && badge.textContent !== numBadgeText) badge.textContent = numBadgeText;

  // 彻底移除无需展示的冗余名称 (SF)
  card.querySelector('.device-name')?.remove();

  const status = card.querySelector('.device-status');
  if (status) {
    const online = isOnline(device);
    status.className = 'device-status device-status-pill' + (online ? ' online' : '');
    const label = status.querySelector('.status-label');
    if (label) label.textContent = online ? '在线' : '连接中';
  }

  // 更新或插入当前使用的 IP / 域名 Badge（节点信息动态比对，避免无谓重绘）
  let ipBadge = card.querySelector('.device-ip-badge');
  const configured = Boolean(device.currentIp);
  if (!ipBadge) {
    ipBadge = document.createElement('span');
    const titleWrap = card.querySelector('.device-title-wrap');
    if (titleWrap) {
      const verTag = titleWrap.querySelector('.device-version-tag');
      if (verTag) titleWrap.insertBefore(ipBadge, verTag);
      else titleWrap.append(ipBadge);
    }
  }
  if (ipBadge) {
    const currentIpText = ipBadge.querySelector('.ip-text')?.textContent || '';
    const wasConfigured = ipBadge.classList.contains('configured');
    if (wasConfigured !== configured || currentIpText !== (device.currentIp || '未配置')) {
      ipBadge.className = 'device-ip-badge' + (configured ? ' configured' : ' unconfigured');
      if (configured) {
        ipBadge.innerHTML = `<span class="ip-text"></span>`;
        ipBadge.querySelector('.ip-text').textContent = device.currentIp;
        ipBadge.title = `当前正在使用的 IP / 域名: ${device.currentIp}${device.proxyAddress ? ` (完整代理: ${device.proxyAddress})` : ''} - 点击复制`;
      } else {
        ipBadge.innerHTML = `<span class="ip-text">未配置</span>`;
        ipBadge.title = '当前云机未配置代理 IP 或域名';
      }
    }
    ipBadge.onclick = configured ? event => {
      event.stopPropagation();
      const ip = device.currentIp;
      if (!ip) return;
      copyToClipboard(ip, `已复制当前 IP/域名: ${ip}`);
      const textEl = ipBadge.querySelector('.ip-text');
      if (textEl) {
        const orig = textEl.textContent;
        textEl.textContent = '已复制✓';
        setTimeout(() => { textEl.textContent = orig; }, 1500);
      }
    } : null;
  }

  // 确保底部不再显示旧的 ID Badge
  card.querySelector('.device-id-badge')?.remove();

  let expireBar = card.querySelector('.device-expire-bar');
  if (device.expireAt) {
    const remainingText = device.remainingText || '计算中…';
    const expireDateStr = new Date(device.expireAt).toLocaleDateString();
    if (!expireBar) {
      expireBar = document.createElement('div');
      expireBar.className = 'device-expire-bar ui-row-between ui-alert ui-alert--info';
      expireBar.style.margin = 'var(--sp-6) var(--sp-12)';
      const head = card.querySelector('.device-card-head');
      if (head && head.nextSibling) card.insertBefore(expireBar, head.nextSibling);
      else card.prepend(expireBar);
    }
    expireBar.innerHTML = `
      <span>到期: <strong>${expireDateStr}</strong></span>
      <strong>剩余 ${escapeHtml(remainingText)}</strong>
    `;
    expireBar.title = `到期具体物理时间: ${new Date(device.expireAt).toLocaleString()}`;
  } else if (expireBar) {
    expireBar.remove();
  }

  updateMiniStepperForDevice(device.deviceId);
}

function renderDeviceGrid() {
  const grid = elements.deviceGrid;
  if (!grid) return;

  if (!state.devices.length) {
    stopPreview();
    grid.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'ui-empty empty-user-devices';
    empty.innerHTML = `
      <div class="ui-empty-title">您名下暂无已分配的云手机</div>
      <div class="ui-empty-desc">在顶部点击「兑换卡密」输入管理员提供的卡密，即可激活并分配专属云机；多台设备可并行执行。</div>
      <button class="run-button" id="emptyRedeemBtn" type="button">兑换卡密</button>
    `;
    const btn = empty.querySelector('#emptyRedeemBtn');
    if (btn) btn.onclick = () => elements.openRedeemModalBtn?.click();
    grid.append(empty);
    renderPreviewSummary();
    renderPipelineStepper();
    return;
  }

  // 清除空状态指示
  grid.querySelector('.empty-user-devices')?.remove();
  grid.querySelector('.loading-card')?.remove();

  if (!state.devices.some(device => device.deviceId === state.selectedDeviceId)) {
    state.selectedDeviceId = state.devices[0].deviceId;
  }

  const existingCards = new Map();
  for (const card of grid.querySelectorAll('.device-card')) {
    existingCards.set(card.dataset.deviceId, card);
  }

  const currentIds = new Set(state.devices.map(d => d.deviceId));

  // 释放已被删除的设备卡片及其实例
  for (const [id, card] of existingCards) {
    if (!currentIds.has(id)) {
      const player = state.previewPlayers.get(id);
      if (player) {
        state.previewPlayers.delete(id);
        player.close();
      }
      card.remove();
      existingCards.delete(id);
    }
  }

  // 就地增量更新已有卡片，避免销毁画布及硬件解码器
  state.devices.forEach((device, index) => {
    let card = existingCards.get(device.deviceId);
    if (!card) {
      card = createDeviceCard(device);
      grid.append(card);
    } else {
      updateDeviceCard(card, device, index);
    }
  });

  renderSelectedDevice();
  renderPreviewSummary();
  renderPipelineStepper();
  requestAllPreviews();
}

function stopPreview() {
  for (const timer of state.previewRetry.values()) clearTimeout(timer);
  state.previewRetry.clear();
  for (const [deviceId, player] of state.previewPlayers) {
    state.previewPlayers.delete(deviceId);
    window.dispatchEvent(new CustomEvent('device-preview:closed', { detail: { deviceId, player } }));
    player.close();
  }
}

function requestDevicePreview(device, card) {
  if (state.previewPlayers.has(device.deviceId)) return;
  const image = card.querySelector('.device-screen-image');
  const placeholder = card.querySelector('.device-screen-placeholder');
  const status = card.querySelector('.device-status');
  clearTimeout(state.previewRetry.get(device.deviceId));
  state.previewRetry.delete(device.deviceId);
  const player = new CloudVideoPlayer({ canvas: image, deviceId: device.deviceId,
    onFrame() {
      if (!card.isConnected || state.previewPlayers.get(device.deviceId) !== player) return;
      placeholder.hidden = true; image.hidden = false;
      if (card.classList.contains('preview-error') || !status.classList.contains('online')) {
        card.classList.remove('preview-error'); status.textContent = '在线'; status.classList.add('online');
        renderPreviewSummary();
      }
    },
    onMessage(message) {
      if (message.type === 'error') placeholder.textContent = message.message;
    },
    onError(error) { placeholder.textContent = error.message; },
    onClose(code) {
      if (state.previewPlayers.get(device.deviceId) !== player) return;
      state.previewPlayers.delete(device.deviceId);
      window.dispatchEvent(new CustomEvent('device-preview:closed', {
        detail: { deviceId: device.deviceId, player }
      }));
      if (!card.isConnected) return;
      placeholder.hidden = false;
      if (!code) placeholder.textContent = '画面已暂停';
      card.classList.add('preview-error'); status.textContent = '待刷新'; status.classList.remove('online');
      renderPreviewSummary();
      if (CloudVideoPlayer.canReconnect(code)) {
        state.previewRetry.set(device.deviceId, setTimeout(() => {
          if (card.isConnected) requestDevicePreview(device, card);
        }, 3000));
      }
    }
  });
  state.previewPlayers.set(device.deviceId, player);
}

function requestAllPreviews() {
  if (!state.tokenConfigured || !state.devices.length) return;
  const targetId = state.selectedDeviceId || state.devices[0]?.deviceId;

  // 释放非当前选中云机的视频流解码占用，节省客户端 GPU/CPU 与网络带宽
  for (const [id, player] of state.previewPlayers) {
    if (id !== targetId) {
      state.previewPlayers.delete(id);
      player.close();
    }
  }

  const selectedCard = elements.deviceGrid.querySelector(`.device-card[data-device-id="${targetId}"]`);
  const selectedDevice = state.devices.find(d => d.deviceId === targetId);
  if (selectedCard && selectedDevice) {
    requestDevicePreview(selectedDevice, selectedCard);
  }
}

function startPreview() {
  stopPreview();
  if (!state.devices.length || !state.tokenConfigured) return;
  requestAllPreviews();
}

window.copyToClipboard = copyToClipboard;
window.requestJson = requestJson;
window.showToast = showToast;
window.currentDevice = currentDevice;
window.externalScriptForDevice = externalScriptForDevice;
window.selectDevice = selectDevice;
window.stopPreview = stopPreview;
window.requestAllPreviews = requestAllPreviews;

