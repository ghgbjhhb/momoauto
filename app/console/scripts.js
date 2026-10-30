'use strict';

// V3 任务模块：初始化流水线、脚本分组、自定义组合、批量执行引擎。
// 批量执行 = 前端按设备逐台串行调度（同一时刻只占用一台设备），服务端执行协议不变。

const STEPS_META = [
  { order: 1, name: '导入云盘', full: '01 导入云盘所有文件' },
  { order: 2, name: '上传证书', full: '02 上传证书' },
  { order: 2.1, name: '导入真参', full: '02.1 导入真参' },
  { order: 3, name: 'VPC 代理', full: '03 设置 VPC 代理' },
  { order: 4, name: '环境配置', full: '04 环境配置' },
  { order: 5, name: '一键生成', full: '05 一键生成全部' },
  { order: 6, name: 'IP 定位', full: '06 定位到ip地' },
  { order: 7, name: '高德地图', full: '07 高德初始化' },
  { order: 8, name: '输入法', full: '08 输入法初始化' }
];
window.STEPS_META = STEPS_META;

const STATUS_LABELS = {
  idle: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已停止，需核对'
};
window.STATUS_LABELS = STATUS_LABELS;

const GROUPS = [
  { key: 'v2', title: 'V2 流程架构 (01~09)' },
  { key: 'v3', title: 'V3 极速架构 (01~09)' },
  { key: 'momo', title: 'MOMO 业务自动化 (11~18)' },
  { key: 'custom', title: '自定义组合脚本' }
];

const RUN_STATE_TEXT = { ok: '已完成', failed: '执行失败', cancelled: '已停止', skipped: '已跳过', pending: '排队中', running: '执行中' };

function formatStepOrder(order) {
  if (typeof order !== 'number') return String(order || '');
  if (Number.isInteger(order)) return String(order).padStart(2, '0');
  return '0' + order;
}

function saveDeviceProgress() {
  try { localStorage.setItem('yunmomo.deviceProgress', JSON.stringify(state.deviceProgress)); } catch {}
}

function getStepState(deviceId, order) {
  if (!deviceId || !state.deviceProgress[deviceId]) return 'idle';
  return state.deviceProgress[deviceId][order] || 'idle';
}
window.getStepState = getStepState;

function setStepState(deviceId, order, status) {
  if (!deviceId) return;
  if (!state.deviceProgress[deviceId]) state.deviceProgress[deviceId] = {};
  state.deviceProgress[deviceId][order] = status;
  saveDeviceProgress();
  if (state.page === 'tasks') renderPipeline();
}

function resetDeviceProgress(deviceId) {
  if (!deviceId) return;
  delete state.deviceProgress[deviceId];
  saveDeviceProgress();
  renderPipeline();
  showToast('已重置该云手机的流程执行记录');
}

function scriptTitle(script) {
  return script.order ? script.title.replace(/^(0[1-9](?:\.\d+)?|\d+)\s*[-_、\s]\s*/, '') : script.title;
}

function isScriptManageMode() {
  return Boolean(state.isAdmin);
}
window.isScriptManageMode = isScriptManageMode;

function scriptVisible(script) {
  return state.visibility?.scripts?.[script.id] !== false;
}

function groupVisible(key) {
  return state.visibility?.groups?.[key] !== false;
}

/* ---------- 页面骨架 ---------- */

function currentTaskScript() {
  const visible = state.scripts.filter(s => scriptVisible(s) && !s.batch);
  return visible.find(s => s.id === state.taskScriptId) || null;
}

function renderTasksPage() {
  const left = elements.taskLeftCol;
  const right = elements.taskRightCol;
  if (!left || !right) return;

  const headActions = elements.taskHeadActions;
  if (headActions) {
    headActions.innerHTML = isScriptManageMode()
      ? '<button class="btn" id="openCreateBundleBtn" type="button">新建组合脚本</button>'
      : '';
    byId('openCreateBundleBtn')?.addEventListener('click', () => openBundleModal());
  }

  left.innerHTML = `
    <section class="panel">
      <div class="panel-head"><h2>初始化流程</h2><span class="badge" id="pipelineTargetBadge">未选择目标</span></div>
      <div class="pipeline-row" id="pipelineRow"></div>
      <div class="details-footer" style="border-top:1px solid var(--line); margin-top:0;">
        <span class="footer-note">节点按当前目标云机的版本自动适配 V2 / V3</span>
        <button class="btn" id="resetStepperBtn" type="button">重置记录</button>
        <button class="btn primary" id="stepperRunAllBtn" type="button">${ic('play', 15)} 执行全流程</button>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>任务列表</h2><span class="hint" id="taskCountHint"></span></div>
      <div id="taskGroups"></div>
    </section>
  `;

  right.innerHTML = `
    <section class="panel" id="taskDetailPanel"><div class="empty">选择左侧任务查看配置</div></section>
    <div id="aiRunCardHost"></div>
    <div id="brainCardHost"></div>
  `;

  byId('resetStepperBtn')?.addEventListener('click', () => {
    if (!state.selectedDeviceId) { showToast('未选择云手机'); return; }
    resetDeviceProgress(state.selectedDeviceId);
  });
  byId('stepperRunAllBtn')?.addEventListener('click', runFlowAll);
  byId('taskGroups')?.addEventListener('click', onTaskGroupsClick);
  byId('taskDetailPanel')?.addEventListener('input', onDetailInput);
  byId('taskDetailPanel')?.addEventListener('change', onDetailInput);
  byId('taskDetailPanel')?.addEventListener('click', onDetailClick);

  renderPipeline();
  renderTaskGroups();
  renderTaskDetail();
  byId('pipelineRow')?.addEventListener('click', onPipelineClick);
  eventBus.dispatchEvent(new CustomEvent('tasks:rendered'));
}

function onPipelineClick(event) {
  const step = event.target.closest('[data-step-order]');
  if (!step) return;
  const target = currentDevice();
  if (!target) { showToast('请先在「设备」页选择目标云机'); return; }
  const order = Number(step.dataset.stepOrder);
  const isV2 = String(target.sdkVersion || '').toLowerCase() === 'v2';
  const script = state.scripts.find(s => s.order === order && (s.category === (isV2 ? 'v2' : 'v3') || s.id.endsWith('-' + (isV2 ? 'v2' : 'v3'))))
    || state.scripts.find(s => s.order === order);
  if (!script) { showToast(`未找到步骤 ${order} 对应的执行脚本`); return; }
  runScriptDirect(script, target.deviceId);
}

