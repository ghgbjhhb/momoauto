'use strict';

// Script 8: 输入法初始化。
// 打开搜狗输入法，进入系统输入法设置，确保搜狗和讯飞输入法已启用，
// 再回到搜狗输入法，通过“切换”选择讯飞输入法；如果遇到首次启动协议，
// 点击“同意并继续”后立即结束，不处理后续页面。不主动返回桌面；失败时按现有约定恢复到桌面。
const fs = require('node:fs/promises');
const { YunmomoClient } = require('../../index');
const { openAppWithRecovery, recoverAppPage } = require('../../automation/app-navigation');
const {
  numberOr,
  sleep,
  deviceIdOf,
  findPhrase,
  findStrictPhrase,
  homeAnchorMatches,
  normalizeText,
  RapidOcrWorker,
  screenshotAndOcr,
  observeUntil,
  confirmHome,
  findApp,
  tapBox,
  sendHome,
} = require('../../automation/screen');

const DEFAULT_DEVICE_ID = '2033060279606353921';
const DEFAULT_POLL_MS = 700;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_APP_TIMEOUT_MS = 20000;
const DEFAULT_SETTINGS_TIMEOUT_MS = 25000;
const DEFAULT_TOGGLE_TIMEOUT_MS = 15000;
const DEFAULT_PICKER_TIMEOUT_MS = 15000;
const DEFAULT_MAX_PAGES_PER_DIRECTION = 5;
const DEFAULT_MAX_SETTINGS_SWIPES = 4;
const DEFAULT_PROMPT_SETTLE_MS = 900;
const DEFAULT_APP_VISIBLE_MS = 1000;

const SOGOU_ALIASES = ['搜狗输入法', '搜狗输', '搜狗'];
const IFly_ALIASES = ['讯飞输入法', '讯飞输入', '讯飞输', '讯飞', '飞输入'];

function exactBox(items, labels) {
  const wanted = labels.map(normalizeText);
  return items
    .filter(item => wanted.includes(normalizeText(item.text)))
    .sort((left, right) => right.centerY - left.centerY || left.left - right.left)[0] || null;
}

function phraseBox(items, phrases) {
  for (const phrase of phrases) {
    const strict = findStrictPhrase(items, phrase);
    if (strict) return strict;
    const fuzzy = findPhrase(items, phrase);
    if (fuzzy) return fuzzy;
  }
  return null;
}

function sogouTargetBox(items) {
  return phraseBox(items, SOGOU_ALIASES);
}

function namedInputMethodBox(items, aliases) {
  const wanted = aliases.map(normalizeText);
  // 系统列表的真实行在上方；底部搜狗引导图也重复显示同名文字。
  return items
    .filter(item => wanted.includes(normalizeText(item.text)))
    .sort((left, right) => left.centerY - right.centerY)[0] || phraseBox(items, aliases);
}

function inputMethodListReady(items) {
  const sogou = namedInputMethodBox(items, SOGOU_ALIASES);
  const ifly = namedInputMethodBox(items, IFly_ALIASES);
  // The 搜狗 app itself also contains its own name. Require either the
  // settings root/list context or the second keyboard name so the app title
  // cannot be mistaken for an Android keyboard row.
  return Boolean(
    ifly ||
    (sogou && inputSettingsRoot(items))
  );
}

function inputSettingsRoot(items) {
  return Boolean(
    findPhrase(items, '语言和输入法') ||
    findPhrase(items, '语言与输入法') ||
    findPhrase(items, '虚拟键盘') ||
    findPhrase(items, '屏幕键盘') ||
    findPhrase(items, '可用虚拟键盘')
  );
}

function inputSettingsEvidence(items) {
  return inputSettingsRoot(items) || inputMethodListReady(items);
}

function sogouAppReady(items) {
  const controls = Boolean(switchButtonBox(items) || enableButtonBox(items));
  const sogou = Boolean(phraseBox(items, SOGOU_ALIASES));
  return sogou && controls && !inputSettingsEvidence(items) && !pickerVisible(items);
}

function sogouLaunchEvidence(items) {
  const homeLike = homeAnchorMatches(items).length >= 2;
  return Boolean(
    !homeLike && !pickerVisible(items) && (
      sogouAppReady(items) ||
      sogouAgreementVisible(items) ||
      inputSettingsEvidence(items) ||
      sogouNotificationPermissionButtonBox(items)
    )
  );
}

