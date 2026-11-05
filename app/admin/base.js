'use strict';

'use strict';

// 全局防御：彻底封杀浏览器原生的 alert, confirm, prompt，无缝重定向到优雅的 Toast 与自研模态框
window.alert = function (message) {
  if (typeof showToast === 'function') {
    showToast(String(message), 'info');
  } else {
    console.warn('[Alert Blocked]:', message);
  }
};
window.confirm = function (message) {
  console.warn('[Confirm Blocked - please use showConfirm]:', message);
  return false;
};
window.prompt = function (message, defaultValue) {
  console.warn('[Prompt Blocked]:', message);
  return defaultValue || '';
};

let currentUser = null;
let adminAuthorized = false;
let currentTab = 'cluster';

// Tab Configuration & Subpage Routing
const TAB_CONFIG = {
  cluster: { title: '设备控制台', group: '设备与资源', desc: '集中查看与操作云机，统一管理设备任务。', path: '/admin/cluster' },
  pool: { title: '设备池与分配', group: '设备与资源', desc: '管理设备库存、分配状态与用户租约。', path: '/admin/pool' },
  disk: { title: '资源云盘', group: '设备与资源', desc: '管理真参、头像及业务所需资源文件。', path: '/admin/disk' },
  users: { title: '用户管理', group: '用户与运营', desc: '查看账号、权限状态及关联权益。', path: '/admin/users' },
  cards: { title: '卡密与权益', group: '用户与运营', desc: '生成、查询和管理兑换卡密及权益。', path: '/admin/cards' },
  sms: { title: '接码平台', group: '用户与运营', desc: '统一维护接码配置和调用记录。', path: '/admin/sms' },
  assistant: { title: 'AI 调试对话', group: 'AI 工作台', desc: '独立测试提示词、模型、思考强度与意图结果。', path: '/admin/assistant' },
  ai: { title: '模型与供应商', group: 'AI 工作台', desc: '配置 AI 服务商、模型和全局回复参数。', path: '/admin/ai' },
  logs: { title: '系统运行日志', group: '运行维护', desc: '排查请求、任务运行和异常记录。', path: '/admin/logs' },
};

// DOM Elements
const adminUserEmail = document.getElementById('adminUserEmail');
const adminLogoutBtn = document.getElementById('adminLogoutBtn');
const navItems = document.querySelectorAll('.nav-item');
const tabContents = document.querySelectorAll('.tab-content');
const navErrorBadge = document.getElementById('navErrorBadge');

// Users DOM
const statUsersCount = document.getElementById('statUsersCount');
const statActiveUsersCount = document.getElementById('statActiveUsersCount');
const statBannedUsersCount = document.getElementById('statBannedUsersCount');
const usersTableBody = document.getElementById('usersTableBody');
const refreshUsersBtn = document.getElementById('refreshUsersBtn');

// Cards DOM
const generateCardsForm = document.getElementById('generateCardsForm');
const benefitCheckCloud = document.getElementById('benefitCheckCloud');
const benefitCheckZhencan = document.getElementById('benefitCheckZhencan');
const benefitCheckIp = document.getElementById('benefitCheckIp');
const cardDurationDays = document.getElementById('cardDurationDays');
const cardZhencanCount = document.getElementById('cardZhencanCount');
const cardIpDays = document.getElementById('cardIpDays');
const cardCount = document.getElementById('cardCount');
const cardBatchTag = document.getElementById('cardBatchTag');
const cardFilterType = document.getElementById('cardFilterType');
const cardFilterStatus = document.getElementById('cardFilterStatus');
const refreshCardsBtn = document.getElementById('refreshCardsBtn');
const cardsTableBody = document.getElementById('cardsTableBody');
const cardsResultModal = document.getElementById('cardsResultModal');
const closeCardsModalBtn = document.getElementById('closeCardsModalBtn');
const batchCardsOutput = document.getElementById('batchCardsOutput');
const copyAllCardsBtn = document.getElementById('copyAllCardsBtn');
const downloadCardsTxtBtn = document.getElementById('downloadCardsTxtBtn');

// Pool DOM
const statPoolTotal = document.getElementById('statPoolTotal');
const statPoolAllocated = document.getElementById('statPoolAllocated');
const statPoolIdle = document.getElementById('statPoolIdle');
const poolTableBody = document.getElementById('poolTableBody');
const refreshPoolBtn = document.getElementById('refreshPoolBtn');

