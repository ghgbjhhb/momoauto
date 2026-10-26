'use strict';

function createPageId() {
  return globalThis.crypto?.randomUUID?.() ||
    ('page_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2));
}

const state = {
  pageId: createPageId(),
  devices: [],
  selectedDeviceId: '',
  tokenConfigured: false,
  scripts: [],
  runningScript: '',
  activeRun: null,
  previewPlayers: new Map(),
  previewRetry: new Map(),
  manualDeviceId: '',
  runtimeState: { runs: [], manualDevices: [] },
  deviceProgress: (() => {
    try { return JSON.parse(localStorage.getItem('yunmomo.deviceProgress') || '{}'); }
    catch { return {}; }
  })()
};

const byId = id => document.getElementById(id);
const elements = {
  serviceState: byId('serviceState'),
  sharedActivity: byId('sharedActivity'),
  serviceText: byId('serviceState').querySelector('.state-text'),
  sessionBridge: byId('sessionBridge'),
  sessionSettings: byId('sessionSettings'),
  sessionToken: byId('sessionToken'),
  connectSession: byId('connectSession'),
  refreshDevices: byId('refreshDevices'),
  previewTitle: byId('previewTitle'),
  previewState: byId('previewState'),
  deviceGrid: byId('deviceGrid'),
  previewSummary: byId('previewSummary'),
  refreshPreview: byId('refreshPreview'),
  pipelineStepperBox: byId('pipelineStepperBox'),
  pipelineStepper: byId('pipelineStepper'),
  stepperTargetBadge: byId('stepperTargetBadge'),
  stepperRunAllBtn: byId('stepperRunAllBtn'),
  resetStepperBtn: byId('resetStepperBtn'),
  scriptList: byId('scriptList'),
  outputSection: byId('outputSection'),
  outputToggle: byId('outputToggle'),
  outputBox: byId('outputBox'),
  clearOutput: byId('clearOutput'),
  copyOutputBtn: byId('copyOutputBtn'),
  stopScriptBtn: byId('stopScriptBtn'),
  statTotal: byId('statTotal'),
  statOnline: byId('statOnline'),
  statTarget: byId('statTarget'),
  workbenchTarget: byId('workbenchTarget'),
  toast: byId('toast'),
  userPill: byId('userPill'),
  openRedeemModalBtn: byId('openRedeemModalBtn'),
  adminPortalLink: byId('adminPortalLink'),
  userLogoutBtn: byId('userLogoutBtn'),
  redeemDialog: byId('redeemDialog'),
  closeRedeemModalBtn: byId('closeRedeemModalBtn'),
  cancelRedeemBtn: byId('cancelRedeemBtn'),
  submitRedeemBtn: byId('submitRedeemBtn'),
  redeemCardInput: byId('redeemCardInput'),
  redeemAlert: byId('redeemAlert')
};

const STEPS_META = [
  { order: 1, id: 'flow-01-import-cloud-disk', name: '导入云盘', full: '01 导入云盘所有文件' },
  { order: 2, id: 'flow-02-upload-cert', name: '上传证书', full: '02 上传证书' },
  { order: 3, id: 'flow-03-set-vpc-proxy', name: 'VPC 代理', full: '03 设置 VPC 代理' },
  { order: 4, id: 'flow-04-setup-environment', name: '环境配置', full: '04 环境配置' },
  { order: 5, id: 'flow-05-generate-all', name: '一键生成', full: '05 一键生成全部' },
  { order: 6, id: 'flow-06-locate-ip', name: 'IP 定位', full: '06 定位到ip地' },
  { order: 7, id: 'flow-07-init-amap', name: '高德地图', full: '07 高德初始化' },
  { order: 8, id: 'flow-08-init-ime', name: '输入法', full: '08 输入法初始化' },
];

const STATUS_LABELS = {
  idle: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已停止，需核对'
};

function saveDeviceProgress() {
  try {
    localStorage.setItem('yunmomo.deviceProgress', JSON.stringify(state.deviceProgress));
  } catch { /* Storage might be unavailable. */ }
}

function getStepState(deviceId, order) {
  if (!deviceId || !state.deviceProgress[deviceId]) return 'idle';
  return state.deviceProgress[deviceId][order] || 'idle';
}

function setStepState(deviceId, order, status) {
  if (!deviceId) return;
  if (!state.deviceProgress[deviceId]) state.deviceProgress[deviceId] = {};
  state.deviceProgress[deviceId][order] = status;
  saveDeviceProgress();
  renderPipelineStepper();
  updateMiniStepperForDevice(deviceId);
}

function resetDeviceProgress(deviceId) {
  if (!deviceId) return;
  delete state.deviceProgress[deviceId];
  saveDeviceProgress();
  renderPipelineStepper();
  updateMiniStepperForDevice(deviceId);
  showToast('已重置该云手机执行记录');
}

function updateMiniStepperForDevice(deviceId) {
  const card = elements.deviceGrid?.querySelector(`.device-card[data-device-id="${deviceId}"]`);
  if (!card) return;
  const miniStepper = card.querySelector('.device-mini-stepper');
  if (!miniStepper) return;
  for (let i = 1; i <= 8; i++) {
    const dot = miniStepper.querySelector(`[data-step="${i}"]`);
    if (!dot) continue;
    dot.className = 'mini-step-dot';
    const st = getStepState(deviceId, i);
    if (st && st !== 'idle') dot.classList.add(st);
    const meta = STEPS_META[i - 1];
    dot.title = `${meta ? meta.name : ('步骤 ' + i)}: ${STATUS_LABELS[st] || '待执行'}`;
  }
}

function renderPipelineStepper() {
  if (!elements.pipelineStepper) return;
  const target = currentDevice();
  if (elements.stepperTargetBadge) {
    if (target) {
      const idx = state.devices.indexOf(target) + 1;
      elements.stepperTargetBadge.textContent = `#${String(idx).padStart(2, '0')} ${target.name}`;
      elements.stepperTargetBadge.title = `目标云机: ${target.name} (${target.deviceId})`;
    } else {
      elements.stepperTargetBadge.textContent = '未选择目标';
      elements.stepperTargetBadge.title = '请在左侧选择目标云手机';
    }
  }

  elements.pipelineStepper.replaceChildren();
  for (const step of STEPS_META) {
    const status = target ? getStepState(target.deviceId, step.order) : 'idle';
    const node = document.createElement('div');
    node.className = `step-node ${status}`;
    node.dataset.stepOrder = String(step.order);
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.title = `${step.full}（状态: ${STATUS_LABELS[status] || status}，点击单独执行）`;

    const num = document.createElement('span');
    num.className = 'step-node-num';
    num.textContent = String(step.order).padStart(2, '0');

    const info = document.createElement('div');
    info.className = 'step-node-info';

    const title = document.createElement('div');
    title.className = 'step-node-title';
    title.textContent = step.name;

    const statusEl = document.createElement('div');
    statusEl.className = 'step-node-status';
    statusEl.textContent = STATUS_LABELS[status] || status;

    info.append(title, statusEl);

    const indicator = document.createElement('span');
    indicator.className = 'step-node-indicator';

    node.append(num, info, indicator);

    const triggerStep = () => {
      if (!currentDevice()) {
        showToast('请先选择一台云机');
        return;
      }
      const script = state.scripts.find(s => s.order === step.order);
      if (script) {
        const card = elements.scriptList.querySelector(`[data-script-id="${script.id}"]`);
        const btn = card?.querySelector('.run-button');
        executeScript(script, btn, card);
      } else {
        showToast(`未找到步骤 ${step.order} 对应的执行脚本`);
      }
    };

    node.addEventListener('click', triggerStep);
    node.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerStep();
      }
    });

    elements.pipelineStepper.append(node);
  }
}

