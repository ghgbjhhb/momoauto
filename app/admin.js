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
let currentTab = 'cluster';

// Tab Configuration & Subpage Routing
const TAB_CONFIG = {
  cluster: { title: '设备集群与控制台', path: '/admin/cluster' },
  disk: { title: '资源云盘 (真参/头像)', path: '/admin/disk' },
  users: { title: '用户管理', path: '/admin/users' },
  cards: { title: '卡密生成与分发', path: '/admin/cards' },
  pool: { title: '设备池调度映射', path: '/admin/pool' },
  ai: { title: 'AI全局设置', path: '/admin/ai' },
  logs: { title: '系统运行日志', path: '/admin/logs' },
  sms: { title: '接码平台管理 (玄武API)', path: '/admin/sms' },
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

// --- 全局风格一致的模态确认窗口 (替换丑陋且不搭调的原生 confirm) ---
function showConfirm({ title = '确认操作', desc = '', okText = '确定', cancelText = '取消', isDanger = true, icon = '⚠️' } = {}) {
  return new Promise(resolve => {
    const modal = document.getElementById('adminConfirmModal');
    const titleEl = document.getElementById('confirmModalTitle');
    const descEl = document.getElementById('confirmModalDesc');
    const okBtn = document.getElementById('confirmModalOkBtn');
    const cancelBtn = document.getElementById('confirmModalCancelBtn');
    const iconEl = document.getElementById('confirmModalIcon');

    if (!modal) return resolve(false);

    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.innerHTML = desc;
    if (okBtn) {
      okBtn.textContent = okText;
      okBtn.className = `btn-action-sm ${isDanger ? 'danger' : ''}`;
      if (isDanger) {
        okBtn.style.background = '#ff4d4f';
        okBtn.style.color = '#ffffff';
        okBtn.style.borderColor = '#ff4d4f';
      } else {
        okBtn.style.background = '#1677ff';
        okBtn.style.color = '#ffffff';
        okBtn.style.borderColor = '#1677ff';
      }
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;
    if (iconEl) {
      iconEl.textContent = icon;
      iconEl.style.background = isDanger ? '#fff2f0' : '#e6f4ff';
      iconEl.style.borderColor = isDanger ? '#ffccc7' : '#91caff';
      iconEl.style.color = isDanger ? '#ff4d4f' : '#1677ff';
    }

    modal.style.display = 'flex';

    const cleanup = () => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
    };

    const onOk = () => {
      cleanup();
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    const onBackdrop = (e) => {
      if (e.target === modal) {
        cleanup();
        resolve(false);
      }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
  });
}

// 1. Auth check
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (!data.ok || !data.user || data.user.role !== 'admin') {
      location.href = '/login.html';
      return;
    }
    currentUser = data.user;
    if (adminUserEmail) {
      adminUserEmail.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span>管理员: ${escapeHtml(currentUser.email)}</span>
      `;
    }
  } catch {
    location.href = '/login.html';
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
  if (!TAB_CONFIG[targetTab]) targetTab = 'cluster';
  currentTab = targetTab;

  // Update Sidebar
  navItems.forEach(item => {
    const tabKey = item.getAttribute('data-tab');
    item.classList.toggle('active', tabKey === targetTab);
  });

  // Update Tab Content Sections
  tabContents.forEach(section => {
    const tabKey = section.id.replace('tab-', '');
    section.classList.toggle('active', tabKey === targetTab);
  });

  // Update Browser Address & Title
  const config = TAB_CONFIG[targetTab];
  document.title = `${config.title} - momo全托管后台`;
  if (updateHistory && window.location.pathname !== config.path) {
    history.pushState({ tab: targetTab }, '', config.path);
  }

  // Trigger Data Loaders
  if (targetTab === 'disk') loadAdminDisk();
  else if (targetTab === 'ai') loadAdminAiSettings();
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

// Navigation Click Handling
navItems.forEach(item => {
  item.addEventListener('click', event => {
    event.preventDefault();
    const targetTab = item.getAttribute('data-tab');
    switchTab(targetTab, { updateHistory: true });
  });
});

// Popstate (Browser Back / Forward)
window.addEventListener('popstate', () => {
  switchTab(getTabFromUrl(), { updateHistory: false });
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
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
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

// 3. Users Management
async function loadUsers() {
  if (!usersTableBody) return;
  usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:#8c8c8c;">正在加载用户列表…</td></tr>';
  try {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const users = data.users || [];
    if (statUsersCount) statUsersCount.textContent = users.length;
    if (statActiveUsersCount) statActiveUsersCount.textContent = users.filter(u => u.status === 'active').length;
    if (statBannedUsersCount) statBannedUsersCount.textContent = users.filter(u => u.status === 'banned').length;

    if (users.length === 0) {
      usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:#8c8c8c;">暂无注册用户</td></tr>';
      return;
    }

    usersTableBody.innerHTML = users.map(u => `
      <tr>
        <td><strong style="color:#1f1f1f;">${escapeHtml(u.email)}</strong></td>
        <td><span class="admin-tag" style="background:#f5f5f5; border-color:#d9d9d9; color:#595959;">${u.role === 'admin' ? '超级管理员' : '普通用户'}</span></td>
        <td>
          <span class="badge-status ${u.status === 'active' ? 'active' : 'banned'}">
            ${u.status === 'active' ? '正常' : '已封禁'}
          </span>
        </td>
        <td><strong style="color:#1677ff;">${u.active_devices || 0}</strong> 台</td>
        <td>${formatDate(u.created_at)}</td>
        <td>
          ${u.role === 'admin' ? '<span style="color:#8c8c8c; font-size:12px;">主账号 (不可操作)</span>' : `
            <button class="btn-action-sm ${u.status === 'active' ? 'danger' : ''}" onclick="toggleUserStatus('${u.id}', '${u.status === 'active' ? 'banned' : 'active'}', '${escapeHtml(u.email)}')">
              ${u.status === 'active' ? '封禁' : '解封'}
            </button>
          `}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    usersTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#ff4d4f; padding:30px;">加载失败: ${escapeHtml(err.message)}</td></tr>`;
  }
}

window.toggleUserStatus = async (userId, targetStatus, userEmail = '') => {
  const isBan = targetStatus === 'banned';
  const confirmed = await showConfirm({
    title: isBan ? '确认封禁该用户？' : '确认解封该用户？',
    desc: `确认要将用户 <strong style="color:#1f1f1f;">${escapeHtml(userEmail || userId)}</strong> 的状态变更为【<strong>${isBan ? '封禁' : '解封'}</strong>】吗？${isBan ? '<br><span style="color:#cf1322; font-size:12.5px;">封禁后该用户将无法登录系统和操作名下云机。</span>' : ''}`,
    okText: isBan ? '确认封禁' : '确认解封',
    cancelText: '取消',
    isDanger: isBan,
    icon: isBan ? '🚫' : '🔓'
  });

  if (!confirmed) return;
  try {
    const res = await fetch('/api/admin/users/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, status: targetStatus })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    showToast(`已成功${isBan ? '封禁' : '解封'}该用户`, 'success');
    loadUsers();
  } catch (err) {
    showToast(`操作失败: ${err.message}`, 'error');
  }
};

if (refreshUsersBtn) refreshUsersBtn.addEventListener('click', loadUsers);

// 4. Cards Management (正常人直觉逻辑：简单、清晰、无废话)
function updateBenefitUI() {
  const isCloud = Boolean(benefitCheckCloud?.checked);
  const isZhencan = Boolean(benefitCheckZhencan?.checked);
  const isIp = Boolean(benefitCheckIp?.checked);

  if (cardDurationDays) cardDurationDays.disabled = !isCloud;
  if (cardZhencanCount) cardZhencanCount.disabled = !isZhencan;
  if (cardIpDays) cardIpDays.disabled = !isIp;
}

[benefitCheckCloud, benefitCheckZhencan, benefitCheckIp].forEach(cb => {
  if (cb) cb.addEventListener('change', updateBenefitUI);
});
updateBenefitUI();

async function loadCards() {
  if (!cardsTableBody) return;
  cardsTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:#8c8c8c;">正在加载卡密列表…</td></tr>';
  try {
    const status = cardFilterStatus ? cardFilterStatus.value : '';
    const type = cardFilterType ? cardFilterType.value : '';
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (type) params.set('type', type);

    const res = await fetch(`/api/admin/cards?${params.toString()}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const cards = data.cards || [];
    if (cards.length === 0) {
      cardsTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:#8c8c8c;">未查找到符合条件的卡密</td></tr>';
      return;
    }

    cardsTableBody.innerHTML = cards.map(c => {
      // 解析类别与权益内容
      let types = ['cloud'];
      if (c.card_types) {
        try {
          const parsed = JSON.parse(c.card_types);
          if (Array.isArray(parsed) && parsed.length > 0) types = parsed;
        } catch {}
      }

      let contents = {};
      if (c.card_contents) {
        try {
          contents = JSON.parse(c.card_contents) || {};
        } catch {}
      }

      const badges = [];
      if (types.includes('cloud')) {
        const cDays = contents.cloud?.durationDays ?? c.duration_days ?? 0;
        const durText = `${cDays || 0}天`;
        badges.push(`<span class="benefit-badge cloud">云机: ${durText}</span>`);
      }
      if (types.includes('zhencan')) {
        const count = contents.zhencan?.count || 10;
        badges.push(`<span class="benefit-badge zhencan">真参: ${count}套</span>`);
      }
      if (types.includes('ip')) {
        const ipDays = contents.ip?.durationDays || 30;
        badges.push(`<span class="benefit-badge ip">IP: ${ipDays}天</span>`);
      }

      // 如果没有任何匹配标签（如老数据），显示时长
      if (badges.length === 0) {
        const oldText = `${c.duration_days || 0}天`;
        badges.push(`<span class="benefit-badge cloud">云机: ${oldText}</span>`);
      }

      const contentDisplay = `<div class="benefit-badge-group">${badges.join('')}</div>`;

      let statusText = '未使用';
      if (c.status === 'used') statusText = '已使用';
      else if (c.status === 'revoked') statusText = '已作废';

      return `
        <tr>
          <td><code style="color:#1677ff; font-weight:700; cursor:pointer;" title="点击复制" onclick="copyCardCode('${c.card_code}')">${c.card_code}</code></td>
          <td>${contentDisplay}</td>
          <td><span class="badge-status ${c.status}">${statusText}</span></td>
          <td>${escapeHtml(c.batch_tag || '--')}</td>
          <td>${formatDate(c.created_at)}</td>
          <td>${c.used_by_email ? escapeHtml(c.used_by_email) : '--'}</td>
          <td>${formatDate(c.used_at)}</td>
          <td>
            ${c.status === 'unused' ? `
              <button class="btn-action-sm danger" onclick="revokeCard('${c.id}', '${c.card_code}')">作废</button>
            ` : '<span style="color:#8c8c8c;">--</span>'}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    cardsTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#ff4d4f; padding:30px;">加载失败: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// 通用剪贴板复制封装（优先 Clipboard API，优雅降级为离屏 textarea execCommand）
async function copyToClipboard(text, successMsg = '已成功复制到剪贴板！') {
  if (!text) {
    showToast('暂无内容可复制', 'error');
    return false;
  }
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      showToast(successMsg, 'success');
      return true;
    }
  } catch {}

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) {
      showToast(successMsg, 'success');
      return true;
    }
  } catch {}

  showToast('复制失败，请手动选取', 'error');
  return false;
}

// 复制单张卡密 (仅弹出优雅 Toast)
window.copyCardCode = code => {
  copyToClipboard(code, `已复制卡密代码: ${code}`);
};

// 作废卡密 (弹出页面居中自定义模态弹窗，保持全站一致设计风格)
window.revokeCard = async (cardId, cardCode = '') => {
  const confirmed = await showConfirm({
    title: '确认作废该卡密？',
    desc: `确认要作废卡密 <strong style="color:#1677ff; font-family:monospace; font-size:14px;">${escapeHtml(cardCode)}</strong> 吗？<br><span style="color:#cf1322; font-size:12.5px;">作废后该卡密将立即失效，用户将无法再兑换。此操作无法撤销。</span>`,
    okText: '确认作废',
    cancelText: '取消',
    isDanger: true,
    icon: '🗑️'
  });

  if (!confirmed) return;

  try {
    const res = await fetch('/api/admin/cards/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    showToast('已成功作废该卡密', 'success');
    loadCards();
  } catch (err) {
    showToast(`作废失败: ${err.message}`, 'error');
  }
};

if (cardFilterStatus) cardFilterStatus.addEventListener('change', loadCards);
if (cardFilterType) cardFilterType.addEventListener('change', loadCards);
if (refreshCardsBtn) refreshCardsBtn.addEventListener('click', loadCards);

// Generate Cards (支持多选类别生成一张卡密)
if (generateCardsForm) {
  generateCardsForm.addEventListener('submit', async event => {
    event.preventDefault();

    const isCloud = Boolean(benefitCheckCloud?.checked);
    const isZhencan = Boolean(benefitCheckZhencan?.checked);
    const isIp = Boolean(benefitCheckIp?.checked);

    const cardTypes = [];
    if (isCloud) cardTypes.push('cloud');
    if (isZhencan) cardTypes.push('zhencan');
    if (isIp) cardTypes.push('ip');

    if (cardTypes.length === 0) {
      showToast('请至少勾选一种兑换内容（云机 / 真参 / IP）！', 'error');
      return;
    }

    const cloudConfig = isCloud ? {
      durationDays: parseInt(cardDurationDays?.value, 10) || 30,
      durationHours: 0
    } : null;

    const zhencanConfig = isZhencan ? {
      count: parseInt(cardZhencanCount?.value, 10) || 10
    } : null;

    if (isZhencan && zhencanConfig.count <= 0) {
      showToast('请指定至少 1 套真参数量！', 'error');
      return;
    }

    const ipConfig = isIp ? {
      durationDays: parseInt(cardIpDays?.value, 10) || 30
    } : null;

    const count = parseInt(cardCount?.value, 10) || 1;
    const batchTag = cardBatchTag ? cardBatchTag.value.trim() : '';

    try {
      const res = await fetch('/api/admin/cards/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cardTypes,
          cloudConfig,
          zhencanConfig,
          ipConfig,
          count,
          batchTag
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      const generated = data.cards || [];
      batchCardsOutput.value = generated.map(c => c.cardCode).join('\n');
      if (cardsResultModal) cardsResultModal.style.display = 'flex';
      loadCards();
    } catch (err) {
      showToast(`生成失败: ${err.message}`, 'error');
    }
  });
}

if (closeCardsModalBtn) {
  closeCardsModalBtn.addEventListener('click', () => {
    cardsResultModal.style.display = 'none';
  });
}

if (copyAllCardsBtn) {
  copyAllCardsBtn.addEventListener('click', () => {
    const val = batchCardsOutput ? batchCardsOutput.value : '';
    copyToClipboard(val, '已成功复制全部卡密到剪贴板！');
  });
}

if (downloadCardsTxtBtn) {
  downloadCardsTxtBtn.addEventListener('click', () => {
    const blob = new Blob([batchCardsOutput.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `卡密列表_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// 5. Device Pool Management
async function loadPool() {
  if (!poolTableBody) return;
  poolTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:#8c8c8c;">正在加载设备池…</td></tr>';
  try {
    const res = await fetch('/api/admin/pool');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    if (statPoolTotal) statPoolTotal.textContent = data.total || 0;
    if (statPoolAllocated) statPoolAllocated.textContent = data.allocatedCount || 0;
    if (statPoolIdle) statPoolIdle.textContent = data.idleCount || 0;

    const pool = data.pool || [];
    if (pool.length === 0) {
      poolTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:#8c8c8c;">主账号下暂无云机，请检查云端登录态</td></tr>';
      return;
    }

    poolTableBody.innerHTML = pool.map(dev => `
      <tr>
        <td><code>${escapeHtml(dev.deviceId)}</code></td>
        <td><strong style="color:#1f1f1f;">${escapeHtml(dev.name || 'SF')}</strong></td>
        <td>
          <span class="badge-status ${dev.online ? 'active' : 'used'}">
            ${dev.online ? '在线' : '离线'}
          </span>
        </td>
        <td>
          <span class="badge-status ${dev.allocated ? 'unused' : 'active'}">
            ${dev.allocated ? '已分配' : '🟢 空闲待租用'}
          </span>
        </td>
        <td>${dev.userEmail ? `<strong>${escapeHtml(dev.userEmail)}</strong>` : '<span style="color:#8c8c8c;">--</span>'}</td>
        <td>${dev.expireAt ? formatDate(dev.expireAt) : '<span style="color:#8c8c8c;">--</span>'}</td>
        <td>${dev.remainingMs ? formatRemaining(dev.remainingMs) : '<span style="color:#8c8c8c;">--</span>'}</td>
        <td>
          ${dev.allocated ? `
            <button class="btn-action-sm danger" onclick="recycleDevice('${dev.allocationId}', '${dev.deviceId}', '${escapeHtml(dev.name || dev.deviceId)}')">
              强制回收
            </button>
          ` : '<span style="color:#8c8c8c;">无需操作</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    poolTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#ff4d4f; padding:30px;">加载失败: ${escapeHtml(err.message)}</td></tr>`;
  }
}

window.recycleDevice = async (allocationId, deviceId, devName = '') => {
  const confirmed = await showConfirm({
    title: '确认强制回收该云机？',
    desc: `确认强制解绑并回收云机 <strong style="color:#1f1f1f;">${escapeHtml(devName || deviceId)}</strong> 吗？<br><span style="color:#cf1322; font-size:12.5px;">当前正在进行的连接将立即断开，设备将重归空闲待分配库存。</span>`,
    okText: '强制回收',
    cancelText: '取消',
    isDanger: true,
    icon: '⚡'
  });

  if (!confirmed) return;

  try {
    const res = await fetch('/api/admin/devices/recycle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocationId, deviceId })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    showToast('已成功解绑并回收该云机', 'success');
    loadPool();
  } catch (err) {
    showToast(`回收失败: ${err.message}`, 'error');
  }
};

if (refreshPoolBtn) refreshPoolBtn.addEventListener('click', loadPool);

// 6. Admin Dedicated System Logs
function parseServerLogLine(line) {
  let level = 'INFO';
  let cleanMsg = line;
  let logTime = null;

  const match = line.match(/^\[Server\s+([A-Z]+)\]\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s*(.*)$/);
  if (match) {
    level = match[1].toUpperCase();
    const isoDate = new Date(match[2]);
    if (!isNaN(isoDate.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      const padMs = n => String(n).padStart(3, '0');
      logTime = `${pad(isoDate.getHours())}:${pad(isoDate.getMinutes())}:${pad(isoDate.getSeconds())}.${padMs(isoDate.getMilliseconds())}`;
    }
    cleanMsg = match[3] || '';
  } else {
    if (line.includes('[Server ERROR]') || line.includes('[API ERROR]')) level = 'ERROR';
    else if (line.includes('[Server WARN]')) level = 'WARN';
    else if (line.includes('GET ') || line.includes('POST ')) level = 'HTTP';
  }

  if (level === 'INFO' && /^(GET|POST|PUT|DELETE|PATCH)\s+\//.test(cleanMsg)) {
    level = 'HTTP';
  }

  return {
    source: 'server',
    time: logTime || new Date().toLocaleTimeString(),
    level,
    tag: 'SERVER',
    message: cleanMsg,
    raw: line
  };
}

function formatLogMessageHtml(rawMsg) {
  if (!rawMsg) return '';
  let safe = escapeHtml(rawMsg);

  // 1. 高亮 HTTP 动作方法
  safe = safe.replace(/\b(GET|POST|PUT|DELETE|PATCH|OPTIONS)\b/g, match => {
    return `<span class="log-method log-method-${match.toLowerCase()}">${match}</span>`;
  });

  // 2. 状态码与箭头 -> (数字状态码或 FAILED)
  safe = safe.replace(/(-&gt;|->)\s*(\d{3}|FAILED)/g, (match, arrow, code) => {
    let statusCls = 'log-status-2xx';
    if (code === 'FAILED' || code.startsWith('5')) statusCls = 'log-status-5xx';
    else if (code.startsWith('4')) statusCls = 'log-status-4xx';
    else if (code.startsWith('3')) statusCls = 'log-status-3xx';
    return `<span class="log-arrow">-&gt;</span> <span class="${statusCls}">${code}</span>`;
  });

  // 3. 耗时 (\d+ms)
  safe = safe.replace(/\((\d+ms)\)/g, '<span class="log-duration">($1)</span>');

  // 4. 用户/身份标识 [guest] 或 [user@domain] 或 [secaudit-probe@...]
  safe = safe.replace(/\[([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-.]+|guest)\]/g, '<span class="log-user">[$1]</span>');

  // 5. 特殊状态关键词 REJECTED / UNHANDLED
  safe = safe.replace(/\bREJECTED\b/g, '<span class="log-status-4xx" style="font-weight:700;">REJECTED</span>');
  safe = safe.replace(/\bUNHANDLED\b/g, '<span class="log-status-5xx" style="font-weight:700;">UNHANDLED</span>');

  return safe;
}

async function fetchServerLogs() {
  try {
    const res = await fetch('/api/server-logs');
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && Array.isArray(data.logs)) {
      const serverEntries = data.logs.map(parseServerLogLine);
      mergeSystemLogs(serverEntries);
    }
  } catch {}
}

function mergeSystemLogs(newEntries) {
  const existingRaws = new Set(allSystemLogs.map(l => l.raw || l.message));
  for (const entry of newEntries) {
    const key = entry.raw || entry.message;
    if (!existingRaws.has(key)) {
      allSystemLogs.push(entry);
      existingRaws.add(key);
    }
  }
  if (allSystemLogs.length > 500) {
    allSystemLogs = allSystemLogs.slice(-400);
  }
  updateNavErrorBadge();
  if (currentTab === 'logs') {
    renderSystemLogs();
  }
}

function updateNavErrorBadge() {
  if (!navErrorBadge) return;
  const errorCount = allSystemLogs.filter(l => l.level === 'ERROR').length;
  navErrorBadge.textContent = String(errorCount);
  navErrorBadge.style.display = errorCount > 0 ? 'inline-block' : 'none';
}

// 校验并清洗系统日志搜索输入：彻底杜绝浏览器密码管理器误把管理员账号/邮箱填入搜索框导致日志过滤为空
function getSanitizedLogSearch() {
  if (!adminLogSearch) return '';
  let val = adminLogSearch.value.trim();
  const userEmail = (currentUser && currentUser.email) ? currentUser.email.toLowerCase() : '';
  const adminEmailText = adminUserEmail ? adminUserEmail.textContent.toLowerCase() : '';

  if (val) {
    const lower = val.toLowerCase();
    if (
      (userEmail && lower === userEmail) ||
      (adminEmailText && adminEmailText.includes(lower) && lower.includes('@')) ||
      (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower))
    ) {
      adminLogSearch.value = '';
      if (clearAdminLogSearchBtn) clearAdminLogSearchBtn.style.display = 'none';
      return '';
    }
  }
  return val;
}

function syncAdminLogSearchClearBtn() {
  if (clearAdminLogSearchBtn && adminLogSearch) {
    clearAdminLogSearchBtn.style.display = adminLogSearch.value ? 'inline-block' : 'none';
  }
}

function renderSystemLogs() {
  if (!adminTerminalOutput) return;
  const keyword = getSanitizedLogSearch().toLowerCase();
  syncAdminLogSearchClearBtn();
  
  const filtered = allSystemLogs.filter(item => {
    if (activeLogLevel !== 'ALL') {
      if (activeLogLevel === 'HTTP') {
        if (item.tag !== 'HTTP' && item.level !== 'HTTP' && !item.message.includes(' -> ')) return false;
      } else if (item.level !== activeLogLevel) {
        return false;
      }
    }
    if (keyword) {
      const full = `${item.time} ${item.level} ${item.tag} ${item.message} ${item.details || ''}`.toLowerCase();
      if (!full.includes(keyword)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    adminTerminalOutput.innerHTML = `<div style="color: #6c7086; padding: 12px 6px; font-style: italic;">${allSystemLogs.length === 0 ? '暂无系统运行日志。' : '没有匹配当前过滤条件的日志。'}</div>`;
    return;
  }

  const htmlRows = filtered.map(item => {
    const levelKey = (item.level || 'INFO').toLowerCase();
    const tagKey = (item.tag || 'APP').toLowerCase();
    const detailsText = item.details ? (typeof item.details === 'string' ? item.details : JSON.stringify(item.details)) : '';
    const detailsHtml = detailsText ? `<span class="log-details">${escapeHtml(detailsText)}</span>` : '';
    const formattedContent = formatLogMessageHtml(item.message);

    return `<div class="log-row log-row-${levelKey}">` +
      `<span class="log-time">[${escapeHtml(item.time)}]</span>` +
      `<span class="log-badge log-badge-${levelKey}">${escapeHtml(item.level)}</span>` +
      `<span class="log-tag log-tag-${tagKey}">${escapeHtml(item.tag)}</span>` +
      `<span class="log-content">${formattedContent}${detailsHtml}</span>` +
    `</div>`;
  });

  adminTerminalOutput.innerHTML = htmlRows.join('');
  if (adminLogAutoScroll && adminLogAutoScroll.checked && adminLogViewport) {
    adminLogViewport.scrollTop = adminLogViewport.scrollHeight;
  }
}

// Log Level Filter Click
logLevelButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    logLevelButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeLogLevel = btn.getAttribute('data-level');
    renderSystemLogs();
  });
});

if (adminLogSearch) {
  adminLogSearch.addEventListener('input', () => {
    syncAdminLogSearchClearBtn();
    renderSystemLogs();
  });
}

if (clearAdminLogSearchBtn) {
  clearAdminLogSearchBtn.addEventListener('click', () => {
    if (adminLogSearch) {
      adminLogSearch.value = '';
      syncAdminLogSearchClearBtn();
      renderSystemLogs();
      adminLogSearch.focus();
    }
  });
}

if (adminLogClearBtn) {
  adminLogClearBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/server-logs/clear', { method: 'POST' });
    } catch {}
    allSystemLogs = [];
    window.AppLogger?.clear();
    renderSystemLogs();
    updateNavErrorBadge();
    showToast('系统运行日志已清空', 'success');
  });
}

if (adminLogCopyBtn) {
  adminLogCopyBtn.addEventListener('click', () => {
    // 复制前先确保清洗可能在此瞬间误填的管理员账号并重新渲染
    getSanitizedLogSearch();
    syncAdminLogSearchClearBtn();

    const text = adminTerminalOutput ? (adminTerminalOutput.innerText || adminTerminalOutput.textContent).trim() : '';
    if (!text || text === '暂无系统运行日志。' || text === '没有匹配当前过滤条件的日志。' || text.startsWith('正在读取')) {
      showToast('暂无日志可复制', 'error');
      return;
    }
    copyToClipboard(text, '已成功复制当前系统运行日志到剪贴板！');
  });
}

if (adminLogRefreshBtn) {
  adminLogRefreshBtn.addEventListener('click', () => {
    fetchServerLogs();
  });
}

// Subscribe to Client Telemetry Logger
if (window.AppLogger) {
  window.AppLogger.subscribe((entry, logs) => {
    const formatted = logs.slice(-20).map(l => ({
      source: 'client',
      time: l.time,
      level: l.level,
      tag: l.tag,
      message: l.message,
      details: l.details,
      raw: `[${l.time}] [${l.level}] [${l.tag}] ${l.message}`
    }));
    mergeSystemLogs(formatted);
  });
}

// Periodically sync server logs
setInterval(() => {
  if (currentTab === 'logs') {
    fetchServerLogs();
  }
}, 4000);

// ==========================================
// 7. Admin Dedicated Cloud Disk Management
// ==========================================
let adminDiskInitialized = false;
let adminDiskCurrentDir = '真参';
let adminDiskFiles = [];
let adminDiskDevices = [];
let adminDiskSelectedFile = null;

async function loadAdminDiskDevices() {
  const select = document.getElementById('adminDiskDeviceSelect');
  if (!select) return;
  try {
    const res = await fetch('/api/devices');
    const data = await res.json();
    if (data.ok && Array.isArray(data.devices)) {
      adminDiskDevices = data.devices;
      if (adminDiskDevices.length === 0) {
        select.innerHTML = '<option value="">暂无可用云机</option>';
      } else {
        select.innerHTML = adminDiskDevices.map(d => {
          const name = d.name ? (d.name + ' (' + d.deviceId + ')') : d.deviceId;
          return '<option value="' + escapeHtml(d.deviceId) + '">' + escapeHtml(name) + '</option>';
        }).join('');
      }
    }
  } catch (err) {
    console.error('加载设备列表失败:', err);
  }
}

async function loadAdminDiskFiles() {
  const listEl = document.getElementById('adminDiskFileList');
  const countParamsEl = document.getElementById('adminDiskCountParams');
  const countAvatarsEl = document.getElementById('adminDiskCountAvatars');
  const refreshBtn = document.getElementById('adminDiskRefreshBtn');

  if (refreshBtn) refreshBtn.classList.add('spinning');
  if (listEl) {
    listEl.innerHTML = '<div class="disk-empty-state"><p>正在读取云盘文件…</p></div>';
  }

  try {
    const res = await fetch('/api/cloud-disk/files?dir=' + encodeURIComponent(adminDiskCurrentDir));
    const data = await res.json();
    if (data.ok) {
      adminDiskFiles = data.files || [];
      if (data.counts) {
        if (countParamsEl) countParamsEl.textContent = String(data.counts['真参'] || 0);
        if (countAvatarsEl) countAvatarsEl.textContent = String(data.counts['头像'] || 0);
      }
      renderAdminDiskFileList();
    } else {
      if (listEl) {
        listEl.innerHTML = '<div class="disk-empty-state error"><p>读取失败: ' + escapeHtml(data.error || '权限不足') + '</p></div>';
      }
    }
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = '<div class="disk-empty-state error"><p>网络异常: ' + escapeHtml(err.message) + '</p></div>';
    }
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

window.selectAdminDiskFile = function(fileName, event) {
  if (event) event.stopPropagation();

  // 点击已选中的项目时：若是单击则取消选中；双击则保持选中状态以便后续操作
  if (adminDiskSelectedFile === fileName) {
    if (!event || event.detail <= 1) {
      adminDiskSelectedFile = null;
    }
  } else {
    adminDiskSelectedFile = fileName;
  }

  updateAvatarOperationBar();

  const items = document.querySelectorAll('.disk-grid-item');
  items.forEach(el => {
    if (adminDiskSelectedFile && el.dataset.filename === adminDiskSelectedFile) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });
};

function updateAvatarOperationBar() {
  const bar = document.getElementById('avatarOperationBar');
  if (!bar) return;

  // 仅在头像目录下且选中了图片时展示操作栏，其余情况完全隐藏，保持界面极简干净
  if (adminDiskCurrentDir !== '头像' || !adminDiskSelectedFile) {
    bar.style.display = 'none';
    return;
  }

  const selected = adminDiskFiles.find(f => f.name === adminDiskSelectedFile);
  if (!selected) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';

  const nameEl = document.getElementById('avatarSelectedName');
  const sizeEl = document.getElementById('avatarSelectedSize');
  const btnPush = document.getElementById('btnPushSelectedAvatar');
  const btnDel = document.getElementById('btnDeleteSelectedAvatar');

  if (nameEl) nameEl.textContent = selected.name;
  if (sizeEl) sizeEl.textContent = '(' + selected.sizeFormatted + ')';
  if (btnPush) btnPush.disabled = false;
  if (btnDel) btnDel.disabled = false;
}

function renderAdminDiskFileList() {
  const listEl = document.getElementById('adminDiskFileList');
  if (!listEl) return;

  const isAvatarDir = adminDiskCurrentDir === '头像';

  if (isAvatarDir) {
    listEl.className = 'disk-grid-view';

    if (adminDiskFiles.length === 0) {
      adminDiskSelectedFile = null;
      updateAvatarOperationBar();
      listEl.innerHTML = '<div class="disk-empty-state" style="padding: 36px 20px; grid-column: 1 / -1; width:100%; text-align:center;">' +
        '<p style="font-size:14px; color:#595959; margin:0;">暂无头像图片，点击右上角【上传文件】或直接将图片拖拽至此</p>' +
      '</div>';
      return;
    }

    // 若此前选中的文件已不存在则清空，严禁在初始加载时强行选中第一项
    const hasCurrent = adminDiskFiles.some(f => f.name === adminDiskSelectedFile);
    if (!hasCurrent) {
      adminDiskSelectedFile = null;
    }
    updateAvatarOperationBar();

    // 点击空白处取消选中
    listEl.onclick = function(e) {
      if (!e.target.closest('.disk-grid-item')) {
        adminDiskSelectedFile = null;
        updateAvatarOperationBar();
        document.querySelectorAll('.disk-grid-item').forEach(el => el.classList.remove('selected'));
      }
    };

    listEl.innerHTML = adminDiskFiles.map(file => {
      const isSelected = file.name === adminDiskSelectedFile;
      const previewUrl = '/api/cloud-disk/preview?dir=' + encodeURIComponent(adminDiskCurrentDir) + '&name=' + encodeURIComponent(file.name);
      return '<div class="disk-grid-item ' + (isSelected ? 'selected' : '') + '" data-filename="' + escapeHtml(file.name) + '" onclick="selectAdminDiskFile(\'' + escapeHtml(file.name) + '\', event)" ondblclick="previewAdminDiskFile(\'' + escapeHtml(file.name) + '\', true, false); event.stopPropagation();" title="双击放大预览，单击选中">' +
        '<div class="disk-grid-check">✓</div>' +
        '<div class="disk-grid-thumb">' +
          '<img src="' + previewUrl + '" alt="' + escapeHtml(file.name) + '" loading="lazy" />' +
        '</div>' +
        '<div class="disk-grid-info">' +
          '<div class="disk-grid-name" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</div>' +
          '<div class="disk-grid-size">' + file.sizeFormatted + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    return;
  }

  // 真机参数列表展示
  listEl.className = 'disk-file-list';
  updateAvatarOperationBar();

  if (adminDiskFiles.length === 0) {
    listEl.innerHTML = '<div class="disk-empty-state" style="padding: 36px 20px;">' +
      '<p style="font-size:14px; color:#595959; margin:0;">暂无真参文件，点击右上角【上传文件】或直接将文件拖拽至此</p>' +
    '</div>';
    return;
  }

  listEl.innerHTML = adminDiskFiles.map(file => {
    let thumbHtml = '<div class="disk-file-thumb params-thumb" style="font-size:22px; display:flex; align-items:center; justify-content:center;">⚙️</div>';

    let metaText = '';
    if (file.previewInfo) {
      const p = file.previewInfo;
      const parts = [];
      if (p.brand || p.model) parts.push('<strong>' + escapeHtml(p.brand) + ' ' + escapeHtml(p.model) + '</strong>');
      if (p.androidVersion) parts.push('Android ' + escapeHtml(p.androidVersion));
      parts.push(file.sizeFormatted);
      metaText = parts.join(' · ');
    } else {
      metaText = file.sizeFormatted;
    }

    let statusBadge = '';
    let toggleBtn = '';
    if (file.zhencanStatus) {
      if (file.zhencanStatus.status === 'used') {
        const titleTip = '使用时间: ' + (file.zhencanStatus.usedAtFormatted || '此前') + ' | 目标云机: ' + (file.zhencanStatus.usedOnDeviceName || file.zhencanStatus.usedOnDeviceId || '未知');
        statusBadge = '<span class="badge-status-used" style="background:#fff2f0; color:#cf1322; border:1px solid #ffccc7; font-size:11.5px; padding:2px 7px; border-radius:4px; font-weight:600; margin-left:8px;" title="' + escapeHtml(titleTip) + '">🔴 已使用 (' + (file.zhencanStatus.usedAtFormatted ? file.zhencanStatus.usedAtFormatted.slice(5, 16) : '已导入') + ')</span>';
        toggleBtn = '<button type="button" class="disk-action-btn success" style="background:#f6ffed; color:#389e0d; border:1px solid #b7eb8f; padding:4px 10px; font-size:12px;" onclick="toggleZhencanStatus(\'' + escapeHtml(file.name) + '\', \'available\')" title="将该真参重置为可用状态，允许再次导入">🔄 重新启用</button>';
      } else {
        statusBadge = '<span class="badge-status-avail" style="background:#f6ffed; color:#389e0d; border:1px solid #b7eb8f; font-size:11.5px; padding:2px 7px; border-radius:4px; font-weight:600; margin-left:8px;">🟢 可用</span>';
        toggleBtn = '<button type="button" class="disk-action-btn subtle" style="color:#8c8c8c; border:1px solid #d9d9d9; padding:4px 10px; font-size:12px;" onclick="toggleZhencanStatus(\'' + escapeHtml(file.name) + '\', \'used\')" title="将该真参标记为已使用">🚫 设为已用</button>';
      }
    }

    return '<div class="disk-file-card" data-filename="' + escapeHtml(file.name) + '">' +
      thumbHtml +
      '<div class="disk-file-main">' +
        '<div class="disk-file-title" title="' + escapeHtml(file.name) + '">' +
          escapeHtml(file.name) + statusBadge +
        '</div>' +
        '<div class="disk-file-meta">' + metaText + '</div>' +
      '</div>' +
      '<div class="disk-file-actions">' +
        toggleBtn +
        '<button type="button" class="disk-action-btn primary push-btn" onclick="sendAdminDiskFileToDevice(\'' + escapeHtml(file.name) + '\')">' +
          '🚀 推送到云机' +
        '</button>' +
        '<button type="button" class="disk-action-btn view-btn" onclick="previewAdminDiskFile(\'' + escapeHtml(file.name) + '\', false, ' + file.isText + ')">' +
          '预览' +
        '</button>' +
        '<button type="button" class="disk-action-btn danger delete-btn" onclick="deleteAdminDiskFile(\'' + escapeHtml(file.name) + '\')">' +
          '删除' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

window.previewAdminDiskFile = async (fileName, isImage, isText) => {
  const dialog = document.getElementById('adminDiskPreviewDialog');
  const titleEl = document.getElementById('adminDiskPreviewTitle');
  const bodyEl = document.getElementById('adminDiskPreviewBody');
  if (!dialog || !titleEl || !bodyEl) return;

  titleEl.textContent = '文件预览: ' + fileName;
  bodyEl.innerHTML = '<div style="padding:24px; text-align:center; color:#595959;">加载中…</div>';
  dialog.showModal();

  const fileUrl = '/api/cloud-disk/file?dir=' + encodeURIComponent(adminDiskCurrentDir) + '&name=' + encodeURIComponent(fileName);

  if (isImage) {
    bodyEl.innerHTML = '<div style="text-align:center; padding:12px; max-height:70vh; overflow:auto;">' +
      '<img src="' + fileUrl + '" alt="' + escapeHtml(fileName) + '" style="max-width:100%; max-height:65vh; border-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,0.1);" />' +
    '</div>';
  } else if (isText) {
    try {
      const res = await fetch(fileUrl);
      const text = await res.text();
      bodyEl.innerHTML = '<div style="max-height:65vh; overflow:auto; padding:12px; background:#f8fafc; border-radius:4px; border:1px solid #e2e8f0;">' +
        '<pre style="margin:0; font-family:Consolas, monospace; font-size:12px; color:#1e293b; white-space:pre-wrap; word-break:break-all;">' + escapeHtml(text) + '</pre>' +
      '</div>';
    } catch (err) {
      bodyEl.innerHTML = '<div style="padding:20px; color:#cf1322;">读取文件内容失败: ' + escapeHtml(err.message) + '</div>';
    }
  } else {
    bodyEl.innerHTML = '<div style="padding:30px; text-align:center;">' +
      '<p style="color:#595959; margin-bottom:14px;">此文件类型不支持在线预览，请下载查看</p>' +
      '<a href="' + fileUrl + '" download class="btn-action-sm" style="display:inline-block; text-decoration:none;">下载文件</a>' +
    '</div>';
  }
};

window.deleteAdminDiskFile = async (fileName) => {
  const confirmed = await showConfirm({
    title: '确认删除该文件？',
    desc: '确定要从【' + escapeHtml(adminDiskCurrentDir) + '】目录删除文件 <strong style="color:#1f1f1f;">' + escapeHtml(fileName) + '</strong> 吗？此操作无法撤销。',
    okText: '确认删除',
    cancelText: '取消',
    isDanger: true,
    icon: '🗑️'
  });

  if (!confirmed) return;

  try {
    const res = await fetch('/api/cloud-disk/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: adminDiskCurrentDir, name: fileName })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('已成功删除文件 "' + fileName + '"', 'success');
      if (adminDiskSelectedFile === fileName) {
        adminDiskSelectedFile = null;
      }
      loadAdminDiskFiles();
    } else {
      showToast('删除失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('删除请求失败: ' + err.message, 'error');
  }
};

window.sendAdminDiskFileToDevice = async (fileName) => {
  const select = document.getElementById('adminDiskDeviceSelect');
  const deviceId = select ? select.value : '';
  const deviceName = select && select.selectedIndex >= 0 ? select.options[select.selectedIndex].text : deviceId;

  if (!deviceId) {
    showToast('请先在上方下拉框中选择要下发的目标云机！', 'error');
    return;
  }

  const isParamsDir = adminDiskCurrentDir === '真参';
  const confirmed = await showConfirm({
    title: isParamsDir ? '确认推送真参配置到云机？' : '确认推送图片到云机相册？',
    desc: isParamsDir
      ? ('确认将真参文件 <strong style="color:#1677ff;">' + escapeHtml(fileName) + '</strong> 推送并应用到云机 <strong>' + escapeHtml(deviceName) + '</strong>？')
      : ('确认将图片 <strong style="color:#1677ff;">' + escapeHtml(fileName) + '</strong> 立即推送到云机 <strong>' + escapeHtml(deviceName) + '</strong> 的相册？'),
    okText: '立即推送',
    cancelText: '取消',
    isDanger: false,
    icon: '🚀'
  });

  if (!confirmed) return;

  const card = document.querySelector('.disk-file-card[data-filename="' + CSS.escape(fileName) + '"]');
  const pushBtn = card ? card.querySelector('.push-btn') : null;
  const originalText = pushBtn ? pushBtn.innerHTML : '';
  const topPushBtn = document.getElementById('btnPushSelectedAvatar');
  const originalTopText = topPushBtn ? topPushBtn.innerHTML : '';

  if (pushBtn) {
    pushBtn.disabled = true;
    pushBtn.innerHTML = '⏳ 正在实时下发…';
  }
  if (topPushBtn) {
    topPushBtn.disabled = true;
    topPushBtn.innerHTML = '⏳ 正在下发…';
  }

  try {
    const res = await fetch('/api/cloud-disk/send-to-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, dir: adminDiskCurrentDir, name: fileName })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('下发成功！' + (data.message || ''), 'success');
    } else {
      showToast('下发失败: ' + (data.error || '操作未能完成'), 'error');
    }
  } catch (err) {
    showToast('网络或下发接口异常: ' + err.message, 'error');
  } finally {
    if (pushBtn) {
      pushBtn.disabled = false;
      pushBtn.innerHTML = originalText;
    }
    if (topPushBtn) {
      topPushBtn.disabled = false;
      topPushBtn.innerHTML = originalTopText;
    }
  }
};

async function uploadAdminDiskFiles(files) {
  if (!files || !files.length) return;
  const total = files.length;
  let successCount = 0;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    try {
      const base64 = await readFileAsBase64Admin(file);
      const res = await fetch('/api/cloud-disk/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: adminDiskCurrentDir, name: file.name, contentBase64: base64 })
      });
      const data = await res.json();
      if (data.ok) successCount++;
      else showToast('文件 [' + file.name + '] 上传失败: ' + (data.error || '服务器错误'), 'error');
    } catch (err) {
      showToast('文件 [' + file.name + '] 读取或上传失败: ' + err.message, 'error');
    }
  }

  showToast('成功上传 ' + successCount + '/' + total + ' 个文件到【' + adminDiskCurrentDir + '】', 'success');
  loadAdminDiskFiles();
}

function readFileAsBase64Admin(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result;
      const commaIdx = res.indexOf(',');
      resolve(commaIdx !== -1 ? res.slice(commaIdx + 1) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadAdminDisk() {
  if (!adminDiskInitialized) {
    adminDiskInitialized = true;
    const btnParams = document.getElementById('adminDiskDirParams');
    const btnAvatars = document.getElementById('adminDiskDirAvatars');
    if (btnParams) {
      btnParams.addEventListener('click', () => {
        adminDiskCurrentDir = '真参';
        adminDiskSelectedFile = null;
        btnParams.classList.add('active');
        btnAvatars?.classList.remove('active');
        const countP = document.getElementById('adminDiskCountParams');
        const countA = document.getElementById('adminDiskCountAvatars');
        if (countP) { countP.style.background = '#1677ff'; countP.style.color = '#fff'; }
        if (countA) { countA.style.background = '#e8e8e8'; countA.style.color = '#595959'; }
        loadAdminDiskFiles();
      });
    }
    if (btnAvatars) {
      btnAvatars.addEventListener('click', () => {
        adminDiskCurrentDir = '头像';
        btnAvatars.classList.add('active');
        btnParams?.classList.remove('active');
        const countP = document.getElementById('adminDiskCountParams');
        const countA = document.getElementById('adminDiskCountAvatars');
        if (countA) { countA.style.background = '#1677ff'; countA.style.color = '#fff'; }
        if (countP) { countP.style.background = '#e8e8e8'; countP.style.color = '#595959'; }
        loadAdminDiskFiles();
      });
    }

    const btnPushAvatar = document.getElementById('btnPushSelectedAvatar');
    if (btnPushAvatar) {
      btnPushAvatar.addEventListener('click', () => {
        if (adminDiskSelectedFile) sendAdminDiskFileToDevice(adminDiskSelectedFile);
      });
    }
    const btnPrevAvatar = document.getElementById('btnPreviewSelectedAvatar');
    if (btnPrevAvatar) {
      btnPrevAvatar.addEventListener('click', () => {
        if (adminDiskSelectedFile) previewAdminDiskFile(adminDiskSelectedFile, true, false);
      });
    }
    const btnDelAvatar = document.getElementById('btnDeleteSelectedAvatar');
    if (btnDelAvatar) {
      btnDelAvatar.addEventListener('click', () => {
        if (adminDiskSelectedFile) deleteAdminDiskFile(adminDiskSelectedFile);
      });
    }

    const refreshBtn = document.getElementById('adminDiskRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadAdminDiskFiles);

    const refreshDevsBtn = document.getElementById('adminDiskRefreshDevicesBtn');
    if (refreshDevsBtn) refreshDevsBtn.addEventListener('click', loadAdminDiskDevices);

    const fileInput = document.getElementById('adminDiskFileInput');
    const uploadBtn = document.getElementById('adminDiskUploadBtn');
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', e => {
        if (e.target.files && e.target.files.length) {
          uploadAdminDiskFiles(Array.from(e.target.files));
          fileInput.value = '';
        }
      });
    }

    const dropArea = document.getElementById('adminDiskFileList');
    if (dropArea && fileInput) {
      ['dragenter', 'dragover'].forEach(name => {
        dropArea.addEventListener(name, e => {
          e.preventDefault();
          e.stopPropagation();
          dropArea.classList.add('drag-over');
        });
      });
      ['dragleave', 'drop'].forEach(name => {
        dropArea.addEventListener(name, e => {
          e.preventDefault();
          e.stopPropagation();
          dropArea.classList.remove('drag-over');
        });
      });
      dropArea.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        dropArea.classList.remove('drag-over');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          uploadAdminDiskFiles(Array.from(e.dataTransfer.files));
        }
      });
    }

    const closePreviewBtn = document.getElementById('closeAdminDiskPreviewBtn');
    const previewDialog = document.getElementById('adminDiskPreviewDialog');
    if (closePreviewBtn && previewDialog) {
      closePreviewBtn.addEventListener('click', () => previewDialog.close());
    }
  }

  loadAdminDiskDevices();
  loadAdminDiskFiles();
}



// 8. AI 供应商管理模块 (AI Multi-Provider Management)
// ============================================================================
let adminAiProviders = [];
let adminAiActiveId = null;
let adminAiEventsInitialized = false;

async function loadAdminAiSettings() {
  initAdminAiEvents();
  const tableBody = document.getElementById('aiProvidersTableBody');
  if (tableBody) {
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#8c8c8c;">正在加载供应商列表…</td></tr>';
  }

  try {
    const res = await fetch('/api/admin/ai-settings');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '获取 AI 供应商失败');

    adminAiProviders = data.providers || [];
    adminAiActiveId = data.activeProviderId || null;
    renderAiProvidersTable();
  } catch (err) {
    if (tableBody) {
      tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#cf1322;">加载失败: ' + escapeHtml(err.message) + '</td></tr>';
    }
    showToast('获取 AI 供应商失败: ' + err.message, 'error');
  }
}

function renderAiProvidersTable() {
  const tableBody = document.getElementById('aiProvidersTableBody');
  if (!tableBody) return;

  if (adminAiProviders.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#8c8c8c;">暂无供应商配置，点击上方「+ 新增供应商」进行添加</td></tr>';
    return;
  }

  tableBody.innerHTML = adminAiProviders.map(p => {
    const isDefault = p.isDefault || p.id === adminAiActiveId;
    const protocolLabel = p.provider === 'deepseek' ? 'DeepSeek 官方' : (p.provider === 'custom' ? '通用自定义' : 'OpenAI 兼容');
    const keyDisplay = p.hasApiKey ? '<span style="font-family:monospace; color:#389e0d;">' + escapeHtml(p.apiKeyMasked) + '</span>' : '<span style="color:#fa8c16;">未配置</span>';
    const statusTag = isDefault
      ? '<span class="badge" style="background:#f6ffed; border:1px solid #b7eb8f; color:#389e0d; padding:2px 8px; border-radius:4px; font-size:12px; font-weight:600;">默认启用</span>'
      : '<span class="badge" style="background:#f5f5f5; border:1px solid #d9d9d9; color:#8c8c8c; padding:2px 8px; border-radius:4px; font-size:12px;">备用</span>';

    return '<tr>' +
      '<td style="font-weight:600; color:#1f1f1f;">' + escapeHtml(p.name) + '</td>' +
      '<td>' + escapeHtml(protocolLabel) + '</td>' +
      '<td style="font-family:monospace; font-size:12.5px; color:#595959; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' + escapeHtml(p.endpoint) + '">' + escapeHtml(p.endpoint) + '</td>' +
      '<td><code>' + escapeHtml(p.model) + '</code></td>' +
      '<td>' + keyDisplay + '</td>' +
      '<td>' + statusTag + '</td>' +
      '<td>' +
        '<div style="display:flex; gap:6px; align-items:center;">' +
          (!isDefault ? '<button type="button" class="btn-action-sm" onclick="setAiDefaultProvider(\'' + escapeHtml(p.id) + '\')">设为默认</button>' : '') +
          '<button type="button" class="btn-action-sm" onclick="testAiProvider(\'' + escapeHtml(p.id) + '\')">测试</button>' +
          '<button type="button" class="btn-action-sm" onclick="editAiProvider(\'' + escapeHtml(p.id) + '\')">编辑</button>' +
          (adminAiProviders.length > 1 ? '<button type="button" class="btn-action-sm danger" onclick="deleteAiProvider(\'' + escapeHtml(p.id) + '\')">删除</button>' : '') +
        '</div>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function initAdminAiEvents() {
  if (adminAiEventsInitialized) return;
  adminAiEventsInitialized = true;

  const btnAdd = document.getElementById('btnAddAiProvider');
  const btnRefresh = document.getElementById('refreshAiProvidersBtn');
  const modalClose = document.getElementById('closeAiProviderModalBtn');
  const btnCancel = document.getElementById('cancelEditProviderBtn');
  const form = document.getElementById('aiProviderForm');
  const clearKeyBtn = document.getElementById('editProviderClearKeyBtn');
  const testBtn = document.getElementById('testEditProviderBtn');

  if (btnAdd) {
    btnAdd.addEventListener('click', () => {
      openAiProviderModal(null);
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      loadAdminAiSettings();
    });
  }

  if (modalClose) {
    modalClose.addEventListener('click', () => {
      closeAiProviderModal();
    });
  }

  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      closeAiProviderModal();
    });
  }

  if (clearKeyBtn) {
    clearKeyBtn.addEventListener('click', () => {
      const apiKeyEl = document.getElementById('editProviderApiKey');
      if (apiKeyEl) {
        apiKeyEl.value = '';
        apiKeyEl.placeholder = '输入 API Key';
        apiKeyEl.dataset.cleared = 'true';
      }
    });
  }

  if (form) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      await handleSaveAiProvider();
    });
  }

  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      await handleTestCurrentModalProvider();
    });
  }
}

