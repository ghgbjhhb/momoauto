'use strict';

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
    if (elements.redeemAlert) elements.redeemAlert.hidden = true;
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
  elements.passwordAlert.className = `ui-alert ui-alert--${tone === 'success' ? 'ok' : 'danger'}`;
  elements.passwordAlert.hidden = false;
}

if (elements.openPasswordModalBtn) {
  elements.openPasswordModalBtn.addEventListener('click', () => {
    if (elements.passwordAlert) elements.passwordAlert.hidden = true;
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
      elements.redeemAlert.className = 'ui-alert ui-alert--danger';
      elements.redeemAlert.hidden = false;
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
      elements.redeemAlert.textContent = summary;
      elements.redeemAlert.className = 'ui-alert ui-alert--ok';
      elements.redeemAlert.hidden = false;
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
      elements.redeemAlert.className = 'ui-alert ui-alert--danger';
      elements.redeemAlert.hidden = false;
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
      zhencanQuotaEl.hidden = false;
      if (isAdmin) {
        zhencanQuotaEl.className = 'ui-badge';
        zhencanQuotaEl.textContent = '真参: 管理员无限';
        zhencanQuotaEl.title = '管理员特权免扣真参配额';
      } else {
        const count = parseInt(data.user.zhencanBalance, 10) || 0;
        if (zhencanCountEl) zhencanCountEl.textContent = String(count);
        zhencanQuotaEl.className = 'ui-badge' + (count <= 0 ? ' ui-badge--danger' : '');
        zhencanQuotaEl.textContent = `真参配额: ${count} 套`;
        zhencanQuotaEl.title = `当前可用真参配额: ${count} 套，导入真参自动核销 1 套，可通过卡密兑换充值`;
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