function copyToClipboard(text, successToast = '已复制到剪贴板') {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successToast);
    }).catch(() => {
      fallbackCopy(text, successToast);
    });
  } else {
    fallbackCopy(text, successToast);
  }
}

function fallbackCopy(text, successToast) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  textarea.setAttribute('readonly', '');
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showToast(successToast);
  } catch (err) {
    showToast('复制失败，请手动长按复制');
  }
  document.body.removeChild(textarea);
}
window.copyToClipboard = copyToClipboard;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(payload.error || '请求失败（HTTP ' + response.status + '）');
    error.status = response.status;
    error.durationMs = payload.durationMs;
    error.runId = payload.runId;
    throw error;
  }
  return payload;
}

function createScriptRunId() {
  return globalThis.crypto?.randomUUID?.() ||
    'web-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function findScriptRunButton(scriptId) {
  const card = [...elements.scriptList.querySelectorAll('.script-card')]
    .find(item => item.dataset.scriptId === scriptId);
  return card?.querySelector('.run-button') || null;
}

function updateScriptRunControls(run) {
  const button = findScriptRunButton(run.scriptId);
  if (button) {
    button.disabled = Boolean(run.stopping || run.stopConfirmed);
    const label = button.querySelector('.run-text');
    if (label) label.textContent = run.stopConfirmed ? '已停止，整理结果…' : run.stopping ? '正在停止…' : '停止执行';
  }
  if (elements.stopScriptBtn) {
    elements.stopScriptBtn.disabled = Boolean(run.stopping || run.stopConfirmed);
    elements.stopScriptBtn.textContent = run.stopConfirmed ? '已停止，整理结果…' : run.stopping ? '正在停止…' : '⏹ 停止脚本';
  }
}

function setService(kind, text) {
  elements.serviceState.classList.remove('ready', 'error');
  if (kind) elements.serviceState.classList.add(kind);
  elements.serviceText.textContent = text;
}

let toastTimer;
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 3600);
}

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

function remoteRunForScript(script) {
  if (script.requiresDevice) {
    return state.runtimeState.runs.find(run => !run.currentPage && run.deviceId === state.selectedDeviceId) || null;
  }
  return state.runtimeState.runs.find(run => !run.currentPage && run.scriptId === script.id) || null;
}

function updateSharedRunControls() {
  for (const card of elements.scriptList.querySelectorAll('.script-card')) {
    const script = state.scripts.find(item => item.id === card.dataset.scriptId);
    const button = card.querySelector('[data-run-button]');
    if (!script || !button || state.activeRun?.scriptId === script.id) continue;
    const externalRun = remoteRunForScript(script);
    const manual = script.requiresDevice ? manualWindowsForDevice(state.selectedDeviceId) : null;
    let message = '';
    if (externalRun) {
      const device = state.devices.find(item => item.deviceId === externalRun.deviceId);
      message = `${device ? device.name + ' ' : ''}正在另一个网页执行「${externalRun.title}」`;
    } else if (manual?.windows) {
      const device = currentDevice();
      const otherWindows = Math.max(0, manual.windows - (state.manualDeviceId === state.selectedDeviceId ? 1 : 0));
      message = otherWindows
        ? `${device ? device.name : '所选设备'}正在被 ${otherWindows} 个其他网页手动操作`
        : '本网页已打开该设备的手动操作窗';
    }
    button.disabled = Boolean(message);
    card.classList.toggle('remote-blocked', Boolean(message));
    let note = card.querySelector('.remote-run-status');
    if (message) {
      if (!note) {
        note = document.createElement('div');
        note.className = 'remote-run-status';
        card.querySelector('.script-actions')?.after(note);
      }
      if (note) note.textContent = message;
    } else note?.remove();
  }
  if (elements.stepperRunAllBtn) {
    const batch = state.scripts.find(script => script.id === 'flow-all' || script.batch === true);
    const remoteRun = batch ? remoteRunForScript(batch) : null;
    const manual = state.selectedDeviceId ? manualWindowsForDevice(state.selectedDeviceId) : null;
    elements.stepperRunAllBtn.disabled = Boolean(state.activeRun || remoteRun || manual?.windows);
  }
}

let sharedStateLoading = false;
async function loadSharedRuntimeState() {
  if (sharedStateLoading) return;
  sharedStateLoading = true;
  try {
    const data = await requestJson('/api/runtime-state?pageId=' + encodeURIComponent(state.pageId));
    state.runtimeState = {
      runs: Array.isArray(data.runs) ? data.runs : [],
      manualDevices: Array.isArray(data.manualDevices) ? data.manualDevices : []
    };
  } catch {
    state.runtimeState = { runs: [], manualDevices: [] };
  } finally {
    sharedStateLoading = false;
  }
  renderSharedActivity();
  updateSharedRunControls();
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
}

