'use strict';

// 3. Users Management
const usersRequests = createAdminLatestRequest();
const cardsRequests = createAdminLatestRequest();
const poolRequests = createAdminLatestRequest();
async function loadUsers() {
  if (!usersTableBody) return;
  const request = usersRequests.start();
  usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:#8c8c8c;">正在加载用户列表…</td></tr>';
  try {
    const res = await fetch('/api/admin/users', { signal: request.signal });
    const data = await res.json();
    if (!request.isCurrent()) return;
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
          <button type="button" class="btn-action-sm" data-admin-user-detail="${escapeHtml(u.id)}">详情 / 权益</button>
          ${u.role === 'admin' ? '<span style="color:#8c8c8c; font-size:12px;">主账号 (不可操作)</span>' : `
            <button class="btn-action-sm ${u.status === 'active' ? 'danger' : ''}" data-user-status-action data-user-id="${escapeHtml(u.id)}" data-user-email="${escapeHtml(u.email)}" data-target-status="${u.status === 'active' ? 'banned' : 'active'}">
              ${u.status === 'active' ? '封禁' : '解封'}
            </button>
          `}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    if (!request.isCurrent() || err.name === 'AbortError') return;
    usersTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#ff4d4f; padding:30px;">加载失败: ${escapeHtml(err.message)}</td></tr>`;
  }
}

usersTableBody?.addEventListener('click', event => {
  const detailButton = event.target.closest('[data-admin-user-detail]');
  if (detailButton && usersTableBody.contains(detailButton)) {
    openAdminUserDetails(detailButton.dataset.adminUserDetail);
    return;
  }
  const button = event.target.closest('[data-user-status-action]');
  if (!button || !usersTableBody.contains(button)) return;
  toggleUserStatus(button.dataset.userId, button.dataset.targetStatus, button.dataset.userEmail);
});

window.toggleUserStatus = async (userId, targetStatus, userEmail = '') => {
  const key = 'user-status:' + userId;
  if (adminWriteGuard.isPending(key)) return;
  const isBan = targetStatus === 'banned';
  const confirmed = await showConfirm({
    title: isBan ? '确认封禁该用户？' : '确认解封该用户？',
    desc: `确认要将用户 <strong>${escapeHtml(userEmail || userId)}</strong> 的状态变更为【<strong>${isBan ? '封禁' : '解封'}</strong>】吗？${isBan ? '<br><span class="admin-confirm-warning">封禁后该用户将无法登录系统和操作名下云机。</span>' : ''}`,
    okText: isBan ? '确认封禁' : '确认解封',
    cancelText: '取消',
    isDanger: isBan,
    icon: isBan ? '🚫' : '🔓'
  });

  if (!confirmed || !adminWriteGuard.begin(key)) return;
  try {
    const res = await fetch('/api/admin/users/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, status: targetStatus })
    });
    const data = await res.json();
    if (!data.ok && data.statusApplied) {
      showToast('账号状态已变更，但部分任务未能停止：' + (data.error || '请检查设备'), 'error');
      loadUsers();
      return;
    }
    if (!data.ok) throw new Error(data.error);
    showToast(`已成功${isBan ? '封禁' : '解封'}该用户`, 'success');
    loadUsers();
  } catch (err) {
    showToast(`操作失败: ${err.message}`, 'error');
  } finally {
    adminWriteGuard.end(key);
  }
};

if (refreshUsersBtn) refreshUsersBtn.addEventListener('click', loadUsers);

