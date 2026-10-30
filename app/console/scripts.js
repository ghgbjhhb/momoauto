'use strict';

const STEPS_META = [
  { order: 1, id: 'flow-01-import-cloud-disk', name: '导入云盘', full: '01 导入云盘所有文件' },
  { order: 2, id: 'flow-02-upload-cert', name: '上传证书', full: '02 上传证书' },
  { order: 2.1, id: 'flow-02.1-import-params', name: '导入真参', full: '02.1 导入真参' },
  { order: 3, id: 'flow-03-set-vpc-proxy', name: 'VPC 代理', full: '03 设置 VPC 代理' },
  { order: 4, id: 'flow-04-setup-environment', name: '环境配置', full: '04 环境配置' },
  { order: 5, id: 'flow-05-generate-all', name: '一键生成', full: '05 一键生成全部' },
  { order: 6, id: 'flow-06-locate-ip', name: 'IP 定位', full: '06 定位到ip地' },
  { order: 7, id: 'flow-07-init-amap', name: '高德地图', full: '07 高德初始化' },
  { order: 8, id: 'flow-08-init-ime', name: '输入法', full: '08 输入法初始化' },
];

const STATUS_LABELS = {
  idle: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已停止，需核对'
};

function formatStepOrder(order) {
  if (typeof order !== 'number') return String(order || '');
  if (Number.isInteger(order)) return String(order).padStart(2, '0');
  return '0' + order;
}

function saveDeviceProgress() {
  try {
    localStorage.setItem('yunmomo.deviceProgress', JSON.stringify(state.deviceProgress));
  } catch { /* Storage might be unavailable. */ }
}

function getStepState(deviceId, order) {
  if (!deviceId || !state.deviceProgress[deviceId]) return 'idle';
  return state.deviceProgress[deviceId][order] || 'idle';
}

function setStepState(deviceId, order, status) {
  if (!deviceId) return;
  if (!state.deviceProgress[deviceId]) state.deviceProgress[deviceId] = {};
  state.deviceProgress[deviceId][order] = status;
  saveDeviceProgress();
  renderPipelineStepper();
  updateMiniStepperForDevice(deviceId);
}

function resetDeviceProgress(deviceId) {
  if (!deviceId) return;
  delete state.deviceProgress[deviceId];
  saveDeviceProgress();
  renderPipelineStepper();
  updateMiniStepperForDevice(deviceId);
  showToast('已重置该云手机执行记录');
}

function updateMiniStepperForDevice(deviceId) {
  const card = elements.deviceGrid?.querySelector(`.device-card[data-device-id="${deviceId}"]`);
  if (!card) return;
  const miniStepper = card.querySelector('.device-mini-stepper');
  if (!miniStepper) return;
  const dev = state.devices.find(d => String(d.deviceId) === String(deviceId));
  const isV2 = String(dev?.sdkVersion || '').toLowerCase() === 'v2';
  const metaList = STEPS_META.filter(s => isV2 ? s.order !== 8 : s.order !== 2.1);
  for (const meta of metaList) {
    const dot = miniStepper.querySelector(`[data-step="${meta.order}"]`);
    if (!dot) continue;
    dot.className = 'mini-step-dot';
    const st = getStepState(deviceId, meta.order);
    if (st && st !== 'idle') dot.classList.add(st);
    dot.title = `${meta.name}: ${STATUS_LABELS[st] || '待执行'}`;
  }
}

function renderPipelineStepper() {
  if (!elements.pipelineStepper) return;
  const target = currentDevice();
  if (elements.stepperTargetBadge) {
    if (target) {
      const idx = state.devices.indexOf(target) + 1;
      const ver = String(target.sdkVersion || '').toUpperCase();
      elements.stepperTargetBadge.textContent = `#${String(idx).padStart(2, '0')} ${target.name}` + (ver ? ` [${ver}]` : '');
      elements.stepperTargetBadge.title = `目标云机: ${target.name} (${target.deviceId})${ver ? ' · 架构版本: ' + ver : ''}`;
    } else {
      elements.stepperTargetBadge.textContent = '未选择目标';
      elements.stepperTargetBadge.title = '请在左侧选择目标云手机';
    }
  }

  const isV2 = String(target?.sdkVersion || '').toLowerCase() === 'v2';
  if (elements.stepperRunAllBtn) {
    const label = isV2 ? '执行全流程 (V2)' : '执行全流程 (V3)';
    const labelSpan = elements.stepperRunAllBtn.querySelector('span:last-child');
    if (labelSpan) labelSpan.textContent = label;
    else elements.stepperRunAllBtn.textContent = label;
    elements.stepperRunAllBtn.title = isV2 ? '执行全流程 01–07 (V2)' : '执行全流程 01–08 (V3)';
  }

  elements.pipelineStepper.replaceChildren();
  const visibleSteps = STEPS_META.filter(step => isV2 ? step.order !== 8 : step.order !== 2.1);
  for (const step of visibleSteps) {
    const status = target ? getStepState(target.deviceId, step.order) : 'idle';
    const node = document.createElement('div');
    node.className = `step-node ${status}`;
    node.dataset.stepOrder = String(step.order);
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.title = `${step.full}（状态: ${STATUS_LABELS[status] || status}，点击单独执行）`;

    const num = document.createElement('span');
    num.className = 'step-node-num';
    num.textContent = formatStepOrder(step.order);

    const info = document.createElement('div');
    info.className = 'step-node-info';

    const title = document.createElement('div');
    title.className = 'step-node-title';
    title.textContent = step.name;

    info.append(title);

    const indicator = document.createElement('span');
    indicator.className = 'step-node-indicator';
    if (status === 'completed') indicator.innerHTML = '<span class="status-icon-check">✓</span>';
    else if (status === 'running') indicator.innerHTML = '<span class="status-icon-pulse"></span>';
    else if (status === 'failed') indicator.innerHTML = '<span class="status-icon-fail">✗</span>';

    node.append(num, info, indicator);

    const triggerStep = () => {
      const dev = currentDevice();
      if (!dev) {
        showToast('请先选择一台云机');
        return;
      }
      const isV2 = String(dev.sdkVersion || '').toLowerCase() === 'v2';
      const targetVer = isV2 ? 'v2' : 'v3';
      const script = state.scripts.find(s => s.order === step.order && (s.category === targetVer || s.version === targetVer || s.id.endsWith('-' + targetVer)))
        || state.scripts.find(s => s.order === step.order);
      if (script) {
        const card = elements.scriptList.querySelector(`[data-script-id="${script.id}"]`);
        const btn = card?.querySelector('.run-button');
        executeScript(script, btn, card);
      } else {
        showToast(`未找到步骤 ${step.order} 对应的 ${targetVer.toUpperCase()} 执行脚本`);
      }
    };

    node.addEventListener('click', triggerStep);
    node.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerStep();
      }
    });

    elements.pipelineStepper.append(node);
  }
}


function parameterChoiceLabel(field, value) {
  if (field.name === 'action') return ({ set: '设置代理', show: '展示当前', close: '关闭代理' })[value] || String(value);
  if (field.name === 'androidVersion') return value === 'all' ? '全部版本' : 'Android ' + value;
  if (field.name === 'mode') return ({ random: '随机', button: '底部按钮', pull: '下拉刷新',
    execute: '执行发送', draft: '生成并输入', watch: '1. 挂机模式 (巡查前几页)', drain: '2. 全量模式 (必须翻到底)' })[value] || String(value);
  if (field.name === 'maxContacts') return ({ xx: '持续运行(无上限)', '1': '1人(单次测试)', '3': '3人', '5': '5人', '10': '10人' })[value] || String(value);
  if (field.name === 'warmupInterval') return ({ default: '默认(25~70分随机)', '0': '【立即养号(测试-启动即养号)】', '60000': '1分钟后养号', '300000': '5分钟后养号' })[value] || String(value);
  if (field.name === 'greetingsInterval') return ({ '0': '【发现招呼立即处理(测试)】', '1200000': '20分钟一次', '1800000': '30分钟一次' })[value] || String(value);
  if (field.name === 'maxApproved') return value + ' 人';
  if (field.name === 'maxDistance') return ({ none: '不限距离', '3': '≤ 3公里', '5': '≤ 5公里', '10': '≤ 10公里', '20': '≤ 20公里', '50': '≤ 50公里' })[value] || (value === 'none' ? '不限距离' : '≤ ' + value + '公里');
  if (field.name === 'approveProbability') return Math.round(Number(value) * 100) + '%';
  return String(value);
}