window.getSelectedDeviceId = () => state.selectedDeviceId;

function selectDevice(deviceId) {
  if (!state.devices.some(device => device.deviceId === deviceId)) return;
  state.selectedDeviceId = deviceId;
  renderSelectedDevice();
  renderPreviewSummary();
  renderPipelineStepper();
  updateSharedRunControls();
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
  header.className = 'device-card-head';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'device-title-wrap';

  const badge = document.createElement('span');
  badge.className = 'device-num-badge';
  badge.textContent = numBadgeText;

  const name = document.createElement('strong');
  name.className = 'device-name';
  name.textContent = device.name;
  name.title = device.name;

  titleWrap.append(badge, name);

  const status = document.createElement('span');
  status.className = 'device-status' + (isOnline(device) ? ' online' : '');
  status.innerHTML = `<span class="status-dot"></span><span class="status-label">${isOnline(device) ? '在线' : '连接中'}</span>`;

  header.append(titleWrap, status);

  // 云机租约与有效期倒计时指示条
  let expireBar = null;
  if (device.expireAt) {
    expireBar = document.createElement('div');
    expireBar.className = 'device-expire-bar';
    expireBar.style.cssText = 'padding: 5px 10px; font-size: 11px; background: rgba(56, 139, 253, 0.12); border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; border-radius: 4px; margin: 4px 6px;';
    const remainingText = device.remainingText || '计算中…';
    const expireDateStr = new Date(device.expireAt).toLocaleDateString();
    expireBar.innerHTML = `
      <span style="color:var(--text-muted);">⏱️ 到期: <strong style="color:#fff;">${expireDateStr}</strong></span>
      <span style="color:var(--cyan); font-weight:600;">剩余 ${remainingText}</span>
    `;
    expireBar.title = `到期具体物理时间: ${new Date(device.expireAt).toLocaleString()}`;
  }

  // 01~08 微型步进指示条
  const miniStepper = document.createElement('div');
  miniStepper.className = 'device-mini-stepper';
  miniStepper.dataset.deviceId = device.deviceId;
  miniStepper.title = '01~08 初始化全流程进度';
  for (let i = 1; i <= 8; i++) {
    const dot = document.createElement('span');
    dot.className = 'mini-step-dot';
    dot.dataset.step = String(i);
    const meta = STEPS_META[i - 1];
    const st = getStepState(device.deviceId, i);
    if (st && st !== 'idle') dot.classList.add(st);
    dot.title = `${meta ? meta.name : ('步骤 ' + i)}: ${STATUS_LABELS[st] || '待执行'}`;
    miniStepper.append(dot);
  }

  // 手机屏幕预览区（带点击进入真机操作台的悬浮导引）
  const screen = document.createElement('div');
  screen.className = 'device-screen';
  screen.setAttribute('role', 'button');
  screen.setAttribute('aria-label', `放大操作 ${numBadgeText} (${device.name})`);
  screen.tabIndex = 0;
  screen.title = '点击进入真机控制台操作';
  screen.addEventListener('click', event => {
    event.stopPropagation();
    openManualControl(device);
  });
  screen.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      openManualControl(device);
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

  // 底部业务工具条：解决“数字看着没什么用”的问题，集成一键复制虚拟机 ID
  const footer = document.createElement('div');
  footer.className = 'device-card-footer';

  const idBadge = document.createElement('div');
  idBadge.className = 'device-id-badge';
  idBadge.title = `完整虚拟机 ID: ${device.deviceId} (点击右侧按钮复制)`;
  idBadge.innerHTML = `<span class="id-tag">ID</span><span class="id-digits">${shortDeviceId(device)}</span>`;

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

  footer.append(idBadge, copyBtn);

  // 目标标记
  const targetTag = document.createElement('div');
  targetTag.className = 'device-target-tag';
  targetTag.innerHTML = `<span>当前目标</span>`;

  if (expireBar) {
    card.append(header, expireBar, miniStepper, screen, footer, targetTag);
  } else {
    card.append(header, miniStepper, screen, footer, targetTag);
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

function renderDeviceGrid() {
  stopPreview();
  elements.deviceGrid.replaceChildren();

  if (!state.devices.length) {
    const empty = document.createElement('div');
    empty.className = 'loading-card empty-user-devices';
    empty.style.cssText = 'padding: 40px 20px; text-align: center; border: 1px dashed var(--line-accent); border-radius: 12px; margin: 20px;';
    empty.innerHTML = `
      <div style="font-size: 36px; margin-bottom: 12px;">📱</div>
      <div style="font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 8px;">您名下暂无已分配的云手机</div>
      <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 18px;">请点击顶部的【🎟️ 兑换卡密】输入管理员提供的卡密，立即激活分配专属云机！</div>
      <button class="run-button" id="emptyRedeemBtn" type="button" style="margin: 0 auto; display: inline-flex;">立即兑换卡密</button>
    `;
    const btn = empty.querySelector('#emptyRedeemBtn');
    if (btn) btn.onclick = () => elements.openRedeemModalBtn?.click();
    elements.deviceGrid.append(empty);
    renderPreviewSummary();
    renderPipelineStepper();
    return;
  }

  if (!state.devices.some(device => device.deviceId === state.selectedDeviceId)) {
    state.selectedDeviceId = state.devices[0].deviceId;
  }
  for (const device of state.devices) {
    elements.deviceGrid.append(createDeviceCard(device));
  }
  renderSelectedDevice();
  renderPreviewSummary();
  renderPipelineStepper();
  startPreview();
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
  if (state.previewPlayers.has(device.deviceId) || state.manualDeviceId) return;
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
      if (!state.manualDeviceId && CloudVideoPlayer.canReconnect(code)) {
        state.previewRetry.set(device.deviceId, setTimeout(() => {
          if (card.isConnected) requestDevicePreview(device, card);
        }, 3000));
      }
    }
  });
  state.previewPlayers.set(device.deviceId, player);
}

