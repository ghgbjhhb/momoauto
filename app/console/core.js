'use strict';

// V3 控制台核心：外壳（侧栏/顶栏/路由/主题）、全局状态、API 与通用组件。
// 页面数据逻辑分布在 devices.js / scripts.js / ai-reply.js / momo-brain.js / session.js。

// 构建标记：改动前端后递增，用于确认浏览器加载的是否为新版（控制台输出 + window.YunMomoConsoleBuild）
window.YunMomoConsoleBuild = '20261102-device-actions-stable';
console.info(`[yunmomo-console] build ${window.YunMomoConsoleBuild}`);

// 全局防御：封杀浏览器原生 alert / confirm / prompt
window.alert = function (message) {
  if (typeof showToast === 'function') showToast(String(message));
  else console.warn('[Alert Blocked]:', message);
};
window.confirm = function () {
  console.warn('[Confirm Blocked - please use in-page modal]');
  return false;
};
window.prompt = function (message, defaultValue) { return defaultValue || ''; };

const isEmbedMode = location.search.includes('view=admin-embed');
document.body.classList.toggle('embed', isEmbedMode);

function getPageFromUrl() {
  const hash = String(location.hash || '').replace(/^#\/?/, '').trim().toLowerCase();
  if (['devices', 'tasks', 'messages', 'logs', 'settings'].includes(hash)) return hash;
  return 'overview';
}
window.getPageFromUrl = getPageFromUrl;

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
  devicesNavExpanded: (function() {
    try { return localStorage.getItem('yunmomo.nav.devicesExpanded') !== 'false'; } catch { return true; }
  })(),
  pageId: createPageId(),
  page: isEmbedMode ? 'overview' : getPageFromUrl(),
  view: 'single',
  theme: 'light',
  devices: [],
  selectedDeviceId: '',
  tokenConfigured: false,
  isAdmin: false,
  currentUser: null,
  scripts: [],
  bundles: [],
  visibility: { groups: {}, scripts: {} },
  runningScript: '',
  activeRun: null,
  activeBundleRun: null,
  activeWorkflowRun: null,
  batchDevices: [],
  batchRunning: false,
  batchStopRequested: false,
  taskScriptId: '',
  taskParamValues: {},
  previewPlayers: new Map(),
  previewRetry: new Map(),
  tileShots: new Map(),
  manualDeviceId: '',
  runtimeState: { runs: [], manualDevices: [] },
  runtimeStateStale: false,
  devicesStale: false,
  deviceProgress: (() => {
    try { return JSON.parse(localStorage.getItem('yunmomo.deviceProgress') || '{}'); }
    catch { return {}; }
  })(),
  logFeed: [],
  lastOutput: null,
  logTab: 'script'
};

const byId = id => document.getElementById(id);
window.byId = byId;
window.state = state;
window.isEmbedMode = isEmbedMode;

