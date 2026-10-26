'use strict';

let currentUser = null;

// DOM Elements
const adminUserEmail = document.getElementById('adminUserEmail');
const adminLogoutBtn = document.getElementById('adminLogoutBtn');
const navItems = document.querySelectorAll('.nav-item');
const tabContents = document.querySelectorAll('.tab-content');

// Users DOM
const statUsersCount = document.getElementById('statUsersCount');
const statActiveUsersCount = document.getElementById('statActiveUsersCount');
const statBannedUsersCount = document.getElementById('statBannedUsersCount');
const usersTableBody = document.getElementById('usersTableBody');
const refreshUsersBtn = document.getElementById('refreshUsersBtn');

// Cards DOM
const generateCardsForm = document.getElementById('generateCardsForm');
const cardDurationDays = document.getElementById('cardDurationDays');
const cardDurationHours = document.getElementById('cardDurationHours');
const cardCount = document.getElementById('cardCount');
const cardBatchTag = document.getElementById('cardBatchTag');
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

function formatDate(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatRemaining(ms) {
  if (!ms || ms <= 0) return '<span style="color:#f85149">已到期</span>';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
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
    adminUserEmail.textContent = `管理员: ${currentUser.email}`;
  } catch {
    location.href = '/login.html';
  }
}

// 2. Navigation Tabs
navItems.forEach(item => {
  item.addEventListener('click', () => {
    const targetTab = item.getAttribute('data-tab');
    navItems.forEach(n => n.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));

    item.classList.add('active');
    const content = document.getElementById(`tab-${targetTab}`);
    if (content) content.classList.add('active');

    if (targetTab === 'users') loadUsers();
    else if (targetTab === 'cards') loadCards();
    else if (targetTab === 'pool') loadPool();
  });
});

// Logout
adminLogoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});

// 3. Users Management
async function loadUsers() {
  usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px;">正在加载用户列表…</td></tr>';
  try {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const users = data.users || [];
    statUsersCount.textContent = users.length;
    statActiveUsersCount.textContent = users.filter(u => u.status === 'active').length;
    statBannedUsersCount.textContent = users.filter(u => u.status === 'banned').length;

    if (users.length === 0) {
      usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px;">暂无注册用户</td></tr>';
      return;
    }

    usersTableBody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${escapeHtml(u.email)}</strong></td>
        <td><span class="panel-tag">${u.role === 'admin' ? '超级管理员' : '普通用户'}</span></td>
        <td>
          <span class="badge-status ${u.status === 'active' ? 'active' : 'banned'}">
            ${u.status === 'active' ? '正常' : '已封禁'}
          </span>
        </td>
        <td><strong style="color:var(--blue)">${u.active_devices || 0}</strong> 台</td>
        <td>${formatDate(u.created_at)}</td>
        <td>
          ${u.role === 'admin' ? '<span style="color:var(--text-dim)">系统主账号</span>' : `
            <button class="outline-button" style="padding:4px 8px; font-size:12px;" onclick="toggleUserStatus('${u.id}', '${u.status === 'active' ? 'banned' : 'active'}')">
              ${u.status === 'active' ? '封禁' : '解封'}
            </button>
          `}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    usersTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#ff7b72; padding:30px;">加载失败: ${err.message}</td></tr>`;
  }
}

