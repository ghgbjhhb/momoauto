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

const RUN_STATE_TEXT = { ok: '已完成', failed: '执行失败', cancelled: '已停止', skipped: '已跳过', pending: '排队中', running: '执行中', unknown: '状态未知' };

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

function currentTaskBundle() {
  if (!state.taskBundleId) return null;
  const bundles = Array.isArray(state.bundles) ? state.bundles : [];
  const bundle = bundles.find(item => item.id === state.taskBundleId);
  if (!bundle) return null;
  if (!isScriptManageMode() && (bundle.enabled === false || !groupVisible('custom'))) return null;
  return bundle;
}

function bundleSteps(bundle) {
  return (bundle.stepIds || []).map(id => state.scripts.find(s => s.id === id)).filter(Boolean);
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
      <div class="panel-head"><h2>任务列表</h2><span class="hint" id="taskCountHint"></span></div>
      <div id="taskGroups"></div>
    </section>
  `;

  right.innerHTML = `
    <section class="panel" id="taskDetailPanel"><div class="empty">选择左侧任务查看配置</div></section>
  `;

  byId('taskGroups')?.addEventListener('click', onTaskGroupsClick);
  byId('taskDetailPanel')?.addEventListener('input', onDetailInput);
  byId('taskDetailPanel')?.addEventListener('change', onDetailInput);
  byId('taskDetailPanel')?.addEventListener('click', onDetailClick);

  renderTaskGroups();
  renderTaskDetail();
  eventBus.dispatchEvent(new CustomEvent('tasks:rendered'));
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
  const bundleAdd = event.target.closest('[data-bundle-add]');
  if (bundleAdd) {
    openBundleModal();
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
    if (state.batchRunning || state.activeRun || state.activeBundleRun) { showToast('请等待当前脚本完成'); return; }
    const bundle = state.bundles.find(item => item.id === bundleRun.dataset.bundleRun);
    if (bundle) executeBundle(bundle);
    return;
  }
  const bundleSelect = event.target.closest('[data-bundle-select]');
  if (bundleSelect) {
    state.taskBundleId = bundleSelect.dataset.bundleSelect;
    state.taskScriptId = '';
    renderTaskGroups();
    renderTaskDetail();
    return;
  }
  const card = event.target.closest('[data-task-select]');
  if (card) {
    state.taskScriptId = card.dataset.taskSelect;
    state.taskBundleId = '';
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
  const bundleParam = event.target.closest('[data-bundle-run-param]');
  if (bundleParam && state.taskBundleId) {
    state.bundleParamValues = state.bundleParamValues || {};
    state.bundleParamValues[bundleRunParamKey(state.taskBundleId, ...bundleParam.dataset.bundleRunParam.split(':'))] = bundleParam.value;
  }
}

/* ---------- 任务分组列表 ---------- */

function groupScripts(key) {
  // 分组只认 category：MOMO 脚本（11/16）也带 version: 'v2'，按版本匹配会重复出现在 V2 组
  if (key === 'v2') {
    return state.scripts.filter(s => s.category === 'v2' && !s.batch)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }
  if (key === 'v3') {
    return state.scripts.filter(s => s.category === 'v3' && !s.batch)
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
    </span>
    ${visSwitch}${ic('chevron', 15)}
  </div>`;
}