function requestAllPreviews() {
  if (!state.tokenConfigured || !state.devices.length || state.manualDeviceId) return;
  for (const card of elements.deviceGrid.querySelectorAll('.device-card')) {
    const device = state.devices.find(item => item.deviceId === card.dataset.deviceId);
    if (device) requestDevicePreview(device, card);
  }
}

function startPreview() {
  stopPreview();
  if (!state.devices.length || !state.tokenConfigured) return;
  requestAllPreviews();
}

function parameterChoiceLabel(field, value) {
  if (field.name === 'androidVersion') return value === 'all' ? '全部版本' : 'Android ' + value;
  if (field.name === 'mode') return ({ random: '随机', button: '底部按钮', pull: '下拉刷新',
    execute: '执行发送', draft: '生成并输入', watch: '1. 挂机模式 (巡查前几页)', drain: '2. 全量模式 (必须翻到底)' })[value] || String(value);
  if (field.name === 'maxContacts') return ({ xx: '持续运行(无上限)', '1': '1人(单次测试)', '3': '3人', '5': '5人', '10': '10人' })[value] || String(value);
  if (field.name === 'warmupInterval') return ({ default: '默认(25~70分随机)', '0': '【立即养号(测试-启动即养号)】', '60000': '1分钟后养号', '300000': '5分钟后养号' })[value] || String(value);
  if (field.name === 'greetingsInterval') return ({ '0': '【发现招呼立即处理(测试)】', '1200000': '20分钟一次', '1800000': '30分钟一次' })[value] || String(value);
  if (field.name === 'maxApproved') return value + ' 人';
  if (field.name === 'maxDistance') return ({ none: '不限距离', '3': '≤ 3公里', '5': '≤ 5公里', '10': '≤ 10公里', '20': '≤ 20公里', '50': '≤ 50公里' })[value] || (value === 'none' ? '不限距离' : '≤ ' + value + '公里');
  if (field.name === 'approveProbability') return Math.round(Number(value) * 100) + '%';
  return String(value);
}

function createScriptCard(script) {
  const card = document.createElement('article');
  card.className = 'script-card';
  card.dataset.scriptId = script.id;
  if (script.batch) card.classList.add('script-hero-card');
  if (script.parameters?.length) card.classList.add('script-card-has-params');
  if (script.destructive) card.classList.add('script-card-destructive');

  const head = document.createElement('div');
  head.className = 'script-card-head';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'script-title-group';

  if (script.order) {
    const order = document.createElement('span');
    order.className = 'script-order';
    order.textContent = String(script.order).padStart(2, '0');
    titleGroup.append(order);
  }

  const title = document.createElement('div');
  title.className = 'script-title';
  title.textContent = script.title;
  titleGroup.append(title);

  head.append(titleGroup);

  if (script.destructive) {
    const dangerTag = document.createElement('span');
    dangerTag.className = 'script-danger-badge';
    dangerTag.textContent = '⚠️ 清数据';
    head.append(dangerTag);
  }

  card.append(head);

  if (script.parameters?.length) {
    const settings = document.createElement('details');
    settings.className = 'script-settings';
    const summary = document.createElement('summary');
    summary.innerHTML = `<span>配置参数</span><svg class="dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`;
    settings.append(summary);

    for (const field of script.parameters) {
      const label = document.createElement('label');
      label.textContent = field.label;
      const input = document.createElement(field.choices ? 'select' : field.multiline ? 'textarea' : 'input');
      input.dataset.parameter = field.name;
      input.setAttribute('aria-label', field.label);
      if (field.required) {
        input.required = true;
        input.setAttribute('aria-required', 'true');
      }
      if (field.choices) {
        for (const value of field.choices) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = parameterChoiceLabel(field, value);
          input.append(option);
        }
      } else {
        if (!field.multiline) input.type = 'text';
        else input.rows = 3;
        input.autocomplete = 'off';
        input.spellcheck = false;
        if (field.maxLength) input.maxLength = field.maxLength;
      }
      input.value = field.defaultValue ?? '';
      label.append(input);
      settings.append(label);
    }
    card.append(settings);
  }

  const actions = document.createElement('div');
  actions.className = 'script-actions';
  const activeRun = state.activeRun?.scriptId === script.id ? state.activeRun : null;
  const isCurrentRunning = Boolean(activeRun);
  const button = document.createElement('button');
  button.dataset.runButton = 'true';
  button.className = 'run-button' + (script.batch ? ' run-button-hero' : '') + (isCurrentRunning ? ' run-button-stop' : '');
  button.type = 'button';
  if (isCurrentRunning) {
    button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">${activeRun.stopConfirmed ? '已停止，整理结果…' : activeRun.stopping ? '正在停止…' : '停止执行'}</span>`;
    button.disabled = Boolean(activeRun.stopping || activeRun.stopConfirmed);
    button.setAttribute('aria-label', '停止 ' + script.title);
  } else {
    button.innerHTML = `<span class="run-icon">▶</span><span class="run-text">${script.batch ? '一键执行全部' : '执行'}</span>`;
    button.setAttribute('aria-label', '执行 ' + script.title);
  }
  button.addEventListener('click', () => {
    if (state.activeRun?.scriptId === script.id) stopRunningScript();
    else executeScript(script, button, card);
  });
  actions.append(button);

  card.append(actions);
  return card;
}

async function stopRunningScript() {
  const run = state.activeRun;
  if (!run) {
    showToast('当前没有正在执行的脚本');
    return;
  }
  if (run.stopping || run.stopConfirmed) return;
  run.stopping = true;
  updateScriptRunControls(run);
  showToast('正在停止脚本并等待进程退出…');
  try {
    const res = await requestJson('/api/execute/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptRunId: run.id
      })
    });
    if (res.stopped !== true) {
      run.stopping = false;
      updateScriptRunControls(run);
      showToast(res.message || '停止尚未确认，请查看当前运行状态');
      return;
    }
    if (state.activeRun?.id === run.id) {
      run.stopConfirmed = true;
      run.stopping = false;
      updateScriptRunControls(run);
      showToast(res.message || (res.pending ? '停止请求已登记' : '脚本已停止'));
      writeOutput(res.pending ? '【已登记停止请求】' : '【已停止并确认脚本进程退出】', [
        res.pending
          ? '服务端已登记停止请求；如果启动请求尚在途中，将在登记时取消脚本启动。页面会等待执行请求返回。'
          : '停止请求已确认，服务端已等待脚本进程退出并释放设备占用。',
        '脚本中断时设备状态可能只完成了部分操作；请核对设备后再继续。'
      ]);
    }
  } catch (error) {
    if (state.activeRun?.id === run.id) {
      run.stopping = false;
      updateScriptRunControls(run);
    }
    showToast('停止请求失败：' + error.message);
  }
}