function openAiProviderModal(providerId = null) {
  const modal = document.getElementById('aiProviderModal');
  const titleEl = document.getElementById('aiProviderModalTitle');
  const idEl = document.getElementById('editProviderId');
  const nameEl = document.getElementById('editProviderName');
  const protoEl = document.getElementById('editProviderProtocol');
  const endpointEl = document.getElementById('editProviderEndpoint');
  const apiKeyEl = document.getElementById('editProviderApiKey');
  const modelEl = document.getElementById('editProviderModel');
  const tempEl = document.getElementById('editProviderTemp');
  const maxTokensEl = document.getElementById('editProviderMaxTokens');
  const timeoutEl = document.getElementById('editProviderTimeout');
  const defaultEl = document.getElementById('editProviderIsDefault');

  if (!modal) return;

  if (apiKeyEl) delete apiKeyEl.dataset.cleared;

  if (providerId) {
    const p = adminAiProviders.find(item => item.id === providerId);
    if (!p) return;
    if (titleEl) titleEl.textContent = '编辑 AI 供应商';
    if (idEl) idEl.value = p.id;
    if (nameEl) nameEl.value = p.name || '';
    if (protoEl) protoEl.value = p.provider || 'openai';
    if (endpointEl) endpointEl.value = p.endpoint || '';
    if (apiKeyEl) {
      apiKeyEl.value = '';
      apiKeyEl.placeholder = p.hasApiKey ? '已配置: ' + p.apiKeyMasked + ' (留空保持)' : '输入 API Key';
    }
    if (modelEl) modelEl.value = p.model || '';
    if (tempEl) tempEl.value = p.temperature ?? 0.7;
    if (maxTokensEl) maxTokensEl.value = p.maxTokens ?? 150;
    if (timeoutEl) timeoutEl.value = p.timeoutMs ?? 15000;
    if (defaultEl) defaultEl.checked = Boolean(p.isDefault || p.id === adminAiActiveId);
  } else {
    if (titleEl) titleEl.textContent = '新增 AI 供应商';
    if (idEl) idEl.value = '';
    if (nameEl) nameEl.value = '';
    if (protoEl) protoEl.value = 'openai';
    if (endpointEl) endpointEl.value = 'https://api.deepseek.com';
    if (apiKeyEl) {
      apiKeyEl.value = '';
      apiKeyEl.placeholder = '输入 API Key';
    }
    if (modelEl) modelEl.value = 'deepseek-chat';
    if (tempEl) tempEl.value = 0.7;
    if (maxTokensEl) maxTokensEl.value = 150;
    if (timeoutEl) timeoutEl.value = 15000;
    if (defaultEl) defaultEl.checked = adminAiProviders.length === 0;
  }

  modal.style.display = 'flex';
}

