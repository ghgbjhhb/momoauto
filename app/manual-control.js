'use strict';

const manual = {
  socket: null,
  ready: false,
  player: null,
  previewPlayer: null,
  previewCanvas: null,
  previewParent: null,
  previewNextSibling: null,
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
const dialog = byId('controlDialog'), surface = byId('controlStage'), controlImage = byId('controlImage');
const controlStatus = byId('controlStatus'), controlLoading = byId('controlLoading');
const toggleVisionBtn = byId('toggleVisionBtn');
const visionCanvas = byId('visionOverlayCanvas');
const visionTooltip = byId('visionTooltip');
const visionDeckCard = byId('visionDeckCard');
const visionStatus = byId('visionStatus');
const visionCount = byId('visionCount');
const reinspectVisionBtn = byId('reinspectVisionBtn');
const visionItemsList = byId('visionItemsList');

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}

function sendInput(message) {
  if (document.hidden && message.type !== 'release') return false;
  if (manual.socket?.readyState !== WebSocket.OPEN || (!manual.ready && message.type !== 'release')) return false;
  const frameAt = latestControlFrameAt();
  if (message.type !== 'release' && (!frameAt || Date.now() - frameAt > 6000)) {
    releaseManual(); showToast('画面尚未就绪或已过时，请等待最新原图'); return false;
  }
  if (manual.socket.bufferedAmount > 32768) { manual.socket.close(); manual.ready = false; controlStatus.textContent = '输入连接积压，已停止，请重新打开'; return false; }
  manual.socket.send(JSON.stringify(message)); return true;
}

function releaseManual() {
  sendInput({ type: 'release' }); manual.pointer = null;
}

function captureManual() {
  if (!dialog.open || document.hidden) return;
  if (!manual.socket || manual.socket.readyState === WebSocket.CLOSED || manual.socket.readyState === WebSocket.CLOSING) {
    startManualInput();
  }
  const player = manual.previewPlayer && !manual.previewPlayer.closed
    ? manual.previewPlayer : manual.player;
  if (player && !player.closed) player.refresh();
  else startManualVideo();
}

function activeControlCanvas() {
  return manual.previewCanvas || controlImage;
}

function latestControlFrameAt() {
  const previewFrameAt = manual.previewPlayer && !manual.previewPlayer.closed
    ? manual.previewPlayer.stats?.frameAt || 0
    : 0;
  return Math.max(manual.frameAt || 0, previewFrameAt);
}

