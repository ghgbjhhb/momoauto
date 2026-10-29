'use strict';

// 全局防御：彻底封杀浏览器原生的 alert, confirm, prompt，永远不再弹窗干扰
window.alert = function (message) {
  if (typeof showToast === 'function') {
    showToast(String(message));
  } else {
    console.warn('[Alert Blocked]:', message);
  }
};
window.confirm = function (message) {
  console.warn('[Confirm Blocked - please use in-page modal]:', message);
  return false;
};
window.prompt = function (message, defaultValue) {
  return defaultValue || '';
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
  bundles: [],
  visibility: { groups: {}, scripts: {} },
  isAdmin: false,
  runningScript: '',
  activeRun: null,
  activeBundleRun: null,
  previewPlayers: new Map(),
  previewRetry: new Map(),
  manualDeviceId: '',
  runtimeState: { runs: [], manualDevices: [] },
  deviceProgress: (() => {
    try { return JSON.parse(localStorage.getItem('yunmomo.deviceProgress') || '{}'); }
    catch { return {}; }
  })()
};

function isCurrentUserAdmin() {
  return Boolean(state.isAdmin || state.currentUser?.role === 'admin');
}

function isScriptManageMode() {
  const isEmbed = location.search.includes('view=admin-embed');
  return Boolean(isEmbed && isCurrentUserAdmin());
}

const byId = id => document.getElementById(id);
window.byId = byId;
window.state = state;

// 统一应用状态与事件总线 (Unified App Hub)
const eventBus = new EventTarget();
const AppStore = {
  get state() { return state; },
  getSelectedDeviceId() { return state.selectedDeviceId || state.devices[0]?.deviceId || ''; },
  setSelectedDeviceId(id) { selectDevice(id); },
  getManualDeviceId() { return state.manualDeviceId || ''; },
  setManualDeviceId(id) {
    state.manualDeviceId = id || '';
    eventBus.dispatchEvent(new CustomEvent('manual:changed', { detail: { deviceId: id } }));
  },
  getCurrentDevice() { return currentDevice(); },
  getDevices() { return state.devices || []; },
  on(event, handler) { eventBus.addEventListener(event, handler); },
  off(event, handler) { eventBus.removeEventListener(event, handler); },
  emit(event, detail) { eventBus.dispatchEvent(new CustomEvent(event, { detail })); }
};

window.YunMomo = {
  store: AppStore,
  state: state,
  eventBus: eventBus,
  api: {
    requestJson,
    showToast,
    copyToClipboard
  }
};

// 动态安全元素访问代理，避免由于脚本加载时序导致 null 引用
const elements = new Proxy({
  serviceState: null,
  sharedActivity: null,
  serviceText: null,
  sessionBridge: null,
  sessionSettings: null,
  sessionToken: null,
  connectSession: null,
  refreshDevices: null,
  previewTitle: null,
  previewState: null,
  deviceGrid: null,
  previewSummary: null,
  refreshPreview: null,
  pipelineStepperBox: null,
  pipelineStepper: null,
  stepperTargetBadge: null,
  stepperRunAllBtn: null,
  resetStepperBtn: null,
  scriptList: null,
  outputSection: null,
  outputToggle: null,
  outputBox: null,
  systemLogBox: null,
  tabTerminalScript: null,
  tabTerminalSystem: null,
  systemLogBadge: null,
  diagReportBtn: null,
  clearOutput: null,
  copyOutputBtn: null,
  stopScriptBtn: null,
  statTotal: null,
  statOnline: null,
  statTarget: null,
  workbenchTarget: null,
  toast: null,
  userPill: null,
  openRedeemModalBtn: null,
  adminPortalLink: null,
  userLogoutBtn: null,
  redeemDialog: null,
  closeRedeemModalBtn: null,
  cancelRedeemBtn: null,
  submitRedeemBtn: null,
  redeemCardInput: null,
  redeemAlert: null,
  openPasswordModalBtn: null,
  passwordDialog: null,
  closePasswordModalBtn: null,
  cancelPasswordBtn: null,
  submitPasswordBtn: null,
  pwdCurrentInput: null,
  pwdNewInput: null,
  pwdConfirmInput: null,
  passwordAlert: null
}, {
  get(target, prop) {
    if (prop === 'serviceText') {
      return byId('serviceState')?.querySelector?.('.state-text') || byId('serviceState');
    }
    const cached = target[prop];
    if (cached && cached.isConnected) return cached;
    const el = byId(prop);
    if (el) target[prop] = el;
    return el;
  }
});
window.elements = elements;

const STEPS_META = [
  { order: 1, id: 'flow-01-import-cloud-disk', name: '导入云盘', full: '01 导入云盘所有文件' },
  { order: 2, id: 'flow-02-upload-cert', name: '上传证书', full: '02 上传证书' },
  { order: 2.1, id: 'flow-02.1-import-params', name: '导入真参', full: '02.1 导入真参' },
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

function formatStepOrder(order) {
  if (typeof order !== 'number') return String(order || '');
  if (Number.isInteger(order)) return String(order).padStart(2, '0');
  return '0' + order;
}

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
  const dev = state.devices.find(d => String(d.deviceId) === String(deviceId));
  const isV2 = String(dev?.sdkVersion || '').toLowerCase() === 'v2';
  const metaList = STEPS_META.filter(s => isV2 ? s.order !== 8 : s.order !== 2.1);
  for (const meta of metaList) {
    const dot = miniStepper.querySelector(`[data-step="${meta.order}"]`);
    if (!dot) continue;
    dot.className = 'mini-step-dot';
    const st = getStepState(deviceId, meta.order);
    if (st && st !== 'idle') dot.classList.add(st);
    dot.title = `${meta.name}: ${STATUS_LABELS[st] || '待执行'}`;
  }
}