function enableButtonBox(items) {
  return (
    exactBox(items, ['启用搜狗输入法', '启用搜狗', '启用输入法', '启用']) ||
    findStrictPhrase(items, '启用搜狗输入法') ||
    findStrictPhrase(items, '启用搜狗') ||
    findStrictPhrase(items, '启用输入法')
  );
}

function switchButtonBox(items) {
  return (
    exactBox(items, ['切换到搜狗输入法', '切换到讯飞输入法', '切换输入法', '切换']) ||
    findStrictPhrase(items, '切换到搜狗输入法') ||
    findStrictPhrase(items, '切换到讯飞输入法') ||
    findStrictPhrase(items, '切换输入法') ||
    findStrictPhrase(items, '切换')
  );
}

function virtualKeyboardEntryBox(items) {
  return phraseBox(items, ['虚拟键盘', '屏幕键盘', '可用虚拟键盘']);
}

function inputMethodWarning(items) {
  return Boolean(
    findPhrase(items, '注意') ||
    findPhrase(items, '警告') ||
    findPhrase(items, '第三方输入法') ||
    (findPhrase(items, '输入法') && (findPhrase(items, '安全') || findPhrase(items, '允许')))
  );
}

function settingsConfirmBox(observation) {
  const items = observation?.items || [];
  if (!inputMethodWarning(items)) return null;
  const height = Number(observation?.height) || 640;
  const positive = exactBox(items, ['确定', '允许', '同意', '继续', '开启']);
  if (!positive) return null;
  if (positive.centerY >= height * 0.38 || ['确定', '允许', '同意'].includes(normalizeText(positive.text))) {
    return positive;
  }
  return null;
}

function pickerVisible(items) {
  const hasIfly = IFly_ALIASES.some(alias => findPhrase(items, alias));
  return Boolean(
    findPhrase(items, '选择输入法') ||
    findPhrase(items, '选择键盘') ||
    findPhrase(items, '使用以下输入法') ||
    (!inputSettingsRoot(items) &&
      findPhrase(items, 'gmime') &&
      findPhrase(items, '搜狗输入法') &&
      hasIfly) ||
    (findPhrase(items, '搜狗输入法') && hasIfly && findPhrase(items, '切换'))
  );
}

function pickerOptionBox(items) {
  return phraseBox(items, IFly_ALIASES);
}

function pickerSogouOptionBox(items) {
  const exact = items
    .filter(item => normalizeText(item.text) === '搜狗输入法')
    .sort((left, right) => right.centerY - left.centerY || left.left - right.left);
  if (exact.length) return exact[0];

  const candidates = items
    .filter(item => {
      const text = normalizeText(item.text);
      return text.includes('搜狗') && text.includes('输入法') && !text.includes('请选择');
    })
    .sort((left, right) => right.centerY - left.centerY || left.left - right.left);
  return candidates[0] || null;
}

function sogouAgreementButtonBox(items) {
  return (
    exactBox(items, ['同意并继续']) ||
    findStrictPhrase(items, '同意并继续')
  );
}

function sogouAgreementVisible(items) {
  // “同意并继续”是首启协议页独有的操作目标；标题 OCR 偶尔会被状态栏或
  // 长文本截断，因此不把标题作为硬性条件。
  return Boolean(sogouAgreementButtonBox(items));
}

function sogouNotificationPermissionButtonBox(items) {
  if (!findPhrase(items, '搜狗') || !findPhrase(items, '通知')) return null;
  // 使用完整按钮文字，避免把“不允许”误认为“允许”。
  return exactBox(items, ['允许']);
}

function sameRow(left, right) {
  const leftHeight = Math.max(1, left.bottom - left.top);
  const rightHeight = Math.max(1, right.bottom - right.top);
  return Math.abs(left.centerY - right.centerY) <= Math.max(18, Math.max(leftHeight, rightHeight) * 1.8);
}

function inputMethodState(observation, labelBox) {
  if (!observation || !labelBox) return 'unknown';
  const visual = inputMethodSwitch(observation, labelBox);
  if (visual && visual.state !== 'unknown') return visual.state;
  const rowItems = observation.items
    .filter(item => sameRow(item, labelBox) && item.left >= labelBox.right - 12)
    .map(item => normalizeText(item.text));
  const off = ['关闭', '未开启', '未启用', '禁用', '关', 'OFF'];
  const on = ['开启', '已开启', '启用', '已启用', '开', 'ON'];
  if (rowItems.some(text => off.includes(text))) return 'off';
  if (rowItems.some(text => on.includes(text))) return 'on';
  return 'unknown';
}