function createVersionSection(versionTag, title, scripts, defaultCollapsed = false) {
  const section = document.createElement('section');
  const tagClass = versionTag.toLowerCase() + '-tag';
  const colClass = versionTag.toLowerCase() + '-column';

  const storageKey = `yunmomo.collapse.${versionTag.toLowerCase()}`;
  let isCollapsed = defaultCollapsed;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) isCollapsed = saved === 'true';
  } catch {}

  section.className = `scripts-version-column ${colClass}` + (isCollapsed ? ' collapsed' : '');
  section.innerHTML = `
    <div class="version-column-head" role="button" tabindex="0" title="点击展开/收起此栏脚本">
      <div class="version-badge-group">
        <span class="version-tag ${tagClass}">${versionTag}</span>
        <span class="version-title">${title}</span>
        <span class="version-count">${scripts.length} 个</span>
      </div>
      <button class="version-collapse-btn" type="button" aria-expanded="${!isCollapsed}" title="点击收起/展开">
        <span class="toggle-text">${isCollapsed ? '展开' : '收起'}</span>
        <span class="toggle-icon">${isCollapsed ? '▼' : '▲'}</span>
      </button>
    </div>
    <div class="version-cards-stack"></div>
  `;

  const stack = section.querySelector('.version-cards-stack');
  for (const script of scripts) {
    stack.append(createScriptCard(script));
  }

  const head = section.querySelector('.version-column-head');
  const toggleBtn = section.querySelector('.version-collapse-btn');
  const toggleText = section.querySelector('.toggle-text');
  const toggleIcon = section.querySelector('.toggle-icon');

  function toggleCollapse(e) {
    if (e) e.stopPropagation();
    isCollapsed = !isCollapsed;
    section.classList.toggle('collapsed', isCollapsed);
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    toggleText.textContent = isCollapsed ? '展开' : '收起';
    toggleIcon.textContent = isCollapsed ? '▼' : '▲';
    try {
      localStorage.setItem(storageKey, String(isCollapsed));
    } catch {}
  }

  head.addEventListener('click', toggleCollapse);
  head.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleCollapse(e);
    }
  });

  return section;
}

function renderScripts() {
  elements.scriptList.replaceChildren();

  const v2Scripts = state.scripts
    .filter(s => s.category === 'v2' || s.version === 'v2' || s.id.endsWith('-v2'))
    .filter(s => !s.batch)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  const v3Scripts = state.scripts
    .filter(s => s.category === 'v3' || s.version === 'v3' || s.id.endsWith('-v3'))
    .filter(s => !s.batch)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  const momoScripts = state.scripts
    .filter(s => s.category === 'momo')
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  const batchScripts = state.scripts
    .filter(s => s.batch || s.id.startsWith('flow-all'));

  // 1. V2 流程脚本栏 (在 V3 上方)
  if (v2Scripts.length > 0) {
    const v2Section = createVersionSection('V2', 'V2 流程脚本 (01~09)', v2Scripts, false);
    elements.scriptList.append(v2Section);
  }

  // 2. V3 流程脚本栏 (带收起操作)
  if (v3Scripts.length > 0) {
    const v3Section = createVersionSection('V3', 'V3 流程脚本 (01~09)', v3Scripts, false);
    elements.scriptList.append(v3Section);
  }

  // 3. MOMO 业务自动化板块 (11~15 + 全量执行)
  if (momoScripts.length || batchScripts.length) {
    const momoSection = document.createElement('section');
    const storageKey = 'yunmomo.collapse.momo';
    let isMomoCollapsed = false;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) isMomoCollapsed = saved === 'true';
    } catch {}

    momoSection.className = 'scripts-momo-section' + (isMomoCollapsed ? ' collapsed' : '');
    momoSection.innerHTML = `
      <div class="momo-section-head version-column-head" role="button" tabindex="0" title="点击展开/收起此栏脚本">
        <div class="momo-title-group version-badge-group">
          <span class="momo-icon">⚡</span>
          <span class="momo-title version-title">MOMO 业务自动化中枢 (11~15)</span>
          <span class="version-count">${momoScripts.length + batchScripts.length} 个</span>
        </div>
        <button class="version-collapse-btn" type="button" aria-expanded="${!isMomoCollapsed}" title="点击收起/展开">
          <span class="toggle-text">${isMomoCollapsed ? '展开' : '收起'}</span>
          <span class="toggle-icon">${isMomoCollapsed ? '▼' : '▲'}</span>
        </button>
      </div>
      <div class="momo-cards-grid version-cards-stack"></div>
    `;
    const momoGrid = momoSection.querySelector('.momo-cards-grid');
    for (const script of momoScripts) {
      momoGrid.append(createScriptCard(script));
    }
    for (const script of batchScripts) {
      momoGrid.append(createScriptCard(script));
    }

    const head = momoSection.querySelector('.momo-section-head');
    const toggleBtn = momoSection.querySelector('.version-collapse-btn');
    const toggleText = momoSection.querySelector('.toggle-text');
    const toggleIcon = momoSection.querySelector('.toggle-icon');

    function toggleMomo(e) {
      if (e) e.stopPropagation();
      isMomoCollapsed = !isMomoCollapsed;
      momoSection.classList.toggle('collapsed', isMomoCollapsed);
      toggleBtn.setAttribute('aria-expanded', String(!isMomoCollapsed));
      toggleText.textContent = isMomoCollapsed ? '展开' : '收起';
      toggleIcon.textContent = isMomoCollapsed ? '▼' : '▲';
      try {
        localStorage.setItem(storageKey, String(isMomoCollapsed));
      } catch {}
    }

    head.addEventListener('click', toggleMomo);
    head.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleMomo(e);
      }
    });

    elements.scriptList.append(momoSection);
  }
}