function renderPipelineStepper() {
  if (!elements.pipelineStepper) return;
  const target = currentDevice();
  if (elements.stepperTargetBadge) {
    if (target) {
      const idx = state.devices.indexOf(target) + 1;
      const ver = String(target.sdkVersion || '').toUpperCase();
      elements.stepperTargetBadge.textContent = `#${String(idx).padStart(2, '0')} ${target.name}` + (ver ? ` [${ver}]` : '');
      elements.stepperTargetBadge.title = `目标云机: ${target.name} (${target.deviceId})${ver ? ' · 架构版本: ' + ver : ''}`;
    } else {
      elements.stepperTargetBadge.textContent = '未选择目标';
      elements.stepperTargetBadge.title = '请在左侧选择目标云手机';
    }
  }

  const isV2 = String(target?.sdkVersion || '').toLowerCase() === 'v2';
  if (elements.stepperRunAllBtn) {
    const label = isV2 ? '执行全流程 (V2)' : '执行全流程 (V3)';
    const labelSpan = elements.stepperRunAllBtn.querySelector('span:last-child');
    if (labelSpan) labelSpan.textContent = label;
    else elements.stepperRunAllBtn.textContent = label;
    elements.stepperRunAllBtn.title = isV2 ? '执行全流程 01–07 (V2)' : '执行全流程 01–08 (V3)';
  }

  elements.pipelineStepper.replaceChildren();
  const visibleSteps = STEPS_META.filter(step => isV2 ? step.order !== 8 : step.order !== 2.1);
  for (const step of visibleSteps) {
    const status = target ? getStepState(target.deviceId, step.order) : 'idle';
    const node = document.createElement('div');
    node.className = `step-node ${status}`;
    node.dataset.stepOrder = String(step.order);
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.title = `${step.full}（状态: ${STATUS_LABELS[status] || status}，点击单独执行）`;

    const num = document.createElement('span');
    num.className = 'step-node-num';
    num.textContent = formatStepOrder(step.order);

    const info = document.createElement('div');
    info.className = 'step-node-info';

    const title = document.createElement('div');
    title.className = 'step-node-title';
    title.textContent = step.name;

    info.append(title);

    const indicator = document.createElement('span');
    indicator.className = 'step-node-indicator';
    if (status === 'completed') indicator.innerHTML = '<span class="status-icon-check">✓</span>';
    else if (status === 'running') indicator.innerHTML = '<span class="status-icon-pulse"></span>';
    else if (status === 'failed') indicator.innerHTML = '<span class="status-icon-fail">✕</span>';

    node.append(num, info, indicator);

    const triggerStep = () => {
      const dev = currentDevice();
      if (!dev) {
        showToast('请先选择一台云机');
        return;
      }
      const isV2 = String(dev.sdkVersion || '').toLowerCase() === 'v2';
      const targetVer = isV2 ? 'v2' : 'v3';
      const script = state.scripts.find(s => s.order === step.order && (s.category === targetVer || s.version === targetVer || s.id.endsWith('-' + targetVer)))
        || state.scripts.find(s => s.order === step.order);
      if (script) {
        const card = elements.scriptList.querySelector(`[data-script-id="${script.id}"]`);
        const btn = card?.querySelector('.run-button');
        executeScript(script, btn, card);
      } else {
        showToast(`未找到步骤 ${step.order} 对应的 ${targetVer.toUpperCase()} 执行脚本`);
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

async function requestJson(url, options = {}) {
  const token = localStorage.getItem('yunmomo.auth_token');
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(url, { ...options, headers });
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
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${ts}-${rand}`;
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
  if (elements.serviceState) {
    elements.serviceState.classList.remove('ready', 'error');
    if (kind) elements.serviceState.classList.add(kind);
  }
  if (elements.serviceText) {
    elements.serviceText.textContent = text;
  }
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
    ipBadge.innerHTML = `<span class="ip-icon" aria-hidden="true">🌐</span><span class="ip-text"></span>`;
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
    ipBadge.innerHTML = `<span class="ip-icon" aria-hidden="true">⚠️</span><span class="ip-text">未配置</span>`;
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
    expireBar.className = 'device-expire-bar';
    expireBar.style.cssText = 'padding: 6px 12px; font-size: 12.5px; background: #e6f4ff; border: 1px solid #91caff; display: flex; align-items: center; justify-content: space-between; border-radius: 4px; margin: 6px 10px;';
    const remainingText = device.remainingText || '计算中…';
    const expireDateStr = new Date(device.expireAt).toLocaleDateString();
    expireBar.innerHTML = `
      <span style="color:var(--text-muted);">⏱️ 到期: <strong style="color:var(--text-title);">${expireDateStr}</strong></span>
      <span style="color:#0958d9; font-weight:600;">剩余 ${escapeHtml(remainingText)}</span>
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
  operateBtn.textContent = '📱 放大操作云机';
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
        ipBadge.innerHTML = `<span class="ip-icon" aria-hidden="true">🌐</span><span class="ip-text"></span>`;
        ipBadge.querySelector('.ip-text').textContent = device.currentIp;
        ipBadge.title = `当前正在使用的 IP / 域名: ${device.currentIp}${device.proxyAddress ? ` (完整代理: ${device.proxyAddress})` : ''} - 点击复制`;
      } else {
        ipBadge.innerHTML = `<span class="ip-icon" aria-hidden="true">⚠️</span><span class="ip-text">未配置</span>`;
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
      expireBar.className = 'device-expire-bar';
      expireBar.style.cssText = 'padding: 6px 12px; font-size: 12.5px; background: #e6f4ff; border: 1px solid #91caff; display: flex; align-items: center; justify-content: space-between; border-radius: 4px; margin: 6px 10px;';
      const head = card.querySelector('.device-card-head');
      if (head && head.nextSibling) card.insertBefore(expireBar, head.nextSibling);
      else card.prepend(expireBar);
    }
    expireBar.innerHTML = `
      <span style="color:var(--text-muted);">⏱️ 到期: <strong style="color:var(--text-title);">${expireDateStr}</strong></span>
      <span style="color:#0958d9; font-weight:600;">剩余 ${escapeHtml(remainingText)}</span>
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
    empty.className = 'loading-card empty-user-devices';
    empty.style.cssText = 'padding: 40px 20px; text-align: center; border: 1px dashed var(--border); border-radius: 8px; margin: 20px; background: #ffffff;';
    empty.innerHTML = `
      <div style="font-size: 36px; margin-bottom: 12px;">📱</div>
      <div style="font-size: 16px; font-weight: 600; color: var(--text-title); margin-bottom: 8px;">您名下暂无已分配的云手机</div>
      <div style="font-size: 13.5px; color: var(--text-muted); margin-bottom: 18px;">请点击顶部的【兑换卡密】输入管理员提供的卡密，立即激活分配专属云机！</div>
      <button class="run-button" id="emptyRedeemBtn" type="button" style="margin: 0 auto; display: inline-flex;">立即兑换卡密</button>
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

function parameterChoiceLabel(field, value) {
  if (field.name === 'action') return ({ set: '设置代理', show: '展示当前', close: '关闭代理' })[value] || String(value);
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

async function saveVisibilityConfig({ type, id, visible }) {
  if (!isScriptManageMode()) return;
  const payload = {};
  if (type === 'group') {
    if (!state.visibility.groups) state.visibility.groups = {};
    state.visibility.groups[id] = visible;
    payload.groups = { [id]: visible };
  } else if (type === 'script') {
    if (!state.visibility.scripts) state.visibility.scripts = {};
    state.visibility.scripts[id] = visible;
    payload.scripts = { [id]: visible };
  }
  try {
    const res = await requestJson('/api/admin/scripts/visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok && res.visibility) {
      state.visibility = res.visibility;
    }
    showToast(`已${visible ? '开启' : '关闭'}在用户侧的显示`);
    renderScripts();
  } catch (err) {
    showToast('更新显隐设置失败: ' + err.message);
  }
}

function createScriptCard(script) {
  const isManageMode = isScriptManageMode();
  const isScriptVisible = state.visibility?.scripts?.[script.id] !== false;

  // 普通用户视角（非管理模式）：若该脚本被管理员关闭，则直接不渲染
  if (!isManageMode && !isScriptVisible) return null;

  const card = document.createElement('article');
  card.className = 'script-card';
  card.dataset.scriptId = script.id;
  if (!isScriptVisible && isManageMode) card.classList.add('hidden-from-user');
  if (script.batch) card.classList.add('script-hero-card');

  const isSingleInline = script.parameters?.length === 1 && !script.parameters[0].multiline;
  if (script.parameters?.length && !isSingleInline) card.classList.add('script-card-has-params');
  if (script.destructive) card.classList.add('script-card-destructive');

  const head = document.createElement('div');
  head.className = 'script-card-head';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'script-title-group';

  if (script.order) {
    const order = document.createElement('span');
    order.className = 'script-order';
    order.textContent = formatStepOrder(script.order);
    titleGroup.append(order);
  }

  const title = document.createElement('div');
  title.className = 'script-title';
  title.textContent = script.order ? script.title.replace(/^(0[1-9](?:\.\d+)?|\d+)\s*[-_、\s]\s*/, '') : script.title;
  titleGroup.append(title);

  if (!isScriptVisible && isManageMode) {
    const hiddenBadge = document.createElement('span');
    hiddenBadge.className = 'badge-hidden-user';
    hiddenBadge.textContent = '用户侧隐藏';
    titleGroup.append(hiddenBadge);
  }

  head.append(titleGroup);

  if (script.destructive) {
    const dangerTag = document.createElement('span');
    dangerTag.className = 'script-danger-badge';
    dangerTag.textContent = '⚠️ 清数据';
    head.append(dangerTag);
  }

  // 仅在管理模式下渲染开关
  if (isManageMode) {
    const visWrap = document.createElement('div');
    visWrap.className = 'script-visibility-wrap';
    visWrap.innerHTML = `
      <label class="switch-toggle" title="控制此脚本在普通用户侧是否显示">
        <input type="checkbox" ${isScriptVisible ? 'checked' : ''}>
        <span class="switch-slider"></span>
        <span class="switch-text">${isScriptVisible ? '用户可见' : '隐藏'}</span>
      </label>
    `;
    const visInput = visWrap.querySelector('input');
    visInput.addEventListener('click', e => e.stopPropagation());
    visInput.addEventListener('change', e => {
      e.stopPropagation();
      saveVisibilityConfig({ type: 'script', id: script.id, visible: e.target.checked });
    });
    head.append(visWrap);
  }

  card.append(head);

  if (script.parameters?.length && !isSingleInline) {
    const settings = document.createElement('details');
    settings.className = 'script-settings';
    settings.open = true;
    const summary = document.createElement('summary');
    summary.textContent = '配置参数';
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
        input.name = `param_${script.id}_${field.name}`;
        input.autocomplete = 'new-password';
        input.setAttribute('autocomplete', 'new-password');
        input.setAttribute('data-lpignore', 'true');
        input.setAttribute('data-1p-ignore', 'true');
        input.setAttribute('data-form-type', 'other');
        input.spellcheck = false;
        if (field.maxLength) input.maxLength = field.maxLength;
        if (field.placeholder) input.placeholder = field.placeholder;
      }
      input.value = field.defaultValue ?? '';
      label.append(input);
      settings.append(label);
    }
    card.append(settings);
  }

  const actions = document.createElement('div');
  actions.className = 'script-actions';

  // 单一参数（如 VPC 代理操作选择、或真参输入）直接内联展示在执行按钮左侧，保持整齐一致
  if (isSingleInline) {
    const field = script.parameters[0];
    if (field.choices) {
      const select = document.createElement('select');
      select.className = 'script-inline-select';
      select.dataset.parameter = field.name;
      select.setAttribute('aria-label', field.label);
      for (const value of field.choices) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = parameterChoiceLabel(field, value);
        select.append(option);
      }
      select.value = field.defaultValue ?? '';
      actions.append(select);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'script-inline-input';
      input.dataset.parameter = field.name;
      input.name = `inline_${script.id}_${field.name}`;
      input.setAttribute('autocomplete', 'new-password');
      input.setAttribute('data-lpignore', 'true');
      input.setAttribute('data-form-type', 'other');
      input.setAttribute('aria-label', field.label);
      input.title = `${field.label}: ${field.defaultValue ?? ''}`;
      input.value = field.defaultValue ?? '';
      input.spellcheck = false;
      if (field.placeholder) input.placeholder = field.placeholder;
      actions.append(input);
    }
  }

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

function showInPageConfirm({ title, message, okText = '确定', cancelText = '取消', isDanger = true, icon = '⚠️' } = {}) {
  return new Promise(resolve => {
    const dialog = document.getElementById('userConfirmDialog');
    if (!dialog) return resolve(false);
    const titleEl = document.getElementById('userConfirmTitle');
    const descEl = document.getElementById('userConfirmDesc');
    const okBtn = document.getElementById('userConfirmOkBtn');
    const cancelBtn = document.getElementById('userConfirmCancelBtn');
    const closeBtn = document.getElementById('userConfirmCloseBtn');
    const iconEl = document.getElementById('userConfirmIcon');

    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.innerHTML = message;
    if (okBtn) {
      okBtn.textContent = okText;
      okBtn.className = isDanger ? 'danger-button' : 'run-button';
      okBtn.style.background = '';
      okBtn.style.borderColor = '';
      okBtn.style.color = '';
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;
    if (iconEl) {
      iconEl.textContent = icon;
      iconEl.classList.toggle('info', !isDanger);
    }

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      try { dialog.close(); } catch {}
      okBtn?.removeEventListener('click', onOk);
      cancelBtn?.removeEventListener('click', onCancel);
      closeBtn?.removeEventListener('click', onCancel);
      dialog.removeEventListener('keydown', onKeyDown);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('click', onBackdropClick);
    };

    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(false); }
    };
    const onBackdropClick = (e) => {
      const rect = dialog.getBoundingClientRect();
      const inDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height
        && rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
      if (!inDialog) {
        cleanup();
        resolve(false);
      }
    };

    okBtn?.addEventListener('click', onOk);
    cancelBtn?.addEventListener('click', onCancel);
    closeBtn?.addEventListener('click', onCancel);
    dialog.addEventListener('keydown', onKeyDown);
    dialog.addEventListener('cancel', onCancel, { once: true });
    dialog.addEventListener('click', onBackdropClick);

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');

    // 高危破坏性操作默认将焦点落在“取消”按钮，防止误敲回车造成不可逆损失
    if (isDanger) {
      cancelBtn?.focus();
    } else {
      okBtn?.focus();
    }
  });
}

function createVersionSection(versionTag, title, scripts, defaultCollapsed = false, groupKey = '') {
  const isManageMode = isScriptManageMode();
  const isGroupVisible = state.visibility?.groups?.[groupKey] !== false;

  // 普通用户视角（非管理模式）：如果该分组被关闭，直接不渲染
  if (!isManageMode && !isGroupVisible) return null;

  const section = document.createElement('section');
  const tagClass = versionTag.toLowerCase() + '-tag';
  const colClass = versionTag.toLowerCase() + '-column';

  const storageKey = `yunmomo.collapse.${versionTag.toLowerCase()}`;
  let isCollapsed = defaultCollapsed;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) isCollapsed = saved === 'true';
  } catch {}

  section.className = `scripts-version-column ${colClass}` + (isCollapsed ? ' collapsed' : '') + (!isGroupVisible && isManageMode ? ' hidden-from-user' : '');
  section.innerHTML = `
    <div class="version-column-head" role="button" tabindex="0" title="点击展开/收起此栏脚本">
      <div class="version-badge-group">
        <span class="version-title">${title}</span>
        ${!isGroupVisible && isManageMode ? '<span class="badge-hidden-user">用户侧隐藏</span>' : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        ${isManageMode ? `
          <div class="group-visibility-wrap" title="控制是否在普通用户侧显示此分组">
            <label class="switch-toggle" onclick="event.stopPropagation()">
              <input type="checkbox" class="group-vis-input" data-group="${groupKey}" ${isGroupVisible ? 'checked' : ''}>
              <span class="switch-slider"></span>
              <span class="switch-text">${isGroupVisible ? '用户可见' : '隐藏'}</span>
            </label>
          </div>
        ` : ''}
        <button class="version-collapse-btn" type="button" aria-expanded="${!isCollapsed}" title="点击收起/展开">
          <span class="toggle-text">${isCollapsed ? '展开' : '收起'}</span>
          <span class="toggle-icon">${isCollapsed ? '▼' : '▲'}</span>
        </button>
      </div>
    </div>
    <div class="version-cards-stack"></div>
  `;

  if (isManageMode) {
    const groupInput = section.querySelector('.group-vis-input');
    if (groupInput) {
      groupInput.addEventListener('change', e => {
        e.stopPropagation();
        saveVisibilityConfig({ type: 'group', id: groupKey, visible: e.target.checked });
      });
    }
  }

  const stack = section.querySelector('.version-cards-stack');
  let visibleCount = 0;
  for (const script of scripts) {
    const card = createScriptCard(script);
    if (card) {
      stack.append(card);
      visibleCount++;
    }
  }

  if (!isManageMode && visibleCount === 0) return null;

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