function onTaskGroupsClick(event) {
  const collapse = event.target.closest('[data-collapse-group]');
  if (collapse) {
    const key = collapse.dataset.collapseGroup;
    const next = !collapse.closest('.task-group').classList.contains('collapsed');
    collapse.closest('.task-group').classList.toggle('collapsed', next);
    try { localStorage.setItem('yunmomo.collapse.' + key, String(next)); } catch {}
    return;
  }
  const visBundle = event.target.closest('[data-vis-bundle]');
  if (visBundle) {
    const bundle = state.bundles.find(item => item.id === visBundle.dataset.visBundle);
    if (bundle) { bundle.enabled = !(bundle.enabled !== false); saveBundleDirect(bundle); }
    return;
  }
  const visScript = event.target.closest('[data-vis-script]');
  if (visScript) {
    saveVisibilityConfig({ type: 'script', id: visScript.dataset.visScript, visible: !visScript.classList.contains('on') });
    return;
  }
  const visGroup = event.target.closest('[data-vis-group]');
  if (visGroup) {
    saveVisibilityConfig({ type: 'group', id: visGroup.dataset.visGroup, visible: !visGroup.classList.contains('on') });
    return;
  }
  const bundleEdit = event.target.closest('[data-bundle-edit]');
  if (bundleEdit) {
    const bundle = state.bundles.find(item => item.id === bundleEdit.dataset.bundleEdit);
    if (bundle) openBundleModal(bundle);
    return;
  }
  const bundleDelete = event.target.closest('[data-bundle-delete]');
  if (bundleDelete) {
    const bundle = state.bundles.find(item => item.id === bundleDelete.dataset.bundleDelete);
    if (!bundle) return;
    showInPageConfirm({
      title: '确认删除脚本组合？',
      message: `<p class="confirm-lead">确定要彻底删除组合脚本 <strong>${escapeHtml(bundle.name)}</strong> 吗？此操作无法撤销。</p>`,
      okText: '确认删除'
    }).then(confirmed => { if (confirmed) deleteBundle(bundle.id); });
    return;
  }
  const bundleRun = event.target.closest('[data-bundle-run]');
  if (bundleRun) {
    const bundle = state.bundles.find(item => item.id === bundleRun.dataset.bundleRun);
    if (bundle) executeBundle(bundle);
    return;
  }
  const card = event.target.closest('[data-task-select]');
  if (card) {
    state.taskScriptId = card.dataset.taskSelect;
    renderTaskGroups();
    renderTaskDetail();
  }
}

function onDetailInput(event) {
  const batch = event.target.closest('[data-batch-device]');
  if (batch) {
    const id = batch.dataset.batchDevice;
    if (batch.checked && !state.batchDevices.includes(id)) state.batchDevices.push(id);
    else if (!batch.checked) state.batchDevices = state.batchDevices.filter(item => item !== id);
    batch.closest('.device-choice')?.classList.toggle('checked', batch.checked);
    updateBatchCount();
    return;
  }
  const input = event.target.closest('[data-task-param]');
  if (input && state.taskScriptId) {
    state.taskParamValues[state.taskScriptId + ':' + input.dataset.taskParam] = input.value;
  }
}

/* ---------- 流水线 ---------- */

function renderPipeline() {
  const row = byId('pipelineRow');
  if (!row) return;
  const target = currentDevice();
  const badge = byId('pipelineTargetBadge');
  if (badge) {
    if (target) {
      const ver = String(target.sdkVersion || '').toUpperCase();
      badge.textContent = `${deviceIndexLabel(target)} ${target.name}` + (ver ? ` · ${ver}` : '');
      badge.title = `目标云机: ${deviceLabel(target)}`;
    } else {
      badge.textContent = '未选择目标';
    }
  }
  const isV2 = String(target?.sdkVersion || '').toLowerCase() === 'v2';
  const visibleSteps = STEPS_META.filter(step => isV2 ? step.order !== 8 : step.order !== 2.1);
  row.innerHTML = visibleSteps.map(step => {
    const status = target ? getStepState(target.deviceId, step.order) : 'idle';
    const mark = status === 'completed' ? '✓' : status === 'failed' ? '✗' : '';
    return `<button class="step-node ${status}" data-step-order="${step.order}" type="button" title="${escapeHtml(step.full)}（${STATUS_LABELS[status] || status}，点击单独执行）">
      <span class="num">${formatStepOrder(step.order)}</span>${escapeHtml(step.name)}${mark ? `<b>${mark}</b>` : ''}
    </button>`;
  }).join('');

  const runAll = byId('stepperRunAllBtn');
  if (runAll) {
    runAll.textContent = isV2 ? '执行全流程 (V2)' : '执行全流程 (V3)';
    runAll.prepend(ic('play', 15));
  }
}

async function runFlowAll() {
  if (!currentDevice()) { showToast('请先在「设备」页选择目标云机'); return; }
  const target = currentDevice();
  const isV2 = String(target?.sdkVersion || '').toLowerCase() === 'v2';
  const flowAll = state.scripts.find(s => s.id === (isV2 ? 'flow-all-v2' : 'flow-all'))
    || state.scripts.find(s => s.batch === true);
  if (!flowAll) { showToast('未找到全流程自动化脚本'); return; }
  await runScriptDirect(flowAll, target.deviceId);
}

/* ---------- 任务分组列表 ---------- */

function groupScripts(key) {
  if (key === 'v2') {
    return state.scripts.filter(s => (s.category === 'v2' || s.version === 'v2' || s.id.endsWith('-v2')) && !s.batch)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }
  if (key === 'v3') {
    return state.scripts.filter(s => (s.category === 'v3' || s.version === 'v3' || s.id.endsWith('-v3')) && !s.batch)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }
  if (key === 'momo') {
    return state.scripts.filter(s => s.category === 'momo' && !s.batch)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }
  return [];
}

function taskCardHtml(script) {
  const manage = isScriptManageMode();
  const visible = scriptVisible(script);
  if (!manage && !visible) return '';
  const active = state.taskScriptId === script.id ? 'active' : '';
  const hiddenBadge = manage && !visible ? '<span class="badge warn">用户侧隐藏</span>' : '';
  const danger = script.destructive ? '<span class="danger-tag">清数据</span>' : '';
  const hero = script.batch ? '<span class="hero-tag">全流程</span>' : '';
  const visSwitch = manage ? `<button class="switch ${visible ? 'on' : ''}" data-vis-script="${escapeHtml(script.id)}" type="button" title="控制此脚本在用户侧是否显示" role="switch"></button>` : '';
  return `<div class="task-card ${active}" data-task-select="${escapeHtml(script.id)}" role="button" tabindex="0">
    ${script.order ? `<span class="num">${formatStepOrder(script.order)}</span>` : '<span class="num">组</span>'}
    <span class="task-card-main">
      <span class="task-name">${escapeHtml(scriptTitle(script))}${danger}${hero}${hiddenBadge}</span>
      <span class="task-sub">${escapeHtml(script.file || '')}</span>
    </span>
    ${visSwitch}${ic('chevron', 15)}
  </div>`;
}