// 管理员可从用户列表或设备池直接查看该用户的权益与租赁设备。
let adminDetailSeq = 0;
let adminDetailUserId = '';
let adminDetailController = null;
async function openAdminUserDetails(userId) {
  if (!userId) return;
  const overlay = document.getElementById('adminUserDetailOverlay');
  const title = document.getElementById('adminUserDetailTitle');
  const subtitle = document.getElementById('adminUserDetailSubtitle');
  const content = document.getElementById('adminUserDetailContent');
  if (!overlay || !content) return;
  adminDetailUserId = userId;
  adminDetailController?.abort();
  adminDetailController = new AbortController();
  const requestId = ++adminDetailSeq;
  overlay.hidden = false;
  document.getElementById('adminUserDetailClose')?.focus();
  title.textContent = '用户详情';
  subtitle.textContent = '正在读取用户与权益数据…';
  content.textContent = '正在加载…';
  try {
    const res = await fetch('/api/admin/users/detail?userId=' + encodeURIComponent(userId),
      { signal: adminDetailController.signal });
    const data = await res.json();
    if (requestId !== adminDetailSeq || overlay.hidden) return;
    if (!res.ok || !data.ok) throw new Error(data.error || '无法获取用户详情');
    title.textContent = data.user.email;
    subtitle.textContent = data.user.status === 'active' ? '账号正常' : '账号已封禁';
    const devices = data.allocations || [];
    const redeems = data.redemptions || [];
    content.innerHTML = `
      <div class="admin-detail-block">
        <h3>当前权益</h3>
        <div class="admin-detail-record"><span>租赁云机</span><strong>${devices.length} 台</strong></div>
        <div class="admin-detail-record"><span>真参剩余额度</span><strong>${Number(data.zhencanBalance || 0)} 套</strong></div>
        <div class="admin-detail-record"><span>IP 权益</span><strong>${data.ip?.active ? '有效，至 ' + escapeHtml(formatDate(data.ip.expireAt)) : '未生效 / 已过期'}</strong></div>
      </div>
      <div class="admin-detail-block">
        <h3>当前租赁设备</h3>
        ${devices.length ? devices.map(item => `
          <div class="admin-detail-record">
            <span><strong>${escapeHtml(item.deviceName || item.deviceId)}</strong>
              <span class="admin-detail-muted">ID: ${escapeHtml(item.deviceId)} · 到期 ${escapeHtml(formatDate(item.expireAt))}</span></span>
            <span class="admin-detail-actions">
              <button type="button" class="btn-action-sm" data-admin-detail-open-device="${escapeHtml(item.deviceId)}">控制设备</button>
              <button type="button" class="btn-action-sm" data-admin-detail-pool-device="${escapeHtml(item.deviceId)}">租赁管理</button>
            </span>
          </div>`).join('') : '<p class="admin-detail-muted">当前没有有效的租赁设备。</p>'}
      </div>
      <div class="admin-detail-block">
        <h3>近期卡密兑换（最多 20 条）</h3>
        ${redeems.length ? redeems.map(item => `
          <div class="admin-detail-record"><span>${escapeHtml(item.summary || '兑换权益')}</span>
            <span class="admin-detail-muted">${escapeHtml(formatDate(item.redeemedAt))}</span></div>
        `).join('') : '<p class="admin-detail-muted">暂无兑换记录。</p>'}
        <button class="btn-action-sm" type="button" data-admin-detail-cards>打开卡密管理</button>
      </div>
    `;
  } catch (error) {
    if (requestId === adminDetailSeq && !overlay.hidden && error.name !== 'AbortError') {
      content.textContent = '加载失败：' + error.message;
    }
  }
}
window.openAdminUserDetails = openAdminUserDetails;

