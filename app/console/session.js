'use strict';

// V3 会话模块：鉴权、数据加载编排、跨页互斥状态、日志页、设置页、兑换与改密。

/* ---------- 跨页互斥提示 ---------- */

function renderSharedActivity() {
  const box = elements.sharedActivity;
  if (!box) return;
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
  box.textContent = messages.join('\n');
  box.hidden = messages.length === 0;
}

/* ---------- 鉴权 ---------- */

async function checkAuth() {
  try {
    const savedToken = localStorage.getItem('yunmomo.auth_token');
    const headers = savedToken ? { Authorization: `Bearer ${savedToken}` } : {};
    const res = await fetch('/api/auth/me', { headers });
    const data = await res.json();
    if (!data.ok || !data.user) {
      if (!isEmbedMode) location.href = '/login.html';
      return null;
    }
    state.currentUser = data.user;
    state.isAdmin = data.user.role === 'admin';

    const email = elements.userEmail;
    if (email) { email.hidden = false; email.textContent = data.user.email; email.title = data.user.email; }
    if (elements.adminPortalLink) elements.adminPortalLink.hidden = !state.isAdmin;
    if (elements.userLogoutBtn) elements.userLogoutBtn.hidden = Boolean(isEmbedMode);

    const quota = byId('topbarZhencanQuota');
    if (quota) {
      quota.hidden = false;
      if (state.isAdmin) {
        quota.textContent = '真参配额：管理员无限';
        quota.classList.remove('empty');
        quota.title = '管理员特权免扣真参配额';
      } else {
        const count = parseInt(data.user.zhencanBalance, 10) || 0;
        quota.textContent = `真参配额：${count} 套`;
        quota.classList.toggle('empty', count <= 0);
        quota.title = `当前可用真参配额: ${count} 套，导入真参自动核销 1 套，可通过卡密兑换充值`;
      }
    }

    if (elements.tabTerminalSystem) elements.tabTerminalSystem.hidden = !state.isAdmin;
    if (elements.dockTabTerminalSystem) elements.dockTabTerminalSystem.hidden = !state.isAdmin;
    if (elements.diagReportBtn) elements.diagReportBtn.hidden = !state.isAdmin;
    const sessionPanel = byId('sessionPanel');
    if (sessionPanel) sessionPanel.hidden = !state.isAdmin;
    const adminEntryPanel = byId('adminEntryPanel');
    if (adminEntryPanel) adminEntryPanel.hidden = !state.isAdmin;

    renderSettingsAccount();
    eventBus.dispatchEvent(new CustomEvent('auth:changed', { detail: { user: data.user } }));
    return data.user;
  } catch {
    if (!isEmbedMode) location.href = '/login.html';
    return null;
  }
}

function renderSettingsAccount() {
  const user = state.currentUser;
  const email = byId('settingsEmail');
  const role = byId('settingsRole');
  const quotaRow = byId('settingsQuotaRow');
  const quotaVal = byId('settingsQuota');
  if (email) email.textContent = user?.email || '--';
  if (role) role.textContent = user ? (state.isAdmin ? '管理员' : '普通用户') : '--';
  if (quotaRow && quotaVal) {
    if (state.isAdmin) {
      quotaRow.hidden = false;
      quotaVal.textContent = '管理员无限';
    } else if (user) {
      quotaRow.hidden = false;
      quotaVal.textContent = `${parseInt(user.zhencanBalance, 10) || 0} 套`;
    }
  }
}

/* ---------- 状态与数据加载 ---------- */

async function loadStatus() {
  try {
    const status = await requestJson('/api/status');
    state.tokenConfigured = status.tokenConfigured === true;
    const sessionPanel = byId('sessionPanel');
    if (sessionPanel) sessionPanel.hidden = !state.isAdmin;
    if (state.tokenConfigured) {
      setService('ready', status.sessionSource === 'local-session' ? '网页登录态已就绪' : '已连接');
    } else {
      setService('error', '平台会话待同步，请联系管理员在「设置 → 平台会话」导入');
      state.devices = [];
      state.selectedDeviceId = '';
      eventBus.dispatchEvent(new CustomEvent('devices:changed'));
    }
  } catch {
    setService('error', '本地服务不可用');
  }
}