function inputMethodSwitch(observation, labelBox) {
  return (observation.keyboardSwitches || []).find(toggle =>
    normalizeText(toggle.text) === normalizeText(labelBox.text) &&
    Math.abs(toggle.centerY - labelBox.centerY) <= Math.max(12, labelBox.bottom - labelBox.top),
  ) || null;
}

function togglePoint(control, observation, labelBox) {
  const visual = inputMethodSwitch(observation, labelBox);
  if (visual) {
    return {
      x: Math.round(visual.centerX * control.screenWidth / observation.width),
      y: Math.round(visual.centerY * control.screenHeight / observation.height),
    };
  }
  const height = Math.max(1, Number(observation.height) || control.screenHeight);
  return {
    x: Math.round(control.screenWidth * 0.89),
    y: Math.round(((labelBox.top + labelBox.bottom) / 2) * control.screenHeight / height),
  };
}

async function capture(phone, worker, directory, state, label) {
  state.counter += 1;
  const observation = await screenshotAndOcr(phone, worker, directory, state.counter);
  observation.label = label;
  return observation;
}

async function chooseSogouFromPicker(phone, control, worker, directory, state, picker, options) {
  const option = pickerSogouOptionBox(picker.items);
  if (!option) throw new Error('输入法选择框中未识别到“搜狗输入法”选项');
  const optionPoint = tapBox(control, option, picker);
  await control.tap(optionPoint.x, optionPoint.y);
  await control.flush();
  await sleep(options.promptSettleMs);
  return observeUntil(
    phone,
    worker,
    directory,
    state,
    observation =>
      sogouLaunchEvidence(observation.items) ||
      sogouAgreementVisible(observation.items) ||
      homeAnchorMatches(observation.items).length >= 2,
    options.appTimeoutMs,
    options.pollMs,
    'sogou-picker-selected',
  );
}

async function acceptSogouAgreement(phone, control, worker, directory, state, page, options) {
  const button = sogouAgreementButtonBox(page.items);
  if (!button) throw new Error('搜狗首次启动页面未识别到“同意并继续”按钮');
  const point = tapBox(control, button, page);
  await control.tap(point.x, point.y);
  await control.flush();
  await sleep(options.promptSettleMs);
  const after = await capture(phone, worker, directory, state, 'sogou-agreement-accepted');
  return {
    agreementPoint: point,
    afterText: after.text.slice(0, 700),
  };
}

async function settleSogouStartup(phone, control, worker, directory, state, page, options) {
  let current = page;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const permission = sogouNotificationPermissionButtonBox(current.items);
    if (permission) {
      const point = tapBox(control, permission, current);
      await control.tap(point.x, point.y);
      await control.flush();
      state.startupPromptActions ??= [];
      state.startupPromptActions.push('允许搜狗发送通知');
      await sleep(options.promptSettleMs);
      current = await observeUntil(
        phone, worker, directory, state,
        observation => sogouLaunchEvidence(observation.items) || pickerVisible(observation.items),
        options.appTimeoutMs, options.pollMs, 'sogou-notification-allowed',
      );
      continue;
    }
    if (pickerVisible(current.items)) {
      current = await chooseSogouFromPicker(phone, control, worker, directory, state, current, options);
      continue;
    }
    return current;
  }
  throw new Error('搜狗首启弹窗处理后仍未进入软件界面：' + current.text.slice(0, 700));
}

async function openSogou(phone, control, worker, directory, state, found, options) {
  return openAppWithRecovery(phone, control, worker, directory, state, found, options, {
    appName: '搜狗输入法', targetName: '启用/切换入口或首启协议页', label: 'sogou', targetBox: sogouTargetBox,
    isTarget: observation => sogouAppReady(observation.items) || sogouAgreementVisible(observation.items),
    launchEvidence: observation => sogouLaunchEvidence(observation.items) || pickerVisible(observation.items),
    prepare: observation => settleSogouStartup(phone, control, worker, directory, state, observation, options),
    launchTimeoutMs: Math.min(options.appTimeoutMs, options.openAttemptTimeoutMs),
  });
}

async function waitForInputSettings(phone, control, worker, directory, state, options, initial) {
  let page = initial;
  const deadline = Date.now() + options.settingsTimeoutMs;
  while (Date.now() <= deadline) {
    const warning = settingsConfirmBox(page);
    if (warning) {
      const point = tapBox(control, warning, page);
      await control.tap(point.x, point.y);
      await control.flush();
      await sleep(options.promptSettleMs);
      page = await capture(phone, worker, directory, state, 'input-method-warning-confirmed');
      continue;
    }
    if (inputSettingsEvidence(page.items)) return page;
    await sleep(options.pollMs);
    page = await capture(phone, worker, directory, state, 'input-method-settings-wait');
  }
  throw new Error('点击“启用”后未进入系统输入法设置：' + (page?.text?.slice(0, 800) || '无 OCR 结果'));
}