async function saveVisibilityConfig({ type, id, visible }) {
  if (!isScriptManageMode()) return;
  const payload = {};
  if (type === 'group') {
    if (!state.visibility.groups) state.visibility.groups = {};
    state.visibility.groups[id] = visible;
    payload.groups = { [id]: visible };
  } else if (type === 'script') {
    if (!state.visibility.scripts) state.visibility.scripts = {};
    state.visibility.scripts[id] = visible;
    payload.scripts = { [id]: visible };
  }
  try {
    const res = await requestJson('/api/admin/scripts/visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok && res.visibility) {
      state.visibility = res.visibility;
    }
    showToast(`已${visible ? '开启' : '关闭'}在用户侧的显示`);
    renderScripts();
  } catch (err) {
    showToast('更新显隐设置失败: ' + err.message);
  }
}

function createScriptCard(script) {
  const isManageMode = isScriptManageMode();
  const isScriptVisible = state.visibility?.scripts?.[script.id] !== false;

  // 普通用户视角（非管理模式）：若该脚本被管理员关闭，则直接不渲染
  if (!isManageMode && !isScriptVisible) return null;

  const card = document.createElement('article');
  card.className = 'script-card';
  card.dataset.scriptId = script.id;
  if (!isScriptVisible && isManageMode) card.classList.add('hidden-from-user');
  if (script.batch) card.classList.add('script-hero-card');

  const isSingleInline = script.parameters?.length === 1 && !script.parameters[0].multiline;
  if (script.parameters?.length && !isSingleInline) card.classList.add('script-card-has-params');
  if (script.destructive) card.classList.add('script-card-destructive');

  const head = document.createElement('div');
  head.className = 'script-card-head';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'script-title-group';

  if (script.order) {
    const order = document.createElement('span');
    order.className = 'script-order';
    order.textContent = formatStepOrder(script.order);
    titleGroup.append(order);
  }

  const title = document.createElement('div');
  title.className = 'script-title';
  title.textContent = script.order ? script.title.replace(/^(0[1-9](?:\.\d+)?|\d+)\s*[-_、\s]\s*/, '') : script.title;
  titleGroup.append(title);

  if (!isScriptVisible && isManageMode) {
    const hiddenBadge = document.createElement('span');
    hiddenBadge.className = 'badge-hidden-user';
    hiddenBadge.textContent = '用户侧隐藏';
    titleGroup.append(hiddenBadge);
  }

  head.append(titleGroup);

  if (script.destructive) {
    const dangerTag = document.createElement('span');
    dangerTag.className = 'script-danger-badge';
    dangerTag.textContent = '清数据';
    head.append(dangerTag);
  }

  // 仅在管理模式下渲染开关
  if (isManageMode) {
    const visWrap = document.createElement('div');
    visWrap.className = 'script-visibility-wrap';
    visWrap.innerHTML = `
      <label class="switch-toggle" title="控制此脚本在普通用户侧是否显示">
        <input type="checkbox" ${isScriptVisible ? 'checked' : ''}>
        <span class="switch-slider"></span>
        <span class="switch-text">${isScriptVisible ? '用户可见' : '隐藏'}</span>
      </label>
    `;
    const visInput = visWrap.querySelector('input');
    visInput.addEventListener('click', e => e.stopPropagation());
    visInput.addEventListener('change', e => {
      e.stopPropagation();
      saveVisibilityConfig({ type: 'script', id: script.id, visible: e.target.checked });
    });
    head.append(visWrap);
  }

  card.append(head);

  if (script.parameters?.length && !isSingleInline) {
    const settings = document.createElement('details');
    settings.className = 'script-settings';
    settings.open = true;
    const summary = document.createElement('summary');
    summary.textContent = '配置参数';
    settings.append(summary);

    for (const field of script.parameters) {
      const label = document.createElement('label');
      label.textContent = field.label;
      const input = document.createElement(field.choices ? 'select' : field.multiline ? 'textarea' : 'input');
      input.dataset.parameter = field.name;
      input.setAttribute('aria-label', field.label);
      if (field.required) {
        input.required = true;
        input.setAttribute('aria-required', 'true');
      }
      if (field.choices) {
        for (const value of field.choices) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = parameterChoiceLabel(field, value);
          input.append(option);
        }
      } else {
        if (!field.multiline) input.type = 'text';
        else input.rows = 3;
        input.name = `param_${script.id}_${field.name}`;
        input.autocomplete = 'new-password';
        input.setAttribute('autocomplete', 'new-password');
        input.setAttribute('data-lpignore', 'true');
        input.setAttribute('data-1p-ignore', 'true');
        input.setAttribute('data-form-type', 'other');
        input.spellcheck = false;
        if (field.maxLength) input.maxLength = field.maxLength;
        if (field.placeholder) input.placeholder = field.placeholder;
      }
      input.value = field.defaultValue ?? '';
      label.append(input);
      settings.append(label);
    }
    card.append(settings);
  }

  const actions = document.createElement('div');
  actions.className = 'script-actions';

  // 单一参数（如 VPC 代理操作选择、或真参输入）直接内联展示在执行按钮左侧，保持整齐一致
  if (isSingleInline) {
    const field = script.parameters[0];
    if (field.choices) {
      const select = document.createElement('select');
      select.className = 'script-inline-select';
      select.dataset.parameter = field.name;
      select.setAttribute('aria-label', field.label);
      for (const value of field.choices) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = parameterChoiceLabel(field, value);
        select.append(option);
      }
      select.value = field.defaultValue ?? '';
      actions.append(select);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'script-inline-input';
      input.dataset.parameter = field.name;
      input.name = `inline_${script.id}_${field.name}`;
      input.setAttribute('autocomplete', 'new-password');
      input.setAttribute('data-lpignore', 'true');
      input.setAttribute('data-form-type', 'other');
      input.setAttribute('aria-label', field.label);
      input.title = `${field.label}: ${field.defaultValue ?? ''}`;
      input.value = field.defaultValue ?? '';
      input.spellcheck = false;
      if (field.placeholder) input.placeholder = field.placeholder;
      actions.append(input);
    }
  }

  const activeRun = state.activeRun?.scriptId === script.id ? state.activeRun : null;
  const isCurrentRunning = Boolean(activeRun);
  const button = document.createElement('button');
  button.dataset.runButton = 'true';
  button.className = 'run-button' + (script.batch ? ' run-button-hero' : '') + (isCurrentRunning ? ' run-button-stop' : '');
  button.type = 'button';
  if (isCurrentRunning) {
    button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">${activeRun.stopConfirmed ? '已停止，整理结果…' : activeRun.stopping ? '正在停止…' : '停止执行'}</span>`;
    button.disabled = Boolean(activeRun.stopping || activeRun.stopConfirmed);
    button.setAttribute('aria-label', '停止 ' + script.title);
  } else {
    button.innerHTML = `<span class="run-icon">▶</span><span class="run-text">${script.batch ? '一键执行全部' : '执行'}</span>`;
    button.setAttribute('aria-label', '执行 ' + script.title);
  }
  button.addEventListener('click', () => {
    if (state.activeRun?.scriptId === script.id) stopRunningScript();
    else executeScript(script, button, card);
  });
  actions.append(button);

  card.append(actions);
  return card;
}