function writeOutput(title, lines) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  elements.outputBox.textContent = '[' + timestamp + '] ' + title + '\n' + lines.filter(Boolean).join('\n');
  elements.outputSection.open = true;
  elements.outputBox.scrollTop = elements.outputBox.scrollHeight;
}

function cleanScriptLines(stdout, stderr) {
  const lines = [];
  if (stdout) {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('{"deviceId"') || trimmed.startsWith('{"ok":true') ||
          trimmed.startsWith('{"targetDeviceId"') || trimmed.startsWith('{"phase"') || trimmed.startsWith('[timing]')) continue;
      lines.push(trimmed);
    }
  }
  if (stderr) {
    for (const line of stderr.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('[timing]')) continue;
      lines.push('错误: ' + trimmed);
    }
  }
  return lines;
}

function promptVpcProxyDialog() {
  const dialog = document.getElementById('vpcProxyDialog');
  const input = document.getElementById('vpcProxyInput');
  const closeBtn = document.getElementById('closeVpcDialogBtn');
  const cancelBtn = document.getElementById('cancelVpcDialogBtn');
  const confirmBtn = document.getElementById('confirmVpcDialogBtn');

  if (!dialog || !input) return Promise.resolve(null);

  return new Promise(resolve => {
    let resolved = false;

    const cleanup = () => {
      closeBtn?.removeEventListener('click', onCancel);
      cancelBtn?.removeEventListener('click', onCancel);
      confirmBtn?.removeEventListener('click', onConfirm);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('keydown', onKeyDown);
    };

    const finish = value => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { dialog.close(); } catch {}
      resolve(value);
    };

    const onCancel = () => finish(null);

    const onConfirm = () => {
      const val = input.value.trim();
      if (!val) {
        showToast('请输入 VPC 代理数据');
        input.focus();
        return;
      }
      finish(val);
    };

    const onKeyDown = e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onConfirm();
      }
    };

    closeBtn?.addEventListener('click', onCancel);
    cancelBtn?.addEventListener('click', onCancel);
    confirmBtn?.addEventListener('click', onConfirm);
    dialog.addEventListener('cancel', onCancel, { once: true });
    dialog.addEventListener('keydown', onKeyDown);

    input.value = '';
    dialog.showModal();
    setTimeout(() => input.focus(), 50);
  });
}

async function executeScript(script, button, card) {
  if (state.activeRun || state.runningScript) { showToast('请等待当前脚本结束'); return; }
  if (state.manualDeviceId) { showToast('请先关闭手动操作窗，再运行脚本'); return; }
  if (!state.tokenConfigured) {
    showToast('尚未连接');
    return;
  }
  if (script.requiresDevice && !currentDevice()) {
    showToast('请点击一台云机');
    return;
  }
  const targetId = state.selectedDeviceId;
  const externalRun = remoteRunForScript(script);
  if (externalRun) {
    const device = state.devices.find(item => item.deviceId === externalRun.deviceId);
    showToast(`${device ? device.name + ' ' : ''}正在另一个网页执行「${externalRun.title}」`);
    return;
  }
  const manual = script.requiresDevice ? manualWindowsForDevice(targetId) : null;
  if (manual?.windows) {
    showToast(`${currentDevice()?.name || '所选设备'}正在被其他网页手动操作`);
    return;
  }
  const options = {};
  if (card) {
    for (const input of card.querySelectorAll('[data-parameter]')) {
      const value = String(input.value ?? '').trim();
      if (input.required && !value) {
        input.focus?.();
        showToast((input.getAttribute('aria-label') || '该参数') + '为必填项');
        return;
      }
      if (value) options[input.dataset.parameter] = value;
    }
  }

  // 03 设置 VPC 代理：网页弹窗识别并输入 VPC 代理
  if (script.id === 'flow-03' || script.order === 3) {
    const vpcData = await promptVpcProxyDialog();
    if (!vpcData) return;
    options.vpcData = vpcData;
  }

  const resetConfirmed = script.destructive ? window.confirm(
    '确认对 ' + deviceLabel(currentDevice()) + ' 执行“改机重置”？\n' +
    '机型范围：Android ' + (options.androidVersion || '16') + '；国家：' + (options.countryCode || 'CN') +
    '。\n此操作会清除该设备数据，不能撤销。取消将不执行。'
  ) : false;
  if (script.destructive && !resetConfirmed) return;
  const scriptRunId = createScriptRunId();
  const run = { id: scriptRunId, scriptId: script.id, deviceId: targetId, stopping: false, stopConfirmed: false };
  state.activeRun = run;
  state.runningScript = script.id;
  if (elements.stopScriptBtn) {
    elements.stopScriptBtn.style.display = 'inline-flex';
    elements.stopScriptBtn.disabled = false;
    elements.stopScriptBtn.textContent = '⏹ 停止脚本';
  }
  if (button) {
    button.disabled = false;
    button.classList.add('run-button-stop');
    button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">停止执行</span>`;
  }
  if (card) card.classList.add('running');
  writeOutput('正在执行：' + script.title, []);

  const outputPollTimer = setInterval(async () => {
    if (!state.activeRun || state.activeRun.id !== scriptRunId) {
      clearInterval(outputPollTimer);
      return;
    }
    try {
      const live = await requestJson('/api/execute/output?scriptRunId=' + encodeURIComponent(scriptRunId));
      if (live.ok && (live.stdout || live.stderr)) {
        if (state.activeRun && state.activeRun.id === scriptRunId) {
          const lines = cleanScriptLines(live.stdout, live.stderr);
          writeOutput('正在执行：' + script.title, lines);
        }
      }
    } catch { /* 轮询异常静默忽略 */ }
  }, 100);

  if (script.order >= 1 && script.order <= 8) {
    setStepState(targetId, script.order, 'running');
  } else if (script.batch || script.id === 'flow-all') {
    setStepState(targetId, 1, 'running');
  }

  try {
    const result = await requestJson('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptRunId,
        scriptId: script.id,
        deviceId: targetId,
        pageId: state.pageId,
        options,
        resetConfirmed
      })
    });
    clearInterval(outputPollTimer);
    if (state.activeRun && state.activeRun.id !== scriptRunId) return;
    const lines = cleanScriptLines(result.stdout, result.stderr);
    const durationSec = Number.isFinite(result.durationMs) ? (result.durationMs / 1000).toFixed(1) + 's' : '';
    let title;
    if (result.cancelled) {
      title = '脚本已停止：' + script.title;
      lines.push('（已停止执行）');
    } else if (result.ok) {
      title = '执行成功：' + script.title + (durationSec ? ' (' + durationSec + ')' : '');
    } else {
      title = '执行失败：' + script.title + (result.exitCode !== null ? ' (退出码: ' + result.exitCode + ')' : '');
    }
    writeOutput(title, lines);
    if (result.ok && card) {
      const privateInput = card.querySelector('[data-parameter="vpcData"]');
      if (privateInput) privateInput.value = '';
    }
    if (result.ok) {
      const vpcInput = document.getElementById('vpcProxyInput');
      if (vpcInput) vpcInput.value = '';
    }

    if (script.order >= 1 && script.order <= 8) {
      setStepState(targetId, script.order, result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed');
    } else if (script.batch || script.id === 'flow-all') {
      if (result.ok) {
        for (let i = 1; i <= 8; i++) setStepState(targetId, i, 'completed');
      } else {
        const out = (result.stdout || '') + '\n' + (result.stderr || '');
        for (let i = 1; i <= 8; i++) {
          if (out.includes(`[${i}/8] 成功完成`)) {
            setStepState(targetId, i, 'completed');
          } else if (out.includes(`[${i}/8] 执行失败`)) {
            setStepState(targetId, i, 'failed');
          }
        }
      }
      if (result.cancelled) {
        for (let i = 1; i <= 8; i++) {
          if (getStepState(targetId, i) === 'running') setStepState(targetId, i, 'cancelled');
        }
      }
    }

    if (result.cancelled) showToast('脚本已停止，请核对设备状态');
    else if (!result.ok) showToast('脚本执行失败，请查看执行记录');
    requestAllPreviews();
  } catch (error) {
    if (state.activeRun && state.activeRun.id !== scriptRunId) return;
    if (run.stopConfirmed) {
      writeOutput('脚本已停止：' + script.title, [
        '服务端已确认脚本进程退出并释放设备占用。',
        '脚本中断时设备状态可能只完成了部分操作；请核对设备后再继续。'
      ]);
      showToast('脚本已停止，请核对设备状态');
      if (targetId && script.order >= 1 && script.order <= 8) {
        setStepState(targetId, script.order, 'cancelled');
      } else if (targetId && (script.batch || script.id === 'flow-all')) {
        for (let i = 1; i <= 8; i++) {
          if (getStepState(targetId, i) === 'running') setStepState(targetId, i, 'cancelled');
        }
      }
      return;
    }
    if (targetId) {
      if (script.order >= 1 && script.order <= 8) {
        setStepState(targetId, script.order, 'failed');
      } else if (script.batch || script.id === 'flow-all') {
        const cur = getStepState(targetId, 1);
        if (cur === 'running') setStepState(targetId, 1, 'failed');
      }
    }
    writeOutput('执行请求失败：' + script.title, [error.message,
      Number.isFinite(error.durationMs) ? '总耗时：' + error.durationMs + ' ms' : '',
      error.runId ? '运行编号：' + error.runId : '']);
    showToast(error.message);
  } finally {
    clearInterval(outputPollTimer);
    if (state.activeRun?.id === scriptRunId) {
      state.activeRun = null;
      state.runningScript = '';
      if (elements.stopScriptBtn) {
        elements.stopScriptBtn.style.display = 'none';
        elements.stopScriptBtn.disabled = false;
        elements.stopScriptBtn.textContent = '⏹ 停止脚本';
      }
      if (button) {
        button.disabled = false;
        button.classList.remove('run-button-stop');
        button.innerHTML = `<span class="run-icon">▶</span><span class="run-text">${script.batch ? '一键执行全部' : '执行'}</span>`;
      }
      if (card) card.classList.remove('running');
    }
    loadSharedRuntimeState();
  }
}

