'use strict';

// ==========================================
let adminDiskInitialized = false;
let adminDiskCurrentDir = '真参';
let adminDiskFiles = [];
let adminDiskSelectedFile = null;
let adminDiskRequestSeq = 0;
let adminDiskPreviewSeq = 0;
let adminDiskPreviewController = null;
let adminDiskStatusFilter = 'all'; // 'all' | 'avail' | 'used'
let adminDiskSearchQuery = '';

async function loadAdminDiskFiles() {
  const requestId = ++adminDiskRequestSeq;
  const requestedDir = adminDiskCurrentDir;
  const listEl = document.getElementById('adminDiskFileList');
  const countParamsEl = document.getElementById('adminDiskCountParams');
  const countAvatarsEl = document.getElementById('adminDiskCountAvatars');
  const refreshBtn = document.getElementById('adminDiskRefreshBtn');

  if (refreshBtn) refreshBtn.classList.add('spinning');
  if (listEl) {
    listEl.innerHTML = '<div class="disk-empty-state"><p>正在读取云盘文件…</p></div>';
  }

  try {
    const res = await fetch('/api/cloud-disk/files?dir=' + encodeURIComponent(requestedDir));
    const data = await res.json();
    if (requestId !== adminDiskRequestSeq || requestedDir !== adminDiskCurrentDir) return;
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
    if (requestId === adminDiskRequestSeq && requestedDir === adminDiskCurrentDir && listEl) {
      listEl.innerHTML = '<div class="disk-empty-state error"><p>网络异常: ' + escapeHtml(err.message) + '</p></div>';
    }
  } finally {
    if (requestId === adminDiskRequestSeq && refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

function getFilteredAdminDiskFiles() {
  let list = adminDiskFiles;
  if (adminDiskCurrentDir === '真参' && adminDiskStatusFilter !== 'all') {
    if (adminDiskStatusFilter === 'avail') {
      list = list.filter(f => !f.zhencanStatus || f.zhencanStatus.status !== 'used');
    } else if (adminDiskStatusFilter === 'used') {
      list = list.filter(f => f.zhencanStatus && f.zhencanStatus.status === 'used');
    }
  }
  const q = adminDiskSearchQuery.trim().toLowerCase();
  if (q) {
    list = list.filter(f => {
      if (f.name.toLowerCase().includes(q)) return true;
      if (f.previewInfo) {
        const brand = (f.previewInfo.brand || '').toLowerCase();
        const model = (f.previewInfo.model || '').toLowerCase();
        const ver = (f.previewInfo.androidVersion || '').toLowerCase();
        if (brand.includes(q) || model.includes(q) || ver.includes(q)) return true;
      }
      return false;
    });
  }
  return list;
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

  // 仅在头像目录下且选中了图片时展示操作栏，其余情况完全隐藏
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
  const btnDel = document.getElementById('btnDeleteSelectedAvatar');

  if (nameEl) nameEl.textContent = selected.name;
  if (sizeEl) sizeEl.textContent = '(' + selected.sizeFormatted + ')';
  if (btnDel) btnDel.disabled = false;
}

function renderAdminDiskFileList() {
  const listEl = document.getElementById('adminDiskFileList');
  if (!listEl) return;

  const isAvatarDir = adminDiskCurrentDir === '头像';
  const displayFiles = getFilteredAdminDiskFiles();

  if (isAvatarDir) {
    listEl.className = 'disk-grid-view';

    if (displayFiles.length === 0) {
      adminDiskSelectedFile = null;
      updateAvatarOperationBar();
      const emptyTip = adminDiskFiles.length === 0 ? '暂无头像图片' : '未找到匹配的头像图片';
      const emptyHint = adminDiskFiles.length === 0 ? '点击右上角【上传文件】或直接将图片拖拽至此上传' : '请尝试调整搜索关键词';
      listEl.innerHTML = '<div class="disk-empty-state" style="padding: 48px 20px; grid-column: 1 / -1; width:100%; text-align:center;">' +
        '<div class="disk-empty-icon">🖼️</div>' +
        '<p style="font-size:14px; color:#595959; margin:0 0 6px;">' + escapeHtml(emptyTip) + '</p>' +
        '<span style="font-size:12px; color:#8c8c8c;">' + escapeHtml(emptyHint) + '</span>' +
      '</div>';
      return;
    }

    const hasCurrent = displayFiles.some(f => f.name === adminDiskSelectedFile);
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

    listEl.innerHTML = displayFiles.map(file => {
      const selected = file.name === adminDiskSelectedFile;
      const previewUrl = '/api/cloud-disk/preview?dir=' + encodeURIComponent(adminDiskCurrentDir) +
        '&name=' + encodeURIComponent(file.name);
      return '<div class="disk-grid-item ' + (selected ? 'selected' : '') +
        '" data-filename="' + escapeHtml(file.name) + '" title="单击选中，双击放大预览">' +
        '<div class="disk-grid-check">✓</div><div class="disk-grid-thumb">' +
        '<img src="' + escapeHtml(previewUrl) + '" alt="' + escapeHtml(file.name) + '" loading="lazy" />' +
        '<div class="disk-grid-overlay"><button type="button" class="disk-grid-action-btn" data-disk-action="preview" title="查看原图">🔍</button></div>' +
        '</div><div class="disk-grid-info"><div class="disk-grid-name" title="' + escapeHtml(file.name) + '">' +
        escapeHtml(file.name) + '</div><div class="disk-grid-size">' +
        escapeHtml(file.sizeFormatted) + '</div></div></div>';
    }).join('');
    return;
  }

  // 真机参数列表展示
  listEl.className = 'disk-file-list';
  updateAvatarOperationBar();

  if (displayFiles.length === 0) {
    const emptyTip = adminDiskFiles.length === 0 ? '暂无真参文件，点击右上角【上传文件】或直接将文件拖拽至此' : '未找到匹配的真参文件，请尝试调整搜索或过滤条件';
    listEl.innerHTML = '<div class="disk-empty-state" style="padding: 36px 20px;">' +
      '<p style="font-size:14px; color:#595959; margin:0;">' + escapeHtml(emptyTip) + '</p>' +
    '</div>';
    return;
  }

  listEl.innerHTML = displayFiles.map(file => {
    let thumbHtml = '<div class="disk-file-thumb params-thumb" style="font-size:22px; display:flex; align-items:center; justify-content:center;">⚙️</div>';

    let metaText = '';
    if (file.previewInfo) {
      const p = file.previewInfo;
      const parts = [];
      if (p.brand || p.model) parts.push('<strong>' + escapeHtml(p.brand) + ' ' + escapeHtml(p.model) + '</strong>');
      if (p.androidVersion) parts.push('Android ' + escapeHtml(p.androidVersion));
      parts.push(escapeHtml(file.sizeFormatted));
      metaText = parts.join(' · ');
    } else {
      metaText = escapeHtml(file.sizeFormatted);
    }

    let statusBadge = '';
    let toggleBtn = '';
    if (file.zhencanStatus && file.zhencanStatus.status === 'used') {
      const devName = file.zhencanStatus.usedOnDeviceName || file.zhencanStatus.usedOnDeviceId || '';
      const timeStr = file.zhencanStatus.usedAtFormatted ? file.zhencanStatus.usedAtFormatted.slice(5, 16) : '';
      let noteParts = [];
      if (devName) noteParts.push(escapeHtml(devName));
      if (timeStr) noteParts.push(escapeHtml(timeStr));
      const noteText = noteParts.length ? ' (' + noteParts.join(' · ') + ')' : '';

      statusBadge = '<span class="badge-status-used" style="background:#fff2f0; color:#cf1322; border:1px solid #ffccc7; font-size:11.5px; padding:2px 7px; border-radius:4px; font-weight:600; margin-left:8px;" title="使用时间: ' + escapeHtml(file.zhencanStatus.usedAtFormatted || '此前') + '">🔴 已使用' + noteText + '</span>';
      toggleBtn = '<button type="button" class="disk-action-btn success" style="background:#f6ffed; color:#389e0d; border:1px solid #b7eb8f; padding:4px 12px; font-size:12px; border-radius:4px;" data-disk-action="available" title="重置为可用状态">🔄 恢复可用</button>';
    } else {
      statusBadge = '<span class="badge-status-avail" style="background:#f6ffed; color:#389e0d; border:1px solid #b7eb8f; font-size:11.5px; padding:2px 7px; border-radius:4px; font-weight:600; margin-left:8px;">🟢 可用</span>';
      toggleBtn = '<button type="button" class="disk-action-btn subtle" style="color:#595959; background:#fafafa; border:1px solid #d9d9d9; padding:4px 12px; font-size:12px; border-radius:4px;" data-disk-action="used" title="将该真参标记为已使用">🚫 设为已用</button>';
    }

    return '<div class="disk-file-card" data-filename="' + escapeHtml(file.name) + '">' +
      thumbHtml +
      '<div class="disk-file-main">' +
        '<div class="disk-file-title" title="' + escapeHtml(file.name) + '">' +
          escapeHtml(file.name) + statusBadge +
        '</div>' +
        '<div class="disk-file-meta">' + metaText + '</div>' +
      '</div>' +
      '<div class="disk-file-actions" style="display:flex; align-items:center; gap:8px;">' +
        toggleBtn +
        '<button type="button" class="disk-action-btn view-btn" style="padding:4px 12px; font-size:12px; border-radius:4px;" data-disk-action="preview">' +
          '👁️ 预览' +
        '</button>' +
        '<button type="button" class="disk-action-btn danger delete-btn" style="padding:4px 12px; font-size:12px; border-radius:4px;" data-disk-action="delete">' +
          '🗑️ 删除' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

let adminDiskActiveObjectUrl = null;

function clearAdminDiskActivePreviewUrl() {
  ++adminDiskPreviewSeq;
  adminDiskPreviewController?.abort();
  adminDiskPreviewController = null;
  if (adminDiskActiveObjectUrl) {
    try { URL.revokeObjectURL(adminDiskActiveObjectUrl); } catch {}
    adminDiskActiveObjectUrl = null;
  }
}

function formatDiskFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return val.toFixed(1) + ' ' + units[i];
}

async function previewAdminDiskFile(fileName, isImage, isText, explicitDir) {
  const currentDir = explicitDir || adminDiskCurrentDir;
  clearAdminDiskActivePreviewUrl();
  const controller = new AbortController();
  adminDiskPreviewController = controller;
  const seq = adminDiskPreviewSeq;
  const previewIsCurrent = () => seq === adminDiskPreviewSeq && !controller.signal.aborted;

  const dialog = document.getElementById('adminDiskPreviewDialog');
  const titleEl = document.getElementById('adminDiskPreviewTitle');
  const bodyEl = document.getElementById('adminDiskPreviewBody');
  if (!dialog || !titleEl || !bodyEl) return;

  titleEl.textContent = '文件预览: ' + fileName;
  bodyEl.innerHTML = '<div style="padding:48px 16px; text-align:center; color:#595959;">' +
    '<div class="spinning" style="display:inline-block; font-size:28px; margin-bottom:12px;">🔄</div>' +
    '<div style="font-size:14px; font-weight:500;">正在加载内容…</div>' +
    '<div style="font-size:12px; color:#8c8c8c; margin-top:4px;">' + escapeHtml(fileName) + '</div>' +
  '</div>';
  if (!dialog.open) dialog.showModal();

  const fileUrl = '/api/cloud-disk/file?dir=' + encodeURIComponent(currentDir) + '&name=' + encodeURIComponent(fileName);
  dialog.dataset.retryFile = fileName;
  dialog.dataset.retryDir = currentDir;

  if (isImage) {
    try {
      const res = await fetch(fileUrl, { signal: controller.signal });
      if (!previewIsCurrent()) return;
      if (!res.ok) {
        let errMsg = 'HTTP ' + res.status;
        try {
          const errData = await res.json();
          if (errData && errData.error) errMsg = errData.error;
        } catch {}
        if (!previewIsCurrent()) return;
        bodyEl.innerHTML = '<div style="text-align:center; padding:40px 16px;">' +
          '<div style="font-size:42px; margin-bottom:12px;">🖼️❌</div>' +
          '<div style="font-size:15px; font-weight:600; color:#cf1322; margin-bottom:6px;">图片加载失败</div>' +
          '<div style="font-size:13px; color:#8c8c8c; margin-bottom:20px; word-break:break-all;">' + escapeHtml(errMsg) + '</div>' +
          '<button type="button" class="btn-action-sm" data-disk-retry>🔄 重试加载</button>' +
        '</div>';
        return;
      }

      const blob = await res.blob();
      if (!previewIsCurrent()) return;
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
      if (!previewIsCurrent() || err.name === 'AbortError') return;
      bodyEl.innerHTML = '<div style="text-align:center; padding:40px 16px;">' +
        '<div style="font-size:42px; margin-bottom:12px;">⚠️</div>' +
        '<div style="font-size:15px; font-weight:600; color:#cf1322; margin-bottom:6px;">网络异常，无法获取图片</div>' +
        '<div style="font-size:13px; color:#8c8c8c; margin-bottom:20px;">' + escapeHtml(err.message) + '</div>' +
        '<button type="button" class="btn-action-sm" data-disk-retry>🔄 重试加载</button>' +
      '</div>';
    }
  } else if (isText) {
    try {
      const res = await fetch(fileUrl, { signal: controller.signal });
      if (!previewIsCurrent()) return;
      if (!res.ok) {
        let errMsg = 'HTTP ' + res.status;
        try {
          const errData = await res.json();
          if (errData && errData.error) errMsg = errData.error;
        } catch {}
        if (!previewIsCurrent()) return;
        bodyEl.innerHTML = '<div style="padding:24px; text-align:center; color:#cf1322;">读取文件内容失败: ' + escapeHtml(errMsg) + '</div>';
        return;
      }
      const text = await res.text();
      if (!previewIsCurrent()) return;
      bodyEl.innerHTML = '<div style="max-height: 60vh; overflow-y: auto; background: var(--bg-hover); padding: var(--sp-12); border-radius: var(--r-6); font-family: var(--font-mono); font-size: var(--fs-12); line-height: 1.6; white-space: pre-wrap; word-break: break-all; color: var(--text-1);">' +
        escapeHtml(text) +
      '</div>';
    } catch (err) {
      if (!previewIsCurrent() || err.name === 'AbortError') return;
      bodyEl.innerHTML = '<div style="padding:24px; text-align:center; color:#cf1322;">网络异常: ' + escapeHtml(err.message) + '</div>';
    }
  } else {
    bodyEl.innerHTML = '<div style="text-align: center; padding: var(--sp-24); color: var(--text-2);">' +
      '<p>暂不支持在网页中直接内联预览该格式文件。</p>' +
      '<a href="' + escapeHtml(fileUrl) + '" download class="btn-action-sm" style="margin-top: var(--sp-12); display: inline-block; text-decoration: none;">⬇️ 下载文件</a>' +
    '</div>';
  }
}

window.deleteAdminDiskFile = async function(fileName) {
  const currentDir = adminDiskCurrentDir;
  const confirmed = await showConfirm({
    title: '确认删除文件？',
    desc: '即将永久从云盘中删除：<strong class="admin-confirm-highlight">' + escapeHtml(fileName) + '</strong><br>此操作不可撤销，请确认！',
    okText: '确认删除',
    cancelText: '取消',
    isDanger: true,
    icon: '🗑️'
  });
  if (!confirmed) return;

  const key = 'disk-delete:' + currentDir + ':' + fileName;
  if (!adminWriteGuard.begin(key)) return;

  try {
    const res = await fetch('/api/cloud-disk/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: currentDir, name: fileName })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('文件已彻底删除', 'success');
      if (adminDiskSelectedFile === fileName) {
        adminDiskSelectedFile = null;
        updateAvatarOperationBar();
      }
      loadAdminDiskFiles();
    } else {
      showToast('删除失败: ' + (data.error || '权限不足'), 'error');
    }
  } catch (err) {
    showToast('删除网络异常: ' + err.message, 'error');
  } finally {
    adminWriteGuard.end(key);
  }
};

async function uploadAdminDiskFiles(files) {
  if (!files || !files.length) return;
  const uploadDir = adminDiskCurrentDir;
  const total = files.length;
  let successCount = 0;
  let failCount = 0;

  showToast('开始上传 ' + total + ' 个文件到【' + uploadDir + '】…', 'info');

  for (let i = 0; i < total; i++) {
    const file = files[i];
    try {
      const base64 = await readFileAsBase64Admin(file);
      const res = await fetch('/api/cloud-disk/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dir: uploadDir,
          name: file.name,
          data: base64
        })
      });
      const data = await res.json();
      if (data.ok) {
        successCount++;
      } else {
        failCount++;
        console.warn('文件上传失败:', file.name, data.error);
      }
    } catch (err) {
      failCount++;
      console.error('上传过程出错:', file.name, err);
    }
  }

  if (failCount === 0) {
    showToast('全部 ' + successCount + ' 个文件上传成功！', 'success');
  } else {
    showToast('上传完成: ' + successCount + ' 成功, ' + failCount + ' 失败', 'warning');
  }

  if (uploadDir === adminDiskCurrentDir) loadAdminDiskFiles();
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
    const filterGroup = document.getElementById('adminDiskFilterGroup');
    const searchInput = document.getElementById('adminDiskSearchInput');

    if (btnParams) {
      btnParams.addEventListener('click', () => {
        adminDiskCurrentDir = '真参';
        adminDiskSelectedFile = null;
        btnParams.classList.add('active');
        btnAvatars?.classList.remove('active');
        const countP = document.getElementById('adminDiskCountParams');
        const countA = document.getElementById('adminDiskCountAvatars');
        if (countP) { countP.style.background = 'var(--accent)'; countP.style.color = 'var(--text-on-accent)'; }
        if (countA) { countA.style.background = 'var(--border)'; countA.style.color = 'var(--text-2)'; }
        if (filterGroup) filterGroup.style.display = 'flex';
        if (searchInput) searchInput.placeholder = '🔍 搜索文件 / 机型...';
        loadAdminDiskFiles();
      });
    }
    if (btnAvatars) {
      btnAvatars.addEventListener('click', () => {
        adminDiskCurrentDir = '头像';
        adminDiskSelectedFile = null;
        btnAvatars.classList.add('active');
        btnParams?.classList.remove('active');
        const countP = document.getElementById('adminDiskCountParams');
        const countA = document.getElementById('adminDiskCountAvatars');
        if (countA) { countA.style.background = 'var(--accent)'; countA.style.color = 'var(--text-on-accent)'; }
        if (countP) { countP.style.background = 'var(--border)'; countP.style.color = 'var(--text-2)'; }
        if (filterGroup) filterGroup.style.display = 'none';
        if (searchInput) searchInput.placeholder = '🔍 搜索头像图片...';
        loadAdminDiskFiles();
      });
    }

    // 状态过滤切换
    if (filterGroup) {
      filterGroup.addEventListener('click', e => {
        const btn = e.target.closest('[data-status-filter]');
        if (!btn) return;
        adminDiskStatusFilter = btn.dataset.statusFilter || 'all';
        filterGroup.querySelectorAll('.btn-filter-status').forEach(el => {
          if (el === btn) {
            el.classList.add('active');
            el.style.background = 'var(--accent)';
            el.style.color = 'var(--text-on-accent)';
            el.style.fontWeight = 'var(--fw-500)';
          } else {
            el.classList.remove('active');
            el.style.background = 'transparent';
            el.style.color = 'var(--text-2)';
            el.style.fontWeight = 'normal';
          }
        });
        renderAdminDiskFileList();
      });
    }

    // 搜索实时过滤
    if (searchInput) {
      searchInput.addEventListener('input', e => {
        adminDiskSearchQuery = e.target.value || '';
        renderAdminDiskFileList();
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

    const list = document.getElementById('adminDiskFileList');
    list?.addEventListener('click', event => {
      const node = event.target.closest('[data-filename]');
      if (!node) return;
      const fileName = node.dataset.filename;
      const action = event.target.closest('[data-disk-action]')?.dataset.diskAction;
      if (action) {
        event.stopPropagation();
        if (action === 'preview') {
          const file = adminDiskFiles.find(item => item.name === fileName);
          previewAdminDiskFile(fileName, adminDiskCurrentDir === '头像', Boolean(file?.isText));
        } else if (action === 'delete') {
          deleteAdminDiskFile(fileName);
        } else if (action === 'used' || action === 'available') {
          toggleZhencanStatus(fileName, action);
        }
      } else if (node.classList.contains('disk-grid-item')) {
        selectAdminDiskFile(fileName, event);
      }
    });

    list?.addEventListener('dblclick', event => {
      const node = event.target.closest('.disk-grid-item');
      if (node && !event.target.closest('[data-disk-action]')) {
        previewAdminDiskFile(node.dataset.filename, true, false);
      }
    });

    list?.addEventListener('error', event => {
      if (event.target.tagName !== 'IMG' || !event.target.closest('.disk-grid-thumb')) return;
      const thumb = event.target.parentElement;
      thumb.replaceChildren(document.createTextNode('🖼️'));
    }, true);

    document.getElementById('adminDiskPreviewBody')?.addEventListener('click', event => {
      if (!event.target.closest('[data-disk-retry]')) return;
      const dialog = document.getElementById('adminDiskPreviewDialog');
      if (dialog?.dataset.retryFile) {
        previewAdminDiskFile(dialog.dataset.retryFile, true, false, dialog.dataset.retryDir);
      }
    });

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

  loadAdminDiskFiles();
}

window.toggleZhencanStatus = async function(fileName, targetStatus) {
  const key = 'zhencan-status:' + fileName;
  if (!adminWriteGuard.begin(key)) return;
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
  } finally {
    adminWriteGuard.end(key);
  }
};
