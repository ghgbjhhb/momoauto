'use strict';

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
      const response = await fetch('/api/server-logs/clear', { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '清理请求失败');
    } catch (error) {
      showToast('日志清理未成功：' + error.message, 'error');
      return;
    }
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
let smsLogsRequestId = 0;
async function loadSmsLogs() {
  if (!smsRecordsTableBody) return;
  const requestId = ++smsLogsRequestId;
  try {
    const search = getSanitizedSmsSearch();
    syncSmsSearchClearBtn();
    const status = smsRecordStatusFilter ? smsRecordStatusFilter.value : '';

    const params = new URLSearchParams({ limit: '100' });
    if (search) params.set('search', search);
    if (status) params.set('status', status);

    const res = await fetch(`/api/admin/sms/logs?${params.toString()}`);
    const data = await res.json();
    if (requestId !== smsLogsRequestId) return;
    if (!res.ok || !data.ok) throw new Error(data.error || '请求失败');

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
        ? `<code style="color:#1677ff; font-weight:700; cursor:pointer;" title="点击复制号码" data-copy-sms="${escapeHtml(l.phone_number)}">${escapeHtml(l.phone_number)}</code>`
        : '<span style="color:#bfbfbf;">--</span>';

      const codeDisplay = l.sms_code
        ? `<code style="color:#52c41a; font-weight:800; font-size:14px; cursor:pointer;" title="点击复制验证码" data-copy-sms="${escapeHtml(l.sms_code)}">${escapeHtml(l.sms_code)}</code>`
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
        <tr style="cursor: pointer;" data-sms-row="${escapeHtml(l.id)}">
          <td>${formatDate(l.created_at)}</td>
          <td>${actionTag}</td>
          <td>${phoneDisplay}</td>
          <td>${codeDisplay}</td>
          <td>${statusTag}</td>
          <td><span style="font-family:monospace; font-size:12px; color:#595959;">${l.latency_ms || 0}ms</span></td>
          <td style="text-align: center;">
            <button class="btn-action-sm" id="btn-toggle-${escapeHtml(l.id)}" type="button" style="height:24px; padding:0 8px; font-size:12px;" data-sms-toggle="${escapeHtml(l.id)}">
              展开详情 ▾
            </button>
          </td>
        </tr>
        <tr id="detail-row-${escapeHtml(l.id)}" class="log-detail-row" style="display: none;">
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
    if (requestId === smsLogsRequestId) {
      smsRecordsTableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#ff4d4f; padding:30px;">加载日志失败: ${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

smsRecordsTableBody?.addEventListener('click', event => {
  const copy = event.target.closest('[data-copy-sms]');
  if (copy) {
    event.stopPropagation();
    copyCardCode(copy.dataset.copySms);
    return;
  }
  const toggle = event.target.closest('[data-sms-toggle]');
  if (toggle) {
    event.stopPropagation();
    toggleLogDetail(toggle.dataset.smsToggle);
    return;
  }
  const row = event.target.closest('[data-sms-row]');
  if (row) toggleLogDetail(row.dataset.smsRow);
});

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
  const debouncedSmsSearch = debounce(loadSmsLogs, 300);
  smsRecordSearch.addEventListener('input', () => {
    syncSmsSearchClearBtn();
    debouncedSmsSearch();
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