async function stopRunningScript() {
  const run = state.activeRun;
  if (!run) {
    showToast('当前没有正在执行的脚本');
    return;
  }
  if (run.stopping || run.stopConfirmed) return;
  run.stopping = true;
  updateScriptRunControls(run);
  showToast('正在停止脚本并等待进程退出…');
  try {
    const res = await requestJson('/api/execute/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptRunId: run.id
      })
    });
    if (res.stopped !== true) {
      run.stopping = false;
      updateScriptRunControls(run);
      showToast(res.message || '停止尚未确认，请查看当前运行状态');
      return;
    }
    if (state.activeRun?.id === run.id) {
      run.stopConfirmed = true;
      run.stopping = false;
      updateScriptRunControls(run);
      showToast(res.message || (res.pending ? '停止请求已登记' : '脚本已停止'));
      writeOutput(res.pending ? '【已登记停止请求】' : '【已停止并确认脚本进程退出】', [
        res.pending
          ? '服务端已登记停止请求；如果启动请求尚在途中，将在登记时取消脚本启动。页面会等待执行请求返回。'
          : '停止请求已确认，服务端已等待脚本进程退出并释放设备占用。',
        '脚本中断时设备状态可能只完成了部分操作；请核对设备后再继续。'
      ]);
    }
  } catch (error) {
    if (state.activeRun?.id === run.id) {
      run.stopping = false;
      updateScriptRunControls(run);
    }
    showToast('停止请求失败：' + error.message);
  }
}

function showInPageConfirm({ title, message, okText = '确定', cancelText = '取消', isDanger = true, icon = '!' } = {}) {
  return new Promise(resolve => {
    const dialog = document.getElementById('userConfirmDialog');
    if (!dialog) return resolve(false);
    const titleEl = document.getElementById('userConfirmTitle');
    const descEl = document.getElementById('userConfirmDesc');
    const okBtn = document.getElementById('userConfirmOkBtn');
    const cancelBtn = document.getElementById('userConfirmCancelBtn');
    const closeBtn = document.getElementById('userConfirmCloseBtn');
    const iconEl = document.getElementById('userConfirmIcon');

    if (titleEl) titleEl.textContent = title;
    if (descEl) descEl.innerHTML = message;
    if (okBtn) {
      okBtn.textContent = okText;
      okBtn.className = isDanger ? 'danger-button' : 'run-button';
      okBtn.style.background = '';
      okBtn.style.borderColor = '';
      okBtn.style.color = '';
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;
    if (iconEl) {
      iconEl.textContent = icon;
      iconEl.classList.toggle('info', !isDanger);
    }

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      try { dialog.close(); } catch {}
      okBtn?.removeEventListener('click', onOk);
      cancelBtn?.removeEventListener('click', onCancel);
      closeBtn?.removeEventListener('click', onCancel);
      dialog.removeEventListener('keydown', onKeyDown);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('click', onBackdropClick);
    };

    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(false); }
    };
    const onBackdropClick = (e) => {
      const rect = dialog.getBoundingClientRect();
      const inDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height
        && rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
      if (!inDialog) {
        cleanup();
        resolve(false);
      }
    };

    okBtn?.addEventListener('click', onOk);
    cancelBtn?.addEventListener('click', onCancel);
    closeBtn?.addEventListener('click', onCancel);
    dialog.addEventListener('keydown', onKeyDown);
    dialog.addEventListener('cancel', onCancel, { once: true });
    dialog.addEventListener('click', onBackdropClick);

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');

    // 高危破坏性操作默认将焦点落在“取消”按钮，防止误敲回车造成不可逆损失
    if (isDanger) {
      cancelBtn?.focus();
    } else {
      okBtn?.focus();
    }
  });
}

function createVersionSection(versionTag, title, scripts, defaultCollapsed = false, groupKey = '') {
  const isManageMode = isScriptManageMode();
  const isGroupVisible = state.visibility?.groups?.[groupKey] !== false;

  // 普通用户视角（非管理模式）：如果该分组被关闭，直接不渲染
  if (!isManageMode && !isGroupVisible) return null;

  const section = document.createElement('section');
  const tagClass = versionTag.toLowerCase() + '-tag';
  const colClass = versionTag.toLowerCase() + '-column';

  const storageKey = `yunmomo.collapse.${versionTag.toLowerCase()}`;
  let isCollapsed = defaultCollapsed;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) isCollapsed = saved === 'true';
  } catch {}

  section.className = `scripts-version-column ${colClass}` + (isCollapsed ? ' collapsed' : '') + (!isGroupVisible && isManageMode ? ' hidden-from-user' : '');
  section.innerHTML = `
    <div class="version-column-head" role="button" tabindex="0" title="点击展开/收起此栏脚本">
      <div class="version-badge-group">
        <span class="version-title">${title}</span>
        ${!isGroupVisible && isManageMode ? '<span class="badge-hidden-user">用户侧隐藏</span>' : ''}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        ${isManageMode ? `
          <div class="group-visibility-wrap" title="控制是否在普通用户侧显示此分组">
            <label class="switch-toggle" onclick="event.stopPropagation()">
              <input type="checkbox" class="group-vis-input" data-group="${groupKey}" ${isGroupVisible ? 'checked' : ''}>
              <span class="switch-slider"></span>
              <span class="switch-text">${isGroupVisible ? '用户可见' : '隐藏'}</span>
            </label>
          </div>
        ` : ''}
        <button class="version-collapse-btn" type="button" aria-expanded="${!isCollapsed}" title="点击收起/展开">
          <span class="toggle-text">${isCollapsed ? '展开' : '收起'}</span>
          <span class="toggle-icon">${isCollapsed ? '▼' : '▲'}</span>
        </button>
      </div>
    </div>
    <div class="version-cards-stack"></div>
  `;

  if (isManageMode) {
    const groupInput = section.querySelector('.group-vis-input');
    if (groupInput) {
      groupInput.addEventListener('change', e => {
        e.stopPropagation();
        saveVisibilityConfig({ type: 'group', id: groupKey, visible: e.target.checked });
      });
    }
  }

  const stack = section.querySelector('.version-cards-stack');
  let visibleCount = 0;
  for (const script of scripts) {
    const card = createScriptCard(script);
    if (card) {
      stack.append(card);
      visibleCount++;
    }
  }

  if (!isManageMode && visibleCount === 0) return null;

  const head = section.querySelector('.version-column-head');
  const toggleBtn = section.querySelector('.version-collapse-btn');
  const toggleText = section.querySelector('.toggle-text');
  const toggleIcon = section.querySelector('.toggle-icon');

  function toggleCollapse(e) {
    if (e) e.stopPropagation();
    isCollapsed = !isCollapsed;
    section.classList.toggle('collapsed', isCollapsed);
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    toggleText.textContent = isCollapsed ? '展开' : '收起';
    toggleIcon.textContent = isCollapsed ? '▼' : '▲';
    try {
      localStorage.setItem(storageKey, String(isCollapsed));
    } catch {}
  }

  head.addEventListener('click', toggleCollapse);
  head.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleCollapse(e);
    }
  });

  return section;
}