function closeAiProviderModal() {
  const modal = document.getElementById('aiProviderModal');
  if (modal) modal.style.display = 'none';
}

async function handleSaveAiProvider() {
  const id = document.getElementById('editProviderId')?.value?.trim();
  const name = document.getElementById('editProviderName')?.value?.trim();
  const provider = document.getElementById('editProviderProtocol')?.value?.trim();
  const endpoint = document.getElementById('editProviderEndpoint')?.value?.trim();
  const apiKeyEl = document.getElementById('editProviderApiKey');
  const apiKey = apiKeyEl?.value?.trim();
  const model = document.getElementById('editProviderModel')?.value?.trim();
  const temperature = Number(document.getElementById('editProviderTemp')?.value);
  const maxTokens = Number(document.getElementById('editProviderMaxTokens')?.value);
  const timeoutMs = Number(document.getElementById('editProviderTimeout')?.value);
  const isDefault = Boolean(document.getElementById('editProviderIsDefault')?.checked);

  if (!name) {
    showToast('请输入供应商名称', 'error');
    return;
  }
  if (!endpoint) {
    showToast('请输入接口链接', 'error');
    return;
  }
  if (!model) {
    showToast('请输入模型名称', 'error');
    return;
  }

  const payload = {
    id: id || undefined,
    name,
    provider,
    endpoint,
    model,
    temperature,
    maxTokens,
    timeoutMs,
    isDefault
  };

  if (apiKey && !apiKey.includes('***')) {
    payload.apiKey = apiKey;
  } else if (apiKeyEl?.dataset?.cleared === 'true') {
    payload.clearApiKey = true;
  }

  const saveBtn = document.getElementById('saveEditProviderBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
  }

  try {
    const res = await fetch('/api/admin/ai-providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      showToast('供应商已保存', 'success');
      closeAiProviderModal();
      loadAdminAiSettings();
    } else {
      showToast(data.error || '保存失败', 'error');
    }
  } catch (err) {
    showToast('保存出错: ' + err.message, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存供应商';
    }
  }
}