async function enterInputMethodList(phone, control, worker, directory, state, page, options) {
  let current = page;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (inputMethodListReady(current.items)) return current;
    const entry = virtualKeyboardEntryBox(current.items);
    if (!entry) break;
    const point = tapBox(control, entry, current);
    await control.tap(point.x, point.y);
    await control.flush();
    current = await observeUntil(
      phone,
      worker,
      directory,
      state,
      observation => inputMethodListReady(observation.items) || inputMethodWarning(observation.items),
      options.settingsTimeoutMs,
      options.pollMs,
      `input-method-list-${attempt + 1}`,
    );
    const warning = settingsConfirmBox(current);
    if (warning) {
      const warningPoint = tapBox(control, warning, current);
      await control.tap(warningPoint.x, warningPoint.y);
      await control.flush();
      await sleep(options.promptSettleMs);
      current = await capture(phone, worker, directory, state, 'input-method-list-warning-confirmed');
    }
  }
  if (!inputMethodListReady(current.items)) {
    throw new Error('系统输入法设置已打开，但未识别到搜狗或讯飞输入法列表');
  }
  return current;
}

async function findInputMethodRow(phone, control, worker, directory, state, initial, aliases, options) {
  let page = initial;
  for (let swipe = 0; swipe <= options.maxSettingsSwipes; swipe += 1) {
    const box = namedInputMethodBox(page.items, aliases);
    if (box) return { page, box, swipes: swipe };
    if (swipe === options.maxSettingsSwipes) break;
    await control.swipe(
      { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.78) },
      { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.32) },
      { durationMs: 450, steps: 10 },
    );
    await control.flush();
    page = await observeUntil(
      phone,
      worker,
      directory,
      state,
      observation => inputSettingsEvidence(observation.items),
      options.settingsTimeoutMs,
      options.pollMs,
      `input-method-scroll-${swipe + 1}`,
    );
  }
  throw new Error('系统输入法列表中未识别到目标：' + aliases[0]);
}

async function enableOneInputMethod(phone, control, worker, directory, state, initial, aliases, options) {
  let located = await findInputMethodRow(phone, control, worker, directory, state, initial, aliases, options);
  let page = located.page;
  let row = located.box;
  const before = inputMethodState(page, row);
  if (before === 'on') return { page, state: before, changed: false, assumedOff: false, promptActions: [] };
  if (before === 'unknown' && !options.toggleUnknown) {
    throw new Error(`未识别到“${aliases[0]}”开关当前状态，已停止以避免误切换`);
  }

  const promptActions = [];
  let toggleAttempts = 0;
  let unknownObservations = 0;
  let offObservations = 0;
  const deadline = Date.now() + options.toggleTimeoutMs;
  while (Date.now() <= deadline) {
    const point = togglePoint(control, page, row);
    const stateBeforeTap = inputMethodState(page, row);
    if (toggleAttempts === 0 || (stateBeforeTap === 'off' && offObservations >= 2 && toggleAttempts < 2)) {
      await control.tap(point.x, point.y);
      await control.flush();
      toggleAttempts += 1;
      offObservations = 0;
      await sleep(options.promptSettleMs);
    }

    page = await capture(phone, worker, directory, state, `input-method-${aliases[0]}-after-toggle`);
    if (pickerVisible(page.items) && namedInputMethodBox(page.items, aliases)) {
      // 搜狗启用完成后会自动离开系统设置；出现在输入法选择框中即表示已启用。
      return { page, state: 'on', changed: true, assumedOff: false, promptActions };
    }
    const warning = settingsConfirmBox(page);
    if (warning) {
      const warningPoint = tapBox(control, warning, page);
      await control.tap(warningPoint.x, warningPoint.y);
      await control.flush();
      promptActions.push(normalizeText(warning.text));
      await sleep(options.promptSettleMs);
      page = await capture(phone, worker, directory, state, `input-method-${aliases[0]}-after-confirm`);
      if (pickerVisible(page.items) && namedInputMethodBox(page.items, aliases)) {
        return { page, state: 'on', changed: true, assumedOff: false, promptActions };
      }
      located = await findInputMethodRow(phone, control, worker, directory, state, page, aliases, options);
      page = located.page;
      row = located.box;
      continue;
    }

    const currentState = inputMethodState(page, row);
    if (currentState === 'on') {
      return { page, state: currentState, changed: true, assumedOff: false, promptActions };
    }
    if (currentState === 'off') {
      offObservations += 1;
      if (toggleAttempts >= 2 && offObservations >= 2) {
        throw new Error(`点击“${aliases[0]}”开关后仍显示关闭`);
      }
    } else {
      offObservations = 0;
    }
    if (currentState === 'unknown') {
      unknownObservations += 1;
      if (options.toggleUnknown && unknownObservations >= 2) {
        return { page, state: 'assumed-on', changed: true, assumedOff: true, promptActions };
      }
    }

    await sleep(options.pollMs);
    located = await findInputMethodRow(phone, control, worker, directory, state, page, aliases, options);
    page = located.page;
    row = located.box;
  }
  throw new Error(`等待“${aliases[0]}”开关完成超时`);
}