function createBundleCard(bundle) {
  const isManageMode = isScriptManageMode();
  const isEnabled = bundle.enabled !== false;

  // 普通用户视角（非管理模式）：若组合脚本被关闭，直接不渲染
  if (!isManageMode && !isEnabled) return null;

  const card = document.createElement('article');
  card.className = 'script-card bundle-card' + (!isEnabled && isManageMode ? ' hidden-from-user' : '');
  card.dataset.bundleId = bundle.id;

  const stepScripts = (bundle.stepIds || [])
    .map(id => state.scripts.find(s => s.id === id))
    .filter(Boolean);

  const head = document.createElement('div');
  head.className = 'script-card-head';
  head.style.flexDirection = 'column';
  head.style.alignItems = 'stretch';
  head.style.gap = 'var(--sp-4)';

  // 标题行与管理操作
  const titleRow = document.createElement('div');
  titleRow.className = 'ui-row-between';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'script-title-group';

  const badge = document.createElement('span');
  badge.className = 'bundle-badge';
  badge.textContent = '组合';

  const title = document.createElement('div');
  title.className = 'script-title';
  title.textContent = bundle.name;

  titleGroup.append(badge, title);

  if (!isEnabled && isManageMode) {
    const hiddenBadge = document.createElement('span');
    hiddenBadge.className = 'badge-hidden-user';
    hiddenBadge.textContent = '用户侧隐藏';
    titleGroup.append(hiddenBadge);
  }

  titleRow.append(titleGroup);

  if (isManageMode) {
    const adminActions = document.createElement('div');
    adminActions.className = 'bundle-admin-actions';

    // 显隐开关
    const visWrap = document.createElement('div');
    visWrap.className = 'script-visibility-wrap';
    visWrap.innerHTML = `
      <label class="switch-toggle" title="控制此组合脚本在普通用户侧是否显示">
        <input type="checkbox" ${isEnabled ? 'checked' : ''}>
        <span class="switch-slider"></span>
        <span class="switch-text">${isEnabled ? '用户可见' : '隐藏'}</span>
      </label>
    `;
    const visInput = visWrap.querySelector('input');
    visInput.addEventListener('change', async e => {
      e.stopPropagation();
      bundle.enabled = e.target.checked;
      await saveBundleDirect(bundle);
    });

    // 编辑按钮
    const editBtn = document.createElement('button');
    editBtn.className = 'action-btn small';
    editBtn.type = 'button';
    editBtn.textContent = '编辑';
    editBtn.title = '编辑组合名称、备注及步骤';
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      openBundleModal(bundle);
    });

    // 删除按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn small danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '删除';
    deleteBtn.title = '删除此自定义脚本组合';
    deleteBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const confirmed = await showInPageConfirm({
        title: '确认删除脚本组合？',
        message: `确定要彻底删除组合脚本 <strong>${escapeHtml(bundle.name)}</strong> 吗？此操作无法撤销。`,
        okText: '确认删除',
        isDanger: true
      });
      if (!confirmed) return;
      await deleteBundle(bundle.id);
    });

    adminActions.append(visWrap, editBtn, deleteBtn);
    titleRow.append(adminActions);
  }

  head.append(titleRow);

  // 备注 / 脚本功能说明
  if (bundle.description) {
    const desc = document.createElement('div');
    desc.className = 'bundle-desc';
    desc.textContent = bundle.description;
    head.append(desc);
  }

  // 步骤徽章流
  if (stepScripts.length > 0) {
    const flow = document.createElement('div');
    flow.className = 'bundle-steps-flow';
    stepScripts.forEach((step, idx) => {
      if (idx > 0) {
        const arrow = document.createElement('span');
        arrow.className = 'bundle-step-arrow';
        arrow.textContent = '→';
        flow.append(arrow);
      }
      const tag = document.createElement('span');
      tag.className = 'bundle-step-item';
      tag.textContent = `${idx + 1}. ${step.title.replace(/^(0[1-9](?:\.\d+)?|\d+)\s*[-_、\s]\s*/, '')}`;
      flow.append(tag);
    });
    head.append(flow);
  }

  card.append(head);

  // 执行按钮
  const actions = document.createElement('div');
  actions.className = 'script-actions';

  const isCurrentRunning = state.activeBundleRun?.bundleId === bundle.id;
  const button = document.createElement('button');
  button.className = 'run-button' + (isCurrentRunning ? ' run-button-stop' : '');
  button.type = 'button';

  if (isCurrentRunning) {
    button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">停止组合</span>`;
  } else {
    button.innerHTML = `<span class="run-icon">▶</span><span class="run-text">执行组合</span>`;
  }

  button.addEventListener('click', () => {
    if (state.activeBundleRun?.bundleId === bundle.id) {
      stopRunningBundle();
    } else {
      executeScriptBundle(bundle, button, card);
    }
  });

  actions.append(button);
  card.append(actions);

  return card;
}

