'use strict';

// Script 5: open 伍羊工具箱 on the first cloud phone and press
// “一键生成全部”. Completion is confirmed only after an explicit generating
// state has been observed and the normal button remains stable for a few
// observations. This prevents returning home on the pre-generation screen
// when the first OCR frame is captured before the app updates.
const fs = require('node:fs/promises');
const { YunmomoClient } = require('../../index');
const { openAppWithRecovery } = require('../../automation/app-navigation');
const {
  numberOr,
  deviceIdOf,
  findPhrase,
  findStrictPhrase,
  homeAnchorMatches,
  normalizeText,
  RapidOcrWorker,
  screenshotAndOcr,
  confirmHome,
  findApp,
  tapBox,
  sendHome,
} = require('../../automation/screen');

const DEFAULT_DEVICE_ID = '2033060279606353921';
const DEFAULT_POLL_MS = 700;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_APP_TIMEOUT_MS = 20000;
const DEFAULT_GENERATION_TIMEOUT_MS = 120000;
const DEFAULT_COMPLETION_STABLE_OBSERVATIONS = 4;
const DEFAULT_MIN_POST_GENERATION_WAIT_MS = 2000;
const DEFAULT_COMPLETION_QUIET_MS = 15000;
const DEFAULT_MAX_PAGES_PER_DIRECTION = 5;
const SCREENSHOT_LEVEL = 2;

function statsFingerprint(items) {
  return items
    .filter(item => /^\d{1,4}$/.test(normalizeText(item.text)) && item.centerY > 60 && item.centerY < 300)
    .map(item => `${Math.round(item.centerX)}:${Math.round(item.centerY)}:${normalizeText(item.text)}`)
    .sort()
    .join('|');
}

function toolBox(items) {
  return findPhrase(items, '伍羊工具箱') || findPhrase(items, '伍羊工') || findPhrase(items, '伍羊');
}

function toolReady(items) {
  return Boolean(findStrictPhrase(items, '伍羊工具箱') && findStrictPhrase(items, '一键生成全部'));
}

function generatingState(items) {
  return Boolean(
    findStrictPhrase(items, '正在生成') ||
    findStrictPhrase(items, '生成中') ||
    findStrictPhrase(items, '正在发送短信') ||
    findStrictPhrase(items, '发送大量短信')
  );
}

function smsPermissionPrompt(items) {
  return Boolean(
    findStrictPhrase(items, '正在发送短信') ||
    findStrictPhrase(items, '发送大量短信') ||
    (findStrictPhrase(items, '是否允许') && allowButtonBox(items))
  );
}

function allowButtonBox(items) {
  const exact = items
    .filter(item => normalizeText(item.text) === '允许')
    .sort((left, right) => right.centerY - left.centerY || right.centerX - left.centerX);
  if (exact.length) return exact[0];

  // If OCR merged the button with nearby prompt text, avoid tapping the
  // sentence "是否允许" and only use a standalone-looking lower-right item.
  const candidates = items
    .filter(item => {
      const text = normalizeText(item.text);
      return text.includes('允许') && !text.includes('是否') && !text.includes('发送');
    })
    .sort((left, right) => right.centerY - left.centerY || right.centerX - left.centerX);
  return candidates[0] || null;
}

function completionEvidence(items) {
  const text = items.map(item => normalizeText(item.text)).join('');
  return Boolean(
    text.includes('所有数据生成完成') ||
    (text.includes('成功') && text.includes('打开系统短信应用查看'))
  );
}

async function tapToolAndWaitReady(phone, control, worker, directory, state, found, options) {
  return openAppWithRecovery(phone, control, worker, directory, state, found, options, {
    appName: '伍羊工具箱', targetName: '一键生成全部入口', label: 'tool', targetBox: toolBox,
    isTarget: observation => toolReady(observation.items),
    blockedReason: observation => generatingState(observation.items) || smsPermissionPrompt(observation.items)
      ? '上次生成仍在进行或等待短信确认，停止入口恢复，避免打断或重复生成' : null,
    offsets: [{ y: 0 }, { y: -55 }],
  });
}

