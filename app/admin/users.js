'use strict';

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
            <button class="btn-action-sm ${u.status === 'active' ? 'danger' : ''}" data-user-status-action data-user-id="${escapeHtml(u.id)}" data-user-email="${escapeHtml(u.email)}" data-target-status="${u.status === 'active' ? 'banned' : 'active'}">
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

usersTableBody?.addEventListener('click', event => {
  const button = event.target.closest('[data-user-status-action]');
  if (!button || !usersTableBody.contains(button)) return;
  toggleUserStatus(button.dataset.userId, button.dataset.targetStatus, button.dataset.userEmail);
});

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