function renderScripts() {
  elements.scriptList.replaceChildren();

  const isManageMode = isScriptManageMode();

  const v2Scripts = state.scripts
    .filter(s => s.category === 'v2' || s.version === 'v2' || s.id.endsWith('-v2'))
    .filter(s => !s.batch)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  const v3Scripts = state.scripts
    .filter(s => s.category === 'v3' || s.version === 'v3' || s.id.endsWith('-v3'))
    .filter(s => !s.batch)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  const momoScripts = state.scripts
    .filter(s => s.category === 'momo')
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  const batchScripts = state.scripts
    .filter(s => s.batch || s.id.startsWith('flow-all'));

  // 1 & 2: V2 与 V3 流程架构双列并排展示
  const columnsContainer = document.createElement('div');
  columnsContainer.className = 'scripts-columns-container';

  if (v2Scripts.length > 0) {
    const v2Section = createVersionSection('V2', 'V2 流程架构 (01~07)', v2Scripts, false, 'v2');
    if (v2Section) columnsContainer.append(v2Section);
  }

  if (v3Scripts.length > 0) {
    const v3Section = createVersionSection('V3', 'V3 极速架构 (01~08)', v3Scripts, false, 'v3');
    if (v3Section) columnsContainer.append(v3Section);
  }

  if (columnsContainer.hasChildNodes()) {
    elements.scriptList.append(columnsContainer);
  }

  // 3. MOMO 业务自动化板块 (11~15 + 全量执行)
  const isMomoVisible = state.visibility?.groups?.momo !== false;
  if ((momoScripts.length || batchScripts.length) && (isManageMode || isMomoVisible)) {
    const momoSection = document.createElement('section');
    const storageKey = 'yunmomo.collapse.momo';
    let isMomoCollapsed = false;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved !== null) isMomoCollapsed = saved === 'true';
    } catch {}

    momoSection.className = 'scripts-momo-section' + (isMomoCollapsed ? ' collapsed' : '') + (!isMomoVisible && isManageMode ? ' hidden-from-user' : '');
    momoSection.innerHTML = `
      <div class="momo-section-head version-column-head" role="button" tabindex="0" title="点击展开/收起此栏脚本">
        <div class="momo-title-group version-badge-group">
          <span class="momo-title version-title">MOMO 业务自动化 (11~15)</span>
          ${!isMomoVisible && isManageMode ? '<span class="badge-hidden-user">用户侧隐藏</span>' : ''}
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          ${isManageMode ? `
            <div class="group-visibility-wrap" title="控制是否在普通用户侧显示此分组">
              <label class="switch-toggle" onclick="event.stopPropagation()">
                <input type="checkbox" class="momo-vis-input" ${isMomoVisible ? 'checked' : ''}>
                <span class="switch-slider"></span>
                <span class="switch-text">${isMomoVisible ? '用户可见' : '隐藏'}</span>
              </label>
            </div>
          ` : ''}
          <button class="version-collapse-btn" type="button" aria-expanded="${!isMomoCollapsed}" title="点击收起/展开">
            <span class="toggle-text">${isMomoCollapsed ? '展开' : '收起'}</span>
            <span class="toggle-icon">${isMomoCollapsed ? '▼' : '▲'}</span>
          </button>
        </div>
      </div>
      <div class="momo-cards-grid version-cards-stack"></div>
    `;

    if (isManageMode) {
      const momoVisInput = momoSection.querySelector('.momo-vis-input');
      if (momoVisInput) {
        momoVisInput.addEventListener('change', e => {
          e.stopPropagation();
          saveVisibilityConfig({ type: 'group', id: 'momo', visible: e.target.checked });
        });
      }
    }

    const momoGrid = momoSection.querySelector('.momo-cards-grid');
    let visibleCount = 0;
    for (const script of momoScripts) {
      const card = createScriptCard(script);
      if (card) { momoGrid.append(card); visibleCount++; }
    }
    for (const script of batchScripts) {
      const card = createScriptCard(script);
      if (card) { momoGrid.append(card); visibleCount++; }
    }

    if (isManageMode || visibleCount > 0) {
      const head = momoSection.querySelector('.momo-section-head');
      const toggleBtn = momoSection.querySelector('.version-collapse-btn');
      const toggleText = momoSection.querySelector('.toggle-text');
      const toggleIcon = momoSection.querySelector('.toggle-icon');

      function toggleMomo(e) {
        if (e) e.stopPropagation();
        isMomoCollapsed = !isMomoCollapsed;
        momoSection.classList.toggle('collapsed', isMomoCollapsed);
        toggleBtn.setAttribute('aria-expanded', String(!isMomoCollapsed));
        toggleText.textContent = isMomoCollapsed ? '展开' : '收起';
        toggleIcon.textContent = isMomoCollapsed ? '▼' : '▲';
        try {
          localStorage.setItem(storageKey, String(isMomoCollapsed));
        } catch {}
      }

      head.addEventListener('click', toggleMomo);
      head.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleMomo(e);
        }
      });

      elements.scriptList.append(momoSection);
    }
  }

  // 4. 自定义组合脚本板块
  const isCustomGroupVisible = state.visibility?.groups?.custom !== false;
  const bundles = Array.isArray(state.bundles) ? state.bundles : [];
  const displayBundles = isManageMode
    ? bundles
    : bundles.filter(b => b.enabled !== false);

  if (isManageMode || (isCustomGroupVisible && displayBundles.length > 0)) {
    const bundleSection = document.createElement('section');
    bundleSection.className = 'scripts-bundle-section' + (!isCustomGroupVisible && isManageMode ? ' hidden-from-user' : '');
    bundleSection.innerHTML = `
      <div class="bundle-section-head">
        <div class="bundle-title-group">
          <span class="bundle-badge">组合</span>
          <span class="bundle-section-title">自定义组合脚本</span>
          ${!isCustomGroupVisible && isManageMode ? '<span class="badge-hidden-user">用户侧隐藏</span>' : ''}
        </div>
        <div class="bundle-head-actions">
          ${isManageMode ? `
            <div class="group-visibility-wrap" title="控制是否在普通用户侧显示此组合板块">
              <label class="switch-toggle" onclick="event.stopPropagation()">
                <input type="checkbox" class="custom-group-vis-input" ${isCustomGroupVisible ? 'checked' : ''}>
                <span class="switch-slider"></span>
                <span class="switch-text">${isCustomGroupVisible ? '用户可见' : '隐藏'}</span>
              </label>
            </div>
            <button class="action-btn small" id="openCreateBundleBtn" type="button" style="background:#1677ff; color:#fff; border-color:#1677ff; font-weight:600;">+ 新建组合脚本</button>
          ` : ''}
        </div>
      </div>
      <div class="bundle-cards-stack"></div>
    `;

    if (isManageMode) {
      const customGroupInput = bundleSection.querySelector('.custom-group-vis-input');
      if (customGroupInput) {
        customGroupInput.addEventListener('change', e => {
          e.stopPropagation();
          saveVisibilityConfig({ type: 'group', id: 'custom', visible: e.target.checked });
        });
      }
      const openCreateBtn = bundleSection.querySelector('#openCreateBundleBtn');
      if (openCreateBtn) {
        openCreateBtn.addEventListener('click', () => openBundleModal());
      }
    }

    const bundleStack = bundleSection.querySelector('.bundle-cards-stack');
    if (displayBundles.length === 0) {
      const emptyTip = document.createElement('div');
      emptyTip.className = 'ui-empty';
      emptyTip.textContent = isManageMode
        ? '暂无自定义组合脚本，点击右上角【+ 新建组合脚本】可以将多个脚本按序串联为一个组合供用户使用。'
        : '暂无可用组合脚本';
      bundleStack.append(emptyTip);
    } else {
      for (const bundle of displayBundles) {
        const bCard = createBundleCard(bundle);
        if (bCard) bundleStack.append(bCard);
      }
    }

    elements.scriptList.append(bundleSection);
  }
}



function promptVpcProxyDialog() {
  const dialog = document.getElementById('vpcDialog') || document.getElementById('vpcProxyDialog');
  const input = document.getElementById('vpcRawInput') || document.getElementById('vpcProxyInput');
  const closeBtn = document.getElementById('closeVpcDialogBtn');
  const cancelBtn = document.getElementById('cancelVpcBtn') || document.getElementById('cancelVpcDialogBtn');
  const confirmBtn = document.getElementById('confirmVpcBtn') || document.getElementById('confirmVpcDialogBtn');

  if (!dialog || !input) return Promise.resolve(null);

  return new Promise(resolve => {
    let resolved = false;

    const cleanup = () => {
      closeBtn?.removeEventListener('click', onCancel);
      cancelBtn?.removeEventListener('click', onCancel);
      confirmBtn?.removeEventListener('click', onConfirm);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('keydown', onKeyDown);
    };

    const finish = value => {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { dialog.close(); } catch {}
      resolve(value);
    };

    const onCancel = () => finish(null);

    const onConfirm = () => {
      const val = input.value.trim();
      if (!val) {
        showToast('请输入 VPC 代理数据');
        input.focus();
        return;
      }
      finish(val);
    };

    const onKeyDown = e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onConfirm();
      }
    };

    closeBtn?.addEventListener('click', onCancel);
    cancelBtn?.addEventListener('click', onCancel);
    confirmBtn?.addEventListener('click', onConfirm);
    dialog.addEventListener('cancel', onCancel, { once: true });
    dialog.addEventListener('keydown', onKeyDown);

    input.value = '';
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch {
      dialog.setAttribute('open', '');
    }
    setTimeout(() => input.focus(), 50);
  });
}