function closeAdminUserDetails() {
  ++adminDetailSeq;
  adminDetailController?.abort();
  adminDetailController = null;
  adminDetailUserId = '';
  const overlay = document.getElementById('adminUserDetailOverlay');
  if (overlay) overlay.hidden = true;
}
document.getElementById('adminUserDetailClose')?.addEventListener('click', closeAdminUserDetails);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.getElementById('adminUserDetailOverlay')?.hidden) {
    closeAdminUserDetails();
  }
});
document.getElementById('adminUserDetailOverlay')?.addEventListener('click', event => {
  if (event.target.id === 'adminUserDetailOverlay') closeAdminUserDetails();
});
document.getElementById('adminUserDetailContent')?.addEventListener('click', event => {
  const control = event.target.closest('[data-admin-detail-open-device]');
  const pool = event.target.closest('[data-admin-detail-pool-device]');
  if (control) {
    const id = control.dataset.adminDetailOpenDevice;
    closeAdminUserDetails();
    window.adminOpenDevice(id);
  } else if (pool) {
    const id = pool.dataset.adminDetailPoolDevice;
    closeAdminUserDetails();
    window.adminOpenPoolDevice(id);
  } else if (event.target.closest('[data-admin-detail-cards]')) {
    closeAdminUserDetails();
    adminNavigate('cards');
  }
});

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
  const request = cardsRequests.start();
  cardsTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:#8c8c8c;">正在加载卡密列表…</td></tr>';
  try {
    const status = cardFilterStatus ? cardFilterStatus.value : '';
    const type = cardFilterType ? cardFilterType.value : '';
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (type) params.set('type', type);

    const res = await fetch(`/api/admin/cards?${params.toString()}`, { signal: request.signal });
    const data = await res.json();
    if (!request.isCurrent()) return;
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
          <td><code style="color:#1677ff; font-weight:700; cursor:pointer;" title="点击复制" data-admin-copy-card="${escapeHtml(c.card_code)}">${escapeHtml(c.card_code)}</code></td>
          <td>${contentDisplay}</td>
          <td><span class="badge-status ${c.status}">${statusText}</span></td>
          <td>${escapeHtml(c.batch_tag || '--')}</td>
          <td>${formatDate(c.created_at)}</td>
          <td>${c.used_by_email && c.used_by_user_id
            ? `<button type="button" class="admin-link-button" data-admin-card-user="${escapeHtml(c.used_by_user_id)}">${escapeHtml(c.used_by_email)}</button>`
            : '--'}</td>
          <td>${formatDate(c.used_at)}</td>
          <td>
            ${c.status === 'unused' ? `
              <button class="btn-action-sm danger" data-admin-revoke-card="${escapeHtml(c.id)}" data-admin-revoke-code="${escapeHtml(c.card_code)}">作废</button>
            ` : '<span style="color:#8c8c8c;">--</span>'}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    if (!request.isCurrent() || err.name === 'AbortError') return;
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
  const key = 'card-revoke:' + cardId;
  if (adminWriteGuard.isPending(key)) return;
  const confirmed = await showConfirm({
    title: '确认作废该卡密？',
    desc: `确认要作废卡密 <strong class="admin-confirm-highlight admin-confirm-mono">${escapeHtml(cardCode)}</strong> 吗？<br><span class="admin-confirm-warning">作废后该卡密将立即失效，用户将无法再兑换。此操作无法撤销。</span>`,
    okText: '确认作废',
    cancelText: '取消',
    isDanger: true,
    icon: '🗑️'
  });

  if (!confirmed || !adminWriteGuard.begin(key)) return;

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
  } finally {
    adminWriteGuard.end(key);
  }
};

cardsTableBody?.addEventListener('click', event => {
  const copy = event.target.closest('[data-admin-copy-card]');
  if (copy) {
    copyCardCode(copy.dataset.adminCopyCard);
    return;
  }
  const revoke = event.target.closest('[data-admin-revoke-card]');
  if (revoke) {
    revokeCard(revoke.dataset.adminRevokeCard, revoke.dataset.adminRevokeCode);
    return;
  }
  const user = event.target.closest('[data-admin-card-user]');
  if (!user) return;
  adminNavigate('users');
  openAdminUserDetails(user.dataset.adminCardUser);
});
if (cardFilterStatus) cardFilterStatus.addEventListener('change', loadCards);
if (cardFilterType) cardFilterType.addEventListener('change', loadCards);
if (refreshCardsBtn) refreshCardsBtn.addEventListener('click', loadCards);