// 统一应用状态与事件总线
const eventBus = new EventTarget();
const AppStore = {
  get state() { return state; },
  getSelectedDeviceId() { return state.selectedDeviceId || state.devices[0]?.deviceId || ''; },
  setSelectedDeviceId(id) { if (typeof selectDevice === 'function') selectDevice(id); },
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
window.YunMomo = { store: AppStore, state, eventBus, api: { requestJson, showToast, copyToClipboard } };

// 动态安全元素访问代理，避免脚本加载时序导致 null 引用
const elements = new Proxy({}, {
  get(target, prop) {
    const cached = target[prop];
    if (cached && cached.isConnected) return cached;
    const el = byId(prop);
    if (el) target[prop] = el;
    return el;
  }
});
window.elements = elements;

/* ---------- 图标 ---------- */

const ICON_PATHS = {
  home: '<rect x="3" y="3" width="8" height="8" rx="1.3"/><rect x="13" y="3" width="8" height="8" rx="1.3"/><rect x="3" y="13" width="8" height="8" rx="1.3"/><rect x="13" y="13" width="8" height="8" rx="1.3"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  tasks: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 11 2 2 5-5M8 17h8"/>',
  message: '<path d="M21 11a8.5 8.5 0 0 1-8.5 8.5c-1.4 0-2.8-.4-4-1L3 21l2.5-5.1A8.5 8.5 0 1 1 21 11Z"/><path d="M8 10h9M8 14h6"/>',
  log: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M9 2h6l.8 2.6 2 1.2 2.6-.5 2.5 4.4-1.9 2v2.4l1.9 2-2.5 4.4-2.6-.5-2 1.2L15 22H9l-.8-2.6-2-1.2-2.6.5-2.5-4.4L3 12.2V10l-1.9-2L3.6 3.6l2.6.5 2-1.2L9 2Z"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  one: '<rect x="3" y="4" width="18" height="16" rx="2"/>',
  play: '<path d="m8 5 11 7-11 7V5Z"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 15a8 8 0 0 1-11-11 8.2 8.2 0 1 0 11 11Z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-5L4 8m0-5v5h5M4 13a8 8 0 0 0 14 5l2-2m0 5v-5h-5"/>',
  maximize: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  phoneDevice: '<rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M10 18h4"/>'
};

function ic(name, size = 17) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.home}</svg>`;
}
window.ic = ic;

/* ---------- 通用工具 ---------- */

async function copyToClipboard(text, successToast = '已复制到剪贴板') {
  if (!text) { showToast('没有可复制的内容'); return false; }
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(String(text));
      showToast(successToast);
      return true;
    } catch {
      return fallbackCopy(text, successToast);
    }
  }
  return fallbackCopy(text, successToast);
}
window.copyToClipboard = copyToClipboard;

function fallbackCopy(text, successToast) {
  const textarea = document.createElement('textarea');
  textarea.value = String(text);
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.setAttribute('readonly', '');
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy') === true;
  } catch { /* 浏览器拒绝写入剪贴板 */ }
  textarea.remove();
  showToast(copied ? successToast : '浏览器未允许复制，请检查剪贴板权限');
  return copied;
}

let sessionRecheck = null;

// 浏览器只使用 HttpOnly Cookie；出现 401 时复查会话，明确失效才退出。
// 网络抖动不主动清除正在执行的任务状态。
function revalidateSession() {
  if (sessionRecheck || isEmbedMode) return;
  sessionRecheck = (async () => {
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const res = await fetch('/api/auth/me');
      const data = await res.json().catch(() => ({}));
      if (!data.ok || !data.user) location.href = '/login.html';
    } catch { /* 网络抖动不在此处理，由轮询自行重试 */ }
    finally {
      setTimeout(() => { sessionRecheck = null; }, 5000);
    }
  })();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401 && !url.includes('/api/auth/')) {
    revalidateSession();
  }
  let payload = null;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(payload.error || '请求失败（HTTP ' + response.status + '）');
    error.status = response.status;
    error.durationMs = payload.durationMs;
    error.runId = payload.runId;
    throw error;
  }
  return payload;
}
window.requestJson = requestJson;

let toastTimer;
function showToast(message) {
  const el = elements.toast;
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}
window.showToast = showToast;

function setService(kind, text) {
  state.service = { kind, text };
  if (kind === 'error') showToast(text);
}

function createScriptRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
window.cleanScriptLines = cleanScriptLines;

function writeOutput(title, lines, meta = {}) {
  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const runId = meta.runId || state.activeRun?.id || '';
  const runIdPrefix = runId ? `[调用ID: ${runId}] ` : '';
  const header = `[${at}] ${runIdPrefix}${title}`;
  const cleanLines = Array.isArray(lines) ? lines.filter(Boolean) : [String(lines || '')];
  const logFile = meta.logFile || state.activeRun?.logFile || (runId ? `logs/runs/${runId}.log` : '');
  if (logFile && !cleanLines.some(l => l.includes(logFile))) {
    cleanLines.push(`[原始日志] ${logFile}`);
  }
  const text = header + '\n' + cleanLines.join('\n');
  const box = elements.outputBox;
  if (box) {
    box.textContent = text;
    box.scrollTop = box.scrollHeight;
  }
  const dockBox = elements.dockOutputBox;
  if (dockBox) {
    dockBox.textContent = text;
    dockBox.scrollTop = dockBox.scrollHeight;
  }
  state.lastOutput = { at, title, runId, logFile };
  state.logFeed = [{ at, title, runId }, ...state.logFeed].slice(0, 12);
  updateLogMeta();
  eventBus.dispatchEvent(new CustomEvent('output:changed'));
}
window.writeOutput = writeOutput;

function updateLogMeta() {
  const meta = elements.logMeta;
  const dockMeta = elements.dockLogMeta;
  const dockMiniHint = elements.dockMiniHint;
  const last = state.lastOutput;
  if (!last) {
    if (meta) meta.textContent = '';
    if (dockMeta) dockMeta.textContent = '';
    if (dockMiniHint) dockMiniHint.textContent = '暂无执行记录';
    return;
  }
  const text = `最近: ${last.title}` + (last.runId ? ` · 调用ID ${last.runId}` : '') + (last.logFile ? ` · ${last.logFile}` : '');
  if (meta) meta.textContent = text;
  if (dockMeta) dockMeta.textContent = text;
  if (dockMiniHint) dockMiniHint.textContent = last.title || '最近执行';
}

/* ---------- 设备基础判断 ---------- */

// 云机平台列表/详情接口均不返回稳定的 online/status 字段（实测恒为 null/undefined），
// 且租期未到的设备可正常推流与桥接。因此只有在平台明确上报离线时才判离线，
// 未上报状态一律按在线处理；真实不可达由直播流/脚本的连接错误兜底呈现。
function isExplicitOffline(device) {
  return device.online === false
    || device.status === 0 || device.status === '0'
    || device.status === 'offline';
}

function isOnline(device) {
  return !isExplicitOffline(device);
}

function shortDeviceId(device) {
  const id = String(device.deviceId || '');
  return id.length > 8 ? '…' + id.slice(-6) : id;
}

function deviceLabel(device) {
  return device.name + ' · ' + shortDeviceId(device);
}

function currentDevice() {
  return state.devices.find(device => device.deviceId === state.selectedDeviceId) || null;
}

window.isOnline = isOnline;
window.shortDeviceId = shortDeviceId;
window.deviceLabel = deviceLabel;
window.currentDevice = currentDevice;

function externalScriptForDevice(deviceId) {
  return state.runtimeState.runs.find(run => !run.currentPage && run.deviceId === deviceId) || null;
}

function manualWindowsForDevice(deviceId) {
  return state.runtimeState.manualDevices.find(item => item.deviceId === deviceId) || null;
}

function remoteRunForScript(script) {
  if (script.requiresDevice) {
    return state.runtimeState.runs.find(run => !run.currentPage && run.deviceId === state.selectedDeviceId) || null;
  }
  return state.runtimeState.runs.find(run => !run.currentPage && run.scriptId === script.id) || null;
}

window.externalScriptForDevice = externalScriptForDevice;
window.manualWindowsForDevice = manualWindowsForDevice;
window.remoteRunForScript = remoteRunForScript;

/* ---------- 确认弹窗 ---------- */

function showInPageConfirm({ title, message, okText = '确定', cancelText = '取消', isDanger = true, icon = '!' } = {}) {
  return new Promise(resolve => {
    const dialog = byId('userConfirmDialog');
    if (!dialog) return resolve(false);
    byId('userConfirmTitle').textContent = title;
    byId('userConfirmDesc').innerHTML = message;
    const okBtn = byId('userConfirmOkBtn');
    const cancelBtn = byId('userConfirmCancelBtn');
    const closeBtn = byId('userConfirmCloseBtn');
    okBtn.textContent = okText;
    okBtn.className = isDanger ? 'btn danger' : 'btn primary';

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
    const onKeyDown = e => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(false); }
    };
    const onBackdropClick = e => {
      const rect = dialog.getBoundingClientRect();
      const inDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height
        && rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
      if (!inDialog) { cleanup(); resolve(false); }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    dialog.addEventListener('keydown', onKeyDown);
    dialog.addEventListener('cancel', onCancel, { once: true });
    dialog.addEventListener('click', onBackdropClick);

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    (isDanger ? cancelBtn : okBtn)?.focus();
  });
}
window.showInPageConfirm = showInPageConfirm;

/* ---------- 静态区局部更新：避免轮询不断销毁可点击节点 ---------- */

// 仅适用于由调用方完整管理的区域：相同内容不重建 DOM，避免
// 轮询刚好落在 pointerdown/pointerup 之间导致点击丢失、焦点或滚动归零。
const lastRenderedMarkup = new WeakMap();
function renderMarkupIfChanged(element, html) {
  if (!element || lastRenderedMarkup.get(element) === html) return false;
  element.innerHTML = html;
  lastRenderedMarkup.set(element, html);
  return true;
}
window.renderMarkupIfChanged = renderMarkupIfChanged;

/* ---------- 外壳渲染（侧栏 / 顶栏 / 路由 / 主题） ---------- */

const NAVS = [
  ['overview', '总览', 'home'],
  ['devices', '设备', 'phoneDevice'],
  ['tasks', '任务', 'tasks'],
  ['messages', '消息回复设置', 'message'],
  ['logs', '运行日志', 'log'],
  ['settings', '设置', 'settings']
];

function navButtonHtml(page, title, icon) {
  return `<button class="nav-btn ${state.page === page ? 'active' : ''}" data-goto="${page}" type="button" aria-label="${title}"><div class="nav-btn-main">${ic(icon, 18)}<span>${title}</span></div></button>`;
}

function navDevicesGroupHtml() {
  const expanded = Boolean(state.devicesNavExpanded);
  const total = (state.devices || []).length;
  const isDevicesActive = state.page === 'devices' || state.page === 'overview';

  const subItems = (state.devices || []).map(device => {
    const isSelected = state.selectedDeviceId === device.deviceId;
    const statusKey = typeof window.deviceStatusKey === 'function' ? window.deviceStatusKey(device) : (device.online ? 'online' : 'down');
    const statusText = typeof window.STATUS_TEXT !== 'undefined' ? (window.STATUS_TEXT[statusKey] || '在线') : '在线';
    const indexLabel = typeof window.deviceIndexLabel === 'function' ? window.deviceIndexLabel(device) : '#01';
    return `
      <button class="nav-sub-item ${isSelected ? 'active' : ''}" data-nav-device="${escapeHtml(device.deviceId)}" type="button" title="${escapeHtml(device.name || device.deviceId)}">
        <div class="nav-sub-left">
          <span class="nav-sub-dot ${statusKey === 'busy' ? 'running' : statusKey === 'online' ? 'online' : 'offline'}"></span>
          <span class="nav-sub-name">${indexLabel} ${escapeHtml(device.name)}</span>
        </div>
        <span class="nav-sub-status">${statusText}</span>
      </button>
    `;
  }).join('');

  return `
    <div class="nav-item-group">
      <button class="nav-btn ${isDevicesActive ? 'active' : ''}" data-nav-toggle-devices type="button" aria-label="设备">
        <div class="nav-btn-main">
          ${ic('phoneDevice', 18)}
          <span>设备</span>
        </div>
        <div class="nav-btn-tail">
          <span class="nav-count-badge">${total}</span>
          <span class="nav-chevron-icon ${expanded ? 'expanded' : ''}">${ic('chevron', 13)}</span>
        </div>
      </button>
      <div class="nav-sub-list ${expanded ? '' : 'collapsed'}" id="navDevicesSubList">
        ${subItems || '<div class="hint" style="font-size:11px; padding:4px 8px;">暂无云机</div>'}
      </div>
    </div>
  `;
}

function renderShell() {
  const navHtml = NAVS.map(([p, t, i]) => {
    if (p === 'devices') return navDevicesGroupHtml();
    return navButtonHtml(p, t, i);
  }).join('');
  const nav = elements.navMenu;
  renderMarkupIfChanged(nav, navHtml);
  const embedNav = elements.embedNav;
  // Embedded mode uses the regular vertical sidebar; no duplicated top menu.
  renderMarkupIfChanged(embedNav, '');
  const crumb = elements.breadcrumb;
  if (crumb) {
    const name = NAVS.find(x => x[0] === state.page)?.[1] || '总览';
    renderMarkupIfChanged(crumb, `工作台 ${ic('chevron', 13)} <strong>${escapeHtml(name)}</strong>`);
  }
  const themeBtn = elements.themeToggleBtn;
  renderMarkupIfChanged(themeBtn, ic(state.theme === 'dark' ? 'sun' : 'moon', 18));
  const refreshBtn = elements.refreshDevices;
  renderMarkupIfChanged(refreshBtn, ic('refresh', 18));
  const brandMark = elements.brandMark;
  renderMarkupIfChanged(brandMark, ic('phone', 20));
}

function setPage(page, { updateHash = true } = {}) {
  if (!NAVS.some(x => x[0] === page)) page = 'overview';
  state.page = page;

  if (updateHash && !isEmbedMode) {
    const targetHash = page === 'overview' ? '#overview' : '#' + page;
    if (location.hash !== targetHash) {
      try { history.replaceState(null, '', targetHash); }
      catch { location.hash = targetHash; }
    }
  }

  if (page === 'overview') {
    // 聚焦总览实时操控与任务工作台
    for (const section of document.querySelectorAll('.page-section')) {
      section.hidden = section.id !== 'page-overview';
    }
    renderShell();
    eventBus.dispatchEvent(new CustomEvent('page:changed', { detail: { page } }));
    return;
  }

  for (const section of document.querySelectorAll('.page-section')) {
    section.hidden = section.id !== 'page-' + page;
  }
  renderShell();
  eventBus.dispatchEvent(new CustomEvent('page:changed', { detail: { page } }));
}
window.setPage = setPage;

window.addEventListener('hashchange', () => {
  if (isEmbedMode) return;
  const target = getPageFromUrl();
  if (target !== state.page) {
    setPage(target, { updateHash: false });
  }
});

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);
  try { localStorage.setItem('yunmomo.theme', state.theme); } catch {}
  renderShell();
  const settingsThemeBtn = byId('settingsThemeBtn');
  if (settingsThemeBtn) settingsThemeBtn.textContent = state.theme === 'dark' ? '切换浅色' : '切换深色';
  eventBus.dispatchEvent(new CustomEvent('theme:changed', { detail: { theme: state.theme } }));
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
}
window.toggleTheme = toggleTheme;

function initTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem('yunmomo.theme') || 'light'; } catch {}
  state.theme = saved === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);
}

/* ---------- 全局交互 ---------- */

document.addEventListener('click', event => {
  const toggleDevices = event.target.closest('[data-nav-toggle-devices]');
  if (toggleDevices) {
    state.devicesNavExpanded = !state.devicesNavExpanded;
    try { localStorage.setItem('yunmomo.nav.devicesExpanded', state.devicesNavExpanded ? 'true' : 'false'); } catch {}
    setPage('overview');
    renderShell();
    return;
  }

  const navDevice = event.target.closest('[data-nav-device]');
  if (navDevice) {
    const deviceId = navDevice.dataset.navDevice;
    if (typeof window.selectDevice === 'function') {
      window.selectDevice(deviceId);
    }
    if (state.page !== 'overview') {
      setPage('overview');
    } else {
      renderShell();
    }
    return;
  }

  const button = event.target.closest('button, a.btn');
  if (!button) return;
  const goto = button.dataset.goto;
  if (goto) { setPage(goto); return; }
  const view = button.dataset.view;
  if (view && button.closest('#viewToggle')) {
    state.view = view;
    for (const seg of document.querySelectorAll('#viewToggle .segment')) {
      seg.classList.toggle('active', seg.dataset.view === view);
    }
    renderViewer();
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      if (dialog.id === 'controlDialog') continue;
      try { dialog.close(); } catch {}
    }
  }
});

setInterval(() => {
  if (state.page === 'overview') renderRecentActivity();
}, 5000);
