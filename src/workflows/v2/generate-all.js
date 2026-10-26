'use strict';

// Script 5: open 伍羊工具箱 on the target cloud phone and press
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
  swipeHomePage,
  tapBox,
  sendHome,
} = require('../../automation/screen');

const DEFAULT_DEVICE_ID = '1920787385311416321'; // GVIP701808715424 (SF)
const DEFAULT_POLL_MS = 700;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_APP_TIMEOUT_MS = 20000;
const DEFAULT_GENERATION_TIMEOUT_MS = 120000;
const DEFAULT_COMPLETION_STABLE_OBSERVATIONS = 4;
const DEFAULT_MIN_POST_GENERATION_WAIT_MS = 2000;
const DEFAULT_COMPLETION_QUIET_MS = 15000;
const DEFAULT_MAX_PAGES_PER_DIRECTION = 5;

function matchesDevice(record, identifier) {
  const id = String(identifier || '').trim();
  if (!id) return false;
  return deviceIdOf(record) === id ||
    String(record?.deviceCode ?? record?.code ?? record?.cloudNumber ?? '').trim() === id ||
    String(record?.name ?? record?.deviceName ?? '').trim() === id;
}

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
  const hasTitle = Boolean(findStrictPhrase(items, '伍羊工具箱') || findPhrase(items, '伍羊工具箱') || findPhrase(items, '伍羊'));
  const hasButton = Boolean(findStrictPhrase(items, '一键生成全部') || findPhrase(items, '一键生成全部'));
  return hasTitle && hasButton;
}

function generatingState(items) {
  return Boolean(
    findStrictPhrase(items, '正在生成') ||
    findStrictPhrase(items, '生成中') ||
    findStrictPhrase(items, '正在发送短信') ||
    findStrictPhrase(items, '发送大量短信')
  );
}

function permissionPrompt(items) {
  const allowBtn = allowButtonBox(items);
  if (!allowBtn) return false;

  const fullText = items.map(item => normalizeText(item.text)).join('');
  const hasPromptKeyword =
    fullText.includes('允许') && (
      fullText.includes('访问') ||
      fullText.includes('权限') ||
      fullText.includes('通讯录') ||
      fullText.includes('通话记录') ||
      fullText.includes('短信') ||
      fullText.includes('发送') ||
      fullText.includes('不允许') ||
      fullText.includes('拒绝') ||
      fullText.includes('是否允许') ||
      fullText.includes('照片') ||
      fullText.includes('媒体')
    );

  const hasSpecialSmsPrompt =
    Boolean(findStrictPhrase(items, '正在发送短信') || findStrictPhrase(items, '发送大量短信'));

  return Boolean(hasPromptKeyword || hasSpecialSmsPrompt);
}

function allowButtonBox(items) {
  // First prefer exact standalone positive buttons: 允许, 始终允许, 仅在使用中允许
  const exact = items
    .filter(item => {
      const text = normalizeText(item.text);
      return text === '允许' || text === '始终允许' || text === '仅在使用中允许';
    })
    .sort((left, right) => right.centerY - left.centerY || right.centerX - left.centerX);
  if (exact.length) return exact[0];

  const candidates = items
    .filter(item => {
      const text = normalizeText(item.text);
      return text.includes('允许') &&
        !text.includes('不允许') &&
        !text.includes('是否') &&
        !text.includes('访问') &&
        !text.includes('发送') &&
        !text.includes('拒绝');
    })
    .sort((left, right) => right.centerY - left.centerY || right.centerX - left.centerX);
  return candidates[0] || null;
}

function completionEvidence(items) {
  const text = items.map(item => normalizeText(item.text)).join('');
  return Boolean(
    text.includes('所有数据生成完成') ||
    text.includes('数据生成完成') ||
    text.includes('生成完成') ||
    (text.includes('成功') && (text.includes('短信') || text.includes('查看')))
  );
}

