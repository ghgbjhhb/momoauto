(function (window) {
  'use strict';

  const getEl = id => document.getElementById(id);
  const showToast = (...args) => (window.showToast || console.log)(...args);
  const selectDevice = (...args) => (window.selectDevice || (() => {}))(...args);
  const currentDevice = (...args) => (window.currentDevice || (() => null))(...args);
  const externalScriptForDevice = (...args) => (window.externalScriptForDevice || (() => null))(...args);
  const requestAllPreviews = (...args) => (window.requestAllPreviews || (() => {}))(...args);
  const stopPreview = (...args) => (window.stopPreview || (() => {}))(...args);
  const requestJson = (...args) => (window.requestJson || (async (u, o) => (await fetch(u, o)).json()))(...args);
  const getElements = () => window.elements || {};

const manual = {
  targetDeviceId: '',
  socket: null,
  ready: false,
  player: null,
  retryTimer: null,
  retryAttempt: 0,
  videoRetryTimer: null,
  videoRetryAttempt: 0,
  inputWatchdogTimer: null,
  inputGeneration: 0,
  videoGeneration: 0,
  lastInputMessageAt: 0,
  inputErrorCode: '',
  pointer: null,
  lastMove: 0,
  generation: 0,
  frameAt: 0,
  width: 0,
  height: 0,
  visionActive: false,
  visionLoading: false,
  visionItems: [],
  hoveredItem: null,
  visionImageWidth: 720,
  visionImageHeight: 1280
};

function getActiveDeviceId() {
  return manual.targetDeviceId || (window.YunMomo?.store?.getSelectedDeviceId ? window.YunMomo.store.getSelectedDeviceId() : null) || window.state?.manualDeviceId || window.state?.selectedDeviceId || currentDevice()?.deviceId || '';
}

function stopManualInput() {
  clearTimeout(manual.retryTimer);
  manual.retryTimer = null;
  manual.retryAttempt = 0;
  clearInterval(manual.inputWatchdogTimer);
  manual.inputWatchdogTimer = null;
  manual.ready = false;
  manual.pointer = null;
  manual.inputErrorCode = '';
  if (manual.socket) {
    try {
      if (manual.socket.readyState === WebSocket.OPEN) {
        manual.socket.send(JSON.stringify({ type: 'release' }));
      }
      manual.socket.close(1000, 'Manual input stopped');
    } catch {}
    manual.socket = null;
  }
}
const dialog = getEl('controlDialog'), surface = getEl('controlStage'), controlImage = getEl('controlImage');
const controlStatus = getEl('controlStatus'), controlLoading = getEl('controlLoading');
const toggleVisionBtn = getEl('toggleVisionBtn');
const visionCanvas = getEl('visionOverlayCanvas');
const visionTooltip = getEl('visionTooltip');
const visionDeckCard = getEl('visionDeckCard');
const visionStatus = getEl('visionStatus');
const visionCount = getEl('visionCount');
const reinspectVisionBtn = getEl('reinspectVisionBtn');
const visionItemsList = getEl('visionItemsList');

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function sendInput(message) {
  if (document.hidden && message.type !== 'release') return false;
  if (manual.socket?.readyState !== WebSocket.OPEN || (!manual.ready && message.type !== 'release')) {
    if (message.type !== 'release' && !manual.ready) {
      showToast('触控通道连接中，请稍候…');
    }
    return false;
  }
  if (manual.socket.bufferedAmount > 32768) {
    manual.socket.close();
    manual.ready = false;
    controlStatus.textContent = '输入连接积压，已重置';
    return false;
  }
  manual.socket.send(JSON.stringify(message));
  return true;
}

function releaseManual() {
  sendInput({ type: 'release' }); manual.pointer = null;
}

function isControlOpen() {
  const win = dialog || getEl('controlDialog');
  return Boolean(win && !win.hidden && !win.hasAttribute('hidden') && win.style.display !== 'none');
}

function captureManual() {
  if (!isControlOpen() || document.hidden) return;
  if (!manual.socket || manual.socket.readyState === WebSocket.CLOSED || manual.socket.readyState === WebSocket.CLOSING) {
    startManualInput();
  }
  if (manual.player && !manual.player.closed) manual.player.refresh();
  else startManualVideo();
}

function activeControlCanvas() {
  return controlImage;
}

function latestControlFrameAt() {
  return manual.frameAt || manual.player?.stats?.frameAt || 0;
}

function getImageDisplayGeometry() {
  const image = activeControlCanvas();
  const natW = (image && image.width) || manual.visionImageWidth || manual.width || 720;
  const natH = (image && image.height) || manual.visionImageHeight || manual.height || 1280;
  const sw = surface.clientWidth || 360;
  const sh = surface.clientHeight || 640;

  if (!image || image.hidden) {
    const scale = Math.min(sw / natW, sh / natH);
    const width = natW * scale;
    const height = natH * scale;
    const left = (sw - width) / 2;
    const top = (sh - height) / 2;
    return { left, top, width, height, scale, imgW: natW, imgH: natH };
  }
  const rect = image.getBoundingClientRect();
  const imgW = (image.width && image.width > 0) ? image.width : natW;
  const imgH = (image.height && image.height > 0) ? image.height : natH;
  const scale = Math.min(rect.width / imgW, rect.height / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  const left = (rect.width - width) / 2;
  const top = (rect.height - height) / 2;
  return { left, top, width, height, scale, imgW, imgH };
}

function clearVisionCanvas() {
  if (!visionCanvas) return;
  const ctx = visionCanvas.getContext('2d');
  ctx.clearRect(0, 0, visionCanvas.width, visionCanvas.height);
}

function renderVisionOverlay() {
  if (!visionCanvas || !manual.visionActive || !isControlOpen()) return;
  const dpr = window.devicePixelRatio || 1;
  const sw = surface.clientWidth;
  const sh = surface.clientHeight;
  if (!sw || !sh) return;
  if (visionCanvas.width !== Math.round(sw * dpr) || visionCanvas.height !== Math.round(sh * dpr)) {
    visionCanvas.width = Math.round(sw * dpr);
    visionCanvas.height = Math.round(sh * dpr);
  }
  const ctx = visionCanvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, sw, sh);

  const geo = getImageDisplayGeometry();
  const natW = geo.imgW || manual.visionImageWidth || 720;
  const natH = geo.imgH || manual.visionImageHeight || 1280;
  const scaleX = geo.width / natW;
  const scaleY = geo.height / natH;

  for (const item of manual.visionItems) {
    const isHovered = manual.hoveredItem === item;
    const x = geo.left + item.left * scaleX;
    const y = geo.top + item.top * scaleY;
    const w = (item.right - item.left) * scaleX;
    const h = (item.bottom - item.top) * scaleY;

    // 绘制霓虹高亮边界框
    ctx.lineWidth = isHovered ? 2.5 : 1.5;
    ctx.strokeStyle = isHovered ? '#ffeb3b' : 'rgba(0, 240, 255, 0.85)';
    ctx.fillStyle = isHovered ? 'rgba(255, 235, 59, 0.25)' : 'rgba(0, 240, 255, 0.08)';
    ctx.shadowColor = isHovered ? '#ffeb3b' : '#00f0ff';
    ctx.shadowBlur = isHovered ? 8 : 4;

    const radius = Math.min(4, Math.max(0, w / 2), Math.max(0, h / 2));
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();

    // 控件文字与置信度微型胶囊
    if (isHovered || w > 36) {
      ctx.shadowBlur = 0;
      const text = item.text.length > 8 ? item.text.slice(0, 7) + '…' : item.text;
      const scorePct = Math.round((item.score || 0) * 100) + '%';
      const label = `${text} ${scorePct}`;
      ctx.font = 'bold 10px monospace, sans-serif';
      const textMetrics = ctx.measureText(label);
      const pillW = textMetrics.width + 8;
      const pillH = 14;
      const pillX = x;
      const pillY = Math.max(0, y - pillH - 2);

      ctx.fillStyle = isHovered ? 'rgba(255, 235, 59, 0.95)' : 'rgba(0, 20, 40, 0.85)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(pillX, pillY, pillW, pillH, 3);
      else ctx.rect(pillX, pillY, pillW, pillH);
      ctx.fill();
      ctx.strokeStyle = isHovered ? '#ffd600' : 'rgba(0, 240, 255, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = isHovered ? '#000' : '#00f0ff';
      ctx.fillText(label, pillX + 4, pillY + 10);
    }
  }

  ctx.restore();
}

function renderVisionItemsList() {
  if (!visionItemsList) return;
  visionItemsList.replaceChildren();
  if (!manual.visionItems.length) {
    const empty = document.createElement('div');
    empty.style.color = '#8b949e';
    empty.style.fontSize = '11px';
    empty.style.padding = '6px';
    empty.textContent = '暂无识别到的文字控件';
    visionItemsList.append(empty);
    return;
  }
  for (const item of manual.visionItems) {
    const row = document.createElement('div');
    row.className = 'vision-item-row';
    row.title = `点击触击该控件: "${item.text}" (${Math.round(item.center_x)}, ${Math.round(item.center_y)})`;

    const textSpan = document.createElement('span');
    textSpan.className = 'vision-item-text';
    textSpan.textContent = item.text;

    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'vision-item-score';
    scoreSpan.textContent = Math.round((item.score || 0) * 100) + '%';

    row.append(textSpan, scoreSpan);

    row.addEventListener('mouseenter', () => {
      manual.hoveredItem = item;
      renderVisionOverlay();
    });
    row.addEventListener('mouseleave', () => {
      if (manual.hoveredItem === item) {
        manual.hoveredItem = null;
        renderVisionOverlay();
      }
    });

    row.addEventListener('click', () => {
      manual.hoveredItem = item;
      renderVisionOverlay();
      if (manual.ready && manual.width && manual.height) {
        const normX = item.center_x / manual.width;
        const normY = item.center_y / manual.height;
        sendInput({ type: 'touch', action: 'down', x: normX, y: normY });
        setTimeout(() => sendInput({ type: 'touch', action: 'up', x: normX, y: normY }), 80);
        showToast(`已触击控件: "${item.text}"`);
      }
    });

    visionItemsList.append(row);
  }
}

async function inspectVisionCurrentFrame() {
  const deviceId = getActiveDeviceId();
  if (!isControlOpen() || !deviceId) return;
  if (manual.visionLoading) return;
  manual.visionLoading = true;
  if (toggleVisionBtn) toggleVisionBtn.textContent = '识别中…';
  showToast('正在进行 AI 视觉透视分析…');
  const generation = manual.generation;
  try {
    const res = await requestJson('/api/vision-inspect?deviceId=' + encodeURIComponent(deviceId));
    if (!isControlOpen() || !manual.visionActive || generation !== manual.generation) return;
    manual.visionItems = res.items || [];
    manual.visionImageWidth = res.width || manual.width || 720;
    manual.visionImageHeight = res.height || manual.height || 1280;
    renderVisionOverlay();
    renderVisionItemsList();
    showToast(`AI 视觉识别完成：共 ${manual.visionItems.length} 个控件`);
  } catch (error) {
    if (!isControlOpen() || !manual.visionActive) return;
    showToast('AI 视觉识别失败: ' + error.message);
  } finally {
    manual.visionLoading = false;
    if (toggleVisionBtn) {
      toggleVisionBtn.textContent = manual.visionActive ? '视觉✓' : '视觉';
    }
  }
}

function setVisionActive(active) {
  manual.visionActive = active;
  if (toggleVisionBtn) {
    toggleVisionBtn.classList.toggle('active', active);
    toggleVisionBtn.textContent = active ? '视觉✓' : '视觉';
    toggleVisionBtn.title = active ? 'AI 视觉透视开启中（点击关闭）' : '切换 AI 视觉透视';
  }
  if (visionCanvas) {
    visionCanvas.hidden = !active;
    visionCanvas.style.display = active ? 'block' : 'none';
  }
  if (!active) {
    manual.visionItems = [];
    manual.hoveredItem = null;
    if (visionTooltip) visionTooltip.hidden = true;
    clearVisionCanvas();
    showToast('AI 视觉透视已关闭');
  } else {
    inspectVisionCurrentFrame();
  }
}

function handleVisionPointerMove(event) {
  if (!manual.visionActive || !manual.visionItems.length) {
    if (visionTooltip && !visionTooltip.hidden) visionTooltip.hidden = true;
    return;
  }
  const geo = getImageDisplayGeometry();
  const natW = geo.imgW || manual.visionImageWidth || 720;
  const natH = geo.imgH || manual.visionImageHeight || 1280;
  const scaleX = geo.width / natW;
  const scaleY = geo.height / natH;

  const rect = surface.getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;

  let matched = null;
  for (let i = manual.visionItems.length - 1; i >= 0; i--) {
    const item = manual.visionItems[i];
    const x = geo.left + item.left * scaleX;
    const y = geo.top + item.top * scaleY;
    const w = (item.right - item.left) * scaleX;
    const h = (item.bottom - item.top) * scaleY;
    if (mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h) {
      matched = item;
      break;
    }
  }

  if (matched !== manual.hoveredItem) {
    manual.hoveredItem = matched;
    renderVisionOverlay();
  }

  if (matched && visionTooltip) {
    const x = geo.left + matched.center_x * scaleX;
    const y = geo.top + matched.top * scaleY;
    visionTooltip.style.left = `${x}px`;
    visionTooltip.style.top = `${y}px`;
    const scorePct = ((matched.score || 0) * 100).toFixed(1);
    visionTooltip.innerHTML = `
      <div class="vision-tooltip-text">${escapeHtml(matched.text)}</div>
      <div class="vision-tooltip-meta">置信度: <span>${scorePct}%</span> · 坐标: (${Math.round(matched.center_x)}, ${Math.round(matched.center_y)})</div>
    `;
    visionTooltip.hidden = false;
  } else if (visionTooltip) {
    visionTooltip.hidden = true;
  }
}

function updateDeckTelemetry(device) {
  const devices = window.state?.devices || [];
  const index = devices.indexOf(device) + 1;
  const badgeText = '#' + String(index > 0 ? index : 1).padStart(2, '0');
  const badgeEl = getEl('controlDeviceBadge');
  if (badgeEl) badgeEl.textContent = badgeText;
  const titleEl = getEl('controlTitle');
  if (titleEl) titleEl.textContent = `${device.name || '云手机'} · 原画操作台`;
}

function openManualControl(device) {
  try {
    if (!device) {
      device = currentDevice() || window.state?.devices?.[0];
    }
    if (!device) {
      showToast('未选择云手机');
      return;
    }
    if (!window.state?.tokenConfigured) {
      showToast('网页登录态未就绪');
      return;
    }
    if (window.state?.runningScript) {
      showToast('当前脚本执行中，请等待结束再手动操作');
      return;
    }
    const externalRun = externalScriptForDevice(device.deviceId);
    if (externalRun) {
      showToast(`${device.name} 正在另一个网页执行「${externalRun.title}」`);
      return;
    }
    const dlg = dialog || getEl('controlDialog');
    if (!dlg) {
      showToast('控制台组件未就绪');
      return;
    }

    // 若当前浮窗已打开且为同一设备，仅聚焦并确保通道通畅
    if (manual.targetDeviceId === device.deviceId && isControlOpen()) {
      surface?.focus();
      if (!manual.socket || manual.socket.readyState === WebSocket.CLOSED) {
        startManualInput();
      }
      return;
    }

    window.AppLogger?.info('ManualControl', `打开放大操作云机控制台 [${device.name}] (${device.deviceId})`);

    // 切换设备或重新打开时，优雅重置已有连接，避免触发伪关闭事件
    stopManualInput();
    stopManualVideo();

    manual.targetDeviceId = device.deviceId;
    selectDevice(device.deviceId);
    if (window.state) window.state.manualDeviceId = device.deviceId;

    manual.generation++;
    manual.ready = false;
    manual.pointer = null;
    manual.frameAt = 0;

    // 优先复制左侧已有画面快照，秒速上屏，零等待无黑屏
    const previewPlayer = window.state?.previewPlayers?.get(device.deviceId);
    const prevCanvas = previewPlayer?.canvas;
    if (prevCanvas && prevCanvas.width && prevCanvas.height) {
      try {
        controlImage.width = prevCanvas.width;
        controlImage.height = prevCanvas.height;
        const ctx = controlImage.getContext('2d');
        ctx.drawImage(prevCanvas, 0, 0);
        controlImage.hidden = false;
        controlImage.style.display = 'block';
        controlLoading.hidden = true;
        controlLoading.style.display = 'none';
        manual.width = prevCanvas.width;
        manual.height = prevCanvas.height;
      } catch {}
    } else {
      controlLoading.innerHTML = '<div class="spinner"></div><span>正在载入实时画面…</span>';
      controlLoading.hidden = false;
      controlLoading.style.display = 'flex';
      controlImage.hidden = true;
      controlImage.style.display = 'none';
    }

    updateDeckTelemetry(device);
    controlStatus.textContent = '正在建立控制连接…';

    // 浮窗显示与位置自适应
    dlg.hidden = false;
    dlg.removeAttribute('hidden');
    dlg.setAttribute('open', '');
    dlg.style.display = 'flex';

    const rect = dlg.getBoundingClientRect();
    if (!dlg.style.left || rect.width === 0 || rect.right < 50 || rect.left > window.innerWidth - 50) {
      const winW = 384;
      const winH = Math.min(window.innerHeight - 40, 720);
      const left = Math.max(16, Math.round((window.innerWidth - winW) / 2));
      const top = Math.max(16, Math.round((window.innerHeight - winH) / 2));
      dlg.style.position = 'fixed';
      dlg.style.margin = '0';
      dlg.style.left = left + 'px';
      dlg.style.top = top + 'px';
    }

    surface?.focus();
    startManualInput();
    startManualVideo();
  } catch (err) {
    window.AppLogger?.error('ManualControl', '打开放大操作控制台失败: ' + err.message, { stack: err.stack });
    showToast('打开控制台失败: ' + err.message);
  }
}
window.openManualControl = openManualControl;

function startManualInput() {
  if (!isControlOpen()) return;
  if (manual.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(manual.socket.readyState)) return;

  const deviceId = getActiveDeviceId();
  if (!deviceId) {
    controlStatus.textContent = '未选择有效云手机';
    return;
  }
  manual.targetDeviceId = deviceId;
  if (window.state) window.state.manualDeviceId = deviceId;

  clearTimeout(manual.retryTimer);
  manual.retryTimer = null;
  const generation = ++manual.inputGeneration;
  manual.ready = false;
  manual.inputErrorCode = '';
  manual.pointer = null;
  manual.lastInputMessageAt = Date.now();

  const url = new URL('/api/control-input', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('deviceId', deviceId);
  url.searchParams.set('pageId', window.state?.pageId || '');
  try {
    const token = localStorage.getItem('yunmomo.auth_token');
    if (token) url.searchParams.set('token', token);
  } catch {}

  const socket = manual.socket = new WebSocket(url);
  socket.onmessage = event => {
    if (generation !== manual.inputGeneration || manual.socket !== socket) return;
    manual.lastInputMessageAt = Date.now();
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'size' || message.type === 'ready') {
      if (manual.width && (manual.width !== message.width || manual.height !== message.height)) {
        releaseManual();
        manual.frameAt = 0;
      }
      manual.width = message.width;
      manual.height = message.height;
    }
    if (message.type === 'ready') {
      manual.ready = true;
      manual.retryAttempt = 0;
      manual.maxFps = message.maxFps;
      controlStatus.textContent = `手动控制已就绪 · 画面最高 ${manual.maxFps || 30} 帧/秒`;
    } else if (message.type === 'error') {
      manual.inputErrorCode = message.code || '';
      if (message.code === 'INPUT_FAILED') {
        releaseManual();
      }
      controlStatus.textContent = message.message;
      showToast(message.message);
    } else if (message.type === 'input_reset') {
      manual.pointer = null;
      showToast(message.message);
    }
  };
  socket.onerror = () => {
    if (generation === manual.inputGeneration && isControlOpen()) {
      controlStatus.textContent = '触控连接中断，正在恢复…';
    }
  };
  socket.onclose = () => {
    if (generation !== manual.inputGeneration || manual.socket !== socket) return;
    clearInterval(manual.inputWatchdogTimer);
    manual.inputWatchdogTimer = null;
    manual.ready = false;
    manual.pointer = null;
    manual.socket = null;
    if (!isControlOpen() || !CloudVideoPlayer.canReconnect(manual.inputErrorCode)) return;
    controlStatus.textContent = '正在恢复触控连接…';
    const delay = Math.min(30000, 1500 * 2 ** Math.min(manual.retryAttempt++, 5));
    manual.retryTimer = setTimeout(() => {
      manual.retryTimer = null;
      if (generation === manual.inputGeneration && isControlOpen()) {
        startManualInput();
      }
    }, delay);
  };
  manual.inputWatchdogTimer = setInterval(() => {
    if (generation === manual.inputGeneration && manual.socket === socket &&
        Date.now() - manual.lastInputMessageAt > 12000) socket.close();
  }, 3000);
  manual.inputWatchdogTimer.unref?.();
}

function startManualVideo() {
  if (!isControlOpen()) return;

  const deviceId = getActiveDeviceId();
  if (!deviceId) return;
  manual.targetDeviceId = deviceId;
  if (window.state) window.state.manualDeviceId = deviceId;

  clearTimeout(manual.videoRetryTimer);
  manual.videoRetryTimer = null;
  const generation = ++manual.videoGeneration;
  manual.frameAt = 0;

  // 极速同步机制：若左侧预览流已在正常解码，直接接入 mirrorCanvas，0 延迟、0 丢包！
  const previewPlayer = window.state?.previewPlayers?.get(deviceId);
  if (previewPlayer && !previewPlayer.closed && previewPlayer.socket?.readyState === WebSocket.OPEN) {
    previewPlayer.mirrorCanvas = controlImage;
    previewPlayer.mirrorContext = null;
    previewPlayer.onMirrorFrame = ({ width, height, frameAt }) => {
      if (generation !== manual.videoGeneration || !isControlOpen()) return;
      manual.videoRetryAttempt = 0;
      manual.frameAt = frameAt;
      controlLoading.hidden = true;
      controlLoading.style.display = 'none';
      manual.width = width;
      manual.height = height;
      controlImage.hidden = false;
      controlImage.style.display = 'block';
      if (manual.visionActive) renderVisionOverlay();
    };
    controlLoading.hidden = true;
    controlLoading.style.display = 'none';
    controlImage.hidden = false;
    controlImage.style.display = 'block';
    controlStatus.textContent = '手动控制已就绪 · 原画实时同步';
    return;
  }

  if (manual.player && !manual.player.closed) return;

  const player = manual.player = new CloudVideoPlayer({
    canvas: controlImage,
    deviceId: deviceId,
    onMessage(message) {
      if (generation !== manual.videoGeneration) return;
      if ((message.type === 'size' || message.type === 'ready') && message.width && message.height) {
        manual.width = message.width;
        manual.height = message.height;
      }
    },
    onFrame({ width, height, frameAt }) {
      if (generation !== manual.videoGeneration || !isControlOpen()) return;
      manual.videoRetryAttempt = 0;
      manual.frameAt = frameAt;
      controlLoading.hidden = true;
      controlLoading.style.display = 'none';
      manual.width = width;
      manual.height = height;
      controlImage.hidden = false;
      controlImage.style.display = 'block';
      if (manual.visionActive) renderVisionOverlay();
    },
    onError(error) {
      if (generation !== manual.videoGeneration) return;
      manual.frameAt = 0;
      controlLoading.textContent = error.message;
      controlLoading.hidden = false;
      controlLoading.style.display = 'flex';
    },
    onClose(code) {
      if (generation !== manual.videoGeneration || manual.player !== player) return;
      manual.frameAt = 0;
      manual.player = null;
      if (!isControlOpen() || !CloudVideoPlayer.canReconnect(code)) return;
      controlStatus.textContent = '正在恢复投屏画面…';
      controlLoading.textContent = controlStatus.textContent;
      controlLoading.hidden = false;
      controlLoading.style.display = 'flex';
      const delay = Math.min(30000, 1500 * 2 ** Math.min(manual.videoRetryAttempt++, 5));
      manual.videoRetryTimer = setTimeout(() => {
        manual.videoRetryTimer = null;
        if (generation === manual.videoGeneration && isControlOpen()) {
          startManualVideo();
        }
      }, delay);
    }
  });
}

function stopManualVideo() {
  clearTimeout(manual.videoRetryTimer);
  manual.videoRetryTimer = null;
  manual.videoRetryAttempt = 0;
  const deviceId = getActiveDeviceId();
  if (deviceId) {
    const previewPlayer = window.state?.previewPlayers?.get(deviceId);
    if (previewPlayer) {
      previewPlayer.mirrorCanvas = null;
      previewPlayer.mirrorContext = null;
      previewPlayer.onMirrorFrame = null;
    }
  }
  if (manual.player) {
    try { manual.player.close(); } catch {}
    manual.player = null;
  }
}

function bindCopyBtn(btnId, getText) {
  const btn = getEl(btnId);
  if (!btn) return;
  btn.addEventListener('click', () => {
    const text = getText();
    if (!text || text === '--') return;
    window.copyToClipboard(text, '已复制虚拟机 ID: ' + text);
    const span = btn.querySelector('.copy-label') || btn.querySelector('.btn-text');
    if (span) {
      const orig = span.textContent;
      span.textContent = '已复制✓';
      btn.classList.add('copied');
      setTimeout(() => {
        span.textContent = orig;
        btn.classList.remove('copied');
      }, 1800);
    }
  });
}

bindCopyBtn('copyControlIdBtn', () => window.state.manualDeviceId || (currentDevice()?.deviceId));
bindCopyBtn('deckCopyIdBtn', () => window.state.manualDeviceId || (currentDevice()?.deviceId));

function closeManualControl() {
  setVisionActive(false);
  stopManualInput();
  stopManualVideo();
  manual.targetDeviceId = '';
  if (window.state) window.state.manualDeviceId = '';
  controlImage.hidden = true;
  controlImage.style.display = 'none';
  try {
    const dlg = dialog || getEl('controlDialog');
    if (dlg) {
      dlg.hidden = true;
      dlg.setAttribute('hidden', '');
      dlg.removeAttribute('open');
      dlg.style.display = 'none';
      if (typeof dlg.close === 'function') {
        try { dlg.close(); } catch {}
      }
    }
  } catch {}
  requestAllPreviews();
  (getElements().deviceGrid || getEl('deviceGrid'))?.querySelector('.selected')?.focus();
}
window.closeManualControl = closeManualControl;

dialog.addEventListener('close', () => {
  if (!manual.targetDeviceId && !window.state?.manualDeviceId) return;
  closeManualControl();
});

const closeCtrl = getEl('closeControl');
if (closeCtrl) closeCtrl.addEventListener('click', closeManualControl);

// 支持标题栏全屏任意拖拽 (Draggable Floating Window)
const heading = getEl('controlHeading');
if (heading && dialog) {
  let isDragging = false;
  let startX = 0, startY = 0;
  let initialLeft = 0, initialTop = 0;

  heading.addEventListener('pointerdown', event => {
    // 忽略标题栏上的功能按钮点击（如关闭 ✕、复制ID、视觉透视等）
    if (event.target.closest('button, a, input, select')) return;
    if (event.button !== 0) return;

    isDragging = true;
    heading.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    startX = event.clientX;
    startY = event.clientY;

    const rect = dialog.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    dialog.style.left = initialLeft + 'px';
    dialog.style.top = initialTop + 'px';
    dialog.style.margin = '0';
    dialog.style.position = 'fixed';

    const onPointerMove = e => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      const maxLeft = Math.max(0, window.innerWidth - (dialog.offsetWidth || 384));
      const maxTop = Math.max(0, window.innerHeight - (dialog.offsetHeight || 600));

      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));

      dialog.style.left = newLeft + 'px';
      dialog.style.top = newTop + 'px';
    };

    const onPointerUp = () => {
      if (!isDragging) return;
      isDragging = false;
      heading.style.cursor = 'grab';
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });
}