function bundleCardHtml(bundle) {
  const manage = isScriptManageMode();
  const enabled = bundle.enabled !== false;
  if (!manage && !enabled) return '';
  const stepScripts = (bundle.stepIds || []).map(id => state.scripts.find(s => s.id === id)).filter(Boolean);
  const stepsFlow = stepScripts.length
    ? `<span class="bundle-steps-flow">${stepScripts.map((s, i) =>
        `${i ? '<span class="bundle-step-arrow">→</span>' : ''}<span class="bundle-step-item">${i + 1}. ${escapeHtml(scriptTitle(s))}</span>`).join('')}</span>`
    : '';
  const manageActions = manage ? `
    <span class="task-group-extra">
      <button class="switch ${enabled ? 'on' : ''}" data-vis-bundle="${escapeHtml(bundle.id)}" type="button" title="控制此组合在用户侧是否显示" role="switch"></button>
      <button class="btn sm" data-bundle-edit="${escapeHtml(bundle.id)}" type="button">编辑</button>
      <button class="btn sm flat" data-bundle-delete="${escapeHtml(bundle.id)}" type="button">删除</button>
    </span>` : '';
  return `<div class="task-card" data-bundle-card="${escapeHtml(bundle.id)}" style="cursor:default;">
    <span class="num">组</span>
    <span class="task-card-main">
      <span class="task-name">${escapeHtml(bundle.name)}${manage && !enabled ? '<span class="badge warn">用户侧隐藏</span>' : ''}</span>
      ${bundle.description ? `<span class="task-sub">${escapeHtml(bundle.description)}</span>` : ''}
      ${stepsFlow}
    </span>
    ${manageActions}
    <button class="btn sm primary" data-bundle-run="${escapeHtml(bundle.id)}" type="button">${ic('play', 13)} 执行组合</button>
  </div>`;
}

function renderTaskGroups() {
  const host = byId('taskGroups');
  if (!host) return;
  const manage = isScriptManageMode();
  let html = '';
  let visibleCount = 0;

  for (const group of GROUPS) {
    if (group.key === 'custom') {
      const bundles = Array.isArray(state.bundles) ? state.bundles : [];
      const displayBundles = manage ? bundles : bundles.filter(b => b.enabled !== false);
      if (!manage && (!groupVisible('custom') || !displayBundles.length)) continue;
      const collapsed = localStorage.getItem('yunmomo.collapse.custom') === 'true';
      const visSwitch = manage ? `<button class="switch ${groupVisible('custom') ? 'on' : ''}" data-vis-group="custom" type="button" role="switch" title="控制是否在用户侧显示"></button>` : '';
      html += `<div class="task-group ${collapsed ? 'collapsed' : ''}">
        <div class="task-group-head"><span class="task-group-title">${group.title}${!groupVisible('custom') && manage ? '<span class="badge warn">用户侧隐藏</span>' : ''}</span><span class="task-group-extra">${visSwitch}<button class="collapse-btn" data-collapse-group="custom" type="button" aria-label="收起/展开">${ic('chevron', 14)}</button></span></div>
        <div class="task-group-body">${displayBundles.length ? displayBundles.map(bundleCardHtml).join('') : '<div class="empty">暂无自定义组合脚本</div>'}</div>
      </div>`;
      visibleCount += displayBundles.length;
      continue;
    }

    const scripts = groupScripts(group.key);
    const visibleScripts = manage ? scripts : scripts.filter(scriptVisible);
    if (!manage && (!groupVisible(group.key) || !visibleScripts.length)) continue;
    const collapsed = localStorage.getItem('yunmomo.collapse.' + group.key) === 'true';
    const visSwitch = manage ? `<button class="switch ${groupVisible(group.key) ? 'on' : ''}" data-vis-group="${group.key}" type="button" role="switch" title="控制是否在用户侧显示"></button>` : '';
    html += `<div class="task-group ${collapsed ? 'collapsed' : ''}">
      <div class="task-group-head"><span class="task-group-title">${group.title}${!groupVisible(group.key) && manage ? '<span class="badge warn">用户侧隐藏</span>' : ''}</span><span class="task-group-extra">${visSwitch}<button class="collapse-btn" data-collapse-group="${group.key}" type="button" aria-label="收起/展开">${ic('chevron', 14)}</button></span></div>
      <div class="task-group-body">${visibleScripts.map(taskCardHtml).join('')}</div>
    </div>`;
    visibleCount += visibleScripts.length;
  }

  host.innerHTML = html || '<div class="empty">暂无可用任务</div>';
  const hint = byId('taskCountHint');
  if (hint) hint.textContent = `${visibleCount} 项`;
}