window.toggleUserStatus = async (userId, targetStatus) => {
  if (!confirm(`确认要将该用户状态变更为【${targetStatus === 'banned' ? '封禁' : '解封'}】吗？`)) return;
  try {
    const res = await fetch('/api/admin/users/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, status: targetStatus })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    loadUsers();
  } catch (err) {
    alert(`操作失败: ${err.message}`);
  }
};

refreshUsersBtn.addEventListener('click', loadUsers);

// 4. Cards Management
async function loadCards() {
  cardsTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px;">正在加载卡密列表…</td></tr>';
  try {
    const status = cardFilterStatus.value;
    const res = await fetch(`/api/admin/cards?status=${encodeURIComponent(status)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const cards = data.cards || [];
    if (cards.length === 0) {
      cardsTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px;">未查找到符合条件的卡密</td></tr>';
      return;
    }

    cardsTableBody.innerHTML = cards.map(c => {
      const durationParts = [];
      if (c.duration_days > 0) durationParts.push(`${c.duration_days}天`);
      if (c.duration_hours > 0) durationParts.push(`${c.duration_hours}小时`);
      const durationText = durationParts.join('') || '0天';

      let statusText = '未使用';
      if (c.status === 'used') statusText = '已使用';
      else if (c.status === 'revoked') statusText = '已作废';

      return `
        <tr>
          <td><code style="color:var(--cyan); font-weight:600;">${c.card_code}</code></td>
          <td>${durationText}</td>
          <td><span class="badge-status ${c.status}">${statusText}</span></td>
          <td>${escapeHtml(c.batch_tag || '--')}</td>
          <td>${formatDate(c.created_at)}</td>
          <td>${c.used_by_email ? escapeHtml(c.used_by_email) : '--'}</td>
          <td>${formatDate(c.used_at)}</td>
          <td>
            ${c.status === 'unused' ? `
              <button class="danger-button" style="padding:4px 8px; font-size:12px;" onclick="revokeCard('${c.id}')">作废</button>
            ` : '<span style="color:var(--text-dim)">--</span>'}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    cardsTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#ff7b72; padding:30px;">加载失败: ${err.message}</td></tr>`;
  }
}

window.revokeCard = async cardId => {
  if (!confirm('确认作废该卡密？作废后用户将无法兑换！')) return;
  try {
    const res = await fetch('/api/admin/cards/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    loadCards();
  } catch (err) {
    alert(`作废失败: ${err.message}`);
  }
};

cardFilterStatus.addEventListener('change', loadCards);
refreshCardsBtn.addEventListener('click', loadCards);

// Generate Cards
generateCardsForm.addEventListener('submit', async event => {
  event.preventDefault();
  const days = parseInt(cardDurationDays.value, 10) || 0;
  const hours = parseInt(cardDurationHours.value, 10) || 0;
  const count = parseInt(cardCount.value, 10) || 1;
  const batchTag = cardBatchTag.value.trim();

  if (days === 0 && hours === 0) {
    alert('请至少指定天数或小时数！');
    return;
  }

  try {
    const res = await fetch('/api/admin/cards/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationDays: days, durationHours: hours, count, batchTag })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const generated = data.cards || [];
    batchCardsOutput.value = generated.map(c => c.cardCode).join('\n');
    cardsResultModal.style.display = 'flex';
    loadCards();
  } catch (err) {
    alert(`生成失败: ${err.message}`);
  }
});

closeCardsModalBtn.addEventListener('click', () => {
  cardsResultModal.style.display = 'none';
});

copyAllCardsBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(batchCardsOutput.value)
    .then(() => alert('已成功复制全部卡密到剪贴板！'))
    .catch(() => alert('复制失败，请手动选取复制'));
});

downloadCardsTxtBtn.addEventListener('click', () => {
  const blob = new Blob([batchCardsOutput.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `卡密列表_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

// 5. Device Pool Management
async function loadPool() {
  poolTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px;">正在加载设备池…</td></tr>';
  try {
    const res = await fetch('/api/admin/pool');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    statPoolTotal.textContent = data.total || 0;
    statPoolAllocated.textContent = data.allocatedCount || 0;
    statPoolIdle.textContent = data.idleCount || 0;

    const pool = data.pool || [];
    if (pool.length === 0) {
      poolTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px;">主账号下暂无云机，请检查云端登录态</td></tr>';
      return;
    }

    poolTableBody.innerHTML = pool.map(dev => `
      <tr>
        <td><code>${escapeHtml(dev.deviceId)}</code></td>
        <td><strong>${escapeHtml(dev.name || 'SF')}</strong></td>
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
        <td>${dev.userEmail ? `<strong>${escapeHtml(dev.userEmail)}</strong>` : '<span style="color:var(--text-dim)">--</span>'}</td>
        <td>${dev.expireAt ? formatDate(dev.expireAt) : '<span style="color:var(--text-dim)">--</span>'}</td>
        <td>${dev.remainingMs ? formatRemaining(dev.remainingMs) : '<span style="color:var(--text-dim)">--</span>'}</td>
        <td>
          ${dev.allocated ? `
            <button class="danger-button" style="padding:4px 8px; font-size:12px;" onclick="recycleDevice('${dev.allocationId}', '${dev.deviceId}')">
              强制回收
            </button>
          ` : '<span style="color:var(--text-dim)">无需操作</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    poolTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#ff7b72; padding:30px;">加载失败: ${err.message}</td></tr>`;
  }
}

window.recycleDevice = async (allocationId, deviceId) => {
  if (!confirm('确认强制解绑并回收该云机？当前正在进行的连接将立即断开！')) return;
  try {
    const res = await fetch('/api/admin/devices/recycle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocationId, deviceId })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    loadPool();
  } catch (err) {
    alert(`回收失败: ${err.message}`);
  }
};

refreshPoolBtn.addEventListener('click', loadPool);

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Initial bootstrap
checkAuth();