function getImageDisplayGeometry() {
  const image = activeControlCanvas();
  if (!image || image.hidden || !latestControlFrameAt()) {
    const w = surface.clientWidth || 360, h = surface.clientHeight || 640;
    return { left: 0, top: 0, width: w, height: h, scale: 1, imgW: w, imgH: h };
  }
  const rect = image.getBoundingClientRect();
  const scale = Math.min(rect.width / image.width, rect.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const left = (rect.width - width) / 2;
  const top = (rect.height - height) / 2;
  return { left, top, width, height, scale, imgW: image.width, imgH: image.height };
}

function clearVisionCanvas() {
  if (!visionCanvas) return;
  const ctx = visionCanvas.getContext('2d');
  ctx.clearRect(0, 0, visionCanvas.width, visionCanvas.height);
}

function renderVisionOverlay() {
  if (!visionCanvas || !manual.visionActive || !dialog.open) return;
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
  if (!dialog.open || !state.manualDeviceId) return;
  if (manual.visionLoading) return;
  manual.visionLoading = true;
  const generation = manual.generation;
  if (visionStatus) {
    visionStatus.textContent = 'RapidOCR 识别中…';
    visionStatus.className = 'deck-val text-cyan';
  }
  try {
    const res = await requestJson('/api/vision-inspect?deviceId=' + encodeURIComponent(state.manualDeviceId));
    if (!dialog.open || !manual.visionActive || generation !== manual.generation) return;
    manual.visionItems = res.items || [];
    manual.visionImageWidth = res.width || manual.width || 720;
    manual.visionImageHeight = res.height || manual.height || 1280;
    if (visionStatus) {
      visionStatus.textContent = '透视已就绪';
      visionStatus.className = 'deck-val text-green';
    }
    if (visionCount) {
      visionCount.textContent = `${manual.visionItems.length} 个`;
    }
    renderVisionOverlay();
    renderVisionItemsList();
  } catch (error) {
    if (!dialog.open || !manual.visionActive) return;
    if (visionStatus) {
      visionStatus.textContent = '识别失败: ' + error.message;
      visionStatus.className = 'deck-val text-red';
    }
    showToast('AI 视觉识别失败: ' + error.message);
  } finally {
    manual.visionLoading = false;
  }
}

function setVisionActive(active) {
  manual.visionActive = active;
  if (toggleVisionBtn) toggleVisionBtn.classList.toggle('active', active);
  if (visionCanvas) visionCanvas.hidden = !active;
  if (visionDeckCard) {
    visionDeckCard.hidden = !active;
    visionDeckCard.style.display = active ? 'flex' : 'none';
  }
  if (!active) {
    manual.visionItems = [];
    manual.hoveredItem = null;
    if (visionTooltip) visionTooltip.hidden = true;
    clearVisionCanvas();
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
  const index = state.devices.indexOf(device) + 1;
  const badgeText = '#' + String(index).padStart(2, '0');
  const badgeEl = byId('controlDeviceBadge');
  if (badgeEl) badgeEl.textContent = badgeText;
  const titleEl = byId('controlTitle');
  if (titleEl) titleEl.textContent = `${device.name} · 原画操作台`;
  const deckIdx = byId('deckDeviceIndex');
  if (deckIdx) deckIdx.textContent = `${badgeText} 云手机`;
  const deckName = byId('deckDeviceName');
  if (deckName) deckName.textContent = device.name;
  const deckId = byId('deckDeviceId');
  if (deckId) deckId.textContent = device.deviceId;
  const deckRes = byId('deckResolution');
  if (deckRes) deckRes.textContent = `${manual.width || 720} × ${manual.height || 1280} (9:16)`;
}

function takePreviewCanvas(device) {
  const player = state.previewPlayers.get(device.deviceId);
  const source = player?.canvas;
  if (!player || player.closed || !source?.width || !source?.height) return null;
  return { player, canvas: source, parent: source.parentElement, nextSibling: source.nextSibling };
}

function restorePreviewCanvas() {
  const canvas = manual.previewCanvas;
  if (!canvas) return;
  canvas.classList.remove('control-preview-image');
  const currentCard = [...elements.deviceGrid.querySelectorAll('.device-card')]
    .find(card => card.dataset.deviceId === state.manualDeviceId);
  const parent = manual.previewParent?.isConnected
    ? manual.previewParent
    : currentCard?.querySelector('.device-screen');
  const before = parent === manual.previewParent && manual.previewNextSibling?.parentNode === parent
    ? manual.previewNextSibling
    : parent?.querySelector('.screen-hover-hint');
  if (parent) parent.insertBefore(canvas, before || null);
  else canvas.remove();
  manual.previewPlayer = null;
  manual.previewCanvas = null;
  manual.previewParent = null;
  manual.previewNextSibling = null;
}

function openManualControl(device) {
  if (!state.tokenConfigured) { showToast('网页登录态未就绪'); return; }
  if (state.runningScript) { showToast('当前脚本执行中，请等待结束再手动操作'); return; }
  const externalRun = externalScriptForDevice(device.deviceId);
  if (externalRun) { showToast(`${device.name} 正在另一个网页执行「${externalRun.title}」`); return; }
  if (dialog.open) return;
  const preview = takePreviewCanvas(device);
  selectDevice(device.deviceId); state.manualDeviceId = device.deviceId;
  manual.generation++; manual.ready = false; manual.pointer = null; manual.frameAt = 0;
  manual.previewPlayer = preview?.player || null;
  manual.previewCanvas = preview?.canvas || null;
  manual.previewParent = preview?.parent || null;
  manual.previewNextSibling = preview?.nextSibling || null;
  manual.width = preview?.canvas.width || 0; manual.height = preview?.canvas.height || 0;
  if (manual.previewCanvas) {
    const hasFrame = Boolean(manual.previewPlayer.stats?.frameAt);
    manual.previewCanvas.classList.add('control-preview-image');
    manual.previewCanvas.hidden = !hasFrame;
    surface.insertBefore(manual.previewCanvas, controlImage);
    controlImage.hidden = true;
    controlImage.style.display = 'none';
    controlLoading.hidden = hasFrame;
    controlLoading.style.display = hasFrame ? 'none' : 'flex';
    if (!hasFrame) controlLoading.innerHTML = '<div class="spinner"></div><span>正在载入实时画面…</span>';
  } else {
    controlLoading.innerHTML = '<div class="spinner"></div><span>正在读取原画…</span>';
    controlLoading.hidden = false;
    controlLoading.style.display = 'flex';
    controlImage.hidden = true;
    controlImage.style.display = 'none';
  }

  updateDeckTelemetry(device);
  controlStatus.textContent = manual.previewCanvas
    ? '保持当前画面连接，正在接通触控…'
    : '正在建立 SDK 控制连接…';
  dialog.showModal(); surface.focus();
  startManualInput();
  if (!manual.previewCanvas) startManualVideo();
}

function startManualInput() {
  if (!dialog.open || (manual.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(manual.socket.readyState))) return;
  clearTimeout(manual.retryTimer); manual.retryTimer = null;
  const generation = ++manual.inputGeneration;
  manual.ready = false; manual.inputErrorCode = ''; manual.pointer = null;
  manual.lastInputMessageAt = Date.now();
  const url = new URL('/api/control-input', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('deviceId', state.manualDeviceId);
  url.searchParams.set('pageId', state.pageId);
  const socket = manual.socket = new WebSocket(url);
  socket.onmessage = event => {
    if (generation !== manual.inputGeneration || manual.socket !== socket) return;
    manual.lastInputMessageAt = Date.now();
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'size' || message.type === 'ready') {
      if (manual.width && (manual.width !== message.width || manual.height !== message.height)) {
        releaseManual(); manual.frameAt = 0;
      }
      manual.width = message.width; manual.height = message.height;
      const deckRes = byId('deckResolution');
      if (deckRes) deckRes.textContent = `${manual.width} × ${manual.height} (9:16)`;
    }
    if (message.type === 'ready') {
      manual.ready = true; manual.retryAttempt = 0;
      manual.maxFps = message.maxFps;
      controlStatus.textContent = `手动控制已就绪 · 画面最高 ${manual.maxFps || 30} 帧/秒`;
      const config = byId('deckVideoConfig');
      if (config) {
        const bounds = message.bounds || {};
        const dimensions = bounds.width && bounds.height ? `${bounds.width}×${bounds.height}` : '尺寸自适应';
        const bitrate = Number(message.bitrate);
        const rate = Number.isFinite(bitrate) && bitrate > 0 ? `${(bitrate / 1000000).toFixed(1)} Mbps` : '码率自适应';
        config.textContent = `H.264 · ${dimensions} · ${rate} · ${manual.maxFps || 30} 帧/秒上限`;
        config.title = Number.isFinite(bitrate) && bitrate > 0 ? `${bitrate.toLocaleString('zh-CN')} bit/s` : '';
      }
    } else if (message.type === 'error') {
      manual.inputErrorCode = message.code || '';
      if (message.code === 'INPUT_FAILED') { manual.ready = false; releaseManual(); }
      controlStatus.textContent = message.message;
      showToast(message.message);
    } else if (message.type === 'input_reset') {
      manual.pointer = null;
      showToast(message.message);
    }
  };
  socket.onerror = () => {
    if (generation === manual.inputGeneration && dialog.open) controlStatus.textContent = '触控连接中断，正在恢复…';
  };
  socket.onclose = () => {
    if (generation !== manual.inputGeneration || manual.socket !== socket) return;
    clearInterval(manual.inputWatchdogTimer); manual.inputWatchdogTimer = null;
    manual.ready = false; manual.pointer = null; manual.socket = null;
    if (!dialog.open || !CloudVideoPlayer.canReconnect(manual.inputErrorCode)) return;
    controlStatus.textContent = '正在恢复触控连接…';
    const delay = Math.min(30000, 1500 * 2 ** Math.min(manual.retryAttempt++, 5));
    manual.retryTimer = setTimeout(() => {
      manual.retryTimer = null;
      if (generation === manual.inputGeneration && dialog.open) startManualInput();
    }, delay);
  };
  manual.inputWatchdogTimer = setInterval(() => {
    if (generation === manual.inputGeneration && manual.socket === socket &&
        Date.now() - manual.lastInputMessageAt > 12000) socket.close();
  }, 3000);
  manual.inputWatchdogTimer.unref?.();
}

function startManualVideo() {
  if (!dialog.open || (manual.player && !manual.player.closed)) return;
  clearTimeout(manual.videoRetryTimer); manual.videoRetryTimer = null;
  const generation = ++manual.videoGeneration;
  manual.frameAt = 0;
  const player = manual.player = new CloudVideoPlayer({ canvas: controlImage,
    deviceId: state.manualDeviceId,
    onMessage(message) {
      if (generation !== manual.videoGeneration) return;
      if ((message.type === 'size' || message.type === 'ready') && message.width && message.height) {
        manual.width = message.width; manual.height = message.height;
        const deckRes = byId('deckResolution');
        if (deckRes) deckRes.textContent = `${manual.width} × ${manual.height} (9:16)`;
      }
    },
    onFrame({ width, height, frameAt }) {
      if (generation !== manual.videoGeneration || !dialog.open) return;
      manual.videoRetryAttempt = 0;
      manual.frameAt = frameAt;
      controlLoading.hidden = true; controlLoading.style.display = 'none';
      manual.width = width; manual.height = height;
      if (!manual.previewCanvas) {
        controlImage.hidden = false;
        controlImage.style.display = 'block';
      }
      if (manual.visionActive) renderVisionOverlay();
    },
    onError(error) {
      if (generation !== manual.videoGeneration) return;
      manual.frameAt = 0;
      controlLoading.textContent = error.message;
      controlLoading.hidden = false; controlLoading.style.display = 'flex';
    },
    onClose(code) {
      if (generation !== manual.videoGeneration) return;
      manual.frameAt = 0; manual.player = null;
      if (!dialog.open || !CloudVideoPlayer.canReconnect(code)) return;
      controlStatus.textContent = '正在恢复投屏画面…';
      controlLoading.textContent = controlStatus.textContent;
      controlLoading.hidden = false; controlLoading.style.display = 'flex';
      const delay = Math.min(30000, 1500 * 2 ** Math.min(manual.videoRetryAttempt++, 5));
      manual.videoRetryTimer = setTimeout(() => {
        manual.videoRetryTimer = null;
        if (generation === manual.videoGeneration && dialog.open) startManualVideo();
      }, delay);
    }
  });
}

function stopManualVideo() {
  clearTimeout(manual.retryTimer); manual.retryTimer = null; manual.retryAttempt = 0;
  clearTimeout(manual.videoRetryTimer); manual.videoRetryTimer = null; manual.videoRetryAttempt = 0;
  clearInterval(manual.inputWatchdogTimer); manual.inputWatchdogTimer = null;
  releaseManual(); manual.inputGeneration++; manual.videoGeneration++;
  manual.generation++;
  manual.socket?.close();
  manual.socket = null;
  manual.player?.close(); manual.player = null;
  manual.ready = false; manual.frameAt = 0; manual.inputErrorCode = '';
}

function bindCopyBtn(btnId, getText) {
  const btn = byId(btnId);
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

bindCopyBtn('copyControlIdBtn', () => state.manualDeviceId || (currentDevice()?.deviceId));
bindCopyBtn('deckCopyIdBtn', () => state.manualDeviceId || (currentDevice()?.deviceId));

dialog.addEventListener('close', () => {
  setVisionActive(false);
  stopManualVideo();
  restorePreviewCanvas();
  state.manualDeviceId = '';
  controlImage.hidden = true;
  controlImage.style.display = 'none';
  requestAllPreviews();
  elements.deviceGrid.querySelector('.selected')?.focus();
});

window.addEventListener('device-preview:closed', event => {
  if (!dialog.open || event.detail?.deviceId !== state.manualDeviceId ||
      event.detail?.player !== manual.previewPlayer || !manual.previewCanvas) return;
  const canvas = manual.previewCanvas;
  try {
    controlImage.width = canvas.width;
    controlImage.height = canvas.height;
    controlImage.getContext('2d', { alpha: false }).drawImage(canvas, 0, 0);
    controlImage.hidden = false;
    controlImage.style.display = 'block';
  } catch { /* The read-only modal stream can still render its own canvas. */ }
  restorePreviewCanvas();
  manual.frameAt = 0;
  controlStatus.textContent = '正在恢复投屏画面…';
  controlLoading.textContent = controlStatus.textContent;
  controlLoading.hidden = false; controlLoading.style.display = 'flex';
  startManualVideo();
});

byId('closeControl').addEventListener('click', () => dialog.close());
byId('refreshControl').addEventListener('click', captureManual);
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
for (const button of dialog.querySelectorAll('[data-nav]')) button.addEventListener('click', () => { sendInput({ type: 'nav', key: button.dataset.nav }); surface.focus(); });


function normalizedPoint(event, clamp = false) {
  const image = activeControlCanvas();
  if (!manual.ready || image.hidden || !latestControlFrameAt()) return null;
  const rect = image.getBoundingClientRect();
  const scale = Math.min(rect.width / image.width, rect.height / image.height);
  if (manual.width && Math.abs((image.width / image.height) / (manual.width / manual.height) - 1) > 0.05) { releaseManual(); return null; }
  const width = image.width * scale, height = image.height * scale;
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  if (!clamp && (x < 0 || y < 0 || x > 1 || y > 1)) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}
surface.addEventListener('pointerdown', event => {
  if (event.button !== 0 || manual.pointer !== null) return;
  const point = normalizedPoint(event); if (!point) return;
  event.preventDefault(); surface.focus();
  if (sendInput({ type: 'touch', action: 'down', ...point })) { manual.pointer = event.pointerId; surface.setPointerCapture(event.pointerId); }
});
surface.addEventListener('pointermove', event => {
  if (manual.pointer === null) {
    if (manual.visionActive) handleVisionPointerMove(event);
    return;
  }
  if (event.pointerId !== manual.pointer || performance.now() - manual.lastMove < 20) return;
  const point = normalizedPoint(event, true); if (!point) return;
  manual.lastMove = performance.now(); sendInput({ type: 'touch', action: 'move', ...point });
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
  if (point) sendInput({ type: 'touch', action: 'up', ...point }); else releaseManual();
  manual.pointer = null; if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
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
  else if (dialog.open) captureManual(); else requestAllPreviews();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  if (dialog.open) captureManual(); else requestAllPreviews();
});
window.addEventListener('online', () => {
  if (dialog.open) captureManual(); else requestAllPreviews();
});

const previewSize = byId('previewSize');
try { const stored = Number(localStorage.getItem('yunmomo.previewWidth')); if (stored >= 140 && stored <= 280 && stored % 10 === 0) previewSize.value = String(stored); } catch { /* Storage can be disabled. */ }
function resizePreviews() {
  document.documentElement.style.setProperty('--device-width', previewSize.value + 'px');
  byId('previewSizeValue').textContent = previewSize.value;
  try { localStorage.setItem('yunmomo.previewWidth', previewSize.value); } catch { /* Size preference is optional. */ }
}
previewSize.addEventListener('input', resizePreviews); resizePreviews();