function createBundleCard(bundle) {
  const isManageMode = isScriptManageMode();
  const isEnabled = bundle.enabled !== false;

  // 普通用户视角（非管理模式）：若组合脚本被关闭，直接不渲染
  if (!isManageMode && !isEnabled) return null;

  const card = document.createElement('article');
  card.className = 'script-card bundle-card' + (!isEnabled && isManageMode ? ' hidden-from-user' : '');
  card.dataset.bundleId = bundle.id;

  const stepScripts = (bundle.stepIds || [])
    .map(id => state.scripts.find(s => s.id === id))
    .filter(Boolean);

  const head = document.createElement('div');
  head.className = 'script-card-head';
  head.style.flexDirection = 'column';
  head.style.alignItems = 'stretch';
  head.style.gap = '4px';

  // 标题行与管理操作
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%;';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'script-title-group';

  const badge = document.createElement('span');
  badge.className = 'bundle-badge';
  badge.textContent = '组合';

  const title = document.createElement('div');
  title.className = 'script-title';
  title.style.fontWeight = '700';
  title.textContent = bundle.name;

  titleGroup.append(badge, title);

  if (!isEnabled && isManageMode) {
    const hiddenBadge = document.createElement('span');
    hiddenBadge.className = 'badge-hidden-user';
    hiddenBadge.textContent = '用户侧隐藏';
    titleGroup.append(hiddenBadge);
  }

  titleRow.append(titleGroup);

  if (isManageMode) {
    const adminActions = document.createElement('div');
    adminActions.className = 'bundle-admin-actions';

    // 显隐开关
    const visWrap = document.createElement('div');
    visWrap.className = 'script-visibility-wrap';
    visWrap.innerHTML = `
      <label class="switch-toggle" title="控制此组合脚本在普通用户侧是否显示">
        <input type="checkbox" ${isEnabled ? 'checked' : ''}>
        <span class="switch-slider"></span>
        <span class="switch-text">${isEnabled ? '用户可见' : '隐藏'}</span>
      </label>
    `;
    const visInput = visWrap.querySelector('input');
    visInput.addEventListener('change', async e => {
      e.stopPropagation();
      bundle.enabled = e.target.checked;
      await saveBundleDirect(bundle);
    });

    // 编辑按钮
    const editBtn = document.createElement('button');
    editBtn.className = 'action-btn small';
    editBtn.type = 'button';
    editBtn.textContent = '编辑';
    editBtn.title = '编辑组合名称、备注及步骤';
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      openBundleModal(bundle);
    });

    // 删除按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn small danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '删除';
    deleteBtn.title = '删除此自定义脚本组合';
    deleteBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const confirmed = await showInPageConfirm({
        title: '确认删除脚本组合？',
        message: `确定要彻底删除组合脚本 <strong>${escapeHtml(bundle.name)}</strong> 吗？此操作无法撤销。`,
        okText: '确认删除',
        isDanger: true
      });
      if (!confirmed) return;
      await deleteBundle(bundle.id);
    });

    adminActions.append(visWrap, editBtn, deleteBtn);
    titleRow.append(adminActions);
  }

  head.append(titleRow);

  // 备注 / 脚本功能说明
  if (bundle.description) {
    const desc = document.createElement('div');
    desc.className = 'bundle-desc';
    desc.textContent = bundle.description;
    head.append(desc);
  }

  // 步骤徽章流
  if (stepScripts.length > 0) {
    const flow = document.createElement('div');
    flow.className = 'bundle-steps-flow';
    stepScripts.forEach((step, idx) => {
      if (idx > 0) {
        const arrow = document.createElement('span');
        arrow.className = 'bundle-step-arrow';
        arrow.textContent = '➔';
        flow.append(arrow);
      }
      const tag = document.createElement('span');
      tag.className = 'bundle-step-item';
      tag.textContent = `${idx + 1}. ${step.title.replace(/^(0[1-9](?:\.\d+)?|\d+)\s*[-_、\s]\s*/, '')}`;
      flow.append(tag);
    });
    head.append(flow);
  }

  card.append(head);

  // 执行按钮
  const actions = document.createElement('div');
  actions.className = 'script-actions';

  const isCurrentRunning = state.activeBundleRun?.bundleId === bundle.id;
  const button = document.createElement('button');
  button.className = 'run-button' + (isCurrentRunning ? ' run-button-stop' : '');
  button.type = 'button';

  if (isCurrentRunning) {
    button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">停止组合</span>`;
  } else {
    button.innerHTML = `<span class="run-icon">▶</span><span class="run-text">执行组合</span>`;
  }

  button.addEventListener('click', () => {
    if (state.activeBundleRun?.bundleId === bundle.id) {
      stopRunningBundle();
    } else {
      executeScriptBundle(bundle, button, card);
    }
  });

  actions.append(button);
  card.append(actions);

  return card;
}