async function saveVisibilityConfig({ type, id, visible }) {
  const payload = type === 'group' ? { groups: { [id]: visible } } : { scripts: { [id]: visible } };
  try {
    const res = await requestJson('/api/admin/scripts/visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok && res.visibility) state.visibility = res.visibility;
    showToast(`已${visible ? '开启' : '关闭'}在用户侧的显示`);
    renderTaskGroups();
  } catch (err) {
    showToast('更新显隐设置失败: ' + err.message);
  }
}

/* ---------- 任务配置详情 ---------- */

function parameterChoiceLabel(field, value) {
  if (field.name === 'action') return ({ set: '设置代理', show: '展示当前', close: '关闭代理' })[value] || String(value);
  if (field.name === 'mode') return ({ random: '随机', button: '底部按钮', pull: '下拉刷新', execute: '执行发送', draft: '生成并输入', watch: '挂机模式 (巡查前几页)', drain: '全量模式 (必须翻到底)' })[value] || String(value);
  if (field.name === 'maxContacts') return ({ xx: '持续运行(无上限)', '1': '1人(单次测试)', '3': '3人', '5': '5人', '10': '10人' })[value] || String(value);
  if (field.name === 'warmupInterval') return ({ default: '默认(25~70分随机)', '0': '立即养号(测试)', '60000': '1分钟后养号', '300000': '5分钟后养号' })[value] || String(value);
  if (field.name === 'greetingsInterval') return ({ '0': '发现招呼立即处理(测试)', '1200000': '20分钟一次', '1800000': '30分钟一次' })[value] || String(value);
  if (field.name === 'maxApproved') return value + ' 人';
  if (field.name === 'maxDistance') return ({ none: '不限距离', '3': '≤ 3公里', '5': '≤ 5公里', '10': '≤ 10公里', '20': '≤ 20公里', '50': '≤ 50公里' })[value] || String(value);
  if (field.name === 'approveProbability') return Math.round(Number(value) * 100) + '%';
  if (field.name === 'androidVersion') return value === 'all' ? '全部版本' : 'Android ' + value;
  return String(value);
}

function renderTaskDetail() {
  const panel = byId('taskDetailPanel');
  if (!panel) return;
  const script = currentTaskScript();
  if (!script) {
    panel.innerHTML = '<div class="empty">暂无可执行任务</div>';
    return;
  }
  if (!state.taskScriptId) state.taskScriptId = script.id;

  const isSingleInline = script.parameters?.length === 1 && !script.parameters[0].multiline;
  const fieldsHtml = (script.parameters || []).map(field => {
    const key = script.id + ':' + field.name;
    const value = state.taskParamValues[key] ?? field.defaultValue ?? '';
    if (isSingleInline) return '';
    if (field.choices) {
      return `<div class="field"><label for="param-${field.name}">${escapeHtml(field.label)}</label>
        <select class="select" id="param-${field.name}" data-task-param="${escapeHtml(field.name)}">
          ${field.choices.map(choice => `<option value="${escapeHtml(choice)}" ${String(value) === String(choice) ? 'selected' : ''}>${escapeHtml(parameterChoiceLabel(field, choice))}</option>`).join('')}
        </select></div>`;
    }
    if (field.multiline) {
      return `<div class="field"><label for="param-${field.name}">${escapeHtml(field.label)}</label>
        <textarea class="input textarea" id="param-${field.name}" data-task-param="${escapeHtml(field.name)}" ${field.required ? 'required' : ''} ${field.maxLength ? `maxlength="${field.maxLength}"` : ''} placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(value)}</textarea></div>`;
    }
    return `<div class="field"><label for="param-${field.name}">${escapeHtml(field.label)}</label>
      <input class="input" id="param-${field.name}" data-task-param="${escapeHtml(field.name)}" type="text" ${field.required ? 'required' : ''} ${field.maxLength ? `maxlength="${field.maxLength}"` : ''} placeholder="${escapeHtml(field.placeholder || '')}" value="${escapeHtml(value)}" autocomplete="off" spellcheck="false"></div>`;
  }).join('');

  const inlineParam = isSingleInline ? (() => {
    const field = script.parameters[0];
    const key = script.id + ':' + field.name;
    const value = state.taskParamValues[key] ?? field.defaultValue ?? '';
    if (field.choices) {
      return `<div class="field"><label>${escapeHtml(field.label)}</label><select class="select full" data-task-param="${escapeHtml(field.name)}">
        ${field.choices.map(choice => `<option value="${escapeHtml(choice)}" ${String(value) === String(choice) ? 'selected' : ''}>${escapeHtml(parameterChoiceLabel(field, choice))}</option>`).join('')}</select></div>`;
    }
    return `<div class="field"><label>${escapeHtml(field.label)}</label><input class="input" data-task-param="${escapeHtml(field.name)}" type="text" ${field.required ? 'required' : ''} placeholder="${escapeHtml(field.placeholder || '')}" value="${escapeHtml(value)}" autocomplete="off" spellcheck="false"></div>`;
  })() : '';

  panel.innerHTML = `
    <div class="section-line">
      <h3>任务配置</h3>
      <span class="badge ${state.batchRunning ? 'run' : ''}" id="detailRunBadge">${state.batchRunning ? '执行中' : '待命'}</span>
    </div>
    <div class="details">
      <div class="details-heading">
        <h2>${escapeHtml(scriptTitle(script))}</h2>
        ${script.destructive ? '<span class="danger-tag">清数据</span>' : ''}
      </div>
      ${inlineParam}
      ${fieldsHtml}
      ${renderDevicePicker()}
      ${renderBatchResults()}
      <div class="details-footer">
        <span class="footer-note" id="detailNote"></span>
        ${state.batchRunning
          ? `<button class="btn danger" id="batchStopBtn" type="button">${ic('stop', 15)} 停止执行</button>`
          : `<button class="btn primary" id="batchRunBtn" type="button">${ic('play', 15)} 执行 (<span id="batchCount">0</span> 台)</button>`}
      </div>
    </div>
  `;
  updateBatchCount();
  updateTaskRuntime();
}

function renderDevicePicker() {
  if (!state.devices.length) return '<div class="selection-summary">暂无设备，请先在「设备」页确认</div>';
  // 平台在线状态可能滞后（离线设备仍可能可操作），与旧版一致不按在线状态禁选
  if (!state.batchDevices.length && state.selectedDeviceId) state.batchDevices = [state.selectedDeviceId];
  const picker = state.devices.map(device => {
    const active = deviceRunning(device.deviceId);
    const checked = state.batchDevices.includes(device.deviceId);
    const note = active ? '正在执行' : isOnline(device) ? '可执行' : '离线';
    return `<label class="device-choice ${checked ? 'checked' : ''}">
      <input type="checkbox" data-batch-device="${escapeHtml(device.deviceId)}" ${checked ? 'checked' : ''}>
      <span class="choice-text"><b>${deviceIndexLabel(device)} ${escapeHtml(device.name)}</b><small>${note}</small></span>
    </label>`;
  }).join('');
  return `
    <div class="device-select-head">
      <label>执行设备</label>
      <span class="quick">
        <button class="small-link" data-picker-action="all" type="button">全选</button>
        <button class="small-link" data-picker-action="current" type="button">仅当前目标</button>
        <button class="small-link" data-picker-action="none" type="button">清空</button>
      </span>
    </div>
    <div class="device-picker">${picker}</div>
    <div class="selection-summary" id="pickerSummary"></div>`;
}

function renderBatchResults() {
  if (!state.batchResults?.length) return '';
  const rows = state.batchResults.map(result => {
    const device = state.devices.find(d => d.deviceId === result.deviceId);
    const cls = result.status === 'ok' ? 'ok' : result.status === 'running' ? 'run'
      : result.status === 'failed' || result.status === 'cancelled' ? 'err' : '';
    const note = result.message ? `<span class="hint">${escapeHtml(result.message)}</span>` : '';
    return `<div class="run-result-row">
      <span class="result-name">${device ? `${deviceIndexLabel(device)} ${escapeHtml(device.name)}` : escapeHtml(result.deviceId)}</span>
      <span class="result-status">${result.durationMs ? `<span class="hint">${(result.durationMs / 1000).toFixed(1)}s</span>` : ''}${note}<span class="badge ${cls}">${RUN_STATE_TEXT[result.status] || result.status}</span></span>
    </div>`;
  }).join('');
  return `<div class="run-results"><div class="run-results-title">设备执行结果</div>${rows}</div>`;
}

function updateBatchCount() {
  const count = byId('batchCount');
  if (!count) return;
  const script = currentTaskScript();
  const usable = state.batchDevices.filter(id => state.devices.some(d => d.deviceId === id));
  count.textContent = String(usable.length);
  const note = byId('detailNote');
  if (note) note.textContent = script?.requiresDevice
    ? '按选择顺序逐台执行，同一时刻只占用一台设备'
    : '该任务不依赖设备';
}

function resolveBatchDevices(script) {
  let ids = state.batchDevices.filter(id => state.devices.some(d => d.deviceId === id));
  if (script.requiresDevice && !ids.length && state.selectedDeviceId) ids = [state.selectedDeviceId];
  return ids;
}

function collectTaskOptions(script) {
  const panel = byId('taskDetailPanel');
  const options = {};
  if (panel) {
    for (const input of panel.querySelectorAll('[data-task-param]')) {
      const value = String(input.value ?? '').trim();
      if (input.required && !value) {
        input.focus?.();
        throw new Error((input.closest('.field')?.querySelector('label')?.textContent || '该参数') + '为必填项');
      }
      if (value) options[input.dataset.taskParam] = value;
    }
  }
  return options;
}

async function onDetailClick(event) {
  const picker = event.target.closest('[data-picker-action]');
  if (picker) {
    const action = picker.dataset.pickerAction;
    if (action === 'all') state.batchDevices = state.devices.map(d => d.deviceId);
    else if (action === 'current') state.batchDevices = state.selectedDeviceId ? [state.selectedDeviceId] : [];
    else state.batchDevices = [];
    renderTaskDetail();
    return;
  }

  const step = event.target.closest('[data-step-order]');
  if (step) {
    const target = currentDevice();
    if (!target) { showToast('请先在「设备」页选择目标云机'); return; }
    const order = Number(step.dataset.stepOrder);
    const isV2 = String(target.sdkVersion || '').toLowerCase() === 'v2';
    const script = state.scripts.find(s => s.order === order && (s.category === (isV2 ? 'v2' : 'v3') || s.id.endsWith('-' + (isV2 ? 'v2' : 'v3'))))
      || state.scripts.find(s => s.order === order);
    if (!script) { showToast(`未找到步骤 ${order} 对应的执行脚本`); return; }
    await runScriptDirect(script, target.deviceId);
    return;
  }

  if (event.target.closest('#batchRunBtn')) {
    await startTaskBatch();
    return;
  }
  if (event.target.closest('#batchStopBtn')) {
    stopTaskBatch();
    return;
  }

  const visScript = event.target.closest('[data-vis-script]');
  if (visScript) {
    const id = visScript.dataset.visScript;
    await saveVisibilityConfig({ type: 'script', id, visible: !scriptVisible({ id }) });
    return;
  }
  const visGroup = event.target.closest('[data-vis-group]');
  if (visGroup) {
    const key = visGroup.dataset.visGroup;
    await saveVisibilityConfig({ type: 'group', id: key, visible: !groupVisible(key) });
    return;
  }
  const bundleRun = event.target.closest('[data-bundle-run]');
  if (bundleRun) {
    const bundle = state.bundles.find(b => b.id === bundleRun.dataset.bundleRun);
    if (bundle) await executeBundle(bundle);
    return;
  }
  const bundleEdit = event.target.closest('[data-bundle-edit]');
  if (bundleEdit) {
    const bundle = state.bundles.find(b => b.id === bundleEdit.dataset.bundleEdit);
    if (bundle) openBundleModal(bundle);
    return;
  }
  const bundleDelete = event.target.closest('[data-bundle-delete]');
  if (bundleDelete) {
    const bundle = state.bundles.find(b => b.id === bundleDelete.dataset.bundleDelete);
    if (!bundle) return;
    const confirmed = await showInPageConfirm({
      title: '确认删除脚本组合？',
      message: `<p class="confirm-lead">确定要彻底删除组合脚本 <strong>${escapeHtml(bundle.name)}</strong> 吗？此操作无法撤销。</p>`,
      okText: '确认删除'
    });
    if (confirmed) await deleteBundle(bundle.id);
  }
}

/* ---------- 批量执行引擎 ---------- */

async function startTaskBatch() {
  const script = currentTaskScript();
  if (!script) return;
  if (state.batchRunning) { showToast('任务正在执行中'); return; }
  if (state.activeRun || state.activeBundleRun) { showToast('请等待当前脚本结束'); return; }
  if (state.manualDeviceId) { showToast('请先关闭手动操作窗，再运行脚本'); return; }
  if (!state.tokenConfigured) { showToast('尚未连接云机平台'); return; }

  let options;
  try {
    options = collectTaskOptions(script);
  } catch (err) {
    showToast(err.message);
    return;
  }

  const ids = resolveBatchDevices(script);
  if (!ids.length) { showToast('请先勾选至少一台可执行设备'); return; }

  if ((script.id === 'flow-03' || String(script.order) === '3' || script.id.startsWith('flow-03')) && options.action !== 'show' && options.action !== 'close') {
    const vpcData = await promptVpcProxyDialog();
    if (!vpcData) return;
    options.vpcData = vpcData;
  }

  if (script.destructive && !(await confirmDestructive(script, options, ids))) return;
  if (script.destructive) options.resetConfirmed = true;

  state.batchRunning = true;
  state.batchStopRequested = false;
  state.batchResults = ids.map(id => ({ deviceId: id, status: 'pending' }));
  renderTaskDetail();
  eventBus.dispatchEvent(new CustomEvent('task:running', { detail: { scriptId: script.id } }));

  for (let i = 0; i < ids.length; i++) {
    if (state.batchStopRequested) {
      state.batchResults[i].status = 'skipped';
      continue;
    }
    const deviceId = ids[i];
    state.batchResults[i].status = 'running';
    renderBatchResultsOnly();
    const result = await runScriptOnDevice(script, deviceId, options);
    const record = state.batchResults[i];
    if (record) {
      record.status = result.skipped ? 'skipped' : result.cancelled ? 'cancelled' : result.ok ? 'ok' : 'failed';
      record.durationMs = result.durationMs;
      record.message = result.message || '';
    }
    renderBatchResultsOnly();
    if (result.cancelled) state.batchStopRequested = true;
    if (typeof loadDevices === 'function') loadDevices(true);
  }

  state.batchRunning = false;
  renderTaskDetail();
  loadSharedRuntimeState();
  const ok = state.batchResults.filter(r => r.status === 'ok').length;
  showToast(`批量任务结束：${ok}/${state.batchResults.length} 台成功`);
}

function stopTaskBatch() {
  if (!state.batchRunning) return;
  state.batchStopRequested = true;
  showToast('正在停止当前设备上的脚本…');
  stopRunningScript();
}

function renderBatchResultsOnly() {
  const panel = byId('taskDetailPanel');
  if (!panel) return;
  const old = panel.querySelector('.run-results');
  if (old) old.remove();
  const results = renderBatchResults();
  if (results) panel.querySelector('.details')?.insertAdjacentHTML('beforeend', results);
  const badge = byId('detailRunBadge');
  if (badge) {
    const done = state.batchResults.filter(r => !['pending', 'running'].includes(r.status)).length;
    badge.textContent = state.batchRunning ? `执行中 ${done}/${state.batchResults.length}` : '待命';
    badge.className = 'badge ' + (state.batchRunning ? 'run' : '');
  }
}

async function runScriptDirect(script, deviceId) {
  if (state.batchRunning || state.activeRun || state.activeBundleRun) { showToast('请等待当前脚本结束'); return null; }
  if (state.manualDeviceId) { showToast('请先关闭手动操作窗，再运行脚本'); return null; }
  let options = {};
  try {
    options = collectTaskOptions(script);
  } catch { options = {}; }
  if ((script.id === 'flow-03' || String(script.order) === '3' || script.id.startsWith('flow-03')) && options.action !== 'show' && options.action !== 'close') {
    const vpcData = await promptVpcProxyDialog();
    if (!vpcData) return null;
    options.vpcData = vpcData;
  }
  if (script.destructive && !(await confirmDestructive(script, options, [deviceId]))) return null;
  if (script.destructive) options.resetConfirmed = true;
  state.batchRunning = true;
  state.batchResults = [{ deviceId, status: 'pending' }];
  if (state.page === 'tasks') renderTaskDetail();
  state.batchResults[0].status = 'running';
  renderBatchResultsOnly();
  const result = await runScriptOnDevice(script, deviceId, options);
  state.batchResults[0] = {
    deviceId,
    status: result.skipped ? 'skipped' : result.cancelled ? 'cancelled' : result.ok ? 'ok' : 'failed',
    durationMs: result.durationMs,
    message: result.message || ''
  };
  state.batchRunning = false;
  if (state.page === 'tasks') renderTaskDetail();
  loadSharedRuntimeState();
  return result;
}

async function runScriptOnDevice(script, deviceId, options = {}) {
  const device = state.devices.find(d => d.deviceId === deviceId);
  const label = device ? deviceLabel(device) : deviceId.slice(-8);
  const externalRun = state.runtimeState.runs.find(run => !run.currentPage && run.deviceId === deviceId);
  if (externalRun) {
    return { ok: false, skipped: true, message: `正在另一个网页执行「${externalRun.title}」` };
  }
  const manual = manualWindowsForDevice(deviceId);
  if (manual?.windows) {
    return { ok: false, skipped: true, message: '正在被其他网页手动操作' };
  }

  const scriptRunId = createScriptRunId();
  const run = { id: scriptRunId, scriptId: script.id, deviceId, stopping: false, stopConfirmed: false };
  state.activeRun = run;
  state.runningScript = script.id;
  writeOutput(`[设备 ${label}] 开始执行：${script.title}`, [], { runId: scriptRunId });
  eventBus.dispatchEvent(new CustomEvent('task:running', { detail: { scriptId: script.id, deviceId } }));

  if (script.order >= 1 && script.order <= 8) setStepState(deviceId, script.order, 'running');

  let polling = false;
  const outputPollTimer = setInterval(async () => {
    if (!state.activeRun || state.activeRun.id !== scriptRunId) { clearInterval(outputPollTimer); return; }
    if (polling) return;
    polling = true;
    try {
      const live = await requestJson('/api/execute/output?scriptRunId=' + encodeURIComponent(scriptRunId));
      if (live.ok && (live.stdout || live.stderr) && state.activeRun?.id === scriptRunId) {
        writeOutput(`[设备 ${label}] 执行中：${script.title}`, cleanScriptLines(live.stdout, live.stderr), { runId: scriptRunId, logFile: live.logFile });
      }
    } catch { /* 轮询异常静默忽略 */ }
    finally { polling = false; }
  }, 300);

  try {
    const result = await requestJson('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptRunId, scriptId: script.id, deviceId, pageId: state.pageId, options, resetConfirmed: options.resetConfirmed === true })
    });
    const durationMs = Number.isFinite(result.durationMs) ? result.durationMs : null;
    const title = result.cancelled ? `脚本已停止：${script.title}`
      : result.ok ? `执行成功：${script.title}${durationMs ? ' (' + (durationMs / 1000).toFixed(1) + 's)' : ''}`
      : `执行失败：${script.title}${result.exitCode !== null && result.exitCode !== undefined ? ' (退出码: ' + result.exitCode + ')' : ''}`;
    writeOutput(`[设备 ${label}] ${title}`, cleanScriptLines(result.stdout, result.stderr), { runId: scriptRunId, logFile: result.logFile });

    if (script.order >= 1 && script.order <= 8) {
      setStepState(deviceId, script.order, result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed');
    }

    if (result.cancelled) showToast(`[${label}] 脚本已停止，请核对设备状态`);
    else if (!result.ok) showToast(`[${label}] 脚本执行失败，请查看运行日志`);
    else window.AppLogger?.info('Script', `脚本执行成功 [${script.title}] @ ${label}`);

    return { ok: Boolean(result.ok), cancelled: Boolean(result.cancelled), exitCode: result.exitCode, durationMs, logFile: result.logFile };
  } catch (error) {
    if (run.stopConfirmed) {
      writeOutput(`[设备 ${label}] 脚本已停止：${script.title}`, [
        '服务端已确认脚本进程退出并释放设备占用。',
        '脚本中断时设备状态可能只完成了部分操作；请核对设备后再继续。'
      ], { runId: scriptRunId });
      if (script.order >= 1 && script.order <= 8) setStepState(deviceId, script.order, 'cancelled');
      return { ok: false, cancelled: true, durationMs: null };
    }
    if (script.order >= 1 && script.order <= 8) setStepState(deviceId, script.order, 'failed');
    const isNetwork = error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError');
    const display = isNetwork ? '网络连接失败：后端控制台服务暂时断开或重启中，请稍后重试。' : error.message;
    writeOutput(`[设备 ${label}] 执行请求失败：${script.title}`, [display, `调用编号：${scriptRunId}`], { runId: scriptRunId });
    showToast(display);
    return { ok: false, cancelled: false, durationMs: null, message: display };
  } finally {
    clearInterval(outputPollTimer);
    if (state.activeRun?.id === scriptRunId) {
      state.activeRun = null;
      state.runningScript = '';
    }
    if (typeof requestAllPreviews === 'function') requestAllPreviews();
  }
}

async function confirmDestructive(script, options, deviceIds) {
  const isBlock = script.id === 'flow-18';
  const isV2 = script.id === 'flow-09-v2';
  const first = state.devices.find(d => d.deviceId === deviceIds[0]);
  const scope = deviceIds.length > 1 ? `${deviceIds.length} 台设备` : (first ? deviceLabel(first) : '目标设备');
  let title, message, okText;
  if (isBlock) {
    title = '确认执行【拉黑联系人】？';
    okText = '确认拉黑';
    message = `<p class="confirm-lead">确认拉黑联系人 <strong>${escapeHtml(options.contactName || '未指定联系人')}</strong>？</p>
      <div class="confirm-card"><span class="confirm-card-icon">!</span><span><span class="confirm-card-title">拉黑后对方将无法再联系此账号！</span><span class="confirm-card-desc">执行前请确认云机已停留在该联系人的聊天页，脚本会先核验顶栏姓名再操作。</span></span></div>`;
  } else if (isV2) {
    title = '确认执行【重置数据】？';
    okText = '确认重置';
    message = `<p class="confirm-lead">确认对 <strong>${escapeHtml(scope)}</strong> 执行“重置数据”？</p>
      <div class="confirm-card"><span class="confirm-card-icon">!</span><span><span class="confirm-card-title">警告：即将重置该设备，此操作不可恢复！</span><span class="confirm-card-desc">清空该设备所有数据并恢复出厂设置。</span></span></div>`;
  } else {
    title = '确认执行【改机重置】？';
    okText = '确认改机重置';
    message = `<p class="confirm-lead">确认对 <strong>${escapeHtml(scope)}</strong> 执行“改机重置”？机型范围：Android ${escapeHtml(options.androidVersion || '16')}；国家：${escapeHtml(options.countryCode || 'CN')}。</p>
      <div class="confirm-card"><span class="confirm-card-icon">!</span><span><span class="confirm-card-title">警告：此操作会清除该设备所有数据且不可撤销！</span><span class="confirm-card-desc">重置后云机将自动重启并应用新机型参数。</span></span></div>`;
  }
  return showInPageConfirm({ title, message, okText, isDanger: true });
}

async function stopRunningScript() {
  const run = state.activeRun;
  if (!run) { showToast('当前没有正在执行的脚本'); return; }
  if (run.stopping || run.stopConfirmed) return;
  run.stopping = true;
  try {
    const res = await requestJson('/api/execute/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scriptRunId: run.id })
    });
    if (res.stopped !== true) {
      run.stopping = false;
      showToast(res.message || '停止尚未确认，请查看当前运行状态');
      return;
    }
    if (state.activeRun?.id === run.id) {
      run.stopConfirmed = true;
      run.stopping = false;
      showToast(res.pending ? '停止请求已登记，等待执行请求返回' : '脚本已停止');
    }
  } catch (error) {
    if (state.activeRun?.id === run.id) run.stopping = false;
    showToast('停止请求失败：' + error.message);
  }
}
window.stopRunningScript = stopRunningScript;