// 卡密生成是有实际副作用的操作；同一次提交期间禁止再次下发。
let generatingCards = false;
if (generateCardsForm) {
  generateCardsForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (generatingCards) return;

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

    generatingCards = true;
    const submitButton = generateCardsForm.querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
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
      if (!res.ok || !data.ok) {
        const error = new Error(data.error || '服务器拒绝生成卡密');
        error.confirmedFailure = true;
        throw error;
      }

      const generated = data.cards || [];
      batchCardsOutput.value = generated.map(c => c.cardCode).join('\n');
      if (cardsResultModal) cardsResultModal.style.display = 'flex';
      loadCards();
    } catch (err) {
      showToast(err.confirmedFailure
        ? '卡密生成失败：' + err.message
        : '卡密生成结果未确认：' + err.message + '。请先刷新卡密列表核对，勿直接重复生成。',
      'error', 6500);
    } finally {
      generatingCards = false;
      if (submitButton) submitButton.disabled = false;
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
  const request = poolRequests.start();
  poolTableBody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:#8c8c8c;">正在加载设备池…</td></tr>';
  try {
    const res = await fetch('/api/admin/pool', { signal: request.signal });
    const data = await res.json();
    if (!request.isCurrent()) return;
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
      <tr data-admin-pool-device="${escapeHtml(dev.deviceId)}" class="${window.adminPendingPoolDeviceId === dev.deviceId ? 'admin-target-row' : ''}">
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
        <td>${dev.userEmail && dev.userId ? `<button type="button" class="admin-link-button" data-admin-pool-user="${escapeHtml(dev.userId)}">${escapeHtml(dev.userEmail)}</button>` : '<span style="color:#8c8c8c;">--</span>'}</td>
        <td>${dev.expireAt ? formatDate(dev.expireAt) : '<span style="color:#8c8c8c;">--</span>'}</td>
        <td>${dev.remainingMs ? formatRemaining(dev.remainingMs) : '<span style="color:#8c8c8c;">--</span>'}</td>
        <td>
          <button type="button" class="btn-action-sm" data-admin-pool-control="${escapeHtml(dev.deviceId)}">控制</button>
          <button type="button" class="btn-action-sm" data-admin-pool-disk="${escapeHtml(dev.deviceId)}">资源</button>
          ${dev.allocated ? `
            <button type="button" class="btn-action-sm danger" data-admin-pool-recycle="${escapeHtml(dev.allocationId)}" data-admin-pool-recycle-device="${escapeHtml(dev.deviceId)}" data-admin-pool-recycle-name="${escapeHtml(dev.name || dev.deviceId)}">
              强制回收
            </button>
          ` : '<span style="color:#8c8c8c;">无需操作</span>'}
        </td>
      </tr>
    `).join('');
    if (window.adminPendingPoolDeviceId) {
      const target = [...poolTableBody.querySelectorAll('[data-admin-pool-device]')]
        .find(row => row.dataset.adminPoolDevice === window.adminPendingPoolDeviceId);
      target?.scrollIntoView({ block: 'nearest' });
      window.adminPendingPoolDeviceId = '';
    }
  } catch (err) {
    if (!request.isCurrent() || err.name === 'AbortError') return;
    poolTableBody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#ff4d4f; padding:30px;">加载失败: ${escapeHtml(err.message)}</td></tr>`;
  }
}

window.recycleDevice = async (allocationId, deviceId, devName = '') => {
  const key = 'device-recycle:' + allocationId;
  if (adminWriteGuard.isPending(key)) return;
  const confirmed = await showConfirm({
    title: '确认强制回收该云机？',
    desc: `确认强制解绑并回收云机 <strong>${escapeHtml(devName || deviceId)}</strong> 吗？<br><span class="admin-confirm-warning">当前正在进行的连接将立即断开，设备将重归空闲待分配库存。</span>`,
    okText: '强制回收',
    cancelText: '取消',
    isDanger: true,
    icon: '⚡'
  });

  if (!confirmed || !adminWriteGuard.begin(key)) return;

  try {
    const res = await fetch('/api/admin/devices/recycle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocationId, deviceId })
    });
    const data = await res.json();
    if (!data.ok && data.statusApplied) {
      showToast('设备已回收，但部分任务仍未确认停止：' + (data.error || '请检查设备'), 'error');
      loadPool();
      return;
    }
    if (!data.ok) throw new Error(data.error);
    showToast('已成功解绑并回收该云机', 'success');
    loadPool();
  } catch (err) {
    showToast(`回收失败: ${err.message}`, 'error');
  } finally {
    adminWriteGuard.end(key);
  }
};

poolTableBody?.addEventListener('click', event => {
  const user = event.target.closest('[data-admin-pool-user]');
  if (user) {
    adminNavigate('users');
    openAdminUserDetails(user.dataset.adminPoolUser);
    return;
  }
  const control = event.target.closest('[data-admin-pool-control]');
  if (control) { window.adminOpenDevice(control.dataset.adminPoolControl); return; }
  const disk = event.target.closest('[data-admin-pool-disk]');
  if (disk) { window.adminOpenDiskDevice(disk.dataset.adminPoolDisk); return; }
  const recycle = event.target.closest('[data-admin-pool-recycle]');
  if (recycle) {
    window.recycleDevice(recycle.dataset.adminPoolRecycle,
      recycle.dataset.adminPoolRecycleDevice, recycle.dataset.adminPoolRecycleName);
  }
});
if (refreshPoolBtn) refreshPoolBtn.addEventListener('click', loadPool);

