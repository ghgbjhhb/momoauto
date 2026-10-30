'use strict';

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