async function loadStatus() {
  try {
    const status = await requestJson('/api/status');
    state.tokenConfigured = status.tokenConfigured === true;
    elements.sessionSettings.hidden = state.tokenConfigured;
    elements.sessionBridge.hidden = state.tokenConfigured;
    if (state.tokenConfigured) {
      setService('ready', status.sessionSource === 'local-session' ? '网页登录态已就绪' : '已连接');
    } else {
      setService('error', '会话待同步');
      state.devices = [];
      state.selectedDeviceId = '';
      renderDeviceGrid();
    }
  } catch {
    setService('error', '本地服务不可用');
    elements.sessionBridge.hidden = false;
    elements.sessionSettings.hidden = false;
  }
}

async function loadScripts() {
  try {
    const data = await requestJson('/api/scripts');
    state.scripts = Array.isArray(data.scripts) ? data.scripts : [];
    renderScripts();
    updateSharedRunControls();
  } catch (error) {
    elements.scriptList.replaceChildren();
    const failure = document.createElement('div');
    failure.className = 'loading-card';
    failure.textContent = '脚本加载失败：' + error.message;
    elements.scriptList.append(failure);
  }
}

async function loadDevices() {
  elements.refreshDevices.disabled = true;
  elements.refreshDevices.textContent = '读取中…';
  try {
    const data = await requestJson('/api/devices');
    state.devices = Array.isArray(data.devices) ? data.devices : [];
    renderDeviceGrid();
    renderSharedActivity();
    updateSharedRunControls();
    if (!state.devices.length) showToast('当前账号没有可用云机');
  } catch (error) {
    state.devices = [];
    state.selectedDeviceId = '';
    renderDeviceGrid();
    renderSharedActivity();
    updateSharedRunControls();
    showToast(error.message);
    if (error.status === 401 || /Token|YUNMOMO_TOKEN/.test(error.message)) {
      state.tokenConfigured = false;
      elements.sessionBridge.hidden = false;
      elements.sessionSettings.hidden = false;
      setService('error', '网页登录已过期');
    }
  } finally {
    elements.refreshDevices.disabled = false;
    elements.refreshDevices.textContent = '刷新';
  }
}