// 支持按 Esc 键关闭悬浮窗
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && isControlOpen()) {
    closeManualControl();
  }
});

const refreshCtrl = getEl('refreshControl');
if (refreshCtrl) refreshCtrl.addEventListener('click', captureManual);
if (toggleVisionBtn) {
  toggleVisionBtn.addEventListener('click', () => {
    setVisionActive(!manual.visionActive);
  });
}
if (reinspectVisionBtn) {
  reinspectVisionBtn.addEventListener('click', () => {
    inspectVisionCurrentFrame();
  });
}
for (const button of dialog.querySelectorAll('[data-nav]')) {
  button.addEventListener('click', event => {
    event.stopPropagation();
    const rawKey = button.dataset.nav;
    const key = rawKey === 'task' ? 'overview' : rawKey;
    sendInput({ type: 'nav', key });
    surface.focus();
  });
}

function normalizedPoint(event, clamp = false) {
  const image = activeControlCanvas();
  const targetEl = (image && !image.hidden) ? image : surface;
  const rect = targetEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const imgW = (image && image.width) || manual.width || 720;
  const imgH = (image && image.height) || manual.height || 1280;
  const scale = Math.min(rect.width / imgW, rect.height / imgH);
  const width = imgW * scale, height = imgH * scale;
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  if (!clamp && (x < 0 || y < 0 || x > 1 || y > 1)) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}
surface.addEventListener('pointerdown', event => {
  if (event.button !== 0 || manual.pointer !== null) return;
  const point = normalizedPoint(event);
  if (!point) return;
  event.preventDefault();
  surface.focus();
  if (sendInput({ type: 'touch', action: 'down', ...point })) {
    manual.pointer = event.pointerId;
    try { surface.setPointerCapture(event.pointerId); } catch {}
  }
});
surface.addEventListener('pointermove', event => {
  if (manual.pointer === null) {
    if (manual.visionActive) handleVisionPointerMove(event);
    return;
  }
  if (event.pointerId !== manual.pointer || performance.now() - manual.lastMove < 16) return;
  const point = normalizedPoint(event, true);
  if (!point) return;
  manual.lastMove = performance.now();
  sendInput({ type: 'touch', action: 'move', ...point });
});
surface.addEventListener('pointerleave', () => {
  if (manual.visionActive) {
    manual.hoveredItem = null;
    renderVisionOverlay();
    if (visionTooltip) visionTooltip.hidden = true;
  }
});
window.addEventListener('resize', () => {
  if (manual.visionActive) renderVisionOverlay();
});
surface.addEventListener('pointerup', event => {
  if (event.pointerId !== manual.pointer) return;
  const point = normalizedPoint(event, true);
  if (point) sendInput({ type: 'touch', action: 'up', ...point });
  else releaseManual();
  manual.pointer = null;
  try {
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
  } catch {}
});
surface.addEventListener('pointercancel', releaseManual);
surface.addEventListener('lostpointercapture', releaseManual);
surface.addEventListener('contextmenu', event => event.preventDefault());
surface.addEventListener('wheel', event => {
  const point = normalizedPoint(event); if (!point) return;
  event.preventDefault(); if (event.deltaY) sendInput({ type: 'scroll', ...point, dy: -Math.sign(event.deltaY) * Math.min(3, Math.max(1, Math.round(Math.abs(event.deltaY) / 100))) });
}, { passive: false });