/* ---------- 组合脚本执行 ---------- */

async function executeSingleStep(script, targetId) {
  return runScriptOnDevice(script, targetId, {});
}

async function executeBundle(bundle) {
  if (state.batchRunning || state.activeRun || state.activeBundleRun) { showToast('请等待当前脚本完成'); return; }
  if (state.manualDeviceId) { showToast('请先关闭手动操作窗，再运行脚本'); return; }
  if (!state.tokenConfigured) { showToast('尚未连接云机平台'); return; }
  const targetId = state.selectedDeviceId;
  const stepScripts = (bundle.stepIds || []).map(id => state.scripts.find(s => s.id === id)).filter(Boolean);
  if (!stepScripts.length) { showToast('此组合未包含有效脚本步骤'); return; }
  if (stepScripts.some(s => s.requiresDevice) && !targetId) { showToast('此组合需要操作云机，请先选择目标云机'); return; }

  const bundleRunState = { bundleId: bundle.id, stopped: false };
  state.activeBundleRun = bundleRunState;
  const total = stepScripts.length;
  writeOutput(`【开始执行组合脚本】: ${bundle.name}`, [
    `功能备注：${bundle.description || '无'}`,
    `目标设备：${targetId ? deviceLabel(currentDevice()) : '无需设备'}`,
    ...stepScripts.map((s, i) => `  ${i + 1}. ${s.title}`)
  ]);

  try {
    for (let i = 0; i < total; i++) {
      if (bundleRunState.stopped) {
        writeOutput(`【组合脚本人为中断】: ${bundle.name}`, ['用户已主动停止组合脚本，剩余步骤已取消。']);
        showToast('组合脚本已停止');
        break;
      }
      const script = stepScripts[i];
      writeOutput(`▶ [步骤 ${i + 1}/${total}] 启动执行: ${script.title}`, [`正在运行子脚本 ${script.id}...`]);
      const stepRes = await executeSingleStep(script, targetId);
      if (bundleRunState.stopped || stepRes.cancelled) {
        writeOutput(`【组合脚本中断】: 步骤 ${i + 1} (${script.title}) 已停止。`, ['终止后续执行。']);
        showToast(`组合脚本已在步骤 ${i + 1} 停止`);
        break;
      }
      if (!stepRes.ok) {
        writeOutput(`【组合脚本失败中断】: 步骤 ${i + 1} (${script.title}) 执行未达成`, ['组合脚本后续步骤已自动熔断中止。']);
        showToast(`步骤 ${i + 1} (${script.title}) 执行失败，组合已中断`);
        break;
      }
      writeOutput(`✓ [步骤 ${i + 1}/${total}] 成功达成: ${script.title}`, [`耗时: ${stepRes.durationMs ? (stepRes.durationMs / 1000).toFixed(1) + 's' : '--'}`]);
      if (i === total - 1) {
        writeOutput(`【组合脚本全部执行成功】${bundle.name}`, [`共 ${total} 个步骤全部依次顺利执行达成！`]);
        showToast(`组合脚本【${bundle.name}】全部执行完成`);
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  } catch (err) {
    writeOutput(`【组合脚本异常失败】: ${bundle.name}`, [err.message]);
    showToast('组合脚本异常: ' + err.message);
  } finally {
    state.activeBundleRun = null;
    loadSharedRuntimeState();
    if (typeof requestAllPreviews === 'function') requestAllPreviews();
  }
}

function stopRunningBundle() {
  if (state.activeBundleRun) {
    state.activeBundleRun.stopped = true;
    showToast('正在停止组合脚本…');
    stopRunningScript();
  }
}

/* ---------- VPC 代理弹窗 ---------- */

function promptVpcProxyDialog() {
  const dialog = byId('vpcDialog');
  const input = byId('vpcRawInput');
  if (!dialog || !input) return Promise.resolve(null);
  return new Promise(resolve => {
    let resolved = false;
    const cleanup = () => {
      byId('closeVpcDialogBtn')?.removeEventListener('click', onCancel);
      byId('cancelVpcBtn')?.removeEventListener('click', onCancel);
      byId('confirmVpcBtn')?.removeEventListener('click', onConfirm);
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
      if (!val) { showToast('请输入 VPC 代理数据'); input.focus(); return; }
      finish(val);
    };
    const onKeyDown = e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onConfirm(); }
    };
    byId('closeVpcDialogBtn')?.addEventListener('click', onCancel);
    byId('cancelVpcBtn')?.addEventListener('click', onCancel);
    byId('confirmVpcBtn')?.addEventListener('click', onConfirm);
    dialog.addEventListener('cancel', onCancel, { once: true });
    dialog.addEventListener('keydown', onKeyDown);
    input.value = '';
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
    setTimeout(() => input.focus(), 50);
  });
}

