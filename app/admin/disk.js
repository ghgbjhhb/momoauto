'use strict';

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
      listEl.innerHTML = '<div class="disk-empty-state" style="padding: 48px 20px; grid-column: 1 / -1; width:100%; text-align:center;">' +
        '<div class="disk-empty-icon">🖼️</div>' +
        '<p style="font-size:14px; color:#595959; margin:0 0 6px;">暂无头像图片</p>' +
        '<span style="font-size:12px; color:#8c8c8c;">点击右上角【上传文件】或直接将图片拖拽至此上传</span>' +
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

    const diskToken = localStorage.getItem('yunmomo.auth_token') || '';
    const diskTokenQuery = diskToken ? '&token=' + encodeURIComponent(diskToken) : '';

    listEl.innerHTML = adminDiskFiles.map(file => {
      const isSelected = file.name === adminDiskSelectedFile;
      const previewUrl = '/api/cloud-disk/preview?dir=' + encodeURIComponent(adminDiskCurrentDir) + '&name=' + encodeURIComponent(file.name) + diskTokenQuery;
      return '<div class="disk-grid-item ' + (isSelected ? 'selected' : '') + '" data-filename="' + escapeHtml(file.name) + '" onclick="selectAdminDiskFile(\'' + escapeHtml(file.name) + '\', event)" ondblclick="previewAdminDiskFile(\'' + escapeHtml(file.name) + '\', true, false); event.stopPropagation();" title="单击选中，双击放大预览">' +
        '<div class="disk-grid-check">✓</div>' +
        '<div class="disk-grid-thumb">' +
          '<img src="' + previewUrl + '" alt="' + escapeHtml(file.name) + '" loading="lazy" onerror="this.onerror=null; this.parentElement.innerHTML=\'<div style=\\\'font-size:26px; opacity:0.35; display:flex; align-items:center; justify-content:center; width:100%; height:100%;\\\'>🖼️</div>\';" />' +
          '<div class="disk-grid-overlay">' +
            '<button type="button" class="disk-grid-action-btn" title="查看原图" onclick="previewAdminDiskFile(\'' + escapeHtml(file.name) + '\', true, false); event.stopPropagation();">' +
              '🔍' +
            '</button>' +
          '</div>' +
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

let adminDiskActiveObjectUrl = null;

function clearAdminDiskActivePreviewUrl() {
  if (adminDiskActiveObjectUrl) {
    try { URL.revokeObjectURL(adminDiskActiveObjectUrl); } catch {}
    adminDiskActiveObjectUrl = null;
  }
}

function formatDiskFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

window.previewAdminDiskFile = async (fileName, isImage, isText, targetDir) => {
  const dialog = document.getElementById('adminDiskPreviewDialog');
  const titleEl = document.getElementById('adminDiskPreviewTitle');
  const bodyEl = document.getElementById('adminDiskPreviewBody');
  if (!dialog || !titleEl || !bodyEl) return;

  clearAdminDiskActivePreviewUrl();

  const currentDir = targetDir || adminDiskCurrentDir || '头像';
  titleEl.textContent = '文件预览: ' + fileName;
  bodyEl.innerHTML = '<div style="padding:48px 16px; text-align:center; color:#595959;">' +
    '<div class="spinning" style="display:inline-block; font-size:28px; margin-bottom:12px;">🔄</div>' +
    '<div style="font-size:14px; font-weight:500;">正在加载内容…</div>' +
    '<div style="font-size:12px; color:#8c8c8c; margin-top:4px;">' + escapeHtml(fileName) + '</div>' +
  '</div>';
  dialog.showModal();

  const token = localStorage.getItem('yunmomo.auth_token') || '';
  const tokenQuery = token ? '&token=' + encodeURIComponent(token) : '';
  const fileUrl = '/api/cloud-disk/file?dir=' + encodeURIComponent(currentDir) + '&name=' + encodeURIComponent(fileName);
  const authHeaders = token ? { 'Authorization': 'Bearer ' + token } : {};

  if (isImage) {
    try {
      const res = await fetch(fileUrl, { headers: authHeaders });
      if (!res.ok) {
        let errMsg = 'HTTP ' + res.status;
        try {
          const errData = await res.json();
          if (errData && errData.error) errMsg = errData.error;
        } catch {}
        bodyEl.innerHTML = '<div style="text-align:center; padding:40px 16px;">' +
          '<div style="font-size:42px; margin-bottom:12px;">🖼️❌</div>' +
          '<div style="font-size:15px; font-weight:600; color:#cf1322; margin-bottom:6px;">图片加载失败</div>' +
          '<div style="font-size:13px; color:#8c8c8c; margin-bottom:20px; word-break:break-all;">' + escapeHtml(errMsg) + '</div>' +
          '<button type="button" class="btn-action-sm" onclick="previewAdminDiskFile(\'' + escapeHtml(fileName) + '\', true, false, \'' + escapeHtml(currentDir) + '\')">🔄 重试加载</button>' +
        '</div>';
        return;
      }

      const blob = await res.blob();
      adminDiskActiveObjectUrl = URL.createObjectURL(blob);

      bodyEl.innerHTML = '<div style="text-align:center; padding:12px; max-height:72vh; overflow:auto; display:flex; flex-direction:column; align-items:center; justify-content:center;">' +
        '<div style="max-width:100%; max-height:60vh; display:flex; align-items:center; justify-content:center; overflow:hidden; border-radius:6px; background:#f5f5f5; border:1px solid #e8e8e8; box-shadow:0 4px 14px rgba(0,0,0,0.08);">' +
          '<img id="adminDiskActivePreviewImg" src="' + adminDiskActiveObjectUrl + '" alt="' + escapeHtml(fileName) + '" style="max-width:100%; max-height:60vh; object-fit:contain; display:block;" />' +
        '</div>' +
        '<div style="margin-top:14px; display:flex; align-items:center; justify-content:center; gap:16px; flex-wrap:wrap;">' +
          '<span style="font-size:12.5px; color:#595959;">📦 大小: ' + formatDiskFileSize(blob.size) + '</span>' +
          '<span style="font-size:12.5px; color:#595959;">🏷️ 格式: ' + escapeHtml((blob.type || 'image').toUpperCase()) + '</span>' +
          '<a href="' + adminDiskActiveObjectUrl + '" download="' + escapeHtml(fileName) + '" class="btn-action-sm" style="display:inline-flex; align-items:center; gap:4px; font-size:12px; text-decoration:none; background:#1677ff; color:#fff; padding:4px 12px; border-radius:4px;">⬇️ 保存原图</a>' +
        '</div>' +
      '</div>';
    } catch (err) {
      bodyEl.innerHTML = '<div style="text-align:center; padding:40px 16px;">' +
        '<div style="font-size:42px; margin-bottom:12px;">⚠️</div>' +
        '<div style="font-size:15px; font-weight:600; color:#cf1322; margin-bottom:6px;">网络异常，无法获取图片</div>' +
        '<div style="font-size:13px; color:#8c8c8c; margin-bottom:20px;">' + escapeHtml(err.message) + '</div>' +
        '<button type="button" class="btn-action-sm" onclick="previewAdminDiskFile(\'' + escapeHtml(fileName) + '\', true, false, \'' + escapeHtml(currentDir) + '\')">🔄 重试加载</button>' +
      '</div>';
    }
  } else if (isText) {
    try {
      const res = await fetch(fileUrl, { headers: authHeaders });
      if (!res.ok) {
        let errMsg = 'HTTP ' + res.status;
        try {
          const errData = await res.json();
          if (errData && errData.error) errMsg = errData.error;
        } catch {}
        bodyEl.innerHTML = '<div style="padding:24px; text-align:center; color:#cf1322;">读取文件内容失败: ' + escapeHtml(errMsg) + '</div>';
        return;
      }
      const text = await res.text();
      bodyEl.innerHTML = '<div style="max-height:65vh; overflow:auto; padding:14px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">' +
        '<pre style="margin:0; font-family:Consolas, monospace; font-size:12px; color:#1e293b; white-space:pre-wrap; word-break:break-all; line-height:1.5;">' + escapeHtml(text) + '</pre>' +
      '</div>';
    } catch (err) {
      bodyEl.innerHTML = '<div style="padding:24px; text-align:center; color:#cf1322;">读取文件内容失败: ' + escapeHtml(err.message) + '</div>';
    }
  } else {
    bodyEl.innerHTML = '<div style="padding:36px 16px; text-align:center;">' +
      '<div style="font-size:38px; margin-bottom:12px;">📄</div>' +
      '<p style="color:#595959; margin-bottom:16px; font-size:13.5px;">此文件格式暂不支持在线直接预览，请下载到本地查看</p>' +
      '<a href="' + fileUrl + tokenQuery + '&download=1" download="' + escapeHtml(fileName) + '" class="btn-action-sm" style="display:inline-block; text-decoration:none; background:#1677ff; color:#fff; padding:6px 16px;">⬇️ 下载该文件</a>' +
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
      closePreviewBtn.addEventListener('click', () => {
        clearAdminDiskActivePreviewUrl();
        previewDialog.close();
      });
      previewDialog.addEventListener('click', (e) => {
        const rect = previewDialog.getBoundingClientRect();
        const inDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height
          && rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
        if (!inDialog) {
          clearAdminDiskActivePreviewUrl();
          previewDialog.close();
        }
      });
      previewDialog.addEventListener('close', clearAdminDiskActivePreviewUrl);
    }
  }

  loadAdminDiskDevices();
  loadAdminDiskFiles();
}




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