const keyNames = { Backspace: 'DEL', Delete: 'FORWARD_DEL', Enter: 'ENTER', NumpadEnter: 'ENTER', Space: 'SPACE', Tab: 'TAB', ArrowUp: 'DPAD_UP', ArrowDown: 'DPAD_DOWN', ArrowLeft: 'DPAD_LEFT', ArrowRight: 'DPAD_RIGHT', Home: 'MOVE_HOME', End: 'MOVE_END', Minus: 'MINUS', Equal: 'EQUALS', BracketLeft: 'LEFT_BRACKET', BracketRight: 'RIGHT_BRACKET', Backslash: 'BACKSLASH', Semicolon: 'SEMICOLON', Quote: 'APOSTROPHE', Slash: 'SLASH', Backquote: 'GRAVE' };
function keyboard(event, action) {
  if (!manual.ready || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key === 'Escape') return;
  const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? 'DIGIT_' + event.code.slice(5) : keyNames[event.code];
  if (!key) return;
  event.preventDefault(); sendInput({ type: 'key', key, action, shift: event.shiftKey });
}
surface.addEventListener('keydown', event => keyboard(event, 'down'));
surface.addEventListener('keyup', event => keyboard(event, 'up'));
surface.addEventListener('blur', releaseManual);
window.addEventListener('blur', releaseManual);
window.addEventListener('pagehide', () => { stopManualVideo(); stopPreview(); });
document.addEventListener('visibilitychange', () => {
  // Keep video transports alive in the background, but never keep held input.
  if (document.hidden) { releaseManual(); manual.frameAt = 0; }
  else if (isControlOpen()) captureManual(); else requestAllPreviews();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  if (isControlOpen()) captureManual(); else requestAllPreviews();
});
window.addEventListener('online', () => {
  if (isControlOpen()) captureManual(); else requestAllPreviews();
});

const previewSize = getEl('previewSize');
const previewSizeValue = getEl('previewSizeValue');

function updatePreviewSize(val) {
  const width = Math.min(650, Math.max(220, Number(val) || 340));
  document.documentElement.style.setProperty('--device-width', width + 'px');
  if (previewSize) previewSize.value = String(width);
  if (previewSizeValue) previewSizeValue.textContent = width + 'px';
  try { localStorage.setItem('yunmomo.previewWidth', String(width)); } catch {}
}

if (previewSize) {
  let saved = 340;
  try {
    const s = Number(localStorage.getItem('yunmomo.previewWidth'));
    if (s >= 220 && s <= 650) saved = s;
  } catch {}
  updatePreviewSize(saved);
  previewSize.addEventListener('input', e => updatePreviewSize(e.target.value));
}
window.updatePreviewSize = updatePreviewSize;

})(window);