elements.sessionBridge.addEventListener('submit', async event => {
  event.preventDefault();
  const token = elements.sessionToken.value.trim();
  if (!token) {
    showToast('请先提供会话令牌');
    elements.sessionToken.focus();
    return;
  }
  elements.connectSession.disabled = true;
  elements.connectSession.textContent = '连接中…';
  try {
    await requestJson('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    elements.sessionToken.value = '';
    await loadStatus();
    await loadDevices();
    showToast('已连接，令牌已保存');
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.connectSession.disabled = false;
    elements.connectSession.textContent = '连接';
  }
});

elements.refreshDevices.addEventListener('click', async () => {
  await loadStatus();
  if (state.tokenConfigured) await loadDevices();
});

elements.refreshPreview.addEventListener('click', () => {
  if (!state.devices.length) {
    showToast('暂无云机');
    return;
  }
  for (const player of state.previewPlayers.values()) player.refresh();
  requestAllPreviews();
});

elements.clearOutput.addEventListener('click', () => {
  elements.outputBox.textContent = '暂无执行记录。';
});

if (elements.stopScriptBtn) {
  elements.stopScriptBtn.addEventListener('click', stopRunningScript);
}

if (elements.copyOutputBtn) {
  elements.copyOutputBtn.addEventListener('click', () => {
    const text = elements.outputBox.textContent || '';
    if (!text || text === '暂无执行记录。' || text.startsWith('暂无执行记录')) {
      showToast('暂无执行日志可复制');
      return;
    }
    copyToClipboard(text, '已复制终端日志到剪贴板');
  });
}

elements.outputSection.addEventListener('toggle', () => {
  elements.outputToggle.textContent = elements.outputSection.open ? '收起' : '展开';
});

if (elements.stepperRunAllBtn) {
  elements.stepperRunAllBtn.addEventListener('click', () => {
    if (!currentDevice()) {
      showToast('请先选择一台目标云机');
      return;
    }
    const flowAll = state.scripts.find(s => s.id === 'flow-all' || s.batch === true);
    if (!flowAll) {
      showToast('未找到全流程自动化脚本 (V3)');
      return;
    }
    const card = elements.scriptList.querySelector(`[data-script-id="${flowAll.id}"]`);
    const btn = card?.querySelector('.run-button');
    executeScript(flowAll, btn, card);
  });
}

if (elements.resetStepperBtn) {
  elements.resetStepperBtn.addEventListener('click', () => {
    if (!state.selectedDeviceId) {
      showToast('未选择云手机');
      return;
    }
    resetDeviceProgress(state.selectedDeviceId);
  });
}

// 卡密兑换与用户状态事件绑定
if (elements.openRedeemModalBtn) {
  elements.openRedeemModalBtn.addEventListener('click', () => {
    if (elements.redeemAlert) elements.redeemAlert.style.display = 'none';
    if (elements.redeemCardInput) elements.redeemCardInput.value = '';
    elements.redeemDialog?.showModal();
  });
}

if (elements.closeRedeemModalBtn) {
  elements.closeRedeemModalBtn.addEventListener('click', () => elements.redeemDialog?.close());
}

if (elements.cancelRedeemBtn) {
  elements.cancelRedeemBtn.addEventListener('click', () => elements.redeemDialog?.close());
}

if (elements.userLogoutBtn) {
  elements.userLogoutBtn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  });
}

if (elements.submitRedeemBtn) {
  elements.submitRedeemBtn.addEventListener('click', async () => {
    const cardCode = elements.redeemCardInput.value.trim();
    if (!cardCode) {
      elements.redeemAlert.textContent = '请输入卡密代码';
      elements.redeemAlert.style.cssText = 'display:block; padding:10px 12px; border-radius:6px; font-size:13px; margin-bottom:16px; background:rgba(248,81,73,0.15); border:1px solid rgba(248,81,73,0.35); color:#ff7b72;';
      return;
    }
    elements.submitRedeemBtn.disabled = true;
    elements.submitRedeemBtn.textContent = '兑换中…';
    try {
      const res = await fetch('/api/user/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardCode })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      elements.redeemAlert.textContent = `🎉 兑换成功！已为您分配新云手机 [${data.result.deviceName}]，有效期至 ${new Date(data.result.expireAt).toLocaleString()}`;
      elements.redeemAlert.style.cssText = 'display:block; padding:10px 12px; border-radius:6px; font-size:13px; margin-bottom:16px; background:rgba(46,160,67,0.15); border:1px solid rgba(46,160,67,0.35); color:#3fb950;';
      setTimeout(async () => {
        elements.redeemDialog?.close();
        await loadDevices();
        showToast(`已成功分配并加载新云机 [${data.result.deviceName}]`);
      }, 1200);
    } catch (err) {
      elements.redeemAlert.textContent = err.message;
      elements.redeemAlert.style.cssText = 'display:block; padding:10px 12px; border-radius:6px; font-size:13px; margin-bottom:16px; background:rgba(248,81,73,0.15); border:1px solid rgba(248,81,73,0.35); color:#ff7b72;';
    } finally {
      elements.submitRedeemBtn.disabled = false;
      elements.submitRedeemBtn.textContent = '立即兑换';
    }
  });
}

async function checkAuth() {
  const isEmbed = location.search.includes('view=admin-embed');
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (!data.ok || !data.user) {
      if (!isEmbed) location.href = '/login.html';
      return null;
    }
    state.currentUser = data.user;
    if (elements.userPill && !isEmbed) {
      elements.userPill.style.display = 'block';
      elements.userPill.textContent = `${data.user.role === 'admin' ? '管理员' : '用户'}: ${data.user.email}`;
    }
    if (elements.userLogoutBtn && !isEmbed) {
      elements.userLogoutBtn.style.display = 'inline-flex';
    }
    if (data.user.role === 'admin' && elements.adminPortalLink && !isEmbed) {
      elements.adminPortalLink.style.display = 'inline-flex';
    }
    return data.user;
  } catch {
    if (!isEmbed) location.href = '/login.html';
    return null;
  }
}

async function init() {
  await checkAuth();
  await loadStatus();
  await loadScripts();
  if (state.tokenConfigured) await loadDevices();
  renderPipelineStepper();
  await loadSharedRuntimeState();
}

setInterval(loadSharedRuntimeState, 1500);
init();