/* ---------- 组合脚本管理（管理员） ---------- */

let editingBundleSteps = [];

function openBundleModal(bundle = null) {
  const modal = byId('scriptBundleModal');
  if (!modal) return;
  const select = byId('bundleAvailableScriptsSelect');
  if (select) {
    select.innerHTML = '';
    for (const s of state.scripts.filter(item => !item.batch && !item.id.startsWith('flow-all'))) {
      const option = document.createElement('option');
      option.value = s.id;
      const ver = (s.category || s.version || '').toUpperCase();
      option.textContent = `${ver ? `[${ver}] ` : ''}${s.title}`;
      select.append(option);
    }
  }
  if (bundle) {
    byId('bundleModalTitle').textContent = '编辑自定义脚本组合';
    byId('bundleEditId').value = bundle.id;
    byId('bundleNameInput').value = bundle.name || '';
    byId('bundleDescInput').value = bundle.description || '';
    byId('bundleEnabledInput').checked = bundle.enabled !== false;
    editingBundleSteps = Array.isArray(bundle.stepIds) ? [...bundle.stepIds] : [];
  } else {
    byId('bundleModalTitle').textContent = '新建自定义脚本组合';
    byId('bundleEditId').value = '';
    byId('bundleNameInput').value = '';
    byId('bundleDescInput').value = '';
    byId('bundleEnabledInput').checked = true;
    editingBundleSteps = [];
  }
  renderModalSelectedSteps();
  try { modal.showModal(); } catch { modal.setAttribute('open', ''); }
}