async function clickGenerateAllAndWait(phone, control, worker, directory, state, ready, options) {
  const button = findStrictPhrase(ready.items, '一键生成全部');
  if (!button) throw new Error('伍羊工具箱已打开，但未识别到“一键生成全部”按钮');
  const point = tapBox(control, button, ready);
  const beforeStats = statsFingerprint(ready.items);
  await control.tap(point.x, point.y);
  await control.flush();

  const deadline = Date.now() + options.generationTimeoutMs;
  let generationStarted = false;
  let completionToast = false;
  let last = ready;
  let observationsAfterClick = 0;
  let generatingObservations = 0;
  let normalButtonStableObservations = 0;
  let generationStartedAt = 0;
  let lastGenerationActivityAt = 0;
  let buttonReturnedAt = 0;
  let permissionPromptsSeen = 0;
  let permissionPromptsAllowed = 0;

  while (Date.now() <= deadline) {
    state.counter += 1;
    last = await screenshotAndOcr(phone, worker, directory, state.counter);
    observationsAfterClick += 1;
    const permissionPrompt = smsPermissionPrompt(last.items);
    const normalButton = !permissionPrompt && Boolean(findStrictPhrase(last.items, '一键生成全部'));
    const titleVisible = Boolean(findStrictPhrase(last.items, '伍羊工具箱'));
    const running = generatingState(last.items);
    completionToast = completionToast || completionEvidence(last.items);

    // Android can interrupt the all-data flow with a confirmation dialog when
    // the app starts sending many SMS messages. Keep the app in the foreground,
    // tap the positive action, and keep watching for another prompt. Never let
    // the underlying "一键生成全部" button count as complete while this modal
    // is visible.
    if (permissionPrompt) {
      permissionPromptsSeen += 1;
      generationStarted = true;
      if (!generationStartedAt) generationStartedAt = Date.now();
      lastGenerationActivityAt = Date.now();
      normalButtonStableObservations = 0;
      buttonReturnedAt = 0;
      const allow = allowButtonBox(last.items);
      if (allow) {
        const allowPoint = tapBox(control, allow, last);
        await control.tap(allowPoint.x, allowPoint.y);
        await control.flush();
        permissionPromptsAllowed += 1;
      }
      await new Promise(resolve => setTimeout(resolve, options.pollMs));
      continue;
    }

    // Do not infer that generation started merely because the normal button
    // is temporarily absent. The app can be between layout frames, and that
    // caused the previous implementation to return home too early. Require
    // explicit OCR evidence from the in-progress label instead.
    if (running && titleVisible) {
      generatingObservations += 1;
      lastGenerationActivityAt = Date.now();
      if (!generationStarted) {
        generationStarted = true;
        generationStartedAt = Date.now();
      }
      normalButtonStableObservations = 0;
      buttonReturnedAt = 0;
    }

    if (generationStarted && normalButton && titleVisible) {
      normalButtonStableObservations += 1;
      if (!buttonReturnedAt) buttonReturnedAt = Date.now();
    } else if (!normalButton || !titleVisible) {
      normalButtonStableObservations = 0;
      buttonReturnedAt = 0;
    }

    const afterStats = statsFingerprint(last.items);
    const statsChanged = Boolean(beforeStats && afterStats && beforeStats !== afterStats);
    // The toast is transient and may be missed. The durable signal is that
    // the one-click button has returned and stayed stable after explicit
    // generation evidence. A small post-generation delay also prevents an
    // immediate pre-update frame from being treated as completion.
    const stableAfterGeneration =
      normalButtonStableObservations >= options.completionStableObservations &&
      Date.now() - generationStartedAt >= options.minPostGenerationWaitMs;
    const quietAfterGeneration =
      Boolean(buttonReturnedAt && lastGenerationActivityAt) &&
      Date.now() - buttonReturnedAt >= options.completionQuietMs &&
      Date.now() - lastGenerationActivityAt >= options.completionQuietMs;
    if (generationStarted && stableAfterGeneration && (completionToast || quietAfterGeneration)) {
      return {
        observation: last,
        point,
        beforeStats,
        afterStats,
        generationStarted,
        generatingObservations,
        completionToast,
        statsChanged,
        buttonReturned: true,
        normalButtonStableObservations,
        permissionPromptsSeen,
        permissionPromptsAllowed,
        observationsAfterClick,
      };
    }
    await new Promise(resolve => setTimeout(resolve, options.pollMs));
  }

  const detail = last?.text?.slice(0, 600) || 'no OCR observation';
  throw new Error('等待“一键生成全部”恢复正常状态超时；最后画面：' + detail);
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }
  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID);
  if (process.env.YUNMOMO_CONFIRM_GENERATE_ALL !== 'YES' && !process.argv.includes('--execute')) {
    throw new Error('脚本5会生成联系人、通话记录等数据；确认执行请设置 YUNMOMO_CONFIRM_GENERATE_ALL=YES 或传入 --execute');
  }

  const options = {
    pollMs: numberOr(process.env.YUNMOMO_OCR_POLL_MS, DEFAULT_POLL_MS),
    homeTimeoutMs: numberOr(process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
    appTimeoutMs: numberOr(process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    generationTimeoutMs: numberOr(process.env.YUNMOMO_GENERATION_TIMEOUT_MS, DEFAULT_GENERATION_TIMEOUT_MS),
    completionStableObservations: numberOr(
      process.env.YUNMOMO_COMPLETION_STABLE_OBSERVATIONS,
      DEFAULT_COMPLETION_STABLE_OBSERVATIONS,
    ),
    minPostGenerationWaitMs: numberOr(
      process.env.YUNMOMO_MIN_POST_GENERATION_WAIT_MS,
      DEFAULT_MIN_POST_GENERATION_WAIT_MS,
    ),
    completionQuietMs: numberOr(
      process.env.YUNMOMO_COMPLETION_QUIET_MS,
      DEFAULT_COMPLETION_QUIET_MS,
    ),
    maxPagesPerDirection: numberOr(process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
  };
  const client = new YunmomoClient({ timeoutMs: 100000 });
  const devices = await client.listDevices({ size: 50000 });
  const target = devices.records.find(record => deviceIdOf(record) === targetDeviceId);
  if (!target) throw new Error('所选设备不在当前账号设备列表中: ' + targetDeviceId);

  const phone = client.device(targetDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const directory = await require('../../automation/screen').createOcrDirectory('yunmomo-script5-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let success = false;
  try {
    await control.connect();
    const home = await confirmHome(phone, control, worker, directory, state, options);
    const found = await findApp(
      phone,
      control,
      worker,
      directory,
      state,
      home,
      options,
      toolBox,
      '伍羊工具箱',
    );
    const opened = await tapToolAndWaitReady(phone, control, worker, directory, state, found, options);
    const generated = await clickGenerateAllAndWait(
      phone,
      control,
      worker,
      directory,
      state,
      opened.opened,
      options,
    );
    const finalHome = await confirmHome(phone, control, worker, directory, state, options);
    const finalAnchors = homeAnchorMatches(finalHome.items);
    success = generated.buttonReturned && finalAnchors.length >= 2;
    console.log(JSON.stringify({
      ok: success,
      script: 'generate-all-data',
      targetDeviceId,
      targetDeviceName: target.deviceName ?? target.name ?? 'SF',
      ocr: 'RapidOCR 1.2.3 (local WSL worker)',
      initialHomeAnchors: homeAnchorMatches(home.items),
      appLocated: true,
      appTap: opened.point,
      appTapRetried: opened.retried,
      appNavigationRecoveries: state.appNavigationRecoveries ?? [],
      beforeStats: generated.beforeStats,
      afterStats: generated.afterStats,
      generationStartedDetected: generated.generationStarted,
      generatingObservations: generated.generatingObservations,
      completionToastDetected: generated.completionToast,
      buttonReturned: generated.buttonReturned,
      normalButtonStableObservations: generated.normalButtonStableObservations,
      permissionPromptsSeen: generated.permissionPromptsSeen,
      permissionPromptsAllowed: generated.permissionPromptsAllowed,
      finalHomeAnchors: finalAnchors,
      homeRestored: finalAnchors.length >= 2,
      screenshotObservations: state.counter,
    }, null, 2));
  } finally {
    if (!success && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
      try { await sendHome(control); } catch { /* preserve original failure */ }
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

tapToolAndWaitReady = require('../../automation/timing').timed('workflow.generate-all.tapToolAndWaitReady', tapToolAndWaitReady);
clickGenerateAllAndWait = require('../../automation/timing').timed('workflow.generate-all.clickGenerateAllAndWait', clickGenerateAllAndWait);
main = require('../../automation/timing').timedScript('script.src.workflows.v3.generate-all', main);

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main, statsFingerprint, toolBox, toolReady, generatingState, completionEvidence };