async function executeScript(script, button, card) {
  if (state.activeRun || state.runningScript) { showToast('请等待当前脚本结束'); return; }
  if (state.manualDeviceId) { showToast('请先关闭手动操作窗，再运行脚本'); return; }
  if (!state.tokenConfigured) {
    showToast('尚未连接');
    return;
  }
  if (script.requiresDevice && !currentDevice()) {
    showToast('请点击一台云机');
    return;
  }
  const targetId = state.selectedDeviceId;
  const externalRun = remoteRunForScript(script);
  if (externalRun) {
    const device = state.devices.find(item => item.deviceId === externalRun.deviceId);
    showToast(`${device ? device.name + ' ' : ''}正在另一个网页执行「${externalRun.title}」`);
    return;
  }
  const manual = script.requiresDevice ? manualWindowsForDevice(targetId) : null;
  if (manual?.windows) {
    showToast(`${currentDevice()?.name || '所选设备'}正在被其他网页手动操作`);
    return;
  }
  const options = {};
  if (card) {
    for (const input of card.querySelectorAll('[data-parameter]')) {
      const value = String(input.value ?? '').trim();
      if (input.required && !value) {
        input.focus?.();
        showToast((input.getAttribute('aria-label') || '该参数') + '为必填项');
        return;
      }
      if (value) options[input.dataset.parameter] = value;
    }
  }

  // 03 设置 VPC 代理：网页弹窗识别并输入 VPC 代理（仅当操作指令为设置时才弹窗）
  if (script.id === 'flow-03' || script.order === 3 || script.id.startsWith('flow-03')) {
    const action = options.action || 'set';
    if (action === 'set') {
      const vpcData = await promptVpcProxyDialog();
      if (!vpcData) return;
      options.vpcData = vpcData;
    }
  }

  let resetConfirmed = false;
  if (script.destructive) {
    const isV2 = script.id === 'flow-09-v2';
    const isBlock = script.id === 'flow-18';
    const targetLabel = escapeHtml(deviceLabel(currentDevice()));
    let message, title, okText;
    if (isBlock) {
      const peerLabel = escapeHtml(options.contactName || '未指定联系人');
      title = '确认执行【拉黑联系人】？';
      okText = '确认拉黑';
      message = `<div class="confirm-target-lead">确认拉黑联系人 <strong>${peerLabel}</strong>？</div>
         <div class="confirm-danger-card">
           <div class="confirm-danger-card-icon">!</div>
           <div class="confirm-danger-card-body">
             <div class="confirm-danger-card-title">拉黑后对方将无法再联系此账号！</div>
             <div class="confirm-danger-card-desc">执行前请确认云机已停留在该联系人的聊天页，脚本会先核验顶栏姓名再操作。</div>
           </div>
         </div>`;
    } else {
      message = isV2
        ? `<div class="confirm-target-lead">确认对 <strong>${targetLabel}</strong> 执行“重置数据”？</div>
           <div class="confirm-danger-card">
             <div class="confirm-danger-card-icon">!</div>
             <div class="confirm-danger-card-body">
               <div class="confirm-danger-card-title">警告：即将重置该设备，此操作不可恢复！</div>
               <div class="confirm-danger-card-desc">清空该设备所有数据并恢复出厂设置。</div>
             </div>
           </div>`
        : `<div class="confirm-target-lead">确认对 <strong>${targetLabel}</strong> 执行“改机重置”？</div>
           <div class="confirm-sub-text" style="margin-bottom:8px;">机型范围：Android ${escapeHtml(options.androidVersion || '16')}；国家：${escapeHtml(options.countryCode || 'CN')}。</div>
           <div class="confirm-danger-card">
             <div class="confirm-danger-card-icon">!</div>
             <div class="confirm-danger-card-body">
               <div class="confirm-danger-card-title">警告：此操作会清除该设备所有数据且不可撤销！</div>
               <div class="confirm-danger-card-desc">重置后云机将自动重启并应用新机型参数。</div>
             </div>
           </div>`;
      title = isV2 ? '确认执行【重置数据】？' : '确认执行【改机重置】？';
      okText = isV2 ? '确认重置' : '确认改机重置';
    }
    resetConfirmed = await showInPageConfirm({
      title,
      message,
      okText,
      isDanger: true,
      icon: '!'
    });
    if (!resetConfirmed) return;
  }
  const scriptRunId = createScriptRunId();
  const run = { id: scriptRunId, scriptId: script.id, deviceId: targetId, stopping: false, stopConfirmed: false };
  state.activeRun = run;
  state.runningScript = script.id;
  if (elements.stopScriptBtn) {
    elements.stopScriptBtn.style.display = 'inline-flex';
    elements.stopScriptBtn.disabled = false;
    elements.stopScriptBtn.textContent = '⏹ 停止脚本';
  }
  if (button) {
    button.disabled = false;
    button.classList.add('run-button-stop');
    button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">停止执行</span>`;
  }
  if (card) card.classList.add('running');
  window.AppLogger?.info('Script', `启动执行脚本 [${script.title}] (目标设备: ${targetId}, 运行ID: ${scriptRunId})`);
  writeOutput('正在执行：' + script.title, [], { runId: scriptRunId });

  let isPollingOutput = false;
  const outputPollTimer = setInterval(async () => {
    if (!state.activeRun || state.activeRun.id !== scriptRunId) {
      clearInterval(outputPollTimer);
      return;
    }
    if (isPollingOutput) return;
    isPollingOutput = true;
    try {
      const live = await requestJson('/api/execute/output?scriptRunId=' + encodeURIComponent(scriptRunId));
      if (live.ok) {
        if (live.logFile && state.activeRun) state.activeRun.logFile = live.logFile;
        if (live.stdout || live.stderr) {
          if (state.activeRun && state.activeRun.id === scriptRunId) {
            const lines = cleanScriptLines(live.stdout, live.stderr);
            writeOutput('正在执行：' + script.title, lines, { runId: scriptRunId, logFile: live.logFile });
          }
        }
      }
    } catch { /* 轮询异常静默忽略 */ }
    finally { isPollingOutput = false; }
  }, 300);

  if (script.order >= 1 && script.order <= 8) {
    setStepState(targetId, script.order, 'running');
  } else if (script.batch || script.id === 'flow-all') {
    setStepState(targetId, 1, 'running');
  }

  try {
    const result = await requestJson('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptRunId,
        scriptId: script.id,
        deviceId: targetId,
        pageId: state.pageId,
        options,
        resetConfirmed
      })
    });
    clearInterval(outputPollTimer);
    if (state.activeRun && state.activeRun.id !== scriptRunId) return;
    const lines = cleanScriptLines(result.stdout, result.stderr);
    const durationSec = Number.isFinite(result.durationMs) ? (result.durationMs / 1000).toFixed(1) + 's' : '';
    let title;
    if (result.cancelled) {
      title = '脚本已停止：' + script.title;
      lines.push('（已停止执行）');
    } else if (result.ok) {
      title = '执行成功：' + script.title + (durationSec ? ' (' + durationSec + ')' : '');
    } else {
      title = '执行失败：' + script.title + (result.exitCode !== null ? ' (退出码: ' + result.exitCode + ')' : '');
    }
    writeOutput(title, lines, { runId: scriptRunId, logFile: result.logFile });
    if (result.ok && card) {
      const privateInput = card.querySelector('[data-parameter="vpcData"]');
      if (privateInput) privateInput.value = '';
    }
    if (result.ok) {
      const vpcInput = document.getElementById('vpcRawInput') || document.getElementById('vpcProxyInput');
      if (vpcInput) vpcInput.value = '';
    }

    if (script.order >= 1 && script.order <= 8) {
      setStepState(targetId, script.order, result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed');
    } else if (script.batch || script.id === 'flow-all') {
      if (result.ok) {
        for (let i = 1; i <= 8; i++) setStepState(targetId, i, 'completed');
      } else {
        const out = (result.stdout || '') + '\n' + (result.stderr || '');
        for (let i = 1; i <= 8; i++) {
          if (out.includes(`[${i}/8] 成功完成`)) {
            setStepState(targetId, i, 'completed');
          } else if (out.includes(`[${i}/8] 执行失败`)) {
            setStepState(targetId, i, 'failed');
          }
        }
      }
      if (result.cancelled) {
        for (let i = 1; i <= 8; i++) {
          if (getStepState(targetId, i) === 'running') setStepState(targetId, i, 'cancelled');
        }
      }
    }

    if (result.cancelled) {
      window.AppLogger?.warn('Script', `脚本已人为中断 [${script.title}] (运行ID: ${scriptRunId})`);
      showToast('脚本已停止，请核对设备状态');
    } else if (!result.ok) {
      window.AppLogger?.error('Script', `脚本执行未达成目标 [${script.title}] (运行ID: ${scriptRunId})`);
      showToast('脚本执行失败，请查看执行记录');
    } else {
      window.AppLogger?.info('Script', `脚本执行成功达成 [${script.title}] (运行ID: ${scriptRunId})`);
    }
    requestAllPreviews();
    if (state.tokenConfigured) loadDevices(true);
  } catch (error) {
    if (state.activeRun && state.activeRun.id !== scriptRunId) return;
    if (run.stopConfirmed) {
      writeOutput('脚本已停止：' + script.title, [
        '服务端已确认脚本进程退出并释放设备占用。',
        '脚本中断时设备状态可能只完成了部分操作；请核对设备后再继续。'
      ]);
      showToast('脚本已停止，请核对设备状态');
      if (targetId && script.order >= 1 && script.order <= 8) {
        setStepState(targetId, script.order, 'cancelled');
      } else if (targetId && (script.batch || script.id === 'flow-all')) {
        for (let i = 1; i <= 8; i++) {
          if (getStepState(targetId, i) === 'running') setStepState(targetId, i, 'cancelled');
        }
      }
      return;
    }
    if (targetId) {
      if (script.order >= 1 && script.order <= 8) {
        setStepState(targetId, script.order, 'failed');
      } else if (script.batch || script.id === 'flow-all') {
        const cur = getStepState(targetId, 1);
        if (cur === 'running') setStepState(targetId, 1, 'failed');
      }
    }
    const isNetwork = error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError');
    const displayMsg = isNetwork
      ? '网络连接失败（Failed to fetch）：后端控制台服务暂时断开或重启中，请检查服务是否运行或稍后重试。'
      : error.message;
    writeOutput('执行请求失败：' + script.title, [
      displayMsg,
      Number.isFinite(error.durationMs) ? '总耗时：' + error.durationMs + ' ms' : '',
      `调用编号：${scriptRunId}`,
      state.activeRun?.logFile ? `原始日志：${state.activeRun.logFile}` : ''
    ], { runId: scriptRunId });
    window.AppLogger?.error('Script', `脚本执行异常失败 [${script.title}]: ${displayMsg}`, { runId: scriptRunId, error: error.message });
    showToast(displayMsg);
  } finally {
    clearInterval(outputPollTimer);
    if (state.activeRun?.id === scriptRunId) {
      state.activeRun = null;
      state.runningScript = '';
      if (elements.stopScriptBtn) {
        elements.stopScriptBtn.style.display = 'none';
        elements.stopScriptBtn.disabled = false;
        elements.stopScriptBtn.textContent = '⏹ 停止脚本';
      }
      if (button) {
        button.disabled = false;
        button.classList.remove('run-button-stop');
        button.innerHTML = `<span class="run-icon">▶</span><span class="run-text">${script.batch ? '一键执行全部' : '执行'}</span>`;
      }
      if (card) card.classList.remove('running');
    }
    loadSharedRuntimeState();
  }
}