function renderModalSelectedSteps() {
  const container = byId('bundleSelectedSteps');
  if (!container) return;
  container.innerHTML = '';
  if (!editingBundleSteps.length) {
    container.innerHTML = '<div class="hint" style="text-align:center;">暂未添加步骤，请在下方选择脚本并点击「添加步骤」</div>';
    return;
  }
  editingBundleSteps.forEach((stepId, index) => {
    const script = state.scripts.find(s => s.id === stepId);
    const row = document.createElement('div');
    row.className = 'bundle-step-row';
    row.innerHTML = `<span class="task-name"><span class="num">${index + 1}</span>${escapeHtml(script ? script.title : stepId)}</span>
      <span class="bundle-step-actions">
        <button class="btn-icon" data-step-up="${index}" type="button" ${index === 0 ? 'disabled' : ''} title="上移">▲</button>
        <button class="btn-icon" data-step-down="${index}" type="button" ${index === editingBundleSteps.length - 1 ? 'disabled' : ''} title="下移">▼</button>
        <button class="btn-icon danger" data-step-remove="${index}" type="button" title="移除">✗</button>
      </span>`;
    container.append(row);
  });
}

function initBundleModalEvents() {
  byId('closeBundleModalBtn')?.addEventListener('click', () => byId('scriptBundleModal')?.close());
  byId('cancelBundleBtn')?.addEventListener('click', () => byId('scriptBundleModal')?.close());
  byId('bundleSelectedSteps')?.addEventListener('click', event => {
    const up = event.target.closest('[data-step-up]');
    const down = event.target.closest('[data-step-down]');
    const remove = event.target.closest('[data-step-remove]');
    if (up) {
      const i = Number(up.dataset.stepUp);
      [editingBundleSteps[i - 1], editingBundleSteps[i]] = [editingBundleSteps[i], editingBundleSteps[i - 1]];
      renderModalSelectedSteps();
    } else if (down) {
      const i = Number(down.dataset.stepDown);
      [editingBundleSteps[i + 1], editingBundleSteps[i]] = [editingBundleSteps[i], editingBundleSteps[i + 1]];
      renderModalSelectedSteps();
    } else if (remove) {
      editingBundleSteps.splice(Number(remove.dataset.stepRemove), 1);
      renderModalSelectedSteps();
    }
  });
  byId('addStepToBundleBtn')?.addEventListener('click', () => {
    const select = byId('bundleAvailableScriptsSelect');
    if (select?.value) { editingBundleSteps.push(select.value); renderModalSelectedSteps(); }
  });
  byId('saveBundleBtn')?.addEventListener('click', handleSaveBundleModal);
}