async function loadScripts() {
  try {
    const data = await requestJson('/api/scripts');
    state.scripts = Array.isArray(data.scripts) ? data.scripts : [];
    state.bundles = Array.isArray(data.bundles) ? data.bundles : [];
    state.visibility = data.visibility || { groups: {}, scripts: {} };
    if (data.isAdmin !== undefined) state.isAdmin = Boolean(data.isAdmin);
    if (!state.taskScriptId) {
      const firstMomo = state.scripts.filter(s => s.category === 'momo' && !s.batch)
        .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))[0];
      state.taskScriptId = firstMomo?.id || state.scripts.find(s => !s.batch)?.id || '';
    }
    eventBus.dispatchEvent(new CustomEvent('scripts:changed'));
  } catch (error) {
    const host = byId('taskGroups');
    if (host) host.innerHTML = `<div class="empty">脚本加载失败：${escapeHtml(error.message)}</div>`;
  }
}

let isDevicesLoading = false;
async function loadDevices(isBackground = false) {
  if (isDevicesLoading) return;
  if (isBackground && (!state.tokenConfigured || document.hidden)) return;
  isDevicesLoading = true;
  const refreshBtn = elements.refreshDevices;
  if (!isBackground && refreshBtn) refreshBtn.disabled = true;
  try {
    const data = await requestJson('/api/devices');
    state.devices = Array.isArray(data.devices) ? data.devices : [];
    if (!state.devices.some(d => d.deviceId === state.selectedDeviceId)) {
      state.selectedDeviceId = state.devices[0]?.deviceId || '';
      if (state.selectedDeviceId) {
        eventBus.dispatchEvent(new CustomEvent('device:selected', { detail: { deviceId: state.selectedDeviceId } }));
        window.dispatchEvent(new CustomEvent('device:selected', { detail: { deviceId: state.selectedDeviceId } }));
      }
    }
    eventBus.dispatchEvent(new CustomEvent('devices:changed'));
    if (!isBackground && !state.devices.length) showToast('当前账号没有可用云机');
  } catch (error) {
    if (!isBackground) {
      state.devices = [];
      state.selectedDeviceId = '';
      eventBus.dispatchEvent(new CustomEvent('devices:changed'));
      showToast(error.message);
    }
    if (error.status === 401 || /Token|YUNMOMO_TOKEN/.test(error.message)) {
      state.tokenConfigured = false;
      setService('error', '网页登录已过期');
    }
  } finally {
    isDevicesLoading = false;
    if (!isBackground && refreshBtn) refreshBtn.disabled = false;
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
  eventBus.dispatchEvent(new CustomEvent('runtime:changed'));
  updateStopButton();
}

window.loadStatus = loadStatus;
window.loadDevices = loadDevices;
window.loadScripts = loadScripts;
window.loadSharedRuntimeState = loadSharedRuntimeState;

/* ---------- 运行日志页 ---------- */

function updateStopButton() {
  const btn = elements.stopScriptBtn;
  const dockBtn = elements.dockStopScriptBtn;
  const busy = Boolean(state.activeRun || state.activeBundleRun || state.batchRunning);
  const text = state.batchRunning ? '停止批量任务' : '停止脚本';
  if (btn) {
    btn.hidden = !busy;
    btn.textContent = text;
  }
  if (dockBtn) {
    dockBtn.hidden = !busy;
    dockBtn.textContent = text;
  }
  const pulse = elements.dockPulse;
  if (pulse) pulse.classList.toggle('running', busy);
}

function updateSystemLogView() {
  const logs = window.AppLogger ? window.AppLogger.getLogs() : [];
  const text = !logs.length ? '暂无系统日志。' : logs.map(item => {
    const details = item.details ? ' ' + (typeof item.details === 'string' ? item.details : JSON.stringify(item.details)) : '';
    return `[${item.time}] [${item.level}] [${item.tag}] ${item.message}${details}`;
  }).join('\n');
  const box = elements.systemLogBox;
  if (box) {
    box.textContent = text;
    box.scrollTop = box.scrollHeight;
  }
  const dockBox = elements.dockSystemLogBox;
  if (dockBox) {
    dockBox.textContent = text;
    dockBox.scrollTop = dockBox.scrollHeight;
  }
}

function updateSystemLogBadge() {
  if (!window.AppLogger) return;
  const count = window.AppLogger.getErrorCount();
  const countStr = String(count);
  const isHidden = count <= 0;
  const badge = elements.systemLogBadge;
  if (badge) {
    badge.textContent = countStr;
    badge.hidden = isHidden;
  }
  const dockBadge = elements.dockSystemLogBadge;
  if (dockBadge) {
    dockBadge.textContent = countStr;
    dockBadge.hidden = isHidden;
  }
  const miniBadge = elements.dockMiniBadge;
  if (miniBadge) {
    miniBadge.textContent = countStr;
    miniBadge.hidden = isHidden;
  }
}

function switchLogTab(target) {
  state.logTab = target === 'system' ? 'system' : 'script';
  const isScript = state.logTab === 'script';
  elements.tabTerminalScript?.classList.toggle('active', isScript);
  elements.tabTerminalSystem?.classList.toggle('active', !isScript);
  elements.dockTabTerminalScript?.classList.toggle('active', isScript);
  elements.dockTabTerminalSystem?.classList.toggle('active', !isScript);
  if (elements.outputBox) elements.outputBox.hidden = !isScript;
  if (elements.systemLogBox) elements.systemLogBox.hidden = isScript;
  if (elements.dockOutputBox) elements.dockOutputBox.hidden = !isScript;
  if (elements.dockSystemLogBox) elements.dockSystemLogBox.hidden = isScript;
  if (state.logTab === 'system') updateSystemLogView();
}

function initLogPage() {
  const scriptTab = elements.tabTerminalScript;
  const systemTab = elements.tabTerminalSystem;

  scriptTab?.addEventListener('click', () => switchLogTab('script'));
  systemTab?.addEventListener('click', () => {
    if (!state.isAdmin) return;
    switchLogTab('system');
  });

  if (window.AppLogger) {
    window.AppLogger.subscribe(() => {
      updateSystemLogBadge();
      if (state.logTab === 'system') updateSystemLogView();
    });
    updateSystemLogBadge();
  }

  elements.diagReportBtn?.addEventListener('click', () => {
    const report = window.AppLogger?.exportDiagnostics() || '{}';
    copyToClipboard(report, '已复制完整系统诊断包到剪贴板，可直接发送技术支持排查');
  });

  elements.clearOutput?.addEventListener('click', () => {
    if (state.logTab === 'system') {
      window.AppLogger?.clear();
      updateSystemLogView();
      updateSystemLogBadge();
      showToast('已清空系统运行日志');
    } else {
      if (elements.outputBox) elements.outputBox.textContent = '暂无执行记录。';
      if (elements.dockOutputBox) elements.dockOutputBox.textContent = '暂无执行记录。';
      showToast('已清空脚本执行日志');
    }
  });

  elements.copyOutputBtn?.addEventListener('click', () => {
    const box = state.logTab === 'system' ? elements.systemLogBox : elements.outputBox;
    const text = box?.textContent || '';
    if (!text || text.startsWith('暂无')) { showToast('暂无日志可复制'); return; }
    copyToClipboard(text, state.logTab === 'system' ? '已复制系统运行日志到剪贴板' : '已复制脚本执行日志到剪贴板');
  });

  elements.stopScriptBtn?.addEventListener('click', () => {
    if (state.batchRunning) {
      if (typeof stopTaskBatch === 'function') stopTaskBatch();
    } else if (state.activeBundleRun) {
      if (typeof stopRunningBundle === 'function') stopRunningBundle();
    } else if (typeof stopRunningScript === 'function') {
      stopRunningScript();
    }
  });

  eventBus.addEventListener('task:running', updateStopButton);
  eventBus.addEventListener('output:changed', updateStopButton);
}

function initOverviewLogDock() {
  const dock = elements.overviewLogDock;
  if (!dock) return;

  let isCollapsed = true;
  try {
    const saved = localStorage.getItem('yunmomo.overviewLogDock.collapsed');
    if (saved === 'false') isCollapsed = false;
  } catch {}
  dock.classList.toggle('collapsed', isCollapsed);

  function setDockCollapsed(val) {
    dock.classList.toggle('collapsed', val);
    try { localStorage.setItem('yunmomo.overviewLogDock.collapsed', String(val)); } catch {}
    if (!val) {
      if (elements.dockOutputBox) elements.dockOutputBox.scrollTop = elements.dockOutputBox.scrollHeight;
      if (elements.dockSystemLogBox) elements.dockSystemLogBox.scrollTop = elements.dockSystemLogBox.scrollHeight;
    }
  }

  elements.dockBar?.addEventListener('click', () => setDockCollapsed(false));
  elements.dockExpandBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    setDockCollapsed(false);
  });
  elements.dockCollapseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    setDockCollapsed(true);
  });

  elements.dockTabTerminalScript?.addEventListener('click', () => switchLogTab('script'));
  elements.dockTabTerminalSystem?.addEventListener('click', () => {
    if (!state.isAdmin) return;
    switchLogTab('system');
  });

  elements.dockClearOutput?.addEventListener('click', () => {
    if (state.logTab === 'system') {
      window.AppLogger?.clear();
      updateSystemLogView();
      updateSystemLogBadge();
      showToast('已清空系统运行日志');
    } else {
      if (elements.outputBox) elements.outputBox.textContent = '暂无执行记录。';
      if (elements.dockOutputBox) elements.dockOutputBox.textContent = '暂无执行记录。';
      showToast('已清空脚本执行日志');
    }
  });

  elements.dockCopyOutputBtn?.addEventListener('click', () => {
    const box = state.logTab === 'system' ? (elements.dockSystemLogBox || elements.systemLogBox) : (elements.dockOutputBox || elements.outputBox);
    const text = box?.textContent || '';
    if (!text || text.startsWith('暂无')) { showToast('暂无日志可复制'); return; }
    copyToClipboard(text, state.logTab === 'system' ? '已复制系统运行日志到剪贴板' : '已复制脚本执行日志到剪贴板');
  });

  elements.dockStopScriptBtn?.addEventListener('click', () => {
    if (state.batchRunning) {
      if (typeof stopTaskBatch === 'function') stopTaskBatch();
    } else if (state.activeBundleRun) {
      if (typeof stopRunningBundle === 'function') stopRunningBundle();
    } else if (typeof stopRunningScript === 'function') {
      stopRunningScript();
    }
  });

  if (elements.outputBox && elements.dockOutputBox && elements.outputBox.textContent !== '暂无执行记录。') {
    elements.dockOutputBox.textContent = elements.outputBox.textContent;
  }
}