async function executeSingleStep(script, targetId, options = {}) {
  const scriptRunId = createScriptRunId();
  const run = { id: scriptRunId, scriptId: script.id, deviceId: targetId, stopping: false, stopConfirmed: false };
  state.activeRun = run;
  state.runningScript = script.id;

  if (elements.stopScriptBtn) {
    elements.stopScriptBtn.style.display = 'inline-flex';
    elements.stopScriptBtn.disabled = false;
    elements.stopScriptBtn.textContent = '⏹ 停止脚本';
  }

  if (script.order >= 1 && script.order <= 8) {
    setStepState(targetId, script.order, 'running');
  }

  let isPollingOutput = false;
  const outputPollTimer = setInterval(async () => {
    if (!state.activeRun || state.activeRun.id !== scriptRunId) {
      clearInterval(outputPollTimer);
      return;
    }
    if (isPollingOutput) return;
    isPollingOutput = true;
    try {
      const live = await requestJson('/api/execute/output?scriptRunId=' + encodeURIComponent(scriptRunId));
      if (live.ok) {
        if (live.logFile && state.activeRun) state.activeRun.logFile = live.logFile;
        if (live.stdout || live.stderr) {
          if (state.activeRun && state.activeRun.id === scriptRunId) {
            const lines = cleanScriptLines(live.stdout, live.stderr);
            writeOutput('正在执行：' + script.title, lines, { runId: scriptRunId, logFile: live.logFile });
          }
        }
      }
    } catch {}
    finally { isPollingOutput = false; }
  }, 300);

  try {
    const result = await requestJson('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptRunId,
        scriptId: script.id,
        deviceId: targetId,
        pageId: state.pageId,
        options
      })
    });
    clearInterval(outputPollTimer);
    const lines = cleanScriptLines(result.stdout, result.stderr);
    const durationSec = Number.isFinite(result.durationMs) ? (result.durationMs / 1000).toFixed(1) + 's' : '';
    writeOutput(
      result.cancelled ? '脚本已停止：' + script.title : result.ok ? '执行成功：' + script.title : '执行失败：' + script.title,
      lines,
      { runId: scriptRunId, logFile: result.logFile }
    );

    if (script.order >= 1 && script.order <= 8) {
      setStepState(targetId, script.order, result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed');
    }

    return {
      ok: Boolean(result.ok),
      cancelled: Boolean(result.cancelled),
      exitCode: result.exitCode,
      durationSec,
      logFile: result.logFile
    };
  } catch (err) {
    clearInterval(outputPollTimer);
    if (script.order >= 1 && script.order <= 8) {
      setStepState(targetId, script.order, 'failed');
    }
    return {
      ok: false,
      cancelled: run.stopConfirmed,
      exitCode: -1,
      durationSec: '',
      error: err.message
    };
  } finally {
    clearInterval(outputPollTimer);
    if (state.activeRun?.id === scriptRunId) {
      state.activeRun = null;
      state.runningScript = '';
      if (elements.stopScriptBtn) {
        elements.stopScriptBtn.style.display = 'none';
        elements.stopScriptBtn.disabled = false;
        elements.stopScriptBtn.textContent = '⏹ 停止脚本';
      }
    }
  }
}

