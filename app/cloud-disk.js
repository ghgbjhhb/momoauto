// Cloud Disk Client Controller - Yunmomo Enterprise Automation Console
// Manages cloud resources ('真参' and '头像'), handles file upload, preview, and real-time push to target cloud phone.
(function () {
  'use strict';

  const state = {
    currentDir: '真参', // '真参' | '头像'
    files: [],
    counts: { '真参': 0, '头像': 0 },
    selectedDeviceId: '',
    selectedDeviceName: '',
    loading: false
  };

  const byId = id => document.getElementById(id);

  function getActiveDeviceId() {
    if (typeof window.getSelectedDeviceId === 'function') {
      const id = window.getSelectedDeviceId();
      if (id) return id;
    }
    if (typeof window.currentDevice === 'function') {
      const dev = window.currentDevice();
      if (dev?.deviceId) return dev.deviceId;
    }
    return state.selectedDeviceId || '';
  }

  function getActiveDeviceName() {
    if (typeof window.currentDevice === 'function') {
      const dev = window.currentDevice();
      if (dev) return dev.name || dev.deviceName || dev.deviceId;
    }
    return state.selectedDeviceName || '';
  }

  function notify(msg, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
    } else {
      console.log(`[CloudDisk] ${msg}`);
    }
  }

  function updateDeviceBanner() {
    const banner = byId('diskTargetBanner');
    const nameEl = byId('diskTargetName');
    const idEl = byId('diskTargetId');
    const hintEl = byId('diskTargetHint');
    if (!banner || !nameEl || !idEl) return;

    const deviceId = getActiveDeviceId();
    const deviceName = getActiveDeviceName();

    if (deviceId) {
      nameEl.textContent = deviceName ? `${deviceName}` : `设备 ${deviceId}`;
      idEl.textContent = `(ID: ${deviceId})`;
      idEl.style.display = 'inline';
      banner.classList.add('has-device');
      if (hintEl) hintEl.textContent = '已连接到该云机，点击文件卡片上的“推送到当前云机”即可实时下发';
    } else {
      nameEl.textContent = '未选定目标云机';
      idEl.textContent = '';
      idEl.style.display = 'none';
      banner.classList.remove('has-device');
      if (hintEl) hintEl.textContent = '请在左侧设备列表中点击选择要操作的云机';
    }
  }

  async function fetchFileList() {
    const listEl = byId('diskFileList');
    if (!listEl) return;

    state.loading = true;
    updateUiState();

    try {
      const res = await fetch(`/api/cloud-disk/files?dir=${encodeURIComponent(state.currentDir)}`);
      if (res.status === 403) {
        const pane = byId('tabPaneDisk');
        if (pane) pane.style.display = 'none';
        const tabBtn = byId('tabBtnDisk');
        if (tabBtn) tabBtn.style.display = 'none';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.ok) {
        state.files = data.files || [];
        if (data.counts) {
          state.counts = data.counts;
        }
        renderCounts();
        renderFileList();
      } else {
        throw new Error(data.error || '获取文件列表失败');
      }
    } catch (err) {
      listEl.innerHTML = `
        <div class="disk-empty-state error">
          <span class="disk-empty-icon">⚠️</span>
          <p>加载失败: ${escapeHtml(err.message)}</p>
          <button type="button" class="disk-btn-subtle" onclick="window.CloudDisk.refresh()">重新加载</button>
        </div>
      `;
    } finally {
      state.loading = false;
      updateUiState();
    }
  }

  function renderCounts() {
    const pCountEl = byId('diskCountParams');
    const aCountEl = byId('diskCountAvatars');
    if (pCountEl) pCountEl.textContent = String(state.counts['真参'] || 0);
    if (aCountEl) aCountEl.textContent = String(state.counts['头像'] || 0);
  }

  function updateUiState() {
    const refreshBtn = byId('diskRefreshBtn');
    if (refreshBtn) {
      refreshBtn.disabled = state.loading;
      refreshBtn.classList.toggle('spinning', state.loading);
    }

    const pathEl = byId('diskCurrentPath');
    const descEl = byId('diskDirDesc');
    const dropHintEl = byId('diskDropzoneHint');

    if (pathEl) {
      pathEl.textContent = `storage/cloud-disk/${state.currentDir}`;
    }

    if (descEl) {
      if (state.currentDir === '真参') {
        descEl.textContent = '存放真机硬件特征配置（品牌、型号、底层环境属性表），可一键秒级推送到目标云机生效。';
      } else {
        descEl.textContent = '存放用户头像与图片素材，支持常见图片格式，可一键批量推送到目标云机系统相册。';
      }
    }

    if (dropHintEl) {
      if (state.currentDir === '真参') {
        dropHintEl.textContent = '支持 .txt, .json 格式真机参数文件，拖拽或点击上传';
      } else {
        dropHintEl.textContent = '支持 .jpg, .jpeg, .png, .webp 图片，拖拽或点击上传';
      }
    }
  }

  function renderFileList() {
    const listEl = byId('diskFileList');
    if (!listEl) return;

    if (!state.files.length) {
      listEl.innerHTML = `
        <div class="disk-empty-state">
          <span class="disk-empty-icon">${state.currentDir === '真参' ? '⚙️' : '🖼️'}</span>
          <p>当前“${state.currentDir}”目录为空</p>
          <span class="disk-empty-hint">点击上方上传按钮或拖拽文件到虚线框即可添加文件</span>
        </div>
      `;
      return;
    }

    const isParamsDir = state.currentDir === '真参';
    const activeDeviceId = getActiveDeviceId();

    listEl.innerHTML = state.files.map(file => {
      const ext = file.ext || '';
      const dateStr = file.mtime ? new Date(file.mtime).toLocaleString() : '';
      const previewUrl = `/api/cloud-disk/preview?dir=${encodeURIComponent(state.currentDir)}&name=${encodeURIComponent(file.name)}`;

      let thumbHtml = '';
      if (file.isImage) {
        thumbHtml = `
          <div class="disk-file-thumb image-thumb" data-url="${previewUrl}" onclick="window.CloudDisk.previewImage(this.closest('.disk-file-card').dataset.filename, this.dataset.url)">
            <img src="${previewUrl}" alt="${escapeHtml(file.name)}" loading="lazy" />
          </div>
        `;
      } else if (isParamsDir) {
        thumbHtml = `
          <div class="disk-file-thumb params-thumb">
            <span class="params-icon">⚙️</span>
            <span class="params-label">真参</span>
          </div>
        `;
      } else {
        thumbHtml = `
          <div class="disk-file-thumb doc-thumb">
            <span class="doc-icon">📄</span>
            <span class="doc-label">${escapeHtml(ext.toUpperCase().replace('.', '') || 'FILE')}</span>
          </div>
        `;
      }

      let extraBadgeHtml = '';
      if (isParamsDir && file.previewInfo) {
        const p = file.previewInfo;
        extraBadgeHtml = `
          <div class="disk-param-tags">
            ${p.brand ? `<span class="disk-tag brand-tag">📱 ${escapeHtml(p.brand)}</span>` : ''}
            ${p.model ? `<span class="disk-tag model-tag">🏷️ ${escapeHtml(p.model)}</span>` : ''}
            ${p.androidVersion ? `<span class="disk-tag os-tag">🤖 Android ${escapeHtml(p.androidVersion)}</span>` : ''}
          </div>
        `;
      }

      const sendBtnDisabled = !activeDeviceId ? 'disabled title="请先在左侧选择一台目标云机"' : '';
      const sendBtnText = isParamsDir ? '🚀 推送真参到云机' : '🚀 推送到云机相册';

      return `
        <div class="disk-file-card" data-filename="${escapeHtml(file.name)}" data-isimage="${Boolean(file.isImage)}" data-istext="${Boolean(file.isText)}">
          ${thumbHtml}
          <div class="disk-file-main">
            <div class="disk-file-title" title="${escapeHtml(file.name)}">
              ${escapeHtml(file.name)}
              ${isParamsDir && file.zhencanStatus ? (
                file.zhencanStatus.status === 'used'
                  ? `<span class="badge-status-used" style="background:#fff2f0; color:#cf1322; border:1px solid #ffccc7; font-size:11.5px; padding:2px 7px; border-radius:4px; font-weight:600; margin-left:8px;" title="使用时间: ${file.zhencanStatus.usedAtFormatted || '此前'} | 云机: ${file.zhencanStatus.usedOnDeviceName || file.zhencanStatus.usedOnDeviceId || '未知'}">🔴 已使用 (${file.zhencanStatus.usedAtFormatted ? file.zhencanStatus.usedAtFormatted.slice(5, 16) : '已导入'})</span>`
                  : `<span class="badge-status-avail" style="background:#f6ffed; color:#389e0d; border:1px solid #b7eb8f; font-size:11.5px; padding:2px 7px; border-radius:4px; font-weight:600; margin-left:8px;">🟢 可用</span>`
              ) : ''}
            </div>
            <div class="disk-file-meta">
              <span class="meta-item">📦 ${escapeHtml(file.sizeFormatted)}</span>
              <span class="meta-item">🕒 ${dateStr}</span>
            </div>
            ${extraBadgeHtml}
          </div>
          <div class="disk-file-actions">
            ${isParamsDir && file.zhencanStatus ? (
              file.zhencanStatus.status === 'used'
                ? `<button type="button" class="disk-action-btn success" style="background:#f6ffed; color:#389e0d; border:1px solid #b7eb8f; padding:4px 10px; font-size:12px;" onclick="window.CloudDisk.toggleStatus(this.closest('.disk-file-card').dataset.filename, 'available')" title="将该真参重置为可用状态，允许再次导入">🔄 重新启用</button>`
                : `<button type="button" class="disk-action-btn subtle" style="color:#8c8c8c; border:1px solid #d9d9d9; padding:4px 10px; font-size:12px;" onclick="window.CloudDisk.toggleStatus(this.closest('.disk-file-card').dataset.filename, 'used')" title="将该真参标记为已使用">🚫 设为已用</button>`
            ) : ''}
            <button type="button" class="disk-action-btn primary push-btn" ${sendBtnDisabled} onclick="window.CloudDisk.sendToDevice(this.closest('.disk-file-card').dataset.filename)">
              ${sendBtnText}
            </button>
            <button type="button" class="disk-action-btn view-btn" onclick="var c = this.closest('.disk-file-card'); window.CloudDisk.viewFile(c.dataset.filename, c.dataset.isimage === 'true', c.dataset.istext === 'true')">
              👁️ 预览
            </button>
            <button type="button" class="disk-action-btn danger delete-btn" onclick="window.CloudDisk.deleteFile(this.closest('.disk-file-card').dataset.filename)">
              🗑️
            </button>
          </div>
        </div>
      `;
    }).join('');
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

  function selectDir(dir) {
    if (state.currentDir === dir) return;
    state.currentDir = dir;
    const btnParams = byId('diskDirBtnParams');
    const btnAvatars = byId('diskDirBtnAvatars');
    if (btnParams) btnParams.classList.toggle('active', dir === '真参');
    if (btnAvatars) btnAvatars.classList.toggle('active', dir === '头像');
    updateUiState();
    fetchFileList();
  }

  async function uploadFiles(files) {
    if (!files || !files.length) return;
    const total = files.length;
    let successCount = 0;

    notify(`开始上传 ${total} 个文件到【${state.currentDir}】目录...`);

    for (let i = 0; i < total; i++) {
      const file = files[i];
      try {
        const base64 = await readFileAsBase64(file);
        const res = await fetch('/api/cloud-disk/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dir: state.currentDir,
            name: file.name,
            contentBase64: base64
          })
        });
        const data = await res.json();
        if (data.ok) {
          successCount++;
        } else {
          notify(`文件 [${file.name}] 上传失败: ${data.error || '服务器错误'}`);
        }
      } catch (err) {
        notify(`文件 [${file.name}] 读取或上传失败: ${err.message}`);
      }
    }

    notify(`✅ 成功上传 ${successCount}/${total} 个文件到【${state.currentDir}】`);
    fetchFileList();
  }

  function readFileAsBase64(file) {
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

  async function deleteFile(fileName) {
    if (typeof window.showConfirm === 'function') {
      const ok = await window.showConfirm({
        title: '确认删除该文件？',
        desc: `确定要从【${escapeHtml(state.currentDir)}】目录删除文件 <strong>${escapeHtml(fileName)}</strong> 吗？此操作无法撤销。`,
        okText: '确认删除',
        isDanger: true,
        icon: '🗑️'
      });
      if (!ok) return;
    }
    try {
      const res = await fetch('/api/cloud-disk/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dir: state.currentDir,
          name: fileName
        })
      });
      const data = await res.json();
      if (data.ok) {
        notify(`✅ 已删除文件 "${fileName}"`, 'success');
        fetchFileList();
      } else {
        notify(`删除失败: ${data.error || '未知错误'}`, 'error');
      }
    } catch (err) {
      notify(`删除请求失败: ${err.message}`, 'error');
    }
  }

  async function sendToDevice(fileName) {
    const deviceId = getActiveDeviceId();
    const deviceName = getActiveDeviceName() || deviceId;

    if (!deviceId) {
      notify('请先在左侧设备列表中点击选择一台目标云机！', 'error');
      return;
    }

    const isParamsDir = state.currentDir === '真参';
    if (typeof window.showConfirm === 'function') {
      const ok = await window.showConfirm({
        title: isParamsDir ? '确认推送真参配置到云机？' : '确认推送图片到云机相册？',
        desc: isParamsDir
          ? `确认将真参配置文件 <strong>${escapeHtml(fileName)}</strong> 立即推送并应用到云机 <strong>${escapeHtml(deviceName)}</strong>？`
          : `确认将图片 <strong>${escapeHtml(fileName)}</strong> 立即推送到云机 <strong>${escapeHtml(deviceName)}</strong> 的相册？`,
        okText: '立即推送',
        isDanger: false,
        icon: '🚀'
      });
      if (!ok) return;
    }

    // Set button loading state
    const card = document.querySelector(`.disk-file-card[data-filename="${CSS.escape(fileName)}"]`);
    const pushBtn = card?.querySelector('.push-btn');
    const originalText = pushBtn ? pushBtn.innerHTML : '';
    if (pushBtn) {
      pushBtn.disabled = true;
      pushBtn.innerHTML = '⏳ 正在实时下发…';
    }

    try {
      const res = await fetch('/api/cloud-disk/send-to-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          dir: state.currentDir,
          name: fileName
        })
      });
      const data = await res.json();
      if (data.ok) {
        notify(`🎉 下发成功！${data.message || ''}`, 'success');
      } else {
        notify(`❌ 下发失败: ${data.error || '未知错误'}`, 'error');
      }
    } catch (err) {
      notify(`❌ 下发异常: ${err.message}`, 'error');
    } finally {
      if (pushBtn) {
        pushBtn.disabled = false;
        pushBtn.innerHTML = originalText;
      }
    }
  }

  let cloudDiskActiveObjectUrl = null;

  function clearCloudDiskActivePreviewUrl() {
    if (cloudDiskActiveObjectUrl) {
      try { URL.revokeObjectURL(cloudDiskActiveObjectUrl); } catch {}
      cloudDiskActiveObjectUrl = null;
    }
  }

  function formatByteSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  async function viewFile(fileName, isImage, isText, targetDir) {
    const dialog = byId('diskPreviewDialog');
    const titleEl = byId('diskPreviewTitle');
    const bodyEl = byId('diskPreviewBody');
    if (!dialog || !titleEl || !bodyEl) return;

    clearCloudDiskActivePreviewUrl();

    const currentDir = targetDir || state.currentDir || '头像';
    titleEl.textContent = `文件预览: ${fileName}`;
    bodyEl.innerHTML = `<div style="padding:48px 16px; text-align:center; color:#595959;">` +
      `<div class="spinning" style="display:inline-block; font-size:28px; margin-bottom:12px;">🔄</div>` +
      `<div style="font-size:14px; font-weight:500;">正在加载内容…</div>` +
      `<div style="font-size:12px; color:#8c8c8c; margin-top:4px;">${escapeHtml(fileName)}</div>` +
    `</div>`;
    dialog.showModal();

    const token = localStorage.getItem('yunmomo.auth_token') || '';
    const tokenQuery = token ? '&token=' + encodeURIComponent(token) : '';
    const fileUrl = `/api/cloud-disk/file?dir=${encodeURIComponent(currentDir)}&name=${encodeURIComponent(fileName)}`;
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
          bodyEl.innerHTML = `<div style="text-align:center; padding:40px 16px;">` +
            `<div style="font-size:42px; margin-bottom:12px;">🖼️❌</div>` +
            `<div style="font-size:15px; font-weight:600; color:#cf1322; margin-bottom:6px;">图片加载失败</div>` +
            `<div style="font-size:13px; color:#8c8c8c; margin-bottom:20px; word-break:break-all;">${escapeHtml(errMsg)}</div>` +
            `<button type="button" class="run-button" onclick="window.CloudDisk.viewFile('${escapeHtml(fileName)}', true, false, '${escapeHtml(currentDir)}')">🔄 重试加载</button>` +
          `</div>`;
          return;
        }

        const blob = await res.blob();
        cloudDiskActiveObjectUrl = URL.createObjectURL(blob);

        bodyEl.innerHTML = `<div style="text-align:center; padding:12px; max-height:72vh; overflow:auto; display:flex; flex-direction:column; align-items:center; justify-content:center;">` +
          `<div style="max-width:100%; max-height:60vh; display:flex; align-items:center; justify-content:center; overflow:hidden; border-radius:6px; background:#f5f5f5; border:1px solid #e8e8e8; box-shadow:0 4px 14px rgba(0,0,0,0.08);">` +
            `<img src="${cloudDiskActiveObjectUrl}" alt="${escapeHtml(fileName)}" style="max-width:100%; max-height:60vh; object-fit:contain; display:block;" />` +
          `</div>` +
          `<div style="margin-top:14px; display:flex; align-items:center; justify-content:center; gap:16px; flex-wrap:wrap;">` +
            `<span style="font-size:12.5px; color:#595959;">📦 大小: ${formatByteSize(blob.size)}</span>` +
            `<span style="font-size:12.5px; color:#595959;">🏷️ 格式: ${escapeHtml((blob.type || 'image').toUpperCase())}</span>` +
            `<a href="${cloudDiskActiveObjectUrl}" download="${escapeHtml(fileName)}" class="run-button" style="display:inline-flex; align-items:center; gap:4px; font-size:12px; text-decoration:none; padding:4px 12px; border-radius:4px;">⬇️ 保存原图</a>` +
          `</div>` +
        `</div>`;
      } catch (err) {
        bodyEl.innerHTML = `<div style="text-align:center; padding:40px 16px;">` +
          `<div style="font-size:42px; margin-bottom:12px;">⚠️</div>` +
          `<div style="font-size:15px; font-weight:600; color:#cf1322; margin-bottom:6px;">网络异常，无法获取图片</div>` +
          `<div style="font-size:13px; color:#8c8c8c; margin-bottom:20px;">${escapeHtml(err.message)}</div>` +
          `<button type="button" class="run-button" onclick="window.CloudDisk.viewFile('${escapeHtml(fileName)}', true, false, '${escapeHtml(currentDir)}')">🔄 重试加载</button>` +
        `</div>`;
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
          bodyEl.innerHTML = `<div style="padding:24px; text-align:center; color:#cf1322;">读取文本失败: ${escapeHtml(errMsg)}</div>`;
          return;
        }
        const text = await res.text();
        bodyEl.innerHTML = `
          <div style="max-height:65vh; overflow:auto; padding:14px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">
            <pre style="margin:0; font-family:Consolas, monospace; font-size:12px; color:#1e293b; white-space:pre-wrap; word-break:break-all; line-height:1.5;">${escapeHtml(text)}</pre>
          </div>
        `;
      } catch (err) {
        bodyEl.innerHTML = `<div style="padding:24px; text-align:center; color:#cf1322;">读取文本失败: ${escapeHtml(err.message)}</div>`;
      }
    } else {
      bodyEl.innerHTML = `
        <div style="padding:36px 16px; text-align:center;">
          <div style="font-size:38px; margin-bottom:12px;">📄</div>
          <p style="color:#595959; margin-bottom:16px; font-size:13.5px;">该文件格式不支持在线直接预览，请下载到本地查看</p>
          <a href="${fileUrl}${tokenQuery}&download=1" download="${escapeHtml(fileName)}" class="run-button" style="display:inline-block; text-decoration:none; padding:6px 16px;">⬇️ 下载该文件</a>
        </div>
      `;
    }
  }

  function previewImage(fileName, url) {
    viewFile(fileName, true, false);
  }

  function init() {
    updateDeviceBanner();

    // Directory Switcher buttons
    const btnParams = byId('diskDirBtnParams');
    const btnAvatars = byId('diskDirBtnAvatars');
    if (btnParams) btnParams.addEventListener('click', () => selectDir('真参'));
    if (btnAvatars) btnAvatars.addEventListener('click', () => selectDir('头像'));

    // Refresh button
    const refreshBtn = byId('diskRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => fetchFileList());

    // File Input Upload
    const fileInput = byId('diskFileInput');
    const uploadBtn = byId('diskUploadBtn');
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', e => {
        if (e.target.files && e.target.files.length) {
          uploadFiles(Array.from(e.target.files));
          fileInput.value = '';
        }
      });
    }

    // Dropzone
    const dropzone = byId('diskDropzone');
    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());
      ['dragenter', 'dragover'].forEach(name => {
        dropzone.addEventListener(name, e => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add('drag-over');
        });
      });
      ['dragleave', 'drop'].forEach(name => {
        dropzone.addEventListener(name, e => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('drag-over');
        });
      });
      dropzone.addEventListener('drop', e => {
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          uploadFiles(Array.from(e.dataTransfer.files));
        }
      });
    }

    // Preview Dialog close button
    const closeDialogBtn = byId('closeDiskPreviewBtn');
    const previewDialog = byId('diskPreviewDialog');
    if (closeDialogBtn && previewDialog) {
      closeDialogBtn.addEventListener('click', () => {
        clearCloudDiskActivePreviewUrl();
        previewDialog.close();
      });
      previewDialog.addEventListener('close', clearCloudDiskActivePreviewUrl);
    }

    // Listen for global device selection events from app.js
    window.addEventListener('device:selected', e => {
      if (e.detail?.deviceId) {
        state.selectedDeviceId = e.detail.deviceId;
        updateDeviceBanner();
        renderFileList();
      }
    });

    // Initial fetch
    updateUiState();
    fetchFileList();
  }

  // Expose on window for other scripts and UI events
  window.CloudDisk = {
    init,
    refresh: fetchFileList,
    selectDir,
    sendToDevice,
    viewFile,
    previewImage,
    deleteFile,
    toggleStatus: async function(fileName, status) {
      try {
        const res = await fetch('/api/cloud-disk/zhencan/toggle-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName, status })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '操作失败');
        if (typeof showToast === 'function') showToast(data.message || '真参状态已更新', 'success');
        fetchFileList();
      } catch (err) {
        if (typeof showToast === 'function') showToast('更新真参状态失败: ' + err.message, 'error');
        else alert(err.message);
      }
    },
    onDeviceSelected: function (deviceId) {
      state.selectedDeviceId = deviceId;
      updateDeviceBanner();
      renderFileList(); // Update push buttons enabled state
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }
})();