// Logs DOM
const adminTerminalOutput = document.getElementById('adminTerminalOutput');
const adminLogViewport = document.getElementById('adminLogViewport');
const adminLogSearch = document.getElementById('adminLogSearch');
const clearAdminLogSearchBtn = document.getElementById('clearAdminLogSearchBtn');
const adminLogAutoScroll = document.getElementById('adminLogAutoScroll');
const adminLogCopyBtn = document.getElementById('adminLogCopyBtn');
const adminLogClearBtn = document.getElementById('adminLogClearBtn');
const adminLogRefreshBtn = document.getElementById('adminLogRefreshBtn');
const logLevelButtons = document.querySelectorAll('.log-level-btn');

let activeLogLevel = 'ALL';
let allSystemLogs = [];
let logPollTimer = null;

function formatDate(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatRemaining(ms) {
  if (!ms || ms <= 0) return '<span style="color:#ff4d4f; font-weight:600;">已到期</span>';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- 全局通用 Toast 浮动提示条 (轻量无感，不阻断操作，Ant Design 现代微型浮条) ---
let toastTimer = null;
function showToast(message, type = 'info', duration = 2200) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.className = 'toast visible';
  if (type === 'success') {
    toast.classList.add('success');
    toast.innerHTML = `<span style="color:#52c41a; font-size:15px; font-weight:700; line-height:1; display:inline-flex;">✓</span> <span>${escapeHtml(message)}</span>`;
  } else if (type === 'error') {
    toast.classList.add('error');
    toast.innerHTML = `<span style="color:#ff4d4f; font-size:15px; font-weight:700; line-height:1; display:inline-flex;">✕</span> <span>${escapeHtml(message)}</span>`;
  } else {
    toast.innerHTML = `<span style="color:#1677ff; font-size:15px; line-height:1; display:inline-flex;">ℹ</span> <span>${escapeHtml(message)}</span>`;
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
  }, duration);
}

// 统一确认框：取消操作优先聚焦，并将交互限制在当前对话框内。
// 参考 Radix AlertDialog 的交互语义，不引入额外前端依赖。
let adminConfirmOpen = false;
function showConfirm({ title = '确认操作', desc = '', okText = '确定', cancelText = '取消', isDanger = true, icon = '⚠️' } = {}) {
  if (adminConfirmOpen) return Promise.resolve(false);
  const modal = document.getElementById('adminConfirmModal');
  const titleEl = document.getElementById('confirmModalTitle');
  const descEl = document.getElementById('confirmModalDesc');
  const okBtn = document.getElementById('confirmModalOkBtn');
  const cancelBtn = document.getElementById('confirmModalCancelBtn');
  const iconEl = document.getElementById('confirmModalIcon');
  if (!modal || !titleEl || !descEl || !okBtn || !cancelBtn || !iconEl) return Promise.resolve(false);

  adminConfirmOpen = true;
  const origin = document.activeElement;
  titleEl.textContent = title;
  // desc 由内部调用者构造，所有可变文件名、邮箱等文本必须先 escapeHtml。
  descEl.innerHTML = desc;
  okBtn.textContent = okText;
  cancelBtn.textContent = cancelText;
  iconEl.textContent = icon;
  modal.dataset.variant = isDanger ? 'danger' : 'primary';

  return new Promise(resolve => {
    let settled = false;
    const cleanup = result => {
      if (settled) return;
      settled = true;
      modal.style.display = 'none';
      delete modal.dataset.variant;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeyDown);
      adminConfirmOpen = false;
      if (origin?.isConnected && typeof origin.focus === 'function') origin.focus();
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = event => {
      if (event.target === modal) cleanup(false);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(false);
      } else if (event.key === 'Tab') {
        // 目前只有两个可聚焦按钮，维持循环，不让 Tab 移到遮罩下的删除操作。
        if (event.shiftKey && document.activeElement === cancelBtn) {
          event.preventDefault();
          okBtn.focus();
        } else if (!event.shiftKey && document.activeElement === okBtn) {
          event.preventDefault();
          cancelBtn.focus();
        }
      }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKeyDown);
    modal.style.display = 'flex';
    cancelBtn.focus();
  });
}

// 独立的只读请求通道：新请求到来时取消旧请求，防止旧筛选结果覆盖新页面。
function createAdminLatestRequest() {
  let sequence = 0;
  let controller = null;
  return {
    start() {
      controller?.abort();
      controller = new AbortController();
      const requestId = ++sequence;
      return {
        signal: controller.signal,
        isCurrent: () => requestId === sequence
      };
    },
    cancel() {
      ++sequence;
      controller?.abort();
      controller = null;
    }
  };
}

// 有副作用的管理请求以目标对象为键，只允许同一操作一个未完成请求。
// 不能用取消 POST/DELETE 的方式防重：取消连接并不保证服务端停止执行。
const adminWriteGuard = (() => {
  const pending = new Set();
  return {
    isPending: key => pending.has(key),
    begin(key) {
      if (pending.has(key)) return false;
      pending.add(key);
      return true;
    },
    end: key => pending.delete(key)
  };
})();