function renderScripts() {
  elements.scriptList.replaceChildren();

  const isManageMode = isScriptManageMode();

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

  // 1 & 2: V2 与 V3 流程架构双列并排展示
  const columnsContainer = document.createElement('div');
  columnsContainer.className = 'scripts-columns-container';

  if (v2Scripts.length > 0) {
    const v2Section = createVersionSection('V2', 'V2 流程架构 (01~07)', v2Scripts, false, 'v2');
    if (v2Section) columnsContainer.append(v2Section);
  }

  if (v3Scripts.length > 0) {
    const v3Section = createVersionSection('V3', 'V3 极速架构 (01~08)', v3Scripts, false, 'v3');
    if (v3Section) columnsContainer.append(v3Section);
  }

  if (columnsContainer.hasChildNodes()) {
    elements.scriptList.append(columnsContainer);
  }

  // 3. MOMO 业务自动化板块 (11~15 + 全量执行)
  const isMomoVisible = state.visibility?.groups?.momo !== false;
  if ((momoScripts.length || batchScripts.length) && (isManageMode || isMomoVisible)) {
    const momoSection = document.createElement('section');
    const storageKey = 'yunmomo.collapse.momo';
    let isMomoCollapsed = false;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) isMomoCollapsed = saved === 'true';
    } catch {}

    momoSection.className = 'scripts-momo-section' + (isMomoCollapsed ? ' collapsed' : '') + (!isMomoVisible && isManageMode ? ' hidden-from-user' : '');
    momoSection.innerHTML = `
      <div class="momo-section-head version-column-head" role="button" tabindex="0" title="点击展开/收起此栏脚本">
        <div class="momo-title-group version-badge-group">
          <span class="momo-title version-title">MOMO 业务自动化 (11~15)</span>
          ${!isMomoVisible && isManageMode ? '<span class="badge-hidden-user">用户侧隐藏</span>' : ''}
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          ${isManageMode ? `
            <div class="group-visibility-wrap" title="控制是否在普通用户侧显示此分组">
              <label class="switch-toggle" onclick="event.stopPropagation()">
                <input type="checkbox" class="momo-vis-input" ${isMomoVisible ? 'checked' : ''}>
                <span class="switch-slider"></span>
                <span class="switch-text">${isMomoVisible ? '用户可见' : '隐藏'}</span>
              </label>
            </div>
          ` : ''}
          <button class="version-collapse-btn" type="button" aria-expanded="${!isMomoCollapsed}" title="点击收起/展开">
            <span class="toggle-text">${isMomoCollapsed ? '展开' : '收起'}</span>
            <span class="toggle-icon">${isMomoCollapsed ? '▼' : '▲'}</span>
          </button>
        </div>
      </div>
      <div class="momo-cards-grid version-cards-stack"></div>
    `;

    if (isManageMode) {
      const momoVisInput = momoSection.querySelector('.momo-vis-input');
      if (momoVisInput) {
        momoVisInput.addEventListener('change', e => {
          e.stopPropagation();
          saveVisibilityConfig({ type: 'group', id: 'momo', visible: e.target.checked });
        });
      }
    }

    const momoGrid = momoSection.querySelector('.momo-cards-grid');
    let visibleCount = 0;
    for (const script of momoScripts) {
      const card = createScriptCard(script);
      if (card) { momoGrid.append(card); visibleCount++; }
    }
    for (const script of batchScripts) {
      const card = createScriptCard(script);
      if (card) { momoGrid.append(card); visibleCount++; }
    }

    if (isManageMode || visibleCount > 0) {
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

  // 4. 自定义组合脚本板块
  const isCustomGroupVisible = state.visibility?.groups?.custom !== false;
  const bundles = Array.isArray(state.bundles) ? state.bundles : [];
  const displayBundles = isManageMode
    ? bundles
    : bundles.filter(b => b.enabled !== false);

  if (isManageMode || (isCustomGroupVisible && displayBundles.length > 0)) {
    const bundleSection = document.createElement('section');
    bundleSection.className = 'scripts-bundle-section' + (!isCustomGroupVisible && isManageMode ? ' hidden-from-user' : '');
    bundleSection.innerHTML = `
      <div class="bundle-section-head">
        <div class="bundle-title-group">
          <span class="bundle-badge">组合</span>
          <span class="bundle-section-title">自定义组合脚本</span>
          ${!isCustomGroupVisible && isManageMode ? '<span class="badge-hidden-user">用户侧隐藏</span>' : ''}
        </div>
        <div class="bundle-head-actions">
          ${isManageMode ? `
            <div class="group-visibility-wrap" title="控制是否在普通用户侧显示此组合板块">
              <label class="switch-toggle" onclick="event.stopPropagation()">
                <input type="checkbox" class="custom-group-vis-input" ${isCustomGroupVisible ? 'checked' : ''}>
                <span class="switch-slider"></span>
                <span class="switch-text">${isCustomGroupVisible ? '用户可见' : '隐藏'}</span>
              </label>
            </div>
            <button class="action-btn small" id="openCreateBundleBtn" type="button" style="background:#1677ff; color:#fff; border-color:#1677ff; font-weight:600;">+ 新建组合脚本</button>
          ` : ''}
        </div>
      </div>
      <div class="bundle-cards-stack"></div>
    `;

    if (isManageMode) {
      const customGroupInput = bundleSection.querySelector('.custom-group-vis-input');
      if (customGroupInput) {
        customGroupInput.addEventListener('change', e => {
          e.stopPropagation();
          saveVisibilityConfig({ type: 'group', id: 'custom', visible: e.target.checked });
        });
      }
      const openCreateBtn = bundleSection.querySelector('#openCreateBundleBtn');
      if (openCreateBtn) {
        openCreateBtn.addEventListener('click', () => openBundleModal());
      }
    }

    const bundleStack = bundleSection.querySelector('.bundle-cards-stack');
    if (displayBundles.length === 0) {
      const emptyTip = document.createElement('div');
      emptyTip.style.cssText = 'padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;';
      emptyTip.textContent = isManageMode
        ? '暂无自定义组合脚本，点击右上角【+ 新建组合脚本】可以将多个脚本按序串联为一个组合供用户使用。'
        : '暂无可用组合脚本';
      bundleStack.append(emptyTip);
    } else {
      for (const bundle of displayBundles) {
        const bCard = createBundleCard(bundle);
        if (bCard) bundleStack.append(bCard);
      }
    }

    elements.scriptList.append(bundleSection);
  }
}