async function handleSaveBundleModal() {
  const editId = byId('bundleEditId')?.value || '';
  const name = byId('bundleNameInput')?.value?.trim();
  if (!name) { showToast('请输入组合脚本名称'); return; }
  if (!editingBundleSteps.length) { showToast('请至少添加一个执行步骤'); return; }
  try {
    const res = await requestJson('/api/admin/scripts/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: editId || undefined,
        name,
        description: byId('bundleDescInput')?.value?.trim() || '',
        enabled: byId('bundleEnabledInput')?.checked !== false,
        stepIds: editingBundleSteps
      })
    });
    if (res.ok) {
      showToast('组合脚本保存成功');
      byId('scriptBundleModal')?.close();
      if (typeof loadScripts === 'function') await loadScripts();
    }
  } catch (err) {
    showToast('保存组合脚本失败: ' + err.message);
  }
}

async function saveBundleDirect(bundle) {
  try {
    const res = await requestJson('/api/admin/scripts/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle)
    });
    if (res.ok) {
      showToast(`已${bundle.enabled ? '开启' : '关闭'}组合脚本的用户侧显示`);
      if (typeof loadScripts === 'function') await loadScripts();
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
      if (typeof loadScripts === 'function') await loadScripts();
    }
  } catch (err) {
    showToast('删除组合脚本失败: ' + err.message);
  }
}

/* ---------- 总览快捷任务 ---------- */

function renderQuickTasks() {
  const host = elements.quickTaskList;
  if (!host) return;
  const momo = state.scripts.filter(s => s.category === 'momo' && !s.batch && scriptVisible(s))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).slice(0, 6);
  if (!momo.length) {
    host.innerHTML = '<div class="empty">任务加载中…</div>';
    return;
  }
  host.innerHTML = momo.map(script => `<button class="task-row" data-quick-task="${escapeHtml(script.id)}" type="button">
    <span class="task-icon">${ic('tasks', 16)}</span>
    <span class="task-row-body"><b>${escapeHtml(scriptTitle(script))}</b><small>${escapeHtml(script.file || '')}</small></span>
    ${ic('chevron', 15)}
  </button>`).join('');
}

elements.quickTaskList?.addEventListener?.('click', event => {
  const row = event.target.closest('[data-quick-task]');
  if (!row) return;
  state.taskScriptId = row.dataset.quickTask;
  setPage('tasks');
});

/* ---------- 运行时互斥状态同步 ---------- */

function updateTaskRuntime() {
  updateBatchCount();
  const picker = byId('taskDetailPanel');
  if (picker) {
    for (const input of picker.querySelectorAll('[data-batch-device]')) {
      const id = input.dataset.batchDevice;
      const device = state.devices.find(d => d.deviceId === id);
      const active = deviceRunning(id);
      input.disabled = !device;
      const note = input.closest('.device-choice')?.querySelector('small');
      if (note && device) note.textContent = active ? '正在执行' : isOnline(device) ? '可执行' : '离线';
    }
  }
}

window.updateTaskRuntime = updateTaskRuntime;

/* ---------- 事件订阅 ---------- */

eventBus.addEventListener('page:changed', event => {
  if (event.detail.page === 'tasks') renderTasksPage();
});

eventBus.addEventListener('scripts:changed', () => {
  if (state.page === 'tasks') renderTasksPage();
  if (state.page === 'overview') renderQuickTasks();
});

eventBus.addEventListener('device:selected', () => {
  if (state.page === 'tasks') { renderPipeline(); renderTaskDetail(); }
});

eventBus.addEventListener('runtime:changed', () => {
  if (state.page === 'tasks') updateTaskRuntime();
});

eventBus.addEventListener('batch:devices', () => {
  updateBatchCount();
});

byId('taskHeadActions')?.addEventListener?.('change', () => {});