async function tapToolAndWaitReady(phone, control, worker, directory, state, found, options) {
  return openAppWithRecovery(phone, control, worker, directory, state, found, options, {
    appName: '伍羊工具箱',
    targetName: '一键生成全部入口',
    label: 'tool',
    targetBox: toolBox,
    isTarget: observation => toolReady(observation.items),
    prepare: async observation => {
      if (permissionPrompt(observation.items)) {
        const allow = allowButtonBox(observation.items);
        if (allow) {
          const pt = tapBox(control, allow, observation);
          console.log(`[授权] 检测到启动权限弹窗，点击“允许” (${pt.x}, ${pt.y})`);
          await control.tap(pt.x, pt.y);
          await control.flush();
          await new Promise(r => setTimeout(r, 1000));
          state.counter += 1;
          return await screenshotAndOcr(phone, worker, directory, state.counter);
        }
      }
      return observation;
    },
    blockedReason: observation => generatingState(observation.items)
      ? '上次生成仍在进行中，停止入口恢复，避免打断或重复生成' : null,
    offsets: [{ y: -40 }, { y: -55 }, { y: 0 }],
  });
}

async function clickGenerateAllAndWait(phone, control, worker, directory, state, ready, options) {
  const button = findStrictPhrase(ready.items, '一键生成全部') || findPhrase(ready.items, '一键生成全部');
  if (!button) throw new Error('伍羊工具箱已打开，但未识别到“一键生成全部”按钮');
  const point = tapBox(control, button, ready);
  const beforeStats = statsFingerprint(ready.items);
  console.log(`[生成] 找到“一键生成全部”控件 (${point.x}, ${point.y})，点击触发数据生成...`);
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
  let lastProgressLogAt = 0;

  while (Date.now() <= deadline) {
    state.counter += 1;
    last = await screenshotAndOcr(phone, worker, directory, state.counter);
    observationsAfterClick += 1;
    const isPermission = permissionPrompt(last.items);
    const normalButton = !isPermission && Boolean(findStrictPhrase(last.items, '一键生成全部') || findPhrase(last.items, '一键生成全部'));
    const titleVisible = Boolean(findStrictPhrase(last.items, '伍羊工具箱') || findPhrase(last.items, '伍羊工具箱') || findPhrase(last.items, '伍羊'));
    const running = generatingState(last.items);
    completionToast = completionToast || completionEvidence(last.items);

    if (isPermission) {
      permissionPromptsSeen += 1;
      generationStarted = true;
      if (!generationStartedAt) generationStartedAt = Date.now();
      lastGenerationActivityAt = Date.now();
      normalButtonStableObservations = 0;
      buttonReturnedAt = 0;
      const allow = allowButtonBox(last.items);
      if (allow) {
        const allowPoint = tapBox(control, allow, last);
        console.log(`[授权] 检测到系统权限弹窗，已自动点击“允许” (${allowPoint.x}, ${allowPoint.y}) [第 ${permissionPromptsSeen} 次]`);
        await control.tap(allowPoint.x, allowPoint.y);
        await control.flush();
        permissionPromptsAllowed += 1;
      }
      await new Promise(resolve => setTimeout(resolve, options.pollMs));
      continue;
    }

    const afterStats = statsFingerprint(last.items);
    const statsChanged = Boolean(beforeStats && afterStats && beforeStats !== afterStats);
    if (statsChanged && !generationStarted) {
      generationStarted = true;
      if (!generationStartedAt) generationStartedAt = Date.now();
    }

    const isHomeScreen = homeAnchorMatches(last.items).length >= 2;
    if (generationStarted && isHomeScreen) {
      const elapsedTotal = Math.round((Date.now() - (generationStartedAt || Date.now())) / 1000);
      console.log(`[生成完成] 数据生成完成并已自动返回主屏幕！(耗时: ${elapsedTotal}s, 授权: ${permissionPromptsAllowed} 次)`);
      return {
        observation: last,
        point,
        beforeStats,
        afterStats,
        generationStarted,
        generatingObservations,
        completionToast: true,
        statsChanged: true,
        buttonReturned: true,
        alreadyHome: true,
        normalButtonStableObservations: 4,
        permissionPromptsSeen,
        permissionPromptsAllowed,
        observationsAfterClick,
        elapsedSeconds: elapsedTotal,
      };
    }

    if (running && titleVisible) {
      generatingObservations += 1;
      lastGenerationActivityAt = Date.now();
      if (!generationStarted) {
        generationStarted = true;
        generationStartedAt = Date.now();
        console.log('[生成中] 已检测到数据生成状态，正在生成...');
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

    const now = Date.now();
    if (generationStarted && now - lastProgressLogAt >= 4000) {
      lastProgressLogAt = now;
      const elapsed = Math.round((now - (generationStartedAt || now)) / 1000);
      console.log(`[生成中] 数据正在生成中 (已运行 ${elapsed}s)...`);
    }

    const stableAfterGeneration =
      normalButtonStableObservations >= options.completionStableObservations &&
      Date.now() - (generationStartedAt || Date.now()) >= options.minPostGenerationWaitMs;
    const quietAfterGeneration =
      Boolean(buttonReturnedAt && lastGenerationActivityAt) &&
      Date.now() - buttonReturnedAt >= options.completionQuietMs &&
      Date.now() - lastGenerationActivityAt >= options.completionQuietMs;

    if (generationStarted && stableAfterGeneration && (completionToast || statsChanged || quietAfterGeneration)) {
      const elapsedTotal = Math.round((Date.now() - (generationStartedAt || Date.now())) / 1000);
      console.log(`[生成完成] 数据生成全部完成！(耗时: ${elapsedTotal}s, 稳定帧: ${normalButtonStableObservations}, 授权: ${permissionPromptsAllowed} 次)`);
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
        elapsedSeconds: elapsedTotal,
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

  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID).trim();
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
  const target = devices.records.find(record => matchesDevice(record, targetDeviceId));
  if (!target) throw new Error('所选设备不在当前账号设备列表中: ' + targetDeviceId);

  const actualDeviceId = deviceIdOf(target);
  const deviceName = target.deviceName ?? target.name ?? 'SF';

  const confirmExecute = process.env.YUNMOMO_CONFIRM_GENERATE_ALL === 'YES' || process.argv.includes('--execute');
  if (!confirmExecute) {
    console.log(`目标云机: ${deviceName} (${actualDeviceId})`);
    console.log('预览完成；如确认在该设备执行“一键生成全部”，请设置 YUNMOMO_CONFIRM_GENERATE_ALL=YES 或传入 --execute 重跑。');
    return;
  }

  console.log(`目标云机: ${deviceName} (${actualDeviceId})`);
  console.log('[1/5] 正在确认主屏幕就绪...');

  const phone = client.device(actualDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const directory = await require('../../automation/screen').createOcrDirectory('yunmomo-script5-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let success = false;
  let homeRestored = false;

  try {
    await control.connect();
    const home = await confirmHome(phone, control, worker, directory, state, options);

    console.log('[2/5] 正在桌面寻找应用“伍羊工具箱”...');
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

    console.log('[3/5] 正在打开“伍羊工具箱”并等待就绪...');
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

    console.log('[4/5] 数据生成完毕，正在快速返回主屏幕并核验...');
    // 伍羊工具箱位于第二页，退出后会落在第二页；直接发送 HOME 并右滑至第一页，让主屏锚点一次命中，无需任何死等
    if (!generated.alreadyHome) {
      await sendHome(control);
      await swipeHomePage(control, 'right');
    }
    const finalHome = await confirmHome(phone, control, worker, directory, state, {
      ...options,
      homeConfirmation: { firstAttemptTimeoutMs: 3000 }
    });
    const finalAnchors = homeAnchorMatches(finalHome.items);
    homeRestored = finalAnchors.length >= 2;
    success = generated.buttonReturned && homeRestored;

    if (!success) {
      throw new Error('执行未完成：' + (!generated.buttonReturned ? '“一键生成全部”未确认完成' : '未能成功恢复主屏'));
    }

    console.log(`[5/5] 已成功恢复主屏幕 (桌面锚点: ${finalAnchors.length} 个)`);
    console.log(`>>> 一键生成全部执行成功 OK (生成耗时: ${generated.elapsedSeconds}s)`);
  } finally {
    if (!homeRestored && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
      try {
        await sendHome(control);
        homeRestored = true;
      } catch {
        // preserve original failure
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

tapToolAndWaitReady = require('../../automation/timing').timed('workflow.generate-all.tapToolAndWaitReady', tapToolAndWaitReady);
clickGenerateAllAndWait = require('../../automation/timing').timed('workflow.generate-all.clickGenerateAllAndWait', clickGenerateAllAndWait);
main = require('../../automation/timing').timedScript('script.src.workflows.v2.generate-all', main);

if (require.main === module) {
  require('../../automation/runtime').launchCli(main);
}

module.exports = {
  main,
  statsFingerprint,
  toolBox,
  toolReady,
  generatingState,
  completionEvidence,
};