async function handleTestCurrentModalProvider() {
  const provider = document.getElementById('editProviderProtocol')?.value?.trim();
  const endpoint = document.getElementById('editProviderEndpoint')?.value?.trim();
  const model = document.getElementById('editProviderModel')?.value?.trim();
  const apiKey = document.getElementById('editProviderApiKey')?.value?.trim();
  const providerId = document.getElementById('editProviderId')?.value?.trim();
  const testBtn = document.getElementById('testEditProviderBtn');

  if (testBtn) {
    testBtn.disabled = true;
    testBtn.textContent = '正在测试…';
  }

  try {
    const payload = { provider, endpoint, model };
    if (apiKey && !apiKey.includes('***')) {
      payload.apiKey = apiKey;
    } else if (providerId) {
      payload.providerId = providerId;
    }

    const res = await fetch('/api/admin/ai-settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      showToast('连接测试成功: 回复 "' + data.reply + '" (' + data.model + ')', 'success');
    } else {
      showToast('测试连接失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('网络测试失败: ' + err.message, 'error');
  } finally {
    if (testBtn) {
      testBtn.disabled = false;
      testBtn.textContent = '测试连接';
    }
  }
}

window.editAiProvider = function(providerId) {
  openAiProviderModal(providerId);
};

window.setAiDefaultProvider = async function(providerId) {
  try {
    const res = await fetch('/api/admin/ai-providers/' + encodeURIComponent(providerId) + '/set-default', {
      method: 'POST'
    });
    const data = await res.json();
    if (data.ok) {
      showToast('已切换为默认供应商', 'success');
      loadAdminAiSettings();
    } else {
      showToast(data.error || '切换失败', 'error');
    }
  } catch (err) {
    showToast('切换失败: ' + err.message, 'error');
  }
};

window.testAiProvider = async function(providerId) {
  showToast('正在发送测试请求…', 'info');
  try {
    const res = await fetch('/api/admin/ai-settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: providerId })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('连接成功: 回复 "' + data.reply + '"', 'success');
    } else {
      showToast('测试失败: ' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('测试失败: ' + err.message, 'error');
  }
};

window.deleteAiProvider = async function(providerId) {
  const p = adminAiProviders.find(item => item.id === providerId);
  const name = p ? p.name : '该供应商';
  const confirmed = await showConfirm({
    title: '确认删除供应商？',
    desc: '确定要删除供应商【' + escapeHtml(name) + '】吗？此操作无法撤销。',
    okText: '确认删除',
    cancelText: '取消',
    isDanger: true
  });
  if (!confirmed) return;

  try {
    const res = await fetch('/api/admin/ai-providers/' + encodeURIComponent(providerId), {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.ok) {
      showToast('供应商已删除', 'success');
      loadAdminAiSettings();
    } else {
      showToast(data.error || '删除失败', 'error');
    }
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
};


// ==========================================================================
// 8. 接码平台管理 (玄武 OpenAPI - 极简供脚本调用与日志排查)
// ==========================================================================
const smsConfigForm = document.getElementById('smsConfigForm');
const smsApiKey = document.getElementById('smsApiKey');
const toggleSmsKeyVisBtn = document.getElementById('toggleSmsKeyVisBtn');
const saveSmsConfigBtn = document.getElementById('saveSmsConfigBtn');
const testSmsConnBtn = document.getElementById('testSmsConnBtn');
const smsConfigMsg = document.getElementById('smsConfigMsg');
const smsConfigStatusBadge = document.getElementById('smsConfigStatusBadge');
const smsLogTotalCount = document.getElementById('smsLogTotalCount');

const smsRecordSearch = document.getElementById('smsRecordSearch');
const clearSmsSearchBtn = document.getElementById('clearSmsSearchBtn');
const smsRecordStatusFilter = document.getElementById('smsRecordStatusFilter');
const refreshSmsRecordsBtn = document.getElementById('refreshSmsRecordsBtn');
const clearSmsRecordsBtn = document.getElementById('clearSmsRecordsBtn');
const smsRecordsTableBody = document.getElementById('smsRecordsTableBody');

// 校验并清洗搜索框输入：彻底防止浏览器密码管理器误把管理员账号/邮箱填入搜索框导致查询为空
function getSanitizedSmsSearch() {
  if (!smsRecordSearch) return '';
  let val = smsRecordSearch.value.trim();
  const userEmail = (currentUser && currentUser.email) ? currentUser.email.toLowerCase() : '';
  const adminEmailText = adminUserEmail ? adminUserEmail.textContent.toLowerCase() : '';

  if (val) {
    const lower = val.toLowerCase();
    if (
      (userEmail && lower === userEmail) ||
      (adminEmailText && adminEmailText.includes(lower) && lower.includes('@')) ||
      (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower))
    ) {
      smsRecordSearch.value = '';
      if (clearSmsSearchBtn) clearSmsSearchBtn.style.display = 'none';
      return '';
    }
  }
  return val;
}

function syncSmsSearchClearBtn() {
  if (clearSmsSearchBtn && smsRecordSearch) {
    clearSmsSearchBtn.style.display = smsRecordSearch.value ? 'inline-block' : 'none';
  }
}

async function loadSmsManagement() {
  getSanitizedSmsSearch();
  syncSmsSearchClearBtn();
  await loadSmsConfig();
  await loadSmsLogs();
}

async function loadSmsConfig() {
  try {
    const res = await fetch('/api/admin/sms/config');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const cfg = data.config || {};
    if (smsApiKey) {
      smsApiKey.value = cfg.hasApiKey ? '********' : '';
      smsApiKey.dataset.hasKey = cfg.hasApiKey ? 'true' : 'false';
    }

    if (smsConfigStatusBadge) {
      if (cfg.hasApiKey) {
        smsConfigStatusBadge.textContent = '已配置 Key';
        smsConfigStatusBadge.className = 'badge-status active';
      } else {
        smsConfigStatusBadge.textContent = '未配置 Key';
        smsConfigStatusBadge.className = 'badge-status used';
      }
    }
  } catch (err) {
    console.error('加载接码配置失败:', err);
  }
}

// 密钥明文显示/隐藏
if (toggleSmsKeyVisBtn && smsApiKey) {
  toggleSmsKeyVisBtn.addEventListener('click', () => {
    if (smsApiKey.type === 'password') {
      smsApiKey.type = 'text';
      toggleSmsKeyVisBtn.textContent = '🔒';
    } else {
      smsApiKey.type = 'password';
      toggleSmsKeyVisBtn.textContent = '👁️';
    }
  });
}

// 保存配置
if (smsConfigForm) {
  smsConfigForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (saveSmsConfigBtn) {
      saveSmsConfigBtn.disabled = true;
      saveSmsConfigBtn.textContent = '保存中…';
    }

    try {
      const payload = {};
      if (smsApiKey && smsApiKey.value.trim() && !smsApiKey.value.includes('****')) {
        payload.apiKey = smsApiKey.value.trim();
      }

      const res = await fetch('/api/admin/sms/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      if (smsConfigMsg) {
        smsConfigMsg.style.color = '#52c41a';
        smsConfigMsg.textContent = '✓ API Key 保存成功，后续脚本可直接调用';
        setTimeout(() => { smsConfigMsg.textContent = ''; }, 3000);
      }
      showToast('API Key 已成功保存', 'success');
      loadSmsConfig();
    } catch (err) {
      if (smsConfigMsg) {
        smsConfigMsg.style.color = '#ff4d4f';
        smsConfigMsg.textContent = `❌ 保存失败: ${err.message}`;
      }
      showToast(`保存失败: ${err.message}`, 'error');
    } finally {
      if (saveSmsConfigBtn) {
        saveSmsConfigBtn.disabled = false;
        saveSmsConfigBtn.textContent = '💾 保存配置';
      }
    }
  });
}

// 测试连通性
if (testSmsConnBtn) {
  testSmsConnBtn.addEventListener('click', async () => {
    testSmsConnBtn.disabled = true;
    testSmsConnBtn.textContent = '测试中…';
    if (smsConfigMsg) {
      smsConfigMsg.style.color = '#1677ff';
      smsConfigMsg.textContent = '正在探测玄武平台连通性…';
    }

    try {
      const payload = {};
      if (smsApiKey && smsApiKey.value.trim() && !smsApiKey.value.includes('****')) {
        payload.apiKey = smsApiKey.value.trim();
      }

      const res = await fetch('/api/admin/sms/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.ok) {
        if (smsConfigMsg) {
          smsConfigMsg.style.color = '#52c41a';
          smsConfigMsg.textContent = `✓ 连通正常 (${data.latencyMs}ms)，共 ${data.projectCount || 0} 个项目`;
        }
        showToast(`玄武平台连通正常 (${data.latencyMs}ms)`, 'success');
      } else {
        if (smsConfigMsg) {
          smsConfigMsg.style.color = '#ff4d4f';
          smsConfigMsg.textContent = `❌ 连接异常: ${data.error || '失败'}`;
        }
        showToast(`测试失败: ${data.error || '无法连通'}`, 'error');
      }
    } catch (err) {
      if (smsConfigMsg) {
        smsConfigMsg.style.color = '#ff4d4f';
        smsConfigMsg.textContent = `❌ 网络异常: ${err.message}`;
      }
      showToast(err.message, 'error');
    } finally {
      testSmsConnBtn.disabled = false;
      testSmsConnBtn.textContent = '⚡ 测试连通性';
      getSanitizedSmsSearch();
      loadSmsLogs();
    }
  });
}

// 脚本调用日志列表与详情展开
async function loadSmsLogs() {
  if (!smsRecordsTableBody) return;
  try {
    const search = getSanitizedSmsSearch();
    syncSmsSearchClearBtn();
    const status = smsRecordStatusFilter ? smsRecordStatusFilter.value : '';

    const params = new URLSearchParams({ limit: '100' });
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    const res = await fetch(`/api/admin/sms/logs?${params.toString()}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const logs = data.logs || [];
    if (smsLogTotalCount) {
      smsLogTotalCount.textContent = `共 ${data.total || logs.length} 条记录`;
    }

    if (logs.length === 0) {
      smsRecordsTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#8c8c8c;">暂无脚本调用日志（后续脚本调用玄武 API 时将自动在此记录）</td></tr>';
      return;
    }

    smsRecordsTableBody.innerHTML = logs.map(l => {
      // 动作标签美化
      let actionTag = `<code style="font-size:12px;">${escapeHtml(l.action)}</code>`;
      if (l.action === 'phone/get') {
        actionTag = '<span style="background:#e6f4ff; color:#0958d9; padding:2px 8px; border-radius:4px; font-weight:600; font-size:12px;">取号 (phone/get)</span>';
      } else if (l.action === 'sms/get') {
        actionTag = '<span style="background:#f6ffed; color:#389e0d; padding:2px 8px; border-radius:4px; font-weight:600; font-size:12px;">查码 (sms/get)</span>';
      } else if (l.action === 'project/list') {
        actionTag = '<span style="background:#fff7e6; color:#d46b08; padding:2px 8px; border-radius:4px; font-weight:600; font-size:12px;">项目列表 (project/list)</span>';
      }

      const statusTag = l.status === 'success'
        ? '<span class="badge-status active">成功</span>'
        : '<span class="badge-status revoked">失败</span>';

      const phoneDisplay = l.phone_number
        ? `<code style="color:#1677ff; font-weight:700; cursor:pointer;" title="点击复制号码" onclick="copyCardCode('${escapeHtml(l.phone_number)}')">${escapeHtml(l.phone_number)}</code>`
        : '<span style="color:#bfbfbf;">--</span>';

      const codeDisplay = l.sms_code
        ? `<code style="color:#52c41a; font-weight:800; font-size:14px; cursor:pointer;" title="点击复制验证码" onclick="copyCardCode('${escapeHtml(l.sms_code)}')">${escapeHtml(l.sms_code)}</code>`
        : '<span style="color:#bfbfbf;">--</span>';

      // 格式化参数与返回值
      let formattedParams = '{}';
      try {
        const obj = typeof l.request_params === 'string' ? JSON.parse(l.request_params) : l.request_params;
        formattedParams = JSON.stringify(obj, null, 2);
      } catch {
        formattedParams = String(l.request_params || '{}');
      }

      let formattedResp = '{}';
      try {
        const obj = typeof l.response_data === 'string' ? JSON.parse(l.response_data) : l.response_data;
        formattedResp = JSON.stringify(obj, null, 2);
      } catch {
        formattedResp = String(l.response_data || '{}');
      }

      return `
        <tr style="cursor: pointer;" onclick="toggleLogDetail('${l.id}', event)">
          <td>${formatDate(l.created_at)}</td>
          <td>${actionTag}</td>
          <td>${phoneDisplay}</td>
          <td>${codeDisplay}</td>
          <td>${statusTag}</td>
          <td><span style="font-family:monospace; font-size:12px; color:#595959;">${l.latency_ms || 0}ms</span></td>
          <td style="text-align: center;">
            <button class="btn-action-sm" id="btn-toggle-${l.id}" type="button" style="height:24px; padding:0 8px; font-size:12px;" onclick="event.stopPropagation(); toggleLogDetail('${l.id}')">
              展开详情 ▾
            </button>
          </td>
        </tr>
        <tr id="detail-row-${l.id}" class="log-detail-row" style="display: none;">
          <td colspan="7" style="padding: 0 16px 16px;">
            <div class="log-detail-box">
              <div style="display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 10px; color: #595959; font-size: 12px; border-bottom: 1px solid #f0f0f0; padding-bottom: 8px;">
                <span><strong>请求接口：</strong><code style="color:#1677ff;">${escapeHtml(l.request_url || l.action || '--')}</code></span>
                <span><strong>Session ID：</strong><code style="color:#595959;">${escapeHtml(l.session_id || '--')}</code></span>
                <span><strong>调用方：</strong>${escapeHtml(l.caller || '脚本调用')}</span>
                <span><strong>状态代码：</strong><code>${escapeHtml(l.status_code || '--')}</code></span>
              </div>
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px;">
                <div>
                  <div style="font-weight: 600; color: #1f1f1f; font-size: 12px;">📤 请求入参 (Request Params)：</div>
                  <pre class="log-code-pre">${escapeHtml(formattedParams)}</pre>
                </div>
                <div>
                  <div style="font-weight: 600; color: #1f1f1f; font-size: 12px;">📥 平台返回 (Response Data)：</div>
                  <pre class="log-code-pre" style="color: ${l.status === 'success' ? '#389e0d' : '#cf1322'};">${escapeHtml(formattedResp)}</pre>
                </div>
              </div>
              ${l.error_message ? `
                <div style="margin-top: 10px; padding: 8px 12px; background: #fff2f0; border: 1px solid #ffccc7; border-radius: 4px; color: #cf1322; font-size: 12px;">
                  <strong>❌ 异常详情：</strong>${escapeHtml(l.error_message)}
                </div>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    smsRecordsTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#ff4d4f; padding:30px;">加载日志失败: ${escapeHtml(err.message)}</td></tr>`;
  }
}

// 展开 / 收起调用详情
window.toggleLogDetail = (logId, event) => {
  if (event && (event.target.tagName === 'BUTTON' || event.target.tagName === 'CODE')) return;
  const row = document.getElementById(`detail-row-${logId}`);
  const btn = document.getElementById(`btn-toggle-${logId}`);
  if (!row) return;

  const isHidden = row.style.display === 'none';
  row.style.display = isHidden ? 'table-row' : 'none';
  if (btn) {
    btn.textContent = isHidden ? '收起详情 ▴' : '展开详情 ▾';
  }
};

if (refreshSmsRecordsBtn) refreshSmsRecordsBtn.addEventListener('click', () => {
  getSanitizedSmsSearch();
  loadSmsLogs();
});
if (smsRecordSearch) {
  smsRecordSearch.addEventListener('input', () => {
    syncSmsSearchClearBtn();
    debounce(loadSmsLogs, 300)();
  });
}
if (clearSmsSearchBtn) {
  clearSmsSearchBtn.addEventListener('click', () => {
    if (smsRecordSearch) {
      smsRecordSearch.value = '';
      syncSmsSearchClearBtn();
      loadSmsLogs();
      smsRecordSearch.focus();
    }
  });
}
if (smsRecordStatusFilter) smsRecordStatusFilter.addEventListener('change', loadSmsLogs);

// 清空调用日志
if (clearSmsRecordsBtn) {
  clearSmsRecordsBtn.addEventListener('click', async () => {
    const confirmed = await showConfirm({
      title: '确认清空接码调用日志？',
      desc: '确认要清空全部脚本调用日志记录吗？此操作无法撤销。',
      okText: '确认清空',
      cancelText: '取消',
      isDanger: true,
      icon: '🗑️'
    });
    if (!confirmed) return;

    try {
      const res = await fetch('/api/admin/sms/logs', { method: 'DELETE' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      showToast('已清空接码调用日志', 'success');
      loadSmsLogs();
    } catch (err) {
      showToast(`清空失败: ${err.message}`, 'error');
    }
  });
}

function debounce(fn, delay = 300) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Initial bootstrap
checkAuth();
const initialTab = getTabFromUrl();
switchTab(initialTab, { updateHistory: false });

window.toggleZhencanStatus = async function(fileName, targetStatus) {
  try {
    const res = await fetch('/api/cloud-disk/zhencan/toggle-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, status: targetStatus })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || '操作失败');
    showToast(data.message || '真参状态已更新', 'success');
    loadAdminDiskFiles();
  } catch (err) {
    showToast('更新真参状态失败: ' + err.message, 'error');
  }
};