function bundleCardHtml(bundle) {
  const manage = isScriptManageMode();
  const enabled = bundle.enabled !== false;
  if (!manage && !enabled) return '';
  const steps = (bundle.stepIds || []).map((id, i) => {
    const script = state.scripts.find(s => s.id === id);
    return script ? { script, options: bundle.stepOptions?.[i] || {} } : null;
  }).filter(Boolean);
  // 步骤流程仅管理员可见；用户侧只显示备注，避免长流程挤占卡片
  const stepsFlow = manage && steps.length
    ? `<span class="bundle-steps-flow">${steps.map((step, i) =>
        `${i ? '<span class="bundle-step-arrow">→</span>' : ''}<span class="bundle-step-item">${i + 1}. ${escapeHtml(scriptTitle(step.script))}${describeStepOptions(step) ? `<b class="bundle-step-opts">${escapeHtml(describeStepOptions(step))}</b>` : ''}</span>`).join('')}</span>`
    : '';
  const manageActions = manage ? `
    <span class="task-group-extra">
      <button class="switch ${enabled ? 'on' : ''}" data-vis-bundle="${escapeHtml(bundle.id)}" type="button" title="控制此组合在用户侧是否显示" role="switch"></button>
      <button class="btn sm" data-bundle-edit="${escapeHtml(bundle.id)}" type="button">编辑</button>
      <button class="btn sm flat" data-bundle-delete="${escapeHtml(bundle.id)}" type="button">删除</button>
    </span>` : '';
  return `<div class="task-card ${state.taskBundleId === bundle.id ? 'active' : ''}" data-bundle-select="${escapeHtml(bundle.id)}" role="button" tabindex="0">
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
  const flatCards = [];

  for (const group of GROUPS) {
    if (group.key === 'custom') {
      const bundles = Array.isArray(state.bundles) ? state.bundles : [];
      const displayBundles = manage ? bundles : bundles.filter(b => b.enabled !== false);
      if (!manage && (!groupVisible('custom') || !displayBundles.length)) continue;
      visibleCount += displayBundles.length;
      if (!manage) {
        flatCards.push(...displayBundles.map(bundleCardHtml));
        continue;
      }
      const collapsed = localStorage.getItem('yunmomo.collapse.custom') === 'true';
      html += `<div class="task-group ${collapsed ? 'collapsed' : ''}">
        <div class="task-group-head"><span class="task-group-title">${group.title}${!groupVisible('custom') ? '<span class="badge warn">用户侧隐藏</span>' : ''}</span><span class="task-group-extra"><button class="switch ${groupVisible('custom') ? 'on' : ''}" data-vis-group="custom" type="button" role="switch" title="控制是否在用户侧显示"></button><button class="collapse-btn" data-collapse-group="custom" type="button" aria-label="收起/展开">${ic('chevron', 14)}</button></span></div>
        <div class="task-group-body">${displayBundles.length ? displayBundles.map(bundleCardHtml).join('') : '<div class="empty">暂无自定义组合脚本，<button class="btn sm" data-bundle-add type="button">立即添加</button></div>'}</div>
      </div>`;
      continue;
    }

    const scripts = groupScripts(group.key);
    const visibleScripts = manage ? scripts : scripts.filter(scriptVisible);
    if (!manage && (!groupVisible(group.key) || !visibleScripts.length)) continue;
    visibleCount += visibleScripts.length;
    if (!manage) {
      flatCards.push(...visibleScripts.map(taskCardHtml));
      continue;
    }
    const collapsed = localStorage.getItem('yunmomo.collapse.' + group.key) === 'true';
    html += `<div class="task-group ${collapsed ? 'collapsed' : ''}">
      <div class="task-group-head"><span class="task-group-title">${group.title}${!groupVisible(group.key) ? '<span class="badge warn">用户侧隐藏</span>' : ''}</span><span class="task-group-extra"><button class="switch ${groupVisible(group.key) ? 'on' : ''}" data-vis-group="${group.key}" type="button" role="switch" title="控制是否在用户侧显示"></button><button class="collapse-btn" data-collapse-group="${group.key}" type="button" aria-label="收起/展开">${ic('chevron', 14)}</button></span></div>
      <div class="task-group-body">${visibleScripts.map(taskCardHtml).join('')}</div>
    </div>`;
  }

  host.innerHTML = manage
    ? (html || '<div class="empty">暂无可用任务</div>')
    : (flatCards.length ? flatCards.join('') : '<div class="empty">暂无可用任务</div>');
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
    // 任务显隐开关变动，立即同步更新总览页任务列表
    renderOverviewTasks();
    eventBus.dispatchEvent(new CustomEvent('scripts:changed'));
  } catch (err) {
    showToast('更新显隐设置失败: ' + err.message);
  }
}

/* ---------- 任务配置详情 ---------- */

function parameterChoiceLabel(field, value) {
  if (field.name === 'action') return ({ set: '设置代理', show: '展示当前', close: '关闭代理' })[value] || String(value);
  if (field.name === 'mode') return ({ random: '随机', button: '底部按钮', pull: '下拉刷新', execute: '执行发送', draft: '生成并输入', watch: '挂机模式 (巡查前几页)', drain: '全量模式 (必须翻到底)', ip: '定位到IP所在地', search: '搜索地点穿越' })[value] || String(value);
  if (field.name === 'maxContacts') return ({ xx: '持续运行(无上限)', '1': '1人(单次测试)', '3': '3人', '5': '5人', '10': '10人' })[value] || String(value);
  if (field.name === 'maxApproved') return value + ' 人';
  if (field.name === 'maxDistance') return value ? `≤ ${value}公里` : '不限距离';
  if (field.name === 'approveProbability') return Math.round(Number(value) * 100) + '%';
  if (field.name === 'androidVersion') return value === 'all' ? '全部版本' : 'Android ' + value;
  return String(value);
}

function renderTaskDetail() {
  const panel = byId('taskDetailPanel');
  if (!panel) return;
  const bundle = currentTaskBundle();
  if (bundle) {
    renderBundleDetail(panel, bundle);
    return;
  }
  const script = currentTaskScript();
  if (!script) {
    panel.innerHTML = '<div class="empty">暂无可执行任务</div>';
    return;
  }
  if (!state.taskScriptId) state.taskScriptId = script.id;

  const params = (script.parameters || []).filter(field => isScriptManageMode() || !field.adminOnly);
  const isSingleInline = params.length === 1 && !params[0].multiline;
  const fieldsHtml = params.map(field => {
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
    const field = params[0];
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

/* ---------- 组合脚本详情（所有步骤参数集中配置） ---------- */

function bundleRunParamKey(bundleId, stepIndex, fieldName) {
  return `${bundleId}:${stepIndex}:${fieldName}`;
}

function bundleRunFieldHtml(bundle, script, stepIndex, field) {
  state.bundleParamValues = state.bundleParamValues || {};
  const key = bundleRunParamKey(bundle.id, stepIndex, field.name);
  const saved = bundle.stepOptions?.[stepIndex]?.[field.name];
  const value = state.bundleParamValues[key] ?? saved ?? field.defaultValue ?? '';
  const attrs = `data-bundle-run-param="${stepIndex}:${escapeHtml(field.name)}" ${field.required ? 'required' : ''} ${field.maxLength ? `maxlength="${field.maxLength}"` : ''} placeholder="${escapeHtml(field.placeholder || '')}"`;
  if (field.choices) {
    return `<div class="field"><label for="brun-${stepIndex}-${field.name}">${escapeHtml(field.label)}</label>
      <select class="select" id="brun-${stepIndex}-${field.name}" ${attrs}>
        ${field.choices.map(choice => `<option value="${escapeHtml(choice)}" ${String(value) === String(choice) ? 'selected' : ''}>${escapeHtml(parameterChoiceLabel(field, choice))}</option>`).join('')}
      </select></div>`;
  }
  if (field.multiline) {
    return `<div class="field"><label for="brun-${stepIndex}-${field.name}">${escapeHtml(field.label)}</label>
      <textarea class="input textarea" id="brun-${stepIndex}-${field.name}" ${attrs}>${escapeHtml(value)}</textarea></div>`;
  }
  return `<div class="field"><label for="brun-${stepIndex}-${field.name}">${escapeHtml(field.label)}</label>
    <input class="input" id="brun-${stepIndex}-${field.name}" type="text" value="${escapeHtml(value)}" autocomplete="off" spellcheck="false" ${attrs}></div>`;
}

function renderBundleDetail(panel, bundle) {
  const steps = bundleSteps(bundle);
  // 仅展示需要设置参数的步骤，无参脚本不占面板；编号保留组合中的原始顺序
  const stepsHtml = steps.map((script, i) => {
    const fields = (script.parameters || []).map(field => bundleRunFieldHtml(bundle, script, i, field)).join('');
    if (!fields) return '';
    return `<div class="bundle-detail-step">
      <div class="bundle-detail-step-head"><span class="num">${i + 1}</span><span>${escapeHtml(scriptTitle(script))}</span></div>
      ${fields}
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="section-line">
      <h3>任务配置</h3>
      <span class="badge ${state.batchRunning ? 'run' : ''}" id="detailRunBadge">${state.batchRunning ? '执行中' : '待命'}</span>
    </div>
    <div class="details">
      <div class="details-heading">
        <h2>${escapeHtml(bundle.name)}</h2>
      </div>
      ${bundle.description ? `<div class="selection-summary">${escapeHtml(bundle.description)}</div>` : ''}
      ${stepsHtml || (steps.length ? '<div class="empty">此组合内的脚本均无需参数，选择设备后可直接执行</div>' : '<div class="empty">此组合未包含有效脚本步骤</div>')}
      ${renderDevicePicker()}
      ${renderBatchResults()}
      <div class="details-footer">
        <span class="footer-note" id="detailNote"></span>
        ${state.batchRunning
          ? `<button class="btn danger" id="batchStopBtn" type="button">${ic('stop', 15)} 停止执行</button>`
          : `<button class="btn primary" id="bundleRunBtn" type="button">${ic('play', 15)} 执行组合 (<span id="batchCount">0</span> 台)</button>`}
      </div>
    </div>
  `;
  updateBatchCount();
  updateTaskRuntime();
}

// 以面板 DOM 实际值为准收集各步骤参数（空值删除，回退脚本默认行为），并校验必填
function collectBundleRunOptions(bundle) {
  const options = bundleSteps(bundle).map((_, i) => ({ ...(bundle.stepOptions?.[i] || {}) }));
  const panel = byId('taskDetailPanel');
  if (panel) {
    for (const input of panel.querySelectorAll('[data-bundle-run-param]')) {
      const raw = input.dataset.bundleRunParam || '';
      const colon = raw.indexOf(':');
      const index = Number(raw.slice(0, colon));
      const name = raw.slice(colon + 1);
      if (!Number.isInteger(index) || index < 0 || !name || !options[index]) continue;
      const value = String(input.value ?? '').trim();
      if (input.required && !value) {
        input.focus?.();
        throw new Error(`步骤 ${index + 1} 的「${input.closest('.field')?.querySelector('label')?.textContent || name}」为必填项`);
      }
      if (value) options[index][name] = value;
      else delete options[index][name];
    }
  }
  return options;
}

async function startBundleBatch() {
  const bundle = currentTaskBundle();
  if (!bundle) return;
  if (state.batchRunning) { showToast('任务正在执行中'); return; }
  if (state.activeRun || state.activeBundleRun) { showToast('请等待当前脚本结束'); return; }
  if (state.manualDeviceId) { showToast('请先关闭手动操作窗，再运行脚本'); return; }
  if (!state.tokenConfigured) { showToast('尚未连接云机平台'); return; }

  let stepOptions;
  try {
    stepOptions = collectBundleRunOptions(bundle);
  } catch (err) {
    showToast(err.message);
    return;
  }
  const ids = state.batchDevices.filter(id => state.devices.some(d => d.deviceId === id));
  if (!ids.length) { showToast('请先勾选至少一台可执行设备'); return; }

  state.batchRunning = true;
  state.batchStopRequested = false;
  state.batchResults = ids.map(id => ({ deviceId: id, status: 'pending' }));
  renderTaskDetail();
  eventBus.dispatchEvent(new CustomEvent('task:running', { detail: { bundleId: bundle.id } }));

  for (let i = 0; i < ids.length; i++) {
    if (state.batchStopRequested) {
      state.batchResults[i].status = 'skipped';
      continue;
    }
    state.batchResults[i].status = 'running';
    renderBatchResultsOnly();
    const result = await executeBundle(bundle, ids[i], stepOptions);
    const record = state.batchResults[i];
    if (record) {
      record.status = result?.unknown ? 'unknown' : result?.cancelled ? 'cancelled' : result?.ok ? 'ok' : 'failed';
      record.message = result?.message || '';
    }
    renderBatchResultsOnly();
    if (result?.cancelled || result?.unknown) state.batchStopRequested = true;
    if (typeof loadDevices === 'function') loadDevices(true);
  }

  state.batchRunning = false;
  renderTaskDetail();
  loadSharedRuntimeState();
  const ok = state.batchResults.filter(r => r.status === 'ok').length;
  showToast(state.batchResults.some(r => r.status === 'unknown')
    ? '组合任务存在状态未知的设备，已停止后续调度，请先核查现场'
    : `组合任务结束：${ok}/${state.batchResults.length} 台成功`);
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
      : result.status === 'failed' || result.status === 'cancelled' ? 'err' : result.status === 'unknown' ? 'warn' : '';
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
  const bundle = currentTaskBundle();
  const usable = state.batchDevices.filter(id => state.devices.some(d => d.deviceId === id));
  count.textContent = String(usable.length);
  const note = byId('detailNote');
  if (!note) return;
  if (bundle) {
    note.textContent = '组合内步骤按顺序串行执行，多台设备逐台运行';
  } else {
    note.textContent = script?.requiresDevice
      ? '并发运行'
      : '该任务不依赖设备';
  }
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

  if (event.target.closest('#bundleRunBtn')) {
    await startBundleBatch();
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
    if (state.batchRunning || state.activeRun || state.activeBundleRun) { showToast('请等待当前脚本完成'); return; }
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

  if (isVpcProxyScript(script) && options.action !== 'show' && options.action !== 'close') {
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
      record.status = result.unknown ? 'unknown' : result.skipped ? 'skipped' : result.cancelled ? 'cancelled' : result.ok ? 'ok' : 'failed';
      record.durationMs = result.durationMs;
      record.message = result.message || '';
    }
    renderBatchResultsOnly();
    if (result.cancelled || result.unknown) state.batchStopRequested = true;
    if (typeof loadDevices === 'function') loadDevices(true);
  }

  state.batchRunning = false;
  renderTaskDetail();
  loadSharedRuntimeState();
  const ok = state.batchResults.filter(r => r.status === 'ok').length;
  showToast(state.batchResults.some(r => r.status === 'unknown')
    ? '批量任务存在状态未知的设备，已停止后续调度，请先核查现场'
    : `批量任务结束：${ok}/${state.batchResults.length} 台成功`);
}

function stopTaskBatch() {
  if (!state.batchRunning && state.activeBundleRun) { stopRunningBundle(); return; }
  if (!state.batchRunning && state.activeRun) { stopRunningScript(); return; }
  if (!state.batchRunning) return;
  state.batchStopRequested = true;
  showToast('正在停止当前设备上的脚本…');
  if (state.activeBundleRun) stopRunningBundle();
  else stopRunningScript();
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
  } catch (error) {
    showToast(error.message || '任务参数不完整');
    return null;
  }
  if (isVpcProxyScript(script) && options.action !== 'show' && options.action !== 'close') {
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
    status: result.unknown ? 'unknown' : result.skipped ? 'skipped' : result.cancelled ? 'cancelled' : result.ok ? 'ok' : 'failed',
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

  const pendingKey = 'yunmomo.webRun';
  const taskState = { id: scriptRunId, scriptId: script.id, deviceId,
    title: script.title, order: script.order, userId: state.currentUser?.id };
  try { sessionStorage.setItem(pendingKey, JSON.stringify(taskState)); } catch {}
  let unknown = false;
  try {
    // 同一个运行编号只允许提交一次；网络断开后仅查询状态，不重试写操作。
    try {
      await requestJson('/api/execute/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptRunId, scriptId: script.id, deviceId,
          pageId: state.pageId, options, resetConfirmed: options.resetConfirmed === true })
      });
    } catch (error) {
      if (error.status && error.status !== 409 && error.status < 500) throw error;
      writeOutput(`[设备 ${label}] 提交响应断开，正在按运行编号核查实际状态…`,
        [`调用编号：${scriptRunId}；禁止重复提交执行请求。`], { runId: scriptRunId });
    }

    let lastOutput = '';
    let connectionLost = false;
    while (true) {
      let snapshot;
      try {
        snapshot = await requestJson('/api/execute/status?scriptRunId=' + encodeURIComponent(scriptRunId));
        connectionLost = false;
      } catch (error) {
        if (error.status === 404) {
          unknown = true;
          break;
        }
        if (error.status && error.status !== 502 && error.status !== 503 && error.status !== 504) throw error;
        if (!connectionLost) {
          writeOutput(`[设备 ${label}] 无法获取任务状态：网络断开，不代表脚本已停止`,
            [`调用编号：${scriptRunId}，连接恢复后自动重新查询，不会重复执行。`], { runId: scriptRunId });
          connectionLost = true;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      if (snapshot.state === 'unknown' || snapshot.state === 'not_found') {
        unknown = true;
        break;
      }
      if (snapshot.state === 'finished') {
        const result = snapshot.result || { ok: false, message: '缺少执行结果' };
        const durationMs = Number.isFinite(result.durationMs) ? result.durationMs : null;
        const title = result.cancelled ? `脚本已停止：${script.title}`
          : result.ok ? `执行成功：${script.title}${durationMs ? ' (' + (durationMs / 1000).toFixed(1) + 's)' : ''}`
          : `执行失败：${script.title}${result.exitCode != null ? ' (退出码: ' + result.exitCode + ')' : ''}`;
        writeOutput(`[设备 ${label}] ${title}`,
          [...cleanScriptLines(result.stdout, result.stderr), ...(result.message ? [result.message] : [])],
          { runId: scriptRunId, logFile: result.logFile });
        if (script.order >= 1 && script.order <= 8) {
          setStepState(deviceId, script.order, result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed');
        }
        if (result.cancelled) showToast(`[${label}] 脚本已停止，请核对设备状态`);
        else if (!result.ok) showToast(`[${label}] 脚本执行失败，请查看运行日志`);
        return { ok: Boolean(result.ok), cancelled: Boolean(result.cancelled), exitCode: result.exitCode,
          durationMs, logFile: result.logFile, message: result.message };
      }
      const output = (snapshot.stdout || '') + '\n' + (snapshot.stderr || '');
      if (output.trim() && output !== lastOutput) {
        lastOutput = output;
        writeOutput(`[设备 ${label}] 执行中：${script.title}`,
          cleanScriptLines(snapshot.stdout, snapshot.stderr), { runId: scriptRunId, logFile: snapshot.logFile });
      }
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  } catch (error) {
    if (run.stopConfirmed) {
      writeOutput(`[设备 ${label}] 脚本已停止：${script.title}`,
        ['服务端已确认脚本进程退出并释放设备占用。'], { runId: scriptRunId });
      if (script.order >= 1 && script.order <= 8) setStepState(deviceId, script.order, 'cancelled');
      return { ok: false, cancelled: true, durationMs: null };
    }
    if (error.status && error.status < 500) {
      if (script.order >= 1 && script.order <= 8) setStepState(deviceId, script.order, 'failed');
      writeOutput(`[设备 ${label}] 执行被服务端拒绝：${script.title}`, [error.message], { runId: scriptRunId });
      showToast(error.message);
      return { ok: false, cancelled: false, message: error.message };
    }
    unknown = true;
  } finally {
    if (!unknown) {
      try { if (JSON.parse(sessionStorage.getItem(pendingKey) || '{}').id === scriptRunId) sessionStorage.removeItem(pendingKey); } catch {}
      if (state.activeRun?.id === scriptRunId) {
        state.activeRun = null;
        state.runningScript = '';
      }
    } else {
      run.unknown = true;
    }
    if (typeof requestAllPreviews === 'function') requestAllPreviews();
  }
  const warning = '任务结果无法确认：请先核查服务端日志和设备实际状态，禁止直接重复执行';
  writeOutput(`[设备 ${label}] ${warning}`, [`运行编号：${scriptRunId}`], { runId: scriptRunId });
  showToast(warning);
  return { ok: false, unknown: true, message: warning };

}

// 刷新页面后只恢复状态订阅，绝不重新发起已提交的写操作。
async function resumePendingWebRun() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('yunmomo.webRun') || 'null'); } catch { return; }
  if (!saved?.id || saved.userId !== state.currentUser?.id) {
    try { sessionStorage.removeItem('yunmomo.webRun'); } catch {}
    return;
  }
  if (state.activeRun) return;
  const run = { id: saved.id, scriptId: saved.scriptId, deviceId: saved.deviceId,
    stopping: false, stopConfirmed: false };
  state.activeRun = run;
  state.runningScript = saved.scriptId;
  updateStopButton();
  writeOutput('页面已恢复：正在查询 Windows 后台任务状态',
    [`运行编号：${saved.id}。只查询状态，不重新执行脚本。`], { runId: saved.id });
  while (state.activeRun === run) {
    try {
      const snapshot = await requestJson('/api/execute/status?scriptRunId=' + encodeURIComponent(saved.id));
      if (snapshot.state === 'running') {
        if (snapshot.stdout || snapshot.stderr) {
          writeOutput(`执行中：${saved.title}`, cleanScriptLines(snapshot.stdout, snapshot.stderr),
            { runId: saved.id, logFile: snapshot.logFile });
        }
      } else if (snapshot.state === 'finished') {
        const result = snapshot.result || { ok: false };
        writeOutput(result.cancelled ? `已停止：${saved.title}` : result.ok ? `执行完成：${saved.title}` : `执行失败：${saved.title}`,
          [...cleanScriptLines(result.stdout, result.stderr), ...(result.message ? [result.message] : [])],
          { runId: saved.id, logFile: result.logFile });
        if (saved.order >= 1 && saved.order <= 8) {
          setStepState(saved.deviceId, saved.order, result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed');
        }
        sessionStorage.removeItem('yunmomo.webRun');
        state.activeRun = null;
        state.runningScript = '';
        updateStopButton();
        break;
      } else {
        run.unknown = true;
        writeOutput('运行状态未知，禁止重复执行', [snapshot.message || '请核查云机实际状态及服务端日志'],
          { runId: saved.id });
        break;
      }
    } catch (error) {
      if (error.status === 401 || error.status === 403) break;
      if (error.status === 404) {
        run.unknown = true;
        writeOutput('服务端未确认此运行编号，禁止盲目重试', [saved.id], { runId: saved.id });
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
window.resumePendingWebRun = resumePendingWebRun;

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
  if (run.unknown) { showToast('任务状态未知，请先核查设备实际状态，不能盲目停止'); return; }
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

function isVpcProxyScript(script) {
  return script.id === 'flow-03' || String(script.order) === '3' || script.id.startsWith('flow-03');
}

async function executeSingleStep(script, targetId, options = {}) {
  return runScriptOnDevice(script, targetId, options);
}

async function executeBundle(bundle, targetId = null, stepOptions = null) {
  if (state.activeRun || state.activeBundleRun) { showToast('请等待当前脚本完成'); return { ok: false, message: '已有脚本在执行' }; }
  if (state.manualDeviceId) { showToast('请先关闭手动操作窗，再运行脚本'); return { ok: false, message: '手动操作中' }; }
  if (!state.tokenConfigured) { showToast('尚未连接云机平台'); return { ok: false, message: '未连接云机平台' }; }
  const deviceId = targetId || state.selectedDeviceId;
  const steps = (bundle.stepIds || []).map((id, i) => {
    const script = state.scripts.find(s => s.id === id);
    // stepOptions 为详情面板收集的最终参数（已含清空语义），未提供时回退组合保存值
    const options = Array.isArray(stepOptions) ? { ...(stepOptions[i] || {}) } : { ...(bundle.stepOptions?.[i] || {}) };
    return script ? { script, options } : null;
  }).filter(Boolean);
  if (!steps.length) { showToast('此组合未包含有效脚本步骤'); return { ok: false, message: '组合未包含有效步骤' }; }
  if (steps.some(step => step.script.requiresDevice) && !deviceId) { showToast('此组合需要操作云机，请先选择目标云机'); return { ok: false, message: '未选择目标云机' }; }

  // 含「设置 VPC 代理」的步骤统一在组合开始前补一次代理数据输入，避免执行中途被打断
  const vpcSteps = steps.filter(step => isVpcProxyScript(step.script)
    && step.options.action !== 'show' && step.options.action !== 'close' && !step.options.vpcData);
  if (vpcSteps.length) {
    const vpcData = await promptVpcProxyDialog();
    if (!vpcData) return { ok: false, cancelled: true, message: '已取消代理数据输入' };
    for (const step of vpcSteps) step.options.vpcData = vpcData;
  }

  const bundleRunState = { bundleId: bundle.id, stopped: false };
  state.activeBundleRun = bundleRunState;
  const total = steps.length;
  let ok = true;
  let cancelled = false;
  let unknown = false;
  writeOutput(`【开始执行组合脚本】: ${bundle.name}`, [
    `功能备注：${bundle.description || '无'}`,
    `目标设备：${deviceId ? deviceLabel(state.devices.find(d => d.deviceId === deviceId)) : '无需设备'}`,
    ...steps.map((step, i) => `  ${i + 1}. ${step.script.title}${describeStepOptions(step)}`)
  ]);

  try {
    for (let i = 0; i < total; i++) {
      if (bundleRunState.stopped) {
        writeOutput(`【组合脚本人为中断】: ${bundle.name}`, ['用户已主动停止组合脚本，剩余步骤已取消。']);
        showToast('组合脚本已停止');
        ok = false;
        cancelled = true;
        break;
      }
      const step = steps[i];
      const script = step.script;
      if (script.destructive) {
        const confirmed = await confirmDestructive(script, step.options, [deviceId]);
        if (!confirmed) {
          writeOutput(`【组合脚本取消】: 步骤 ${i + 1} (${script.title}) 为破坏性操作，已按确认弹窗取消。`, ['组合脚本后续步骤已终止。']);
          showToast(`步骤 ${i + 1} (${script.title}) 未确认执行，组合已停止`);
          ok = false;
          cancelled = true;
          break;
        }
        step.options.resetConfirmed = true;
      }
      writeOutput(`▶ [步骤 ${i + 1}/${total}] 启动执行: ${script.title}`, [`正在运行子脚本 ${script.id}...`]);
      const stepRes = await executeSingleStep(script, deviceId, step.options);
      if (stepRes.unknown) {
        writeOutput(`【组合脚本状态未知】: 步骤 ${i + 1} (${script.title}) 无法确认`,
          ['后续步骤已停止调度，禁止直接重新执行，请先人工核查云机实际状态。']);
        ok = false;
        unknown = true;
        break;
      }
      if (bundleRunState.stopped || stepRes.cancelled) {
        writeOutput(`【组合脚本中断】: 步骤 ${i + 1} (${script.title}) 已停止。`, ['终止后续执行。']);
        showToast(`组合脚本已在步骤 ${i + 1} 停止`);
        ok = false;
        cancelled = true;
        break;
      }
      if (!stepRes.ok) {
        writeOutput(`【组合脚本失败中断】: 步骤 ${i + 1} (${script.title}) 执行未达成`, ['组合脚本后续步骤已自动熔断中止。']);
        showToast(`步骤 ${i + 1} (${script.title}) 执行失败，组合已中断`);
        ok = false;
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
    ok = false;
  } finally {
    state.activeBundleRun = null;
    loadSharedRuntimeState();
    if (typeof requestAllPreviews === 'function') requestAllPreviews();
  }
  return { ok, cancelled, unknown };
}

function describeStepOptions(step) {
  const entries = Object.entries(step.options || {}).filter(([name]) => name !== 'vpcData');
  if (!entries.length) return '';
  const parts = entries.map(([name, value]) => {
    const field = (step.script.parameters || []).find(item => item.name === name);
    const label = field ? field.label.replace(/（.*?）/g, '') : name;
    const shown = field?.choices ? parameterChoiceLabel(field, String(value)) : String(value);
    return `${label}: ${shown}`;
  });
  return `（${parts.join('；')}）`;
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
let editingBundleStepOptions = [];

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
    editingBundleStepOptions = Array.isArray(bundle.stepOptions)
      ? bundle.stepOptions.map(item => ({ ...(item && typeof item === 'object' ? item : {}) }))
      : [];
  } else {
    byId('bundleModalTitle').textContent = '新建自定义脚本组合';
    byId('bundleEditId').value = '';
    byId('bundleNameInput').value = '';
    byId('bundleDescInput').value = '';
    byId('bundleEnabledInput').checked = true;
    editingBundleSteps = [];
    editingBundleStepOptions = [];
  }
  // 与 stepIds 保持等长，旧数据（无 stepOptions）按空参数补齐
  while (editingBundleStepOptions.length < editingBundleSteps.length) editingBundleStepOptions.push({});
  editingBundleStepOptions.length = editingBundleSteps.length;
  renderModalSelectedSteps();
  try { modal.showModal(); } catch { modal.setAttribute('open', ''); }
}

function bundleStepParamHtml(script, index) {
  const fields = script?.parameters || [];
  return fields.map(field => {
    const value = editingBundleStepOptions[index]?.[field.name] ?? field.defaultValue ?? '';
    if (field.choices) {
      return `<label class="bundle-param"><span>${escapeHtml(field.label)}</span>
        <select class="select" data-bundle-param="${index}:${escapeHtml(field.name)}">
          ${field.choices.map(choice => `<option value="${escapeHtml(choice)}" ${String(value) === String(choice) ? 'selected' : ''}>${escapeHtml(parameterChoiceLabel(field, choice))}</option>`).join('')}
        </select></label>`;
    }
    if (field.multiline) {
      return `<label class="bundle-param bundle-param-full"><span>${escapeHtml(field.label)}</span>
        <textarea class="input textarea" data-bundle-param="${index}:${escapeHtml(field.name)}" ${field.required ? 'required' : ''} ${field.maxLength ? `maxlength="${field.maxLength}"` : ''} placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(value)}</textarea></label>`;
    }
    return `<label class="bundle-param"><span>${escapeHtml(field.label)}</span>
      <input class="input" data-bundle-param="${index}:${escapeHtml(field.name)}" type="text" ${field.required ? 'required' : ''} ${field.maxLength ? `maxlength="${field.maxLength}"` : ''} placeholder="${escapeHtml(field.placeholder || '')}" value="${escapeHtml(value)}" autocomplete="off" spellcheck="false"></label>`;
  }).join('');
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
    const paramFields = bundleStepParamHtml(script, index);
    const row = document.createElement('div');
    row.className = 'bundle-step-row';
    row.innerHTML = `<div class="bundle-step-head">
        <span class="task-name"><span class="num">${index + 1}</span>${escapeHtml(script ? script.title : stepId)}</span>
        <span class="bundle-step-actions">
          <button class="btn-icon" data-step-up="${index}" type="button" ${index === 0 ? 'disabled' : ''} title="上移">▲</button>
          <button class="btn-icon" data-step-down="${index}" type="button" ${index === editingBundleSteps.length - 1 ? 'disabled' : ''} title="下移">▼</button>
          <button class="btn-icon danger" data-step-remove="${index}" type="button" title="移除">✗</button>
        </span>
      </div>
      ${paramFields ? `<div class="bundle-step-params">${paramFields}</div>` : ''}`;
    container.append(row);
  });
}

function initBundleModalEvents() {
  byId('closeBundleModalBtn')?.addEventListener('click', () => byId('scriptBundleModal')?.close());
  byId('cancelBundleBtn')?.addEventListener('click', () => byId('scriptBundleModal')?.close());
  const stepsHost = byId('bundleSelectedSteps');
  // 步骤参数输入实时回填，保证上移/下移重排后值不丢
  const syncParamInput = target => {
    const raw = target.dataset.bundleParam || '';
    const colon = raw.indexOf(':');
    const index = Number(raw.slice(0, colon));
    const name = raw.slice(colon + 1);
    if (!Number.isInteger(index) || index < 0 || !name) return;
    if (!editingBundleStepOptions[index]) editingBundleStepOptions[index] = {};
    editingBundleStepOptions[index][name] = target.value;
  };
  stepsHost?.addEventListener('input', event => {
    if (event.target.matches('[data-bundle-param]')) syncParamInput(event.target);
  });
  stepsHost?.addEventListener('change', event => {
    if (event.target.matches('[data-bundle-param]')) syncParamInput(event.target);
  });
  stepsHost?.addEventListener('click', event => {
    const up = event.target.closest('[data-step-up]');
    const down = event.target.closest('[data-step-down]');
    const remove = event.target.closest('[data-step-remove]');
    if (up) {
      const i = Number(up.dataset.stepUp);
      [editingBundleSteps[i - 1], editingBundleSteps[i]] = [editingBundleSteps[i], editingBundleSteps[i - 1]];
      [editingBundleStepOptions[i - 1], editingBundleStepOptions[i]] = [editingBundleStepOptions[i], editingBundleStepOptions[i - 1]];
      renderModalSelectedSteps();
    } else if (down) {
      const i = Number(down.dataset.stepDown);
      [editingBundleSteps[i + 1], editingBundleSteps[i]] = [editingBundleSteps[i], editingBundleSteps[i + 1]];
      [editingBundleStepOptions[i + 1], editingBundleStepOptions[i]] = [editingBundleStepOptions[i], editingBundleStepOptions[i + 1]];
      renderModalSelectedSteps();
    } else if (remove) {
      const i = Number(remove.dataset.stepRemove);
      editingBundleSteps.splice(i, 1);
      editingBundleStepOptions.splice(i, 1);
      renderModalSelectedSteps();
    }
  });
  byId('addStepToBundleBtn')?.addEventListener('click', () => {
    const select = byId('bundleAvailableScriptsSelect');
    if (select?.value) { editingBundleSteps.push(select.value); editingBundleStepOptions.push({}); renderModalSelectedSteps(); }
  });
  byId('saveBundleBtn')?.addEventListener('click', handleSaveBundleModal);
}

function syncBundleStepOptionsFromDom() {
  const container = byId('bundleSelectedSteps');
  if (!container) return;
  for (const input of container.querySelectorAll('[data-bundle-param]')) {
    const raw = input.dataset.bundleParam || '';
    const colon = raw.indexOf(':');
    const index = Number(raw.slice(0, colon));
    const name = raw.slice(colon + 1);
    if (!Number.isInteger(index) || index < 0 || !name) continue;
    if (!editingBundleStepOptions[index]) editingBundleStepOptions[index] = {};
    editingBundleStepOptions[index][name] = input.value;
  }
}

function normalizeBundleStepOptions() {
  return editingBundleStepOptions.map((options, index) => {
    const script = state.scripts.find(s => s.id === editingBundleSteps[index]);
    const allowed = new Set((script?.parameters || []).map(field => field.name));
    const clean = {};
    for (const [name, value] of Object.entries(options || {})) {
      if (!allowed.has(name)) continue;
      const text = String(value ?? '').trim();
      if (text) clean[name] = text;
    }
    for (const field of (script?.parameters || [])) {
      if (field.required && !clean[field.name]) {
        throw new Error(`步骤 ${index + 1}（${script.title}）的「${field.label}」为必填项`);
      }
    }
    return clean;
  });
}

async function handleSaveBundleModal() {
  const editId = byId('bundleEditId')?.value || '';
  const name = byId('bundleNameInput')?.value?.trim();
  if (!name) { showToast('请输入组合脚本名称'); return; }
  if (!editingBundleSteps.length) { showToast('请至少添加一个执行步骤'); return; }
  // 保存前以 DOM 实际值为准再收集一次，避免输入事件丢失（自动填充、清空等场景）
  syncBundleStepOptionsFromDom();
  let stepOptions;
  try {
    stepOptions = normalizeBundleStepOptions();
  } catch (err) {
    showToast(err.message);
    return;
  }
  try {
    const res = await requestJson('/api/admin/scripts/bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: editId || undefined,
        name,
        description: byId('bundleDescInput')?.value?.trim() || '',
        enabled: byId('bundleEnabledInput')?.checked !== false,
        stepIds: editingBundleSteps,
        stepOptions
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
      renderOverviewTasks();
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

/* ---------- 总览页业务任务控制中心 ---------- */

let ovTaskFilter = 'all'; // 'all' | 'momo' | 'bundle'

function isScriptVisibleForOverview(script) {
  if (!script) return false;
  // 过滤内置批处理/全流程脚本（flow-all-v2 / flow-all），保持与任务列表完全一致
  if (script.batch || script.id.startsWith('flow-all')) return false;
  // 单个脚本显隐开关：关了就不在总览显示
  if (!scriptVisible(script)) return false;
  // 所属分组显隐开关：所属组关了也不在总览显示
  const groupKey = script.category || (script.id.endsWith('-v2') ? 'v2' : script.id.endsWith('-v3') ? 'v3' : 'momo');
  if (groupKey && !groupVisible(groupKey)) return false;
  return true;
}

function isBundleVisibleForOverview(bundle) {
  if (!bundle) return false;
  // 组合脚本分组总开关
  if (!groupVisible('custom')) return false;
  // 组合自身的启用开关
  if (bundle.enabled === false) return false;
  return true;
}

function getOverviewFilteredTasks() {
  const visibleScripts = state.scripts.filter(isScriptVisibleForOverview);
  const visibleBundles = (state.bundles || []).filter(isBundleVisibleForOverview);

  if (ovTaskFilter === 'momo') {
    return {
      scripts: visibleScripts.filter(s => s.category === 'momo' || s.category === 'v2'),
      bundles: []
    };
  }
  if (ovTaskFilter === 'bundle') {
    return { scripts: [], bundles: visibleBundles };
  }
  return {
    scripts: visibleScripts,
    bundles: visibleBundles
  };
}

function renderOverviewTasks() {
  const listEl = byId('ovTaskList');
  const configEl = byId('ovTaskConfig');
  const runningBadge = byId('ovRunningBadge');
  if (!listEl) return;

  const currentDev = currentDevice();
  const currentDevRunning = currentDev ? deviceRunning(currentDev.deviceId) : false;
  const isRunning = state.batchRunning || Boolean(state.activeRun) || Boolean(state.activeBundleRun) || currentDevRunning;
  if (runningBadge) runningBadge.hidden = !isRunning;

  const { scripts, bundles } = getOverviewFilteredTasks();
  if (!scripts.length && !bundles.length) {
    state.taskScriptId = '';
    state.taskBundleId = '';
    listEl.innerHTML = '<div class="empty">暂无可用业务任务</div>';
    if (configEl) configEl.innerHTML = '<div class="empty">暂无可用任务</div>';
    return;
  }

  // 校验当前选中的任务是否依然在可见列表中；如果被关闭隐藏了，自动切换到第一个可用任务
  const isCurrentScriptVisible = state.taskScriptId && scripts.some(s => s.id === state.taskScriptId);
  const isCurrentBundleVisible = state.taskBundleId && bundles.some(b => b.id === state.taskBundleId);

  let forceRebuild = false;
  if (!isCurrentScriptVisible && !isCurrentBundleVisible) {
    if (scripts.length) {
      state.taskScriptId = scripts[0].id;
      state.taskBundleId = '';
    } else if (bundles.length) {
      state.taskBundleId = bundles[0].id;
      state.taskScriptId = '';
    }
    forceRebuild = true;
  }

  // 渲染任务列表
  const scriptItems = scripts.map(s => {
    const active = state.taskScriptId === s.id ? 'active' : '';
    const scriptRunning = state.activeRun?.scriptId === s.id;
    return `
      <div class="ov-task-card ${active} ${scriptRunning ? 'running' : ''}" data-ov-card="script:${escapeHtml(s.id)}" title="${escapeHtml(s.description || s.title)}">
        <div class="ov-task-card-left">
          <span class="ov-task-icon">${ic('tasks', 14)}</span>
          <span class="ov-task-title">${escapeHtml(scriptTitle(s))}</span>
          ${s.batch ? '<span class="badge ghost">全流程</span>' : ''}
          ${scriptRunning ? '<span class="badge run xs">执行中</span>' : ''}
        </div>
        <div class="ov-task-card-actions">
          <button class="btn xs flat" data-ov-select="script:${escapeHtml(s.id)}" type="button" title="展开配置参数">配置</button>
          ${scriptRunning
            ? `<button class="btn xs danger" data-ov-stop type="button" title="停止执行">${ic('stop', 12)} 停止</button>`
            : `<button class="btn xs primary" data-ov-run-direct="script:${escapeHtml(s.id)}" type="button" title="立即执行此任务">${ic('play', 12)} 执行</button>`
          }
        </div>
      </div>
    `;
  }).join('');

  const bundleItems = bundles.map(b => {
    const active = state.taskBundleId === b.id ? 'active' : '';
    const bRunning = state.activeBundleRun?.bundleId === b.id;
    return `
      <div class="ov-task-card ${active} ${bRunning ? 'running' : ''}" data-ov-card="bundle:${escapeHtml(b.id)}" title="${escapeHtml(b.description || b.name)}">
        <div class="ov-task-card-left">
          <span class="ov-task-icon">${ic('phoneDevice', 14)}</span>
          <span class="ov-task-title">${escapeHtml(b.name)}</span>
          <span class="badge ghost">${b.stepIds?.length || 0}步组合</span>
          ${bRunning ? '<span class="badge run xs">执行中</span>' : ''}
        </div>
        <div class="ov-task-card-actions">
          <button class="btn xs flat" data-ov-select="bundle:${escapeHtml(b.id)}" type="button" title="展开配置参数">配置</button>
          ${bRunning
            ? `<button class="btn xs danger" data-ov-stop type="button" title="停止组合执行">${ic('stop', 12)} 停止</button>`
            : `<button class="btn xs primary" data-ov-run-direct="bundle:${escapeHtml(b.id)}" type="button" title="立即执行此组合">${ic('play', 12)} 执行</button>`
          }
        </div>
      </div>
    `;
  }).join('');

  listEl.innerHTML = scriptItems + bundleItems;

  // 渲染底部快速配置与主执行条
  renderOverviewTaskConfig(configEl, currentDev, isRunning, forceRebuild);
}

function updateOverviewWorkbenchFooter(currentDev, isRunning) {
  const container = byId('ovTaskConfig');
  if (!container) return;

  const devLabel = currentDev ? `${deviceIndexLabel(currentDev)} ${currentDev.name}` : '未选择云机';
  const targetStrong = container.querySelector('.ov-wb-target strong');
  if (targetStrong && targetStrong.textContent !== devLabel) {
    targetStrong.textContent = devLabel;
  }

  const footer = container.querySelector('.ov-wb-footer');
  if (!footer) return;

  const isBundle = Boolean(state.taskBundleId);
  const canStop = Boolean(state.batchRunning || state.activeRun || state.activeBundleRun);
  if (canStop) {
    if (!footer.querySelector('#ovCfgStopBtn')) {
      footer.innerHTML = `<button class="btn danger ov-wb-btn-run" id="ovCfgStopBtn" type="button">${ic('stop', 15)} 停止执行</button>`;
    }
  } else {
    const runBtn = footer.querySelector('#ovCfgRunBtn');
    if (!runBtn) {
      footer.innerHTML = `<button class="btn primary ov-wb-btn-run" id="ovCfgRunBtn" type="button" ${!currentDev || isRunning ? 'disabled' : ''}>${ic('play', 15)} 立即在 ${escapeHtml(currentDev ? deviceIndexLabel(currentDev) : '当前云机')} 执行${isBundle ? '组合' : ''}</button>`;
    } else {
      runBtn.disabled = !currentDev || isRunning;
      const expectedText = `${ic('play', 15)} 立即在 ${escapeHtml(currentDev ? deviceIndexLabel(currentDev) : '当前云机')} 执行${isBundle ? '组合' : ''}`;
      if (runBtn.innerHTML !== expectedText) {
        runBtn.innerHTML = expectedText;
      }
    }
  }
}

function renderOverviewTaskConfig(container, currentDev, isRunning, forceRebuild = false) {
  if (!container) return;
  const currentTaskId = state.taskScriptId ? ('script:' + state.taskScriptId) : (state.taskBundleId ? ('bundle:' + state.taskBundleId) : '');

  // 缓存守护：同一个任务已渲染时，只就地更新底部按钮和目标云机，绝对不重建输入框 DOM（保护输入焦点）
  if (!forceRebuild && container.dataset.renderedTask === currentTaskId && currentTaskId) {
    updateOverviewWorkbenchFooter(currentDev, isRunning);
    return;
  }

  container.dataset.renderedTask = currentTaskId;
  const devLabel = currentDev ? `${deviceIndexLabel(currentDev)} ${currentDev.name}` : '未选择云机';
  const devId = currentDev ? currentDev.deviceId : '';
  const canStop = Boolean(state.batchRunning || state.activeRun || state.activeBundleRun);

  if (state.taskScriptId) {
    const script = state.scripts.find(s => s.id === state.taskScriptId);
    if (!script) { container.innerHTML = '<div class="empty">请选择左侧任务</div>'; return; }
    const params = (script.parameters || []).filter(f => !f.adminOnly);

    const fieldsHtml = params.map(field => {
      const key = script.id + ':' + field.name;
      const value = state.taskParamValues[key] ?? field.defaultValue ?? '';
      if (field.choices) {
        return `
          <div class="ov-wb-field">
            <label>${escapeHtml(field.label || field.name)}</label>
            <select class="select" data-ov-param="${escapeHtml(field.name)}">
              ${field.choices.map(c => `<option value="${escapeHtml(c)}" ${String(value) === String(c) ? 'selected' : ''}>${escapeHtml(parameterChoiceLabel(field, c))}</option>`).join('')}
            </select>
            ${field.description ? `<span class="hint" style="font-size:11px;">${escapeHtml(field.description)}</span>` : ''}
          </div>
        `;
      }
      return `
        <div class="ov-wb-field">
          <label>${escapeHtml(field.label || field.name)}</label>
          <input class="input" data-ov-param="${escapeHtml(field.name)}" type="text" value="${escapeHtml(value)}" placeholder="${escapeHtml(field.placeholder || '')}">
          ${field.description ? `<span class="hint" style="font-size:11px;">${escapeHtml(field.description)}</span>` : ''}
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="ov-wb-header">
        <div class="ov-wb-title-box">
          <span class="ov-wb-title">${escapeHtml(scriptTitle(script))}</span>
          <span class="badge ${script.batch ? 'run' : 'ghost'} xs">${script.batch ? '全流程' : '业务任务'}</span>
        </div>
        <div class="ov-wb-target">
          <span class="hint">目标：</span><strong>${escapeHtml(devLabel)}</strong>
        </div>
      </div>
      ${script.description ? `<div class="ov-wb-desc">${escapeHtml(script.description)}</div>` : ''}
      <div class="ov-wb-fields">
        ${fieldsHtml || `
          <div class="ov-wb-empty-fields">
            <span class="ov-wb-empty-icon">${ic('check', 16)}</span>
            <span>该任务无需额外配置参数，就绪后可直接执行。</span>
          </div>
        `}
      </div>
      <div class="ov-wb-footer">
        ${canStop
          ? `<button class="btn danger ov-wb-btn-run" id="ovCfgStopBtn" type="button">${ic('stop', 15)} 停止执行</button>`
          : `<button class="btn primary ov-wb-btn-run" id="ovCfgRunBtn" type="button" ${!currentDev || isRunning ? 'disabled' : ''}>${ic('play', 15)} 立即在 ${escapeHtml(currentDev ? deviceIndexLabel(currentDev) : '当前云机')} 执行</button>`
        }
      </div>
    `;
    return;
  }

  if (state.taskBundleId) {
    const bundle = state.bundles?.find(b => b.id === state.taskBundleId);
    if (!bundle) { container.innerHTML = '<div class="empty">请选择左侧任务</div>'; return; }
    const steps = bundleSteps(bundle);
    const stepsHtml = steps.map((s, idx) => `
      <li>${idx + 1}. <strong>${escapeHtml(scriptTitle(s))}</strong> <span class="hint">(${escapeHtml(s.id)})</span></li>
    `).join('');

    container.innerHTML = `
      <div class="ov-wb-header">
        <div class="ov-wb-title-box">
          <span class="ov-wb-title">${escapeHtml(bundle.name)}</span>
          <span class="badge run xs">组合流程</span>
        </div>
        <div class="ov-wb-target">
          <span class="hint">目标：</span><strong>${escapeHtml(devLabel)}</strong>
        </div>
      </div>
      ${bundle.description ? `<div class="ov-wb-desc">${escapeHtml(bundle.description)}</div>` : ''}
      <div class="ov-wb-fields">
        <div class="ov-wb-steps-box">
          <div class="hint" style="font-weight:600; margin-bottom:8px;">包含步骤清单 (${steps.length} 步)：</div>
          <ol class="ov-wb-step-list">
            ${stepsHtml || '<li class="hint">暂无配置步骤</li>'}
          </ol>
        </div>
      </div>
      <div class="ov-wb-footer">
        ${canStop
          ? `<button class="btn danger ov-wb-btn-run" id="ovCfgStopBtn" type="button">${ic('stop', 15)} 停止组合执行</button>`
          : `<button class="btn primary ov-wb-btn-run" id="ovCfgRunBtn" type="button" ${!currentDev || isRunning ? 'disabled' : ''}>${ic('play', 15)} 立即在 ${escapeHtml(currentDev ? deviceIndexLabel(currentDev) : '当前云机')} 执行组合</button>`
        }
      </div>
    `;
    return;
  }

  container.innerHTML = '<div class="empty">选择左侧任务查看配置</div>';
}

function updateOverviewRuntime() {
  const currentDev = currentDevice();
  const currentDevRunning = currentDev ? deviceRunning(currentDev.deviceId) : false;
  const isRunning = state.batchRunning || Boolean(state.activeRun) || Boolean(state.activeBundleRun) || currentDevRunning;

  const runningBadge = byId('ovRunningBadge');
  if (runningBadge) runningBadge.hidden = !isRunning;

  // 就地更新左侧卡片类名与操作按钮，不重绘整个列表
  const listEl = byId('ovTaskList');
  if (listEl) {
    for (const card of listEl.querySelectorAll('.ov-task-card')) {
      const raw = card.dataset.ovCard;
      if (!raw) continue;
      const [type, id] = raw.split(':');
      let running = false;
      if (type === 'script') {
        running = state.activeRun?.scriptId === id;
      } else if (type === 'bundle') {
        running = state.activeBundleRun?.bundleId === id;
      }
      card.classList.toggle('running', running);
      const actionBox = card.querySelector('.ov-task-card-actions');
      if (actionBox) {
        const hasStop = Boolean(actionBox.querySelector('[data-ov-stop]'));
        if (running && !hasStop) {
          actionBox.innerHTML = `
            <button class="btn xs flat" data-ov-select="${escapeHtml(raw)}" type="button" title="查看配置参数">配置</button>
            <button class="btn xs danger" data-ov-stop type="button" title="停止执行">${ic('stop', 12)} 停止</button>
          `;
        } else if (!running && hasStop) {
          actionBox.innerHTML = `
            <button class="btn xs flat" data-ov-select="${escapeHtml(raw)}" type="button" title="查看配置参数">配置</button>
            <button class="btn xs primary" data-ov-run-direct="${escapeHtml(raw)}" type="button" title="立即执行">${ic('play', 12)} 执行</button>
          `;
        }
      }
    }
  }

  // 就地更新右侧工作台按钮状态，绝不触碰正在输入的输入框表单
  updateOverviewWorkbenchFooter(currentDev, isRunning);
}

function renderQuickTasks() {
  renderOverviewTasks();
}
window.renderQuickTasks = renderQuickTasks;
window.renderOverviewTasks = renderOverviewTasks;

// 总览页过滤与操作监听
byId('ovTaskFilter')?.addEventListener('click', event => {
  const seg = event.target.closest('[data-ov-filter]');
  if (!seg) return;
  ovTaskFilter = seg.dataset.ovFilter;
  for (const b of byId('ovTaskFilter').querySelectorAll('.segment')) {
    b.classList.toggle('active', b === seg);
  }
  renderOverviewTasks();
});

byId('overviewTaskPanel')?.addEventListener('click', async event => {
  const stopBtn = event.target.closest('[data-ov-stop], #ovCfgStopBtn');
  if (stopBtn) {
    stopTaskBatch();
    return;
  }

  const runDirect = event.target.closest('[data-ov-run-direct]');
  if (runDirect) {
    const [type, id] = runDirect.dataset.ovRunDirect.split(':');
    const dev = currentDevice();
    if (!dev) { showToast('请先选择目标云机'); return; }
    if (type === 'script') {
      const script = state.scripts.find(s => s.id === id);
      if (script) await runScriptDirect(script, dev.deviceId);
    } else if (type === 'bundle') {
      const bundle = state.bundles.find(b => b.id === id);
      if (bundle) await executeBundle(bundle, dev.deviceId);
    }
    updateOverviewRuntime();
    return;
  }

  const select = event.target.closest('[data-ov-select], [data-ov-card]');
  if (select) {
    const raw = select.dataset.ovSelect || select.dataset.ovCard;
    const [type, id] = raw.split(':');
    const changed = (type === 'script' && state.taskScriptId !== id) || (type === 'bundle' && state.taskBundleId !== id);
    if (type === 'script') {
      state.taskScriptId = id;
      state.taskBundleId = '';
    } else {
      state.taskBundleId = id;
      state.taskScriptId = '';
    }
    // 切换卡片高亮选中态
    const listEl = byId('ovTaskList');
    if (listEl) {
      for (const card of listEl.querySelectorAll('.ov-task-card')) {
        card.classList.toggle('active', card.dataset.ovCard === raw);
      }
    }
    // 若任务变化，重新渲染右侧工作台；若点击当前已选中的任务，则保持焦点不动
    if (changed) {
      const configEl = byId('ovTaskConfig');
      const currentDev = currentDevice();
      const currentDevRunning = currentDev ? deviceRunning(currentDev.deviceId) : false;
      const isRunning = state.batchRunning || Boolean(state.activeRun) || Boolean(state.activeBundleRun) || currentDevRunning;
      renderOverviewTaskConfig(configEl, currentDev, isRunning, true);
    }
    return;
  }

  const cfgRun = event.target.closest('#ovCfgRunBtn');
  if (cfgRun) {
    const dev = currentDevice();
    if (!dev) { showToast('请先选择目标云机'); return; }
    if (state.taskScriptId) {
      const script = state.scripts.find(s => s.id === state.taskScriptId);
      if (script) await runScriptDirect(script, dev.deviceId);
    } else if (state.taskBundleId) {
      const bundle = state.bundles.find(b => b.id === state.taskBundleId);
      if (bundle) await executeBundle(bundle, dev.deviceId);
    }
    updateOverviewRuntime();
  }
});

function onOvParamChange(event) {
  const input = event.target.closest('[data-ov-param]');
  if (input && state.taskScriptId) {
    state.taskParamValues[state.taskScriptId + ':' + input.dataset.ovParam] = input.value;
  }
}

byId('overviewTaskPanel')?.addEventListener('input', onOvParamChange);
byId('overviewTaskPanel')?.addEventListener('change', onOvParamChange);

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
  if (event.detail.page === 'overview') renderOverviewTasks();
});

eventBus.addEventListener('scripts:changed', () => {
  if (state.page === 'tasks') renderTasksPage();
  if (state.page === 'overview') renderOverviewTasks();
});

eventBus.addEventListener('device:selected', () => {
  if (state.page === 'tasks') renderTaskDetail();
  if (state.page === 'overview') updateOverviewRuntime();
});

eventBus.addEventListener('runtime:changed', () => {
  if (state.page === 'tasks') updateTaskRuntime();
  if (state.page === 'overview') updateOverviewRuntime();
});

eventBus.addEventListener('batch:devices', () => {
  updateBatchCount();
});

byId('taskHeadActions')?.addEventListener?.('change', () => {});