async function executeScriptBundle(bundle, button, card) {
  if (state.activeRun || state.runningScript || state.activeBundleRun) {
    showToast('请等待当前正在运行的脚本完成');
    return;
  }
  if (state.manualDeviceId) {
    showToast('请先关闭手动操作窗，再运行脚本');
    return;
  }
  if (!state.tokenConfigured) {
    showToast('尚未连接');
    return;
  }
  const targetId = state.selectedDeviceId;
  const stepScripts = (bundle.stepIds || [])
    .map(id => state.scripts.find(s => s.id === id))
    .filter(Boolean);

  if (stepScripts.length === 0) {
    showToast('此组合未包含有效脚本步骤');
    return;
  }

  const anyRequiresDevice = stepScripts.some(s => s.requiresDevice);
  if (anyRequiresDevice && !currentDevice()) {
    showToast('此组合脚本需要操作云机，请先在左侧选择目标云机');
    return;
  }

  const bundleRunState = {
    bundleId: bundle.id,
    stopped: false,
    currentStepIndex: 0
  };
  state.activeBundleRun = bundleRunState;

  if (button) {
    button.classList.add('run-button-stop');
    button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">停止组合</span>`;
  }
  if (card) card.classList.add('running');

  const total = stepScripts.length;
  writeOutput(`【开始执行组合脚本】: ${bundle.name}`, [
    `功能备注：${bundle.description || '无'}`,
    `目标设备：${targetId ? deviceLabel(currentDevice()) : '无需设备'}`,
    `计划执行步骤（共 ${total} 步）：`,
    ...stepScripts.map((s, i) => `  ${i + 1}. ${s.title}`)
  ]);

  try {
    for (let i = 0; i < total; i++) {
      if (bundleRunState.stopped) {
        writeOutput(`【组合脚本人为中断】: ${bundle.name}`, ['用户已主动停止组合脚本，剩余步骤已取消。']);
        showToast('组合脚本已停止');
        break;
      }

      bundleRunState.currentStepIndex = i;
      const script = stepScripts[i];
      if (button) {
        button.innerHTML = `<span class="run-icon">⏹</span><span class="run-text">[${i + 1}/${total}] ${escapeHtml(script.title.slice(0, 8))}…</span>`;
      }

      writeOutput(`\n▶ [步骤 ${i + 1}/${total}] 启动执行: ${script.title}`, [
        `正在运行子脚本 ${script.id}...`
      ]);

      const stepRes = await executeSingleStep(script, targetId);

      if (bundleRunState.stopped || stepRes.cancelled) {
        writeOutput(`【组合脚本中断】: 步骤 ${i + 1} (${script.title}) 已停止。`, ['终止后续执行。']);
        showToast(`组合脚本已在步骤 ${i + 1} 停止`);
        break;
      }

      if (!stepRes.ok) {
        writeOutput(`【组合脚本失败中断】: 步骤 ${i + 1} (${script.title}) 执行未达成`, [
          `退出码: ${stepRes.exitCode ?? '未知'}`,
          '组合脚本后续步骤已自动熔断中止。请排查错误后重试。'
        ]);
        showToast(`步骤 ${i + 1} (${script.title}) 执行失败，组合已中断`);
        break;
      }

      writeOutput(`✓ [步骤 ${i + 1}/${total}] 成功达成: ${script.title}`, [
        `耗时: ${stepRes.durationSec || '--'}`
      ]);

      if (i === total - 1) {
        writeOutput(`\n【组合脚本全部执行成功】${bundle.name}`, [
          `共 ${total} 个步骤全部依次顺利执行达成！`
        ]);
        showToast(`组合脚本【${bundle.name}】全部执行完成`);
      } else {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (err) {
    writeOutput(`【组合脚本异常失败】: ${bundle.name}`, [err.message]);
    showToast('组合脚本异常: ' + err.message);
  } finally {
    state.activeBundleRun = null;
    if (button) {
      button.classList.remove('run-button-stop');
      button.innerHTML = `<span class="run-icon">▶</span><span class="run-text">执行组合</span>`;
    }
    if (card) card.classList.remove('running');
    loadSharedRuntimeState();
    requestAllPreviews();
  }
}

function stopRunningBundle() {
  if (state.activeBundleRun) {
    state.activeBundleRun.stopped = true;
    showToast('正在停止组合脚本…');
    stopRunningScript();
  }
}

let editingBundleSteps = [];

function openBundleModal(bundle = null) {
  const modal = byId('scriptBundleModal');
  const title = byId('bundleModalTitle');
  const editIdInput = byId('bundleEditId');
  const nameInput = byId('bundleNameInput');
  const descInput = byId('bundleDescInput');
  const enabledInput = byId('bundleEnabledInput');
  const scriptsSelect = byId('bundleAvailableScriptsSelect');

  if (!modal) return;

  if (scriptsSelect) {
    scriptsSelect.innerHTML = '';
    const nonBatchScripts = state.scripts.filter(s => !s.batch && !s.id.startsWith('flow-all'));
    for (const s of nonBatchScripts) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const ver = (s.category || s.version || '').toUpperCase();
      opt.textContent = `${ver ? `[${ver}] ` : ''}${s.title}`;
      scriptsSelect.append(opt);
    }
  }

  if (bundle) {
    if (title) title.textContent = '编辑自定义脚本组合';
    if (editIdInput) editIdInput.value = bundle.id;
    if (nameInput) nameInput.value = bundle.name || '';
    if (descInput) descInput.value = bundle.description || '';
    if (enabledInput) enabledInput.checked = bundle.enabled !== false;
    editingBundleSteps = Array.isArray(bundle.stepIds) ? [...bundle.stepIds] : [];
  } else {
    if (title) title.textContent = '新建自定义脚本组合';
    if (editIdInput) editIdInput.value = '';
    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';
    if (enabledInput) enabledInput.checked = true;
    editingBundleSteps = [];
  }

  renderModalSelectedSteps();
  try {
    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');
  } catch {}
}

function closeBundleModal() {
  const modal = byId('scriptBundleModal');
  if (!modal) return;
  try {
    modal.close();
  } catch {
    modal.removeAttribute('open');
  }
}

function renderModalSelectedSteps() {
  const container = byId('bundleSelectedSteps');
  if (!container) return;
  container.innerHTML = '';

  if (editingBundleSteps.length === 0) {
    const tip = document.createElement('div');
    tip.className = 'ui-hint';
    tip.style.textAlign = 'center';
    tip.textContent = '暂未添加步骤，请在下方选择脚本并点击【+ 添加步骤】';
    container.append(tip);
    return;
  }

  editingBundleSteps.forEach((stepId, index) => {
    const script = state.scripts.find(s => s.id === stepId);
    const row = document.createElement('div');
    row.className = 'bundle-step-row';

    const info = document.createElement('div');
    info.className = 'ui-row';
    info.innerHTML = `
      <span class="ui-mono" style="color:var(--accent); min-width:20px;">${index + 1}.</span>
      <span style="font-weight:var(--fw-500);">${escapeHtml(script ? script.title : stepId)}</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'bundle-step-actions';

    const upBtn = document.createElement('button');
    upBtn.className = 'btn-icon';
    upBtn.type = 'button';
    upBtn.innerHTML = '▲';
    upBtn.title = '上移一步';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      if (index > 0) {
        const tmp = editingBundleSteps[index];
        editingBundleSteps[index] = editingBundleSteps[index - 1];
        editingBundleSteps[index - 1] = tmp;
        renderModalSelectedSteps();
      }
    });

    const downBtn = document.createElement('button');
    downBtn.className = 'btn-icon';
    downBtn.type = 'button';
    downBtn.innerHTML = '▼';
    downBtn.title = '下移一步';
    downBtn.disabled = index === editingBundleSteps.length - 1;
    downBtn.addEventListener('click', () => {
      if (index < editingBundleSteps.length - 1) {
        const tmp = editingBundleSteps[index];
        editingBundleSteps[index] = editingBundleSteps[index + 1];
        editingBundleSteps[index + 1] = tmp;
        renderModalSelectedSteps();
      }
    });

    const rmBtn = document.createElement('button');
    rmBtn.className = 'btn-icon danger';
    rmBtn.type = 'button';
    rmBtn.innerHTML = '✗';
    rmBtn.title = '移除此步骤';
    rmBtn.addEventListener('click', () => {
      editingBundleSteps.splice(index, 1);
      renderModalSelectedSteps();
    });

    actions.append(upBtn, downBtn, rmBtn);
    row.append(info, actions);
    container.append(row);
  });
}

async function saveBundleDirect(bundle) {
  try {
    const res = await requestJson('/api/admin/scripts/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle)
    });
    if (res.ok) {
      showToast(`已${bundle.enabled ? '开启' : '关闭'}组合脚本【${bundle.name}】的用户侧显示`);
      await loadScripts();
    }
  } catch (err) {
    showToast('更新组合脚本状态失败: ' + err.message);
  }
}

async function deleteBundle(bundleId) {
  try {
    const res = await requestJson('/api/admin/scripts/bundles', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: bundleId })
    });
    if (res.ok) {
      showToast('组合脚本已成功删除');
      await loadScripts();
    }
  } catch (err) {
    showToast('删除组合脚本失败: ' + err.message);
  }
}

async function handleSaveBundleModal() {
  const editId = byId('bundleEditId')?.value || '';
  const name = byId('bundleNameInput')?.value?.trim();
  const description = byId('bundleDescInput')?.value?.trim() || '';
  const enabled = byId('bundleEnabledInput')?.checked !== false;

  if (!name) {
    showToast('请输入组合脚本名称');
    byId('bundleNameInput')?.focus();
    return;
  }

  if (editingBundleSteps.length === 0) {
    showToast('请至少添加一个执行步骤');
    return;
  }

  try {
    const payload = {
      id: editId || undefined,
      name,
      description,
      enabled,
      stepIds: editingBundleSteps
    };
    const res = await requestJson('/api/admin/scripts/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast('组合脚本保存成功');
      closeBundleModal();
      await loadScripts();
    }
  } catch (err) {
    showToast('保存组合脚本失败: ' + err.message);
  }
}

function initBundleModalEvents() {
  byId('closeBundleModalBtn')?.addEventListener('click', closeBundleModal);
  byId('cancelBundleBtn')?.addEventListener('click', closeBundleModal);
  byId('saveBundleBtn')?.addEventListener('click', handleSaveBundleModal);
  byId('addStepToBundleBtn')?.addEventListener('click', () => {
    const select = byId('bundleAvailableScriptsSelect');
    if (select && select.value) {
      editingBundleSteps.push(select.value);
      renderModalSelectedSteps();
    }
  });
}