/* ---------- 设置页 ---------- */

function initSettingsPage() {
  byId('settingsThemeBtn')?.addEventListener('click', toggleTheme);
  byId('settingsLogoutBtn')?.addEventListener('click', doLogout);
  elements.userLogoutBtn?.addEventListener('click', doLogout);

  // 修改密码弹窗
  const passwordAlert = byId('passwordAlert');
  function showPasswordAlert(text, tone) {
    if (!passwordAlert) return;
    passwordAlert.textContent = text;
    passwordAlert.className = `dlg-alert ${tone === 'success' ? 'ok' : 'danger'}`;
    passwordAlert.hidden = false;
  }

  byId('openPasswordModalBtn')?.addEventListener('click', () => {
    if (passwordAlert) passwordAlert.hidden = true;
    for (const id of ['pwdCurrentInput', 'pwdNewInput', 'pwdConfirmInput']) {
      const node = byId(id);
      if (node) node.value = '';
    }
    byId('passwordDialog')?.showModal();
    byId('pwdCurrentInput')?.focus();
  });
  byId('closePasswordModalBtn')?.addEventListener('click', () => byId('passwordDialog')?.close());
  byId('cancelPasswordBtn')?.addEventListener('click', () => byId('passwordDialog')?.close());
  byId('submitPasswordBtn')?.addEventListener('click', async event => {
    event.preventDefault();
    const currentPassword = byId('pwdCurrentInput')?.value || '';
    const newPassword = byId('pwdNewInput')?.value || '';
    if (newPassword.length < 8) { showPasswordAlert('新密码长度至少需要 8 位'); return; }
    if (newPassword !== (byId('pwdConfirmInput')?.value || '')) { showPasswordAlert('两次输入的新密码不一致'); return; }
    const submit = byId('submitPasswordBtn');
    if (submit) submit.disabled = true;
    try {
      await requestJson('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      localStorage.removeItem('yunmomo.auth_token');
      showPasswordAlert('密码已更新，即将跳转到登录页…', 'success');
      setTimeout(() => { location.href = '/login.html'; }, 1200);
    } catch (err) {
      showPasswordAlert(err.message || '密码修改失败');
      if (submit) submit.disabled = false;
    }
  });

  // 平台会话（管理员）
  byId('connectSession')?.addEventListener('click', async event => {
    event.preventDefault();
    const input = byId('sessionToken');
    const token = input?.value.trim();
    if (!token) { showToast('请先粘贴会话令牌'); input?.focus(); return; }
    const btn = byId('connectSession');
    if (btn) btn.disabled = true;
    try {
      await requestJson('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      if (input) input.value = '';
      await loadStatus();
      await loadDevices();
      showToast('已连接，令牌已保存');
    } catch (error) {
      showToast(error.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
}

/* ---------- 兑换卡密 ---------- */

function initRedeemDialog() {
  const alertBox = byId('redeemAlert');
  byId('openRedeemModalBtn')?.addEventListener('click', () => {
    if (alertBox) alertBox.hidden = true;
    const input = byId('redeemCardInput');
    if (input) input.value = '';
    byId('redeemDialog')?.showModal();
    input?.focus();
  });
  byId('closeRedeemModalBtn')?.addEventListener('click', () => byId('redeemDialog')?.close());
  byId('cancelRedeemBtn')?.addEventListener('click', () => byId('redeemDialog')?.close());
  byId('submitRedeemBtn')?.addEventListener('click', async () => {
    const cardCode = byId('redeemCardInput')?.value.trim();
    if (!cardCode) {
      if (alertBox) { alertBox.textContent = '请输入卡密代码'; alertBox.className = 'dlg-alert danger'; alertBox.hidden = false; }
      return;
    }
    const submit = byId('submitRedeemBtn');
    if (submit) { submit.disabled = true; submit.textContent = '兑换中…'; }
    try {
      const res = await fetch('/api/user/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardCode })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || '兑换失败，请联系客服');
      const summary = data.result.summary
        || (data.result.deviceName ? `已为您分配新云手机 [${data.result.deviceName}]，有效期至 ${new Date(data.result.expireAt).toLocaleString()}` : '权益已成功充值到账！');
      if (alertBox) { alertBox.textContent = summary; alertBox.className = 'dlg-alert ok'; alertBox.hidden = false; }
      setTimeout(async () => {
        byId('redeemDialog')?.close();
        await checkAuth();
        if (data.result.deviceId || data.result.deviceName) await loadDevices();
        showToast(`兑换成功: ${summary}`);
      }, 1500);
    } catch (err) {
      if (alertBox) { alertBox.textContent = err.message || '兑换失败，请联系客服'; alertBox.className = 'dlg-alert danger'; alertBox.hidden = false; }
    } finally {
      if (submit) { submit.disabled = false; submit.textContent = '立即兑换'; }
    }
  });
}

/* ---------- 初始化 ---------- */

async function init() {
  window.AppLogger?.info('Init', '正在启动控制台工作台前端...');
  initTheme();
  renderShell();
  initBundleModalEvents();
  initLogPage();
  initOverviewLogDock();
  initSettingsPage();
  initRedeemDialog();

  elements.themeToggleBtn?.addEventListener('click', toggleTheme);
  elements.refreshDevices?.addEventListener('click', async () => {
    await loadStatus();
    if (state.tokenConfigured) await loadDevices();
  });

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
    await loadSharedRuntimeState();
    const initialPage = isEmbedMode ? 'overview' : (typeof getPageFromUrl === 'function' ? getPageFromUrl() : 'overview');
    setPage(initialPage, { updateHash: true });

    window.AppLogger?.info('Init', '控制台工作台初始化全部完成，就绪待命');
  } catch (fatalErr) {
    window.AppLogger?.error('Fatal', '控制台初始化异常中断: ' + fatalErr.message, { stack: fatalErr.stack });
    showToast('控制台初始化异常: ' + fatalErr.message);
  }
}

setInterval(loadSharedRuntimeState, 1500);
setInterval(() => {
  if (state.tokenConfigured) loadDevices(true);
}, 3000);
setInterval(updateStopButton, 2000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.tokenConfigured) loadDevices(true);
});

init();