function writeOutput(title, lines, meta = {}) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const runId = meta.runId || state.activeRun?.id || '';
  const runIdPrefix = runId ? `[调用ID: ${runId}] ` : '';
  const header = `[${timestamp}] ${runIdPrefix}${title}`;

  const cleanLines = Array.isArray(lines) ? lines.filter(Boolean) : [String(lines || '')];
  const logFile = meta.logFile || state.activeRun?.logFile || (runId ? `logs/runs/${runId}.log` : '');
  if (logFile && !cleanLines.some(l => l.includes(logFile))) {
    cleanLines.push(`[原始日志] ${logFile}`);
  }

  elements.outputBox.textContent = header + '\n' + cleanLines.join('\n');
  if (elements.outputSection) elements.outputSection.open = true;
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
  const dialog = document.getElementById('vpcDialog') || document.getElementById('vpcProxyDialog');
  const input = document.getElementById('vpcRawInput') || document.getElementById('vpcProxyInput');
  const closeBtn = document.getElementById('closeVpcDialogBtn');
  const cancelBtn = document.getElementById('cancelVpcBtn') || document.getElementById('cancelVpcDialogBtn');
  const confirmBtn = document.getElementById('confirmVpcBtn') || document.getElementById('confirmVpcDialogBtn');

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
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch {
      dialog.setAttribute('open', '');
    }
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

  // 03 设置 VPC 代理：网页弹窗识别并输入 VPC 代理（仅当操作指令为设置时才弹窗）
  if (script.id === 'flow-03' || script.order === 3 || script.id.startsWith('flow-03')) {
    const action = options.action || 'set';
    if (action === 'set') {
      const vpcData = await promptVpcProxyDialog();
      if (!vpcData) return;
      options.vpcData = vpcData;
    }
  }

  let resetConfirmed = false;
  if (script.destructive) {
    const isV2 = script.id === 'flow-09-v2';
    const targetLabel = escapeHtml(deviceLabel(currentDevice()));
    const message = isV2
      ? `<div class="confirm-target-lead">确认对 <strong>${targetLabel}</strong> 执行“重置数据”？</div>
         <div class="confirm-danger-card">
           <div class="confirm-danger-card-icon">⚠️</div>
           <div class="confirm-danger-card-body">
             <div class="confirm-danger-card-title">警告：即将重置该设备，此操作不可恢复！</div>
             <div class="confirm-danger-card-desc">清空该设备所有数据并恢复出厂设置。</div>
           </div>
         </div>`
      : `<div class="confirm-target-lead">确认对 <strong>${targetLabel}</strong> 执行“改机重置”？</div>
         <div class="confirm-sub-text" style="margin-bottom:8px;">机型范围：Android ${escapeHtml(options.androidVersion || '16')}；国家：${escapeHtml(options.countryCode || 'CN')}。</div>
         <div class="confirm-danger-card">
           <div class="confirm-danger-card-icon">⚠️</div>
           <div class="confirm-danger-card-body">
             <div class="confirm-danger-card-title">警告：此操作会清除该设备所有数据且不可撤销！</div>
             <div class="confirm-danger-card-desc">重置后云机将自动重启并应用新机型参数。</div>
           </div>
         </div>`;

    resetConfirmed = await showInPageConfirm({
      title: isV2 ? '确认执行【重置数据】？' : '确认执行【改机重置】？',
      message,
      okText: isV2 ? '确认重置' : '确认改机重置',
      isDanger: true,
      icon: '⚠️'
    });
    if (!resetConfirmed) return;
  }
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
  window.AppLogger?.info('Script', `启动执行脚本 [${script.title}] (目标设备: ${targetId}, 运行ID: ${scriptRunId})`);
  writeOutput('正在执行：' + script.title, [], { runId: scriptRunId });

  let isPollingOutput = false;
  const outputPollTimer = setInterval(async () => {
    if (!state.activeRun || state.activeRun.id !== scriptRunId) {
      clearInterval(outputPollTimer);
      return;
    }
    if (isPollingOutput) return;
    isPollingOutput = true;
    try {
      const live = await requestJson('/api/execute/output?scriptRunId=' + encodeURIComponent(scriptRunId));
      if (live.ok) {
        if (live.logFile && state.activeRun) state.activeRun.logFile = live.logFile;
        if (live.stdout || live.stderr) {
          if (state.activeRun && state.activeRun.id === scriptRunId) {
            const lines = cleanScriptLines(live.stdout, live.stderr);
            writeOutput('正在执行：' + script.title, lines, { runId: scriptRunId, logFile: live.logFile });
          }
        }
      }
    } catch { /* 轮询异常静默忽略 */ }
    finally { isPollingOutput = false; }
  }, 300);

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
    writeOutput(title, lines, { runId: scriptRunId, logFile: result.logFile });
    if (result.ok && card) {
      const privateInput = card.querySelector('[data-parameter="vpcData"]');
      if (privateInput) privateInput.value = '';
    }
    if (result.ok) {
      const vpcInput = document.getElementById('vpcRawInput') || document.getElementById('vpcProxyInput');
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

    if (result.cancelled) {
      window.AppLogger?.warn('Script', `脚本已人为中断 [${script.title}] (运行ID: ${scriptRunId})`);
      showToast('脚本已停止，请核对设备状态');
    } else if (!result.ok) {
      window.AppLogger?.error('Script', `脚本执行未达成目标 [${script.title}] (运行ID: ${scriptRunId})`);
      showToast('脚本执行失败，请查看执行记录');
    } else {
      window.AppLogger?.info('Script', `脚本执行成功达成 [${script.title}] (运行ID: ${scriptRunId})`);
    }
    requestAllPreviews();
    if (state.tokenConfigured) loadDevices(true);
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
    const isNetwork = error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError');
    const displayMsg = isNetwork
      ? '网络连接失败（Failed to fetch）：后端控制台服务暂时断开或重启中，请检查服务是否运行或稍后重试。'
      : error.message;
    writeOutput('执行请求失败：' + script.title, [
      displayMsg,
      Number.isFinite(error.durationMs) ? '总耗时：' + error.durationMs + ' ms' : '',
      `调用编号：${scriptRunId}`,
      state.activeRun?.logFile ? `原始日志：${state.activeRun.logFile}` : ''
    ], { runId: scriptRunId });
    window.AppLogger?.error('Script', `脚本执行异常失败 [${script.title}]: ${displayMsg}`, { runId: scriptRunId, error: error.message });
    showToast(displayMsg);
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

async function executeSingleStep(script, targetId, options = {}) {
  const scriptRunId = createScriptRunId();
  const run = { id: scriptRunId, scriptId: script.id, deviceId: targetId, stopping: false, stopConfirmed: false };
  state.activeRun = run;
  state.runningScript = script.id;

  if (elements.stopScriptBtn) {
    elements.stopScriptBtn.style.display = 'inline-flex';
    elements.stopScriptBtn.disabled = false;
    elements.stopScriptBtn.textContent = '⏹ 停止脚本';
  }

  if (script.order >= 1 && script.order <= 8) {
    setStepState(targetId, script.order, 'running');
  }

  let isPollingOutput = false;
  const outputPollTimer = setInterval(async () => {
    if (!state.activeRun || state.activeRun.id !== scriptRunId) {
      clearInterval(outputPollTimer);
      return;
    }
    if (isPollingOutput) return;
    isPollingOutput = true;
    try {
      const live = await requestJson('/api/execute/output?scriptRunId=' + encodeURIComponent(scriptRunId));
      if (live.ok) {
        if (live.logFile && state.activeRun) state.activeRun.logFile = live.logFile;
        if (live.stdout || live.stderr) {
          if (state.activeRun && state.activeRun.id === scriptRunId) {
            const lines = cleanScriptLines(live.stdout, live.stderr);
            writeOutput('正在执行：' + script.title, lines, { runId: scriptRunId, logFile: live.logFile });
          }
        }
      }
    } catch {}
    finally { isPollingOutput = false; }
  }, 300);

  try {
    const result = await requestJson('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptRunId,
        scriptId: script.id,
        deviceId: targetId,
        pageId: state.pageId,
        options
      })
    });
    clearInterval(outputPollTimer);
    const lines = cleanScriptLines(result.stdout, result.stderr);
    const durationSec = Number.isFinite(result.durationMs) ? (result.durationMs / 1000).toFixed(1) + 's' : '';
    writeOutput(
      result.cancelled ? '脚本已停止：' + script.title : result.ok ? '执行成功：' + script.title : '执行失败：' + script.title,
      lines,
      { runId: scriptRunId, logFile: result.logFile }
    );

    if (script.order >= 1 && script.order <= 8) {
      setStepState(targetId, script.order, result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed');
    }

    return {
      ok: Boolean(result.ok),
      cancelled: Boolean(result.cancelled),
      exitCode: result.exitCode,
      durationSec,
      logFile: result.logFile
    };
  } catch (err) {
    clearInterval(outputPollTimer);
    if (script.order >= 1 && script.order <= 8) {
      setStepState(targetId, script.order, 'failed');
    }
    return {
      ok: false,
      cancelled: run.stopConfirmed,
      exitCode: -1,
      durationSec: '',
      error: err.message
    };
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
    }
  }
}