async function returnToSogou(phone, control, worker, directory, state, page, options, home) {
  const recovered = await recoverAppPage(phone, control, worker, directory, state, page, options, {
    appName: '搜狗输入法', targetName: '启用/切换入口或首启协议页', label: 'return-sogou', launcherObservation: home,
    isTarget: observation => sogouAppReady(observation.items) || sogouAgreementVisible(observation.items),
    launchEvidence: observation => sogouLaunchEvidence(observation.items) || pickerVisible(observation.items),
    prepare: observation => settleSogouStartup(phone, control, worker, directory, state, observation, options),
  });
  if (recovered.reachedTarget) return recovered.observation;
  const found = await findApp(phone, control, worker, directory, state, recovered.observation, options, sogouTargetBox, '搜狗输入法');
  return (await openSogou(phone, control, worker, directory, state, found, options)).opened;
}

async function clickSwitchAndChooseIfly(phone, control, worker, directory, state, app, options) {
  const button = switchButtonBox(app.items);
  if (!button) throw new Error('搜狗输入法界面未识别到“切换”按钮');
  const point = tapBox(control, button, app);
  await control.tap(point.x, point.y);
  await control.flush();

  let picker = await observeUntil(
    phone,
    worker,
    directory,
    state,
    observation =>
      sogouAgreementVisible(observation.items) ||
      Boolean(pickerOptionBox(observation.items)) ||
      pickerVisible(observation.items) ||
      Boolean(findPhrase(observation.items, 'gmime')),
    options.pickerTimeoutMs,
    options.pollMs,
    'input-method-picker',
  );
  if (sogouAgreementVisible(picker.items)) {
    const accepted = await acceptSogouAgreement(
      phone,
      control,
      worker,
      directory,
      state,
      picker,
      options,
    );
    return {
      switchPoint: point,
      agreedTerms: true,
      agreementPoint: accepted.agreementPoint,
      afterText: accepted.afterText,
      pickerClosed: true,
    };
  }
  let option = pickerOptionBox(picker.items);
  const optionDeadline = Date.now() + options.pickerTimeoutMs;
  while (!option && Date.now() <= optionDeadline) {
    await sleep(options.pollMs);
    picker = await capture(phone, worker, directory, state, 'input-method-picker-wait-ifly');
    if (sogouAgreementVisible(picker.items)) {
      const accepted = await acceptSogouAgreement(
        phone,
        control,
        worker,
        directory,
        state,
        picker,
        options,
      );
      return {
        switchPoint: point,
        agreedTerms: true,
        agreementPoint: accepted.agreementPoint,
        afterText: accepted.afterText,
        pickerClosed: true,
      };
    }
    option = pickerOptionBox(picker.items);
  }
  if (!option) throw new Error('输入法切换弹窗中未识别到“讯飞输入法”');
  const optionPoint = tapBox(control, option, picker);
  await control.tap(optionPoint.x, optionPoint.y);
  await control.flush();
  await sleep(options.appVisibleMs);
  const after = await capture(phone, worker, directory, state, 'ifly-selected');
  if (sogouAgreementVisible(after.items)) {
    const accepted = await acceptSogouAgreement(
      phone, control, worker, directory, state, after, options,
    );
    return {
      switchPoint: point,
      optionPoint,
      agreedTerms: true,
      agreementPoint: accepted.agreementPoint,
      afterText: accepted.afterText,
      pickerClosed: true,
    };
  }
  return {
    switchPoint: point,
    optionPoint,
    pickerText: picker.text.slice(0, 500),
    afterText: after.text.slice(0, 700),
    pickerClosed: !pickerVisible(after.items),
  };
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }
  if (process.env.YUNMOMO_CONFIRM_INPUT_INIT !== 'YES' && !process.argv.includes('--execute')) {
    throw new Error(
      '脚本8会启用搜狗/讯飞输入法并切换当前输入法；确认执行请设置 '
      + 'YUNMOMO_CONFIRM_INPUT_INIT=YES 或传入 --execute',
    );
  }

  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID);
  const options = {
    pollMs: numberOr(process.env.YUNMOMO_OCR_POLL_MS, DEFAULT_POLL_MS),
    homeTimeoutMs: numberOr(process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
    appTimeoutMs: numberOr(process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    openAttemptTimeoutMs: numberOr(process.env.YUNMOMO_INPUT_OPEN_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    settingsTimeoutMs: numberOr(process.env.YUNMOMO_INPUT_SETTINGS_TIMEOUT_MS, DEFAULT_SETTINGS_TIMEOUT_MS),
    toggleTimeoutMs: numberOr(process.env.YUNMOMO_INPUT_TOGGLE_TIMEOUT_MS, DEFAULT_TOGGLE_TIMEOUT_MS),
    pickerTimeoutMs: numberOr(process.env.YUNMOMO_INPUT_PICKER_TIMEOUT_MS, DEFAULT_PICKER_TIMEOUT_MS),
    promptSettleMs: numberOr(process.env.YUNMOMO_INPUT_PROMPT_SETTLE_MS, DEFAULT_PROMPT_SETTLE_MS),
    appVisibleMs: numberOr(process.env.YUNMOMO_INPUT_VISIBLE_MS, DEFAULT_APP_VISIBLE_MS),
    maxSettingsSwipes: numberOr(process.env.YUNMOMO_INPUT_MAX_SWIPES, DEFAULT_MAX_SETTINGS_SWIPES),
    toggleUnknown: process.env.YUNMOMO_INPUT_TOGGLE_UNKNOWN === '1',
    maxPagesPerDirection: numberOr(process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
  };

  const client = new YunmomoClient({ timeoutMs: 100000 });
  const devices = await client.listDevices({ size: 50000 });
  const target = devices.records.find(record => deviceIdOf(record) === targetDeviceId);
  if (!target) throw new Error('所选设备不在当前账号设备列表中: ' + targetDeviceId);

  const phone = client.device(targetDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const directory = await require('../../automation/screen').createOcrDirectory('yunmomo-script8-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let success = false;

  try {
    await control.connect();
    await runInputMethodWorkflow({
      phone,
      control,
      worker,
      directory,
      state,
      options,
      targetDeviceId,
      targetDeviceName: target.deviceName ?? target.name ?? 'SF'
    });
    success = true;
  } finally {
    if (!success && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
      try {
        await sendHome(control);
      } catch {
        // Preserve the original failure; cleanup below still runs.
      }
    }
    await worker.close();
    await control.close();
    if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
      await fs.rm(directory, { recursive: true, force: true });
    } else {
      console.log('OCR screenshots kept at ' + directory);
    }
  }
}

async function runInputMethodWorkflow({ phone, control, worker, directory, state = { counter: 0 }, options = {}, targetDeviceId, targetDeviceName = '设备' }) {
  if (!control.connected) {
    await control.connect();
  }
  const home = await confirmHome(phone, control, worker, directory, state, options);
  const found = await findApp(
    phone,
    control,
    worker,
    directory,
    state,
    home,
    options,
    sogouTargetBox,
    '搜狗输入法',
  );
  const opened = await openSogou(phone, control, worker, directory, state, found, options);
  if (sogouAgreementVisible(opened.opened.items)) {
    const accepted = await acceptSogouAgreement(
      phone,
      control,
      worker,
      directory,
      state,
      opened.opened,
      options,
    );
    const result = {
      ok: true,
      script: '输入法初始化',
      targetDeviceId,
      targetDeviceName,
      initialHomeAnchors: homeAnchorMatches(home.items),
      appLocated: true,
      appTap: opened.point,
      appTapRetried: opened.retried,
      stage: 'sogou-agreement-accepted',
      agreementTap: accepted.agreementPoint,
      finalScreen: '搜狗输入法首启后页面',
      finalText: accepted.afterText,
      appNavigationRecoveries: state.appNavigationRecoveries ?? [],
      screenshotObservations: state.counter,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const enable = enableButtonBox(opened.opened.items);
  let enablePoint = null;
  let sogouResult = {
    page: opened.opened,
    state: 'already-on',
    changed: false,
    assumedOff: false,
    promptActions: [],
  };
  let iflyResult = {
    page: opened.opened,
    state: 'already-on',
    changed: false,
    assumedOff: false,
    promptActions: [],
  };
  let app = opened.opened;

  if (enable) {
    enablePoint = tapBox(control, enable, opened.opened);
    await control.tap(enablePoint.x, enablePoint.y);
    await control.flush();

    let settings = await observeUntil(
      phone,
      worker,
      directory,
      state,
      observation => inputSettingsEvidence(observation.items) || inputMethodWarning(observation.items),
      options.settingsTimeoutMs,
      options.pollMs,
      'input-method-settings-open',
    );
    settings = await waitForInputSettings(phone, control, worker, directory, state, options, settings);
    settings = await enterInputMethodList(phone, control, worker, directory, state, settings, options);

    // 搜狗开关启用后会自动返回软件，先处理讯飞，最后启用搜狗。
    iflyResult = await enableOneInputMethod(
      phone,
      control,
      worker,
      directory,
      state,
      settings,
      IFly_ALIASES,
      options,
    );
    sogouResult = await enableOneInputMethod(
      phone,
      control,
      worker,
      directory,
      state,
      iflyResult.page,
      SOGOU_ALIASES,
      options,
    );
    app = await returnToSogou(
      phone,
      control,
      worker,
      directory,
      state,
      sogouResult.page,
      options,
      home,
    );
  } else if (!sogouAppReady(opened.opened.items)) {
    throw new Error('搜狗输入法界面未识别到“启用”或已完成初始化状态');
  }
  if (sogouAgreementVisible(app.items)) {
    const accepted = await acceptSogouAgreement(
      phone,
      control,
      worker,
      directory,
      state,
      app,
      options,
    );
    const result = {
      ok: true,
      script: '输入法初始化',
      targetDeviceId,
      targetDeviceName,
      initialHomeAnchors: homeAnchorMatches(home.items),
      appLocated: true,
      appTap: opened.point,
      appTapRetried: opened.retried,
      enableTap: enablePoint,
      sogouEnabled: sogouResult.state,
      sogouAssumedOff: sogouResult.assumedOff,
      iflyEnabled: iflyResult.state,
      iflyAssumedOff: iflyResult.assumedOff,
      sogouPromptActions: sogouResult.promptActions,
      iflyPromptActions: iflyResult.promptActions,
      stage: 'sogou-agreement-accepted',
      agreementTap: accepted.agreementPoint,
      finalScreen: '搜狗输入法首启后页面',
      finalText: accepted.afterText,
      appNavigationRecoveries: state.appNavigationRecoveries ?? [],
      screenshotObservations: state.counter,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const selected = await clickSwitchAndChooseIfly(
    phone,
    control,
    worker,
    directory,
    state,
    app,
    options,
  );
  if (selected.agreedTerms) {
    const result = {
      ok: true,
      script: '输入法初始化',
      targetDeviceId,
      targetDeviceName,
      initialHomeAnchors: homeAnchorMatches(home.items),
      appLocated: true,
      appTap: opened.point,
      appTapRetried: opened.retried,
      enableTap: enablePoint,
      sogouEnabled: sogouResult.state,
      sogouAssumedOff: sogouResult.assumedOff,
      iflyEnabled: iflyResult.state,
      iflyAssumedOff: iflyResult.assumedOff,
      sogouPromptActions: sogouResult.promptActions,
      iflyPromptActions: iflyResult.promptActions,
      stage: 'sogou-agreement-accepted',
      agreementTap: selected.agreementPoint,
      finalScreen: '搜狗输入法首启后页面',
      finalText: selected.afterText,
      appNavigationRecoveries: state.appNavigationRecoveries ?? [],
      screenshotObservations: state.counter,
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const successResult = selected.pickerClosed;
  const result = {
    ok: successResult,
    script: '输入法初始化',
    targetDeviceId,
    targetDeviceName,
    initialHomeAnchors: homeAnchorMatches(home.items),
    appLocated: true,
    appTap: opened.point,
    appTapRetried: opened.retried,
    enableTap: enablePoint,
    sogouEnabled: sogouResult.state,
    sogouAssumedOff: sogouResult.assumedOff,
    iflyEnabled: iflyResult.state,
    iflyAssumedOff: iflyResult.assumedOff,
    sogouPromptActions: sogouResult.promptActions,
    iflyPromptActions: iflyResult.promptActions,
    selectedInputMethod: '讯飞输入法',
    pickerClosed: selected.pickerClosed,
    finalScreen: '搜狗输入法',
    finalText: selected.afterText,
    appNavigationRecoveries: state.appNavigationRecoveries ?? [],
    screenshotObservations: state.counter,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    throw new Error('输入法初始化失败：未成功关闭输入法选择器');
  }
  return result;
}

async function runStep(context = {}) {
  const { phone, control, worker, directory, state, target } = context;
  if (!phone || !control || !worker) {
    throw new Error('runStep 必须提供 phone, control, worker 会话对象');
  }
  const options = {
    pollMs: numberOr(process.env.YUNMOMO_OCR_POLL_MS, DEFAULT_POLL_MS),
    homeTimeoutMs: numberOr(process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
    appTimeoutMs: numberOr(process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    settingsTimeoutMs: numberOr(process.env.YUNMOMO_INPUT_SETTINGS_TIMEOUT_MS, DEFAULT_SETTINGS_TIMEOUT_MS),
    toggleTimeoutMs: numberOr(process.env.YUNMOMO_INPUT_TOGGLE_TIMEOUT_MS, DEFAULT_TOGGLE_TIMEOUT_MS),
    pickerTimeoutMs: numberOr(process.env.YUNMOMO_INPUT_PICKER_TIMEOUT_MS, DEFAULT_PICKER_TIMEOUT_MS),
    promptSettleMs: numberOr(process.env.YUNMOMO_PROMPT_SETTLE_MS, DEFAULT_PROMPT_SETTLE_MS),
    appVisibleMs: numberOr(process.env.YUNMOMO_INPUT_APP_VISIBLE_MS, DEFAULT_APP_VISIBLE_MS),
    maxSettingsSwipes: numberOr(process.env.YUNMOMO_MAX_SETTINGS_SWIPES, DEFAULT_MAX_SETTINGS_SWIPES),
    toggleUnknown: process.env.YUNMOMO_INPUT_TOGGLE_UNKNOWN === '1',
    maxPagesPerDirection: numberOr(process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
    ...(context.options || {})
  };

  return await runInputMethodWorkflow({
    phone,
    control,
    worker,
    directory: directory || (await require('../../automation/screen').createOcrDirectory('yunmomo-script8-')),
    state: state || { counter: 0 },
    options,
    targetDeviceId: phone.deviceId,
    targetDeviceName: target?.deviceName || target?.name || '云机'
  });
}

capture = require('../../automation/timing').timed('workflow.initialize-input-method.capture', capture);
chooseSogouFromPicker = require('../../automation/timing').timed('workflow.initialize-input-method.chooseSogouFromPicker', chooseSogouFromPicker);
acceptSogouAgreement = require('../../automation/timing').timed('workflow.initialize-input-method.acceptSogouAgreement', acceptSogouAgreement);
settleSogouStartup = require('../../automation/timing').timed('workflow.initialize-input-method.settleSogouStartup', settleSogouStartup);
openSogou = require('../../automation/timing').timed('workflow.initialize-input-method.openSogou', openSogou);
waitForInputSettings = require('../../automation/timing').timed('workflow.initialize-input-method.waitForInputSettings', waitForInputSettings);
enterInputMethodList = require('../../automation/timing').timed('workflow.initialize-input-method.enterInputMethodList', enterInputMethodList);
findInputMethodRow = require('../../automation/timing').timed('workflow.initialize-input-method.findInputMethodRow', findInputMethodRow);
enableOneInputMethod = require('../../automation/timing').timed('workflow.initialize-input-method.enableOneInputMethod', enableOneInputMethod);
returnToSogou = require('../../automation/timing').timed('workflow.initialize-input-method.returnToSogou', returnToSogou);
clickSwitchAndChooseIfly = require('../../automation/timing').timed('workflow.initialize-input-method.clickSwitchAndChooseIfly', clickSwitchAndChooseIfly);
runInputMethodWorkflow = require('../../automation/timing').timed('workflow.initialize-input-method.runWorkflow', runInputMethodWorkflow);
main = require('../../automation/timing').timedScript('script.src.workflows.v3.initialize-input-method', main);

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  runStep,
  runInputMethodWorkflow,
  sogouTargetBox,
  sogouAppReady,
  inputSettingsEvidence,
  inputMethodState,
  pickerVisible,
  sogouAgreementVisible,
};