// 1. Auth check
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (!data.ok || !data.user || data.user.role !== 'admin') {
      location.href = '/login.html';
      return false;
    }
    currentUser = data.user;
    adminAuthorized = true;
    try { localStorage.removeItem('yunmomo.auth_token'); } catch {}
    if (adminUserEmail) {
      adminUserEmail.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>管理员: ${escapeHtml(currentUser.email)}</span>
      `;
    }
    return true;
  } catch {
    location.href = '/login.html';
    return false;
  }
}

// 2. Subpage URL Router
function getTabFromUrl() {
  const pathname = window.location.pathname.toLowerCase().replace(/\/+$/, '');
  for (const key of Object.keys(TAB_CONFIG)) {
    if (pathname.endsWith('/' + key) || pathname === '/admin/' + key) return key;
  }
  const hash = (window.location.hash || '').replace('#', '').toLowerCase();
  if (TAB_CONFIG[hash]) return hash;
  return 'cluster';
}

function switchTab(targetTab, { updateHistory = true } = {}) {
  if (!adminAuthorized) return;
  if (!TAB_CONFIG[targetTab]) targetTab = 'cluster';
  currentTab = targetTab;
  // One stable navigation tree: the selected page is the active left tab.
  navItems.forEach(item => {
    const isActive = item.getAttribute('data-tab') === targetTab;
    item.classList.toggle('active', isActive);
    if (isActive) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  // Update Tab Content Sections
  tabContents.forEach(section => {
    const tabKey = section.id.replace('tab-', '');
    section.classList.toggle('active', tabKey === targetTab);
  });

  // Update Browser Address & Title
  const config = TAB_CONFIG[targetTab];
  document.title = `${config.title} - momo全托管后台`;
  const pageTitle = document.getElementById('adminPageTitle');
  const pageDescription = document.getElementById('adminPageDescription');
  const pageGroup = document.getElementById('adminPageGroup');
  if (pageTitle) pageTitle.textContent = config.title;
  if (pageDescription) pageDescription.textContent = config.desc;
  if (pageGroup) pageGroup.textContent = config.group;
  const activeLink = document.querySelector('.admin-sidebar .nav-item.active');
  const activeGroup = activeLink?.closest('.admin-nav-group');
  document.querySelectorAll('.admin-nav-group').forEach(group => {
    group.open = group === activeGroup;
  });
  const shell = document.getElementById('adminShell');
  shell?.classList.remove('is-nav-open');
  document.getElementById('adminMenuToggle')?.setAttribute('aria-expanded', 'false');
  if (updateHistory && window.location.pathname !== config.path) {
    history.pushState({ tab: targetTab }, '', config.path);
  }

  // Trigger Data Loaders
  if (targetTab === 'disk') loadAdminDisk();
  else if (targetTab === 'ai') loadAdminAiSettings();
  else if (targetTab === 'assistant') initAdminAiDebug();
  else if (targetTab === 'sms') loadSmsManagement();
  else if (targetTab === 'users') loadUsers();
  else if (targetTab === 'cards') loadCards();
  else if (targetTab === 'pool') loadPool();
  else if (targetTab === 'logs') {
    getSanitizedLogSearch();
    syncAdminLogSearchClearBtn();
    renderSystemLogs();
    fetchServerLogs();
  }
}

// Each original administrator route stays independently addressable in the left menu.
function adminNavigate(tab) {
  switchTab(tab);
}
window.adminNavigate = adminNavigate;

window.adminOpenDevice = deviceId => {
  if (!adminAuthorized || !deviceId) return;
  adminNavigate('cluster');
  const frame = document.getElementById('clusterIframe');
  const select = () => {
    try {
      const app = frame?.contentWindow;
      const store = app?.YunMomo?.store;
      if (!store) {
        showToast('控制台还未完成初始化，请稍后在设备列表选择', 'error');
        return;
      }
      const devices = store.getDevices();
      if (devices.some(device => device.deviceId === deviceId)) {
        app.setPage?.('overview');
        app.selectDevice(deviceId);
        return;
      }
      if (devices.length) {
        showToast('目标设备未出现在控制台列表中，请刷新设备检查', 'error');
        return;
      }
      // 首次加载尚未拿到云机列表时，等实际加载事件再选择，避免静默失败。
      app.YunMomo.eventBus.addEventListener('devices:changed', () => {
        const latest = store.getDevices();
        if (latest.some(device => device.deviceId === deviceId)) {
          app.setPage?.('overview');
          app.selectDevice(deviceId);
        } else {
          showToast('目标设备未出现在控制台列表中', 'error');
        }
      }, { once: true });
    } catch {
      showToast('设备控制台尚未就绪，请在控制台选择设备', 'error');
    }
  };
  if (frame?.contentWindow?.YunMomo?.store) select();
  else frame?.addEventListener('load', select, { once: true });
};
window.adminOpenPoolDevice = deviceId => {
  if (!adminAuthorized) return;
  window.adminPendingPoolDeviceId = deviceId;
  adminNavigate('pool');
};
window.adminOpenDiskDevice = deviceId => {
  if (!adminAuthorized) return;
  window.adminRequestedDeviceId = deviceId;
  adminNavigate('disk');
};

// Navigation Click Handling
navItems.forEach(item => {
  item.addEventListener('click', event => {
    event.preventDefault();
    const targetTab = item.getAttribute('data-tab');
    if (adminAuthorized) switchTab(targetTab, { updateHistory: true });
  });
});

// Responsive navigation uses the same nine existing routes, without a
// second mobile menu or duplicate sidebar handlers.
const adminShell = document.getElementById('adminShell');
const adminMenuToggle = document.getElementById('adminMenuToggle');
const closeAdminMobileNav = () => {
  adminShell?.classList.remove('is-nav-open');
  adminMenuToggle?.setAttribute('aria-expanded', 'false');
};
adminMenuToggle?.addEventListener('click', () => {
  const next = !adminShell?.classList.contains('is-nav-open');
  adminShell?.classList.toggle('is-nav-open', next);
  adminMenuToggle.setAttribute('aria-expanded', String(next));
});
document.getElementById('adminNavBackdrop')?.addEventListener('click', closeAdminMobileNav);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeAdminMobileNav();
});
document.querySelectorAll('[data-admin-link]').forEach(item => {
  item.addEventListener('click', event => {
    if (!adminAuthorized) return;
    event.preventDefault();
    switchTab(item.getAttribute('data-admin-link'));
  });
});

// Popstate (Browser Back / Forward)
window.addEventListener('popstate', () => {
  if (adminAuthorized) switchTab(getTabFromUrl(), { updateHistory: false });
});

// Logout
if (adminLogoutBtn) {
  adminLogoutBtn.addEventListener('click', async () => {
    const confirmed = await showConfirm({
      title: '确认退出登录？',
      desc: '退出后需要重新输入管理员账号与密码方可访问后台。',
      okText: '退出登录',
      isDanger: false,
      icon: '🚪'
    });
    if (!confirmed) return;
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('退出请求失败');
      localStorage.removeItem('yunmomo.auth_token');
      location.href = '/login.html';
    } catch {
      showToast('无法确认退出登录，请检查网络后重试', 'error');
    }
  });
}

// 修改当前账号密码
const adminPasswordBtn = document.getElementById('adminPasswordBtn');
const adminPasswordModal = document.getElementById('adminPasswordModal');
if (adminPasswordBtn && adminPasswordModal) {
  const currentInput = document.getElementById('pwdCurrentInput');
  const newInput = document.getElementById('pwdNewInput');
  const confirmInput = document.getElementById('pwdConfirmInput');
  const errorBox = document.getElementById('pwdModalError');
  const okBtn = document.getElementById('pwdModalOkBtn');
  const cancelBtn = document.getElementById('pwdModalCancelBtn');

  const closePasswordModal = () => {
    adminPasswordModal.style.display = 'none';
    [currentInput, newInput, confirmInput].forEach(input => { if (input) input.value = ''; });
    if (errorBox) errorBox.textContent = '';
  };

  adminPasswordBtn.addEventListener('click', () => {
    adminPasswordModal.style.display = 'flex';
    if (currentInput) currentInput.focus();
  });
  if (cancelBtn) cancelBtn.addEventListener('click', closePasswordModal);

  if (okBtn) {
    okBtn.addEventListener('click', async () => {
      const currentPassword = currentInput?.value || '';
      const newPassword = newInput?.value || '';
      if (newPassword.length < 8) {
        if (errorBox) errorBox.textContent = '新密码长度至少需要 8 位';
        return;
      }
      if (newPassword !== confirmInput?.value) {
        if (errorBox) errorBox.textContent = '两次输入的新密码不一致';
        return;
      }
      okBtn.disabled = true;
      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || '密码修改失败');
        showToast('密码已更新，即将跳转到登录页…', 'success');
        setTimeout(() => { location.href = '/login.html'; }, 1200);
      } catch (err) {
        if (errorBox) errorBox.textContent = err.message;
        okBtn.disabled = false;
      }
    });
  }
}


function debounce(fn, delay = 300) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