async function executeScriptBundle(bundle, button, card) {
  if (state.activeRun || state.runningScript || state.activeBundleRun) {
    showToast('请等待当前正在运行的脚本完成');
    return;
  }
  if (state.manualDeviceId) {
    showToast('请先关闭手动操作窗，再运行脚本');
    return;
  }
  if (!state.tokenConfigured) {
    showToast('尚未连接');
    return;
  }
  const targetId = state.selectedDeviceId;
  const stepScripts = (bundle.stepIds || [])
    .map(id => state.scripts.find(s => s.id === id))
    .filter(Boolean);

  if (stepScripts.length === 0) {
    showToast('此组合未包含有效脚本步骤');
    return;
  }

  const anyRequiresDevice = stepScripts.some(s => s.requiresDevice);
  if (anyRequiresDevice && !currentDevice()) {
    showToast('此组合脚本需要操作云机，请先在左侧选择目标云机');
    return;
  }

  const bundleRunState = {
    bundleId: bundle.id,
    stopped: false,
    currentStepIndex: 0
  };
  state.activeBundleRun = bundleRunState;

  if (button) {
    button.classList.add('run-button-stop');
    button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">停止组合</span>`;
  }
  if (card) card.classList.add('running');

  const total = stepScripts.length;
  writeOutput(`【开始执行组合脚本】: ${bundle.name}`, [
    `功能备注：${bundle.description || '无'}`,
    `目标设备：${targetId ? deviceLabel(currentDevice()) : '无需设备'}`,
    `计划执行步骤（共 ${total} 步）：`,
    ...stepScripts.map((s, i) => `  ${i + 1}. ${s.title}`)
  ]);

  try {
    for (let i = 0; i < total; i++) {
      if (bundleRunState.stopped) {
        writeOutput(`【组合脚本人为中断】: ${bundle.name}`, ['用户已主动停止组合脚本，剩余步骤已取消。']);
        showToast('组合脚本已停止');
        break;
      }

      bundleRunState.currentStepIndex = i;
      const script = stepScripts[i];
      if (button) {
        button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">[${i + 1}/${total}] ${escapeHtml(script.title.slice(0, 8))}…</span>`;
      }

      writeOutput(`\n▶ [步骤 ${i + 1}/${total}] 启动执行: ${script.title}`, [
        `正在运行子脚本 ${script.id}...`
      ]);

      const stepRes = await executeSingleStep(script, targetId);

      if (bundleRunState.stopped || stepRes.cancelled) {
        writeOutput(`【组合脚本中断】: 步骤 ${i + 1} (${script.title}) 已停止。`, ['终止后续执行。']);
        showToast(`组合脚本已在步骤 ${i + 1} 停止`);
        break;
      }

      if (!stepRes.ok) {
        writeOutput(`【组合脚本失败中断】: 步骤 ${i + 1} (${script.title}) 执行未达成`, [
          `退出码: ${stepRes.exitCode ?? '未知'}`,
          '组合脚本后续步骤已自动熔断中止。请排查错误后重试。'
        ]);
        showToast(`步骤 ${i + 1} (${script.title}) 执行失败，组合已中断`);
        break;
      }

      writeOutput(`✓ [步骤 ${i + 1}/${total}] 成功达成: ${script.title}`, [
        `耗时: ${stepRes.durationSec || '--'}`
      ]);

      if (i === total - 1) {
        writeOutput(`\n🎉【组合脚本全部执行成功】: ${bundle.name}`, [
          `共 ${total} 个步骤全部依次顺利执行达成！`
        ]);
        showToast(`🎉 组合脚本【${bundle.name}】全部执行完成！`);
      } else {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (err) {
    writeOutput(`【组合脚本异常失败】: ${bundle.name}`, [err.message]);
    showToast('组合脚本异常: ' + err.message);
  } finally {
    state.activeBundleRun = null;
    if (button) {
      button.classList.remove('run-button-stop');
      button.innerHTML = `<span class="run-icon">▶</span><span class="run-text">执行组合</span>`;
    }
    if (card) card.classList.remove('running');
    loadSharedRuntimeState();
    requestAllPreviews();
  }
}

function stopRunningBundle() {
  if (state.activeBundleRun) {
    state.activeBundleRun.stopped = true;
    showToast('正在停止组合脚本…');
    stopRunningScript();
  }
}

let editingBundleSteps = [];

function openBundleModal(bundle = null) {
  const modal = byId('scriptBundleModal');
  const title = byId('bundleModalTitle');
  const editIdInput = byId('bundleEditId');
  const nameInput = byId('bundleNameInput');
  const descInput = byId('bundleDescInput');
  const enabledInput = byId('bundleEnabledInput');
  const scriptsSelect = byId('bundleAvailableScriptsSelect');

  if (!modal) return;

  if (scriptsSelect) {
    scriptsSelect.innerHTML = '';
    const nonBatchScripts = state.scripts.filter(s => !s.batch && !s.id.startsWith('flow-all'));
    for (const s of nonBatchScripts) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const ver = (s.category || s.version || '').toUpperCase();
      opt.textContent = `${ver ? `[${ver}] ` : ''}${s.title}`;
      scriptsSelect.append(opt);
    }
  }

  if (bundle) {
    if (title) title.textContent = '编辑自定义脚本组合';
    if (editIdInput) editIdInput.value = bundle.id;
    if (nameInput) nameInput.value = bundle.name || '';
    if (descInput) descInput.value = bundle.description || '';
    if (enabledInput) enabledInput.checked = bundle.enabled !== false;
    editingBundleSteps = Array.isArray(bundle.stepIds) ? [...bundle.stepIds] : [];
  } else {
    if (title) title.textContent = '新建自定义脚本组合';
    if (editIdInput) editIdInput.value = '';
    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';
    if (enabledInput) enabledInput.checked = true;
    editingBundleSteps = [];
  }

  renderModalSelectedSteps();
  try {
    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');
  } catch {}
}

function closeBundleModal() {
  const modal = byId('scriptBundleModal');
  if (!modal) return;
  try {
    modal.close();
  } catch {
    modal.removeAttribute('open');
  }
}

function renderModalSelectedSteps() {
  const container = byId('bundleSelectedSteps');
  if (!container) return;
  container.innerHTML = '';

  if (editingBundleSteps.length === 0) {
    const tip = document.createElement('div');
    tip.style.cssText = 'color:#8c8c8c; font-size:12.5px; padding:10px; text-align:center;';
    tip.textContent = '暂未添加步骤，请在下方选择脚本并点击【+ 添加步骤】';
    container.append(tip);
    return;
  }

  editingBundleSteps.forEach((stepId, index) => {
    const script = state.scripts.find(s => s.id === stepId);
    const row = document.createElement('div');
    row.className = 'bundle-step-row';

    const info = document.createElement('div');
    info.style.cssText = 'display:flex; align-items:center; gap:8px;';
    info.innerHTML = `
      <span style="font-weight:700; color:#1677ff; width:20px;">${index + 1}.</span>
      <span style="font-weight:500; color:#262626;">${escapeHtml(script ? script.title : stepId)}</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'bundle-step-actions';

    const upBtn = document.createElement('button');
    upBtn.className = 'btn-icon';
    upBtn.type = 'button';
    upBtn.innerHTML = '▲';
    upBtn.title = '上移一步';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      if (index > 0) {
        const tmp = editingBundleSteps[index];
        editingBundleSteps[index] = editingBundleSteps[index - 1];
        editingBundleSteps[index - 1] = tmp;
        renderModalSelectedSteps();
      }
    });

    const downBtn = document.createElement('button');
    downBtn.className = 'btn-icon';
    downBtn.type = 'button';
    downBtn.innerHTML = '▼';
    downBtn.title = '下移一步';
    downBtn.disabled = index === editingBundleSteps.length - 1;
    downBtn.addEventListener('click', () => {
      if (index < editingBundleSteps.length - 1) {
        const tmp = editingBundleSteps[index];
        editingBundleSteps[index] = editingBundleSteps[index + 1];
        editingBundleSteps[index + 1] = tmp;
        renderModalSelectedSteps();
      }
    });

    const rmBtn = document.createElement('button');
    rmBtn.className = 'btn-icon danger';
    rmBtn.type = 'button';
    rmBtn.innerHTML = '✕';
    rmBtn.title = '移除此步骤';
    rmBtn.addEventListener('click', () => {
      editingBundleSteps.splice(index, 1);
      renderModalSelectedSteps();
    });

    actions.append(upBtn, downBtn, rmBtn);
    row.append(info, actions);
    container.append(row);
  });
}

async function saveBundleDirect(bundle) {
  try {
    const res = await requestJson('/api/admin/scripts/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle)
    });
    if (res.ok) {
      showToast(`已${bundle.enabled ? '开启' : '关闭'}组合脚本【${bundle.name}】的用户侧显示`);
      await loadScripts();
    }
  } catch (err) {
    showToast('更新组合脚本状态失败: ' + err.message);
  }
}

async function deleteBundle(bundleId) {
  try {
    const res = await requestJson('/api/admin/scripts/bundles', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bundleId })
    });
    if (res.ok) {
      showToast('组合脚本已成功删除');
      await loadScripts();
    }
  } catch (err) {
    showToast('删除组合脚本失败: ' + err.message);
  }
}

async function handleSaveBundleModal() {
  const editId = byId('bundleEditId')?.value || '';
  const name = byId('bundleNameInput')?.value?.trim();
  const description = byId('bundleDescInput')?.value?.trim() || '';
  const enabled = byId('bundleEnabledInput')?.checked !== false;

  if (!name) {
    showToast('请输入组合脚本名称');
    byId('bundleNameInput')?.focus();
    return;
  }

  if (editingBundleSteps.length === 0) {
    showToast('请至少添加一个执行步骤');
    return;
  }

  try {
    const payload = {
      id: editId || undefined,
      name,
      description,
      enabled,
      stepIds: editingBundleSteps
    };
    const res = await requestJson('/api/admin/scripts/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast('组合脚本保存成功');
      closeBundleModal();
      await loadScripts();
    }
  } catch (err) {
    showToast('保存组合脚本失败: ' + err.message);
  }
}

function initBundleModalEvents() {
  byId('closeBundleModalBtn')?.addEventListener('click', closeBundleModal);
  byId('cancelBundleBtn')?.addEventListener('click', closeBundleModal);
  byId('saveBundleBtn')?.addEventListener('click', handleSaveBundleModal);
  byId('addStepToBundleBtn')?.addEventListener('click', () => {
    const select = byId('bundleAvailableScriptsSelect');
    if (select && select.value) {
      editingBundleSteps.push(select.value);
      renderModalSelectedSteps();
    }
  });
}

async function loadScripts() {
  try {
    const data = await requestJson('/api/scripts');
    state.scripts = Array.isArray(data.scripts) ? data.scripts : [];
    state.bundles = Array.isArray(data.bundles) ? data.bundles : [];
    state.visibility = data.visibility || { groups: {}, scripts: {} };
    if (data.isAdmin !== undefined) state.isAdmin = Boolean(data.isAdmin);
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

let isDevicesLoading = false;
async function loadDevices(isBackground = false) {
  if (isDevicesLoading) return;
  if (isBackground && (!state.tokenConfigured || document.hidden)) return;
  isDevicesLoading = true;
  if (!isBackground && elements.refreshDevices) {
    elements.refreshDevices.disabled = true;
    elements.refreshDevices.textContent = '读取中…';
  }
  try {
    const data = await requestJson('/api/devices');
    state.devices = Array.isArray(data.devices) ? data.devices : [];
    renderDeviceGrid();
    renderSharedActivity();
    updateSharedRunControls();
    if (!isBackground && !state.devices.length) showToast('当前账号没有可用云机');
  } catch (error) {
    if (!isBackground) {
      state.devices = [];
      state.selectedDeviceId = '';
      renderDeviceGrid();
      renderSharedActivity();
      updateSharedRunControls();
      showToast(error.message);
    }
    if (error.status === 401 || /Token|YUNMOMO_TOKEN/.test(error.message)) {
      state.tokenConfigured = false;
      if (elements.sessionBridge) elements.sessionBridge.hidden = false;
      if (elements.sessionSettings) elements.sessionSettings.hidden = false;
      setService('error', '网页登录已过期');
    }
  } finally {
    isDevicesLoading = false;
    if (!isBackground && elements.refreshDevices) {
      elements.refreshDevices.disabled = false;
      elements.refreshDevices.textContent = '刷新';
    }
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

if (elements.stopScriptBtn) {
  elements.stopScriptBtn.addEventListener('click', stopRunningScript);
}

if (elements.outputSection && elements.outputToggle) {
  elements.outputSection.addEventListener('toggle', () => {
    elements.outputToggle.textContent = elements.outputSection.open ? '收起' : '展开';
  });
}

function initTabs() {
  const tabsContainer = byId('workbenchTabs');
  if (!tabsContainer) return;
  const tabBtns = tabsContainer.querySelectorAll('.tab-btn');
  const panes = document.querySelectorAll('.tab-pane');

  function switchTab(targetTab) {
    if (targetTab !== 'flow' && targetTab !== 'ai') targetTab = 'flow';
    for (const btn of tabBtns) {
      const active = btn.dataset.tab === targetTab;
      btn.classList.toggle('active', active);
    }
    for (const pane of panes) {
      const paneId = 'tabPane' + targetTab.charAt(0).toUpperCase() + targetTab.slice(1);
      const active = pane.id === paneId;
      pane.classList.toggle('active', active);
    }
    try {
      localStorage.setItem('yunmomo.activeTab', targetTab);
    } catch {}
  }

  for (const btn of tabBtns) {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  }

  let savedTab = 'flow';
  try {
    savedTab = localStorage.getItem('yunmomo.activeTab') || 'flow';
    if (savedTab !== 'flow' && savedTab !== 'ai') savedTab = 'flow';
  } catch {}
  switchTab(savedTab);
}

function initTerminalTabs() {
  let activeTerminalTab = 'script'; // 'script' | 'system'

  function updateSystemLogView() {
    if (!elements.systemLogBox) return;
    const logs = window.AppLogger ? window.AppLogger.getLogs() : [];
    if (!logs.length) {
      elements.systemLogBox.textContent = '暂无系统日志。';
      return;
    }
    const lines = logs.map(item => {
      const d = item.details ? ' ' + (typeof item.details === 'string' ? item.details : JSON.stringify(item.details)) : '';
      return `[${item.time}] [${item.level}] [${item.tag}] ${item.message}${d}`;
    });
    elements.systemLogBox.textContent = lines.join('\n');
    elements.systemLogBox.scrollTop = elements.systemLogBox.scrollHeight;
  }

  function updateBadge() {
    if (!elements.systemLogBadge || !window.AppLogger) return;
    const count = window.AppLogger.getErrorCount();
    elements.systemLogBadge.textContent = String(count);
    elements.systemLogBadge.style.display = count > 0 ? 'inline-flex' : 'none';
  }

  if (window.AppLogger) {
    window.AppLogger.subscribe(() => {
      updateBadge();
      if (activeTerminalTab === 'system') {
        updateSystemLogView();
      }
    });
    updateBadge();
  }

  if (elements.tabTerminalScript) {
    elements.tabTerminalScript.addEventListener('click', () => {
      activeTerminalTab = 'script';
      elements.tabTerminalScript.classList.add('active');
      elements.tabTerminalSystem?.classList.remove('active');
      if (elements.outputBox) elements.outputBox.style.display = 'block';
      if (elements.systemLogBox) elements.systemLogBox.style.display = 'none';
    });
  }

  if (elements.tabTerminalSystem) {
    elements.tabTerminalSystem.addEventListener('click', () => {
      const isAdmin = state.currentUser?.role === 'admin';
      if (!isAdmin) return;
      activeTerminalTab = 'system';
      elements.tabTerminalSystem.classList.add('active');
      elements.tabTerminalScript?.classList.remove('active');
      if (elements.outputBox) elements.outputBox.style.display = 'none';
      if (elements.systemLogBox) {
        elements.systemLogBox.style.display = 'block';
        updateSystemLogView();
      }
    });
  }

  if (elements.diagReportBtn) {
    elements.diagReportBtn.addEventListener('click', () => {
      const report = window.AppLogger?.exportDiagnostics() || '{}';
      copyToClipboard(report, '已复制完整系统诊断包到剪贴板，可直接发送技术支持排查');
    });
  }

  if (elements.clearOutput) {
    elements.clearOutput.addEventListener('click', () => {
      if (activeTerminalTab === 'system') {
        window.AppLogger?.clear();
        updateSystemLogView();
        updateBadge();
        showToast('已清空系统运行日志');
      } else {
        if (elements.outputBox) elements.outputBox.textContent = '暂无执行记录。';
        showToast('已清空脚本执行日志');
      }
    });
  }

  if (elements.copyOutputBtn) {
    elements.copyOutputBtn.addEventListener('click', () => {
      if (activeTerminalTab === 'system') {
        const text = elements.systemLogBox?.textContent || '';
        if (!text || text === '暂无系统日志。') {
          showToast('暂无系统日志可复制');
          return;
        }
        copyToClipboard(text, '已复制系统运行日志到剪贴板');
      } else {
        const text = elements.outputBox?.textContent || '';
        if (!text || text === '暂无执行记录。' || text.startsWith('暂无执行记录')) {
          showToast('暂无执行日志可复制');
          return;
        }
        copyToClipboard(text, '已复制脚本执行日志到剪贴板');
      }
    });
  }
}

if (elements.stepperRunAllBtn) {
  elements.stepperRunAllBtn.addEventListener('click', () => {
    if (!currentDevice()) {
      showToast('请先选择一台目标云机');
      return;
    }
    const target = currentDevice();
    const isV2 = String(target?.sdkVersion || '').toLowerCase() === 'v2';
    const targetId = isV2 ? 'flow-all-v2' : 'flow-all';
    const flowAll = state.scripts.find(s => s.id === targetId) || state.scripts.find(s => s.id === 'flow-all' || s.batch === true);
    if (!flowAll) {
      showToast(`未找到全流程自动化脚本 (${isV2 ? 'V2' : 'V3'})`);
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

function showPasswordAlert(text, tone) {
  if (!elements.passwordAlert) return;
  elements.passwordAlert.textContent = text;
  elements.passwordAlert.style.cssText = tone === 'success'
    ? 'display:block; padding:8px 10px; border-radius:4px; font-size:12px; margin-bottom:14px; background:rgba(46,160,67,0.15); border:1px solid rgba(46,160,67,0.35); color:#3fb950;'
    : 'display:block; padding:8px 10px; border-radius:4px; font-size:12px; margin-bottom:14px; background:#fff2f0; border:1px solid #ffccc7; color:#cf1322;';
}

if (elements.openPasswordModalBtn) {
  elements.openPasswordModalBtn.addEventListener('click', () => {
    if (elements.passwordAlert) elements.passwordAlert.style.display = 'none';
    [elements.pwdCurrentInput, elements.pwdNewInput, elements.pwdConfirmInput].forEach(input => { if (input) input.value = ''; });
    elements.passwordDialog?.showModal();
    elements.pwdCurrentInput?.focus();
  });
}

if (elements.closePasswordModalBtn) {
  elements.closePasswordModalBtn.addEventListener('click', () => elements.passwordDialog?.close());
}

if (elements.cancelPasswordBtn) {
  elements.cancelPasswordBtn.addEventListener('click', () => elements.passwordDialog?.close());
}

if (elements.submitPasswordBtn) {
  elements.submitPasswordBtn.addEventListener('click', async () => {
    const currentPassword = elements.pwdCurrentInput?.value || '';
    const newPassword = elements.pwdNewInput?.value || '';
    if (newPassword.length < 8) {
      showPasswordAlert('新密码长度至少需要 8 位');
      return;
    }
    if (newPassword !== (elements.pwdConfirmInput?.value || '')) {
      showPasswordAlert('两次输入的新密码不一致');
      return;
    }
    elements.submitPasswordBtn.disabled = true;
    try {
      await requestJson('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      // 服务端已递增令牌版本，本地缓存的旧 token 立刻作废
      localStorage.removeItem('yunmomo.auth_token');
      showPasswordAlert('密码已更新，即将跳转到登录页…', 'success');
      setTimeout(() => { location.href = '/login.html'; }, 1200);
    } catch (err) {
      showPasswordAlert(err.message || '密码修改失败');
      elements.submitPasswordBtn.disabled = false;
    }
  });
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
      elements.redeemAlert.style.cssText = 'display:block; padding:10px 12px; border-radius:6px; font-size:13px; margin-bottom:16px; background:#fff2f0; border:1px solid #ffccc7; color:#cf1322;';
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
      if (!data.ok) throw new Error(data.error || '兑换失败，请联系客服');

      const summary = data.result.summary || (data.result.deviceName ? `已为您分配新云手机 [${data.result.deviceName}]，有效期至 ${new Date(data.result.expireAt).toLocaleString()}` : '权益已成功充值到账！');
      elements.redeemAlert.innerHTML = `🎉 <strong>兑换成功！</strong><div style="margin-top:4px; line-height:1.4;">${escapeHtml(summary)}</div>`;
      elements.redeemAlert.style.cssText = 'display:block; padding:10px 12px; border-radius:6px; font-size:13px; margin-bottom:16px; background:rgba(46,160,67,0.15); border:1px solid rgba(46,160,67,0.35); color:#3fb950;';
      setTimeout(async () => {
        elements.redeemDialog?.close();
        await checkAuth();
        if (data.result.deviceId || data.result.deviceName) {
          await loadDevices();
        }
        showToast(`兑换成功: ${summary}`);
      }, 1500);
    } catch (err) {
      console.warn('[Redeem] Failed:', err.message);
      elements.redeemAlert.textContent = '兑换失败，请联系客服';
      elements.redeemAlert.style.cssText = 'display:block; padding:10px 12px; border-radius:6px; font-size:13px; margin-bottom:16px; background:#fff2f0; border:1px solid #ffccc7; color:#cf1322;';
    } finally {
      elements.submitRedeemBtn.disabled = false;
      elements.submitRedeemBtn.textContent = '立即兑换';
    }
  });
}

async function checkAuth() {
  const isEmbed = location.search.includes('view=admin-embed');
  try {
    const savedToken = localStorage.getItem('yunmomo.auth_token');
    const headers = savedToken ? { 'Authorization': `Bearer ${savedToken}` } : {};
    const res = await fetch('/api/auth/me', { headers });
    const data = await res.json();
    if (!data.ok || !data.user) {
      if (!isEmbed) location.href = '/login.html';
      return null;
    }
    state.currentUser = data.user;
    // 角色只允许来自服务端响应，URL 查询串不能作为授权依据
    const isAdmin = data.user.role === 'admin';
    if (elements.tabTerminalSystem) {
      elements.tabTerminalSystem.style.display = isAdmin ? 'inline-flex' : 'none';
    }
    if (elements.diagReportBtn) {
      elements.diagReportBtn.style.display = isAdmin ? 'inline-block' : 'none';
    }
    // 系统提示词、连接测试与中枢配置属于全局写入（服务端已限管理员），普通用户不再呈现必然被拒的入口
    if (!isAdmin) {
      for (const id of ['btnSaveAiConfig', 'btnTestAiApi', 'btnBrainSaveConfig']) {
        const node = document.getElementById(id);
        if (node) node.style.display = 'none';
      }
      const promptItem = document.getElementById('aiSystemPrompt')?.closest('.form-item');
      if (promptItem) promptItem.style.display = 'none';
    }
    if (elements.userPill && !isEmbed) {
      elements.userPill.style.display = 'block';
      elements.userPill.textContent = `${isAdmin ? '管理员' : '用户'}: ${data.user.email}`;
    }
    const zhencanQuotaEl = document.getElementById('topbarZhencanQuota');
    const zhencanCountEl = document.getElementById('topbarZhencanCount');
    if (zhencanQuotaEl && !isEmbed) {
      zhencanQuotaEl.style.display = 'inline-flex';
      if (isAdmin) {
        zhencanQuotaEl.innerHTML = '🧬 真参: <strong>管理员无限</strong>';
        zhencanQuotaEl.title = '管理员特权免扣真参配额';
      } else {
        const count = parseInt(data.user.zhencanBalance, 10) || 0;
        if (zhencanCountEl) zhencanCountEl.textContent = String(count);
        zhencanQuotaEl.title = `当前可用真参配额: ${count} 套，导入真参自动核销 1 套，可通过卡密兑换充值`;
        if (count <= 0) {
          zhencanQuotaEl.style.background = '#fff2f0';
          zhencanQuotaEl.style.borderColor = '#ffccc7';
          zhencanQuotaEl.style.color = '#cf1322';
        } else {
          zhencanQuotaEl.style.background = '#f6ffed';
          zhencanQuotaEl.style.borderColor = '#b7eb8f';
          zhencanQuotaEl.style.color = '#237804';
        }
      }
    }
    if (elements.openPasswordModalBtn && !isEmbed) {
      elements.openPasswordModalBtn.style.display = 'inline-flex';
    }
    if (elements.userLogoutBtn && !isEmbed) {
      elements.userLogoutBtn.style.display = 'inline-flex';
    }
    if (isAdmin && elements.adminPortalLink && !isEmbed) {
      elements.adminPortalLink.style.display = 'inline-flex';
    }
    return data.user;
  } catch {
    if (!isEmbed) location.href = '/login.html';
    return null;
  }
}

async function init() {
  window.AppLogger?.info('Init', '正在启动控制台工作台前端...');
  initTabs();
  initTerminalTabs();
  initBundleModalEvents();
  try {
    await checkAuth();
    window.AppLogger?.info('Auth', `登录用户就绪: ${state.currentUser?.email || '未知'}`);
    await loadStatus();
    await loadScripts();
    window.AppLogger?.info('Scripts', `已加载自动化业务脚本 ${state.scripts.length} 个`);
    if (state.tokenConfigured) {
      await loadDevices();
      window.AppLogger?.info('Devices', `已同步云机实例 ${state.devices.length} 台`);
    }
    renderPipelineStepper();
    await loadSharedRuntimeState();
    window.AppLogger?.info('Init', '控制台工作台初始化全部完成，就绪待命');
  } catch (fatalErr) {
    window.AppLogger?.error('Fatal', '控制台初始化异常中断: ' + fatalErr.message, { stack: fatalErr.stack });
    showToast('控制台初始化异常: ' + fatalErr.message);
    if (elements.tabTerminalSystem) elements.tabTerminalSystem.click();
  }
}

setInterval(loadSharedRuntimeState, 1500);

// 云手机操作大屏节点与设备状态后台轮询（每 3 秒自动静默刷新一次，节点变动无感同步，无需手动刷新网页）
setInterval(() => {
  if (state.tokenConfigured) {
    loadDevices(true);
  }
}, 3000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.tokenConfigured) {
    loadDevices(true);
  }
});

init();

