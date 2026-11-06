'use strict';

// Script 7: 打开高德地图并完成首次初始化。
//
// 云机只提供视频流，因此启动应用、处理首次权限/提示和判断地图已就绪，
// 都通过 RapidOCR 找文字坐标；实际点击仍走现有云机控制通道。完成后会
// 先让高德界面稳定可见一小段时间，再发送 HOME 并确认回到桌面。
const fs = require('node:fs/promises');
const { YunmomoClient } = require('../../index');
const { formatDeviceLabel } = require('../../automation/runtime');
const { openAppWithRecovery } = require('../../automation/app-navigation');
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
  confirmHome,
  findApp,
  tapBox,
  sendHome,
} = require('../../automation/screen');

const DEFAULT_DEVICE_ID = '2033060279606353921';
const DEFAULT_POLL_MS = 700;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_APP_TIMEOUT_MS = 20000;
const DEFAULT_OPEN_ATTEMPT_TIMEOUT_MS = 10000;
const DEFAULT_INIT_TIMEOUT_MS = 90000;
const DEFAULT_PROMPT_SETTLE_MS = 900;
const DEFAULT_APP_VISIBLE_MS = 500;
const DEFAULT_STABLE_OBSERVATIONS = 3;
const DEFAULT_MAX_PAGES_PER_DIRECTION = 5;
const DEFAULT_MAX_PROMPT_ACTIONS = 12;
const SCREENSHOT_LEVEL = 2;

function gaodeTargetBox(items) {
  return (
    findStrictPhrase(items, '高德地图') ||
    findPhrase(items, '高德地图') ||
    findStrictPhrase(items, '高德')
  );
}

function launcherVisible(items) {
  return homeAnchorMatches(items).length >= 2 || (
    Boolean(findStrictPhrase(items, '高德地图')) &&
    Boolean(findStrictPhrase(items, '微信')) &&
    items.some(item => normalizeText(item.text).toUpperCase().includes('MOMO'))
  );
}

function mapEvidenceCount(items) {
  const phrases = [
    '搜索', '路线', '导航', '我的', '附近', '驾车', '步行', '公交',
    '地图', '定位', '高德地图',
  ];
  return phrases.reduce((count, phrase) => count + (findPhrase(items, phrase) ? 1 : 0), 0);
}

function gaodeLaunchEvidence(items) {
  const mapControls = [
    '搜索', '路线', '导航', '我的', '附近', '驾车', '步行', '公交',
  ].reduce((count, phrase) => count + (findPhrase(items, phrase) ? 1 : 0), 0);
  const privacyOrPermission = Boolean(
    findPhrase(items, '隐私政策') ||
    findPhrase(items, '个人信息保护') ||
    findPhrase(items, '权限') ||
    findPhrase(items, '允许') ||
    findPhrase(items, '同意')
  );
  // The launcher page itself also contains the “高德地图” label. Do not
  // treat that unchanged home frame as a successful launch observation.
  const stillHome = launcherVisible(items) && mapControls < 2 && !privacyOrPermission;
  return Boolean(
    !stillHome && (
      findPhrase(items, '高德地图') ||
      findPhrase(items, '高德') ||
      mapEvidenceCount(items) >= 2 ||
      privacyOrPermission
    )
  );
}

function gaodeMapReady(items) {
  if (launcherVisible(items)) return false;
  if (findStrictPhrase(items, '添加到主屏幕') || findStrictPhrase(items, '轻触并按住此微件')) return false;
  const mapControls = [
    '搜索', '路线', '导航', '我的', '附近', '驾车', '步行', '公交', '图层', '更多',
  ].reduce((count, phrase) => count + (findStrictPhrase(items, phrase) ? 1 : 0), 0);
  // The words “高德地图”/“地图” on an icon are not two independent signals.
  return mapControls >= 2;
}

function promptCue(items) {
  const cues = [
    '权限', '允许', '隐私', '协议', '用户协议', '服务协议', '个人信息',
    '定位', '通知', '温馨提示', '提示', '更新', '版本', '授权', '政策',
    '高德地图',
  ];
  return cues.some(phrase => findPhrase(items, phrase));
}

function exactActionBox(items, phrases) {
  const wanted = phrases.map(normalizeText);
  const candidates = items
    .filter(item => wanted.includes(normalizeText(item.text)))
    .sort((left, right) => right.centerY - left.centerY || left.left - right.left);
  return candidates[0] || null;
}

// Return only explicit button labels. In particular, do not use a substring
// match for “允许”, otherwise “不允许” could be selected accidentally.
function findPromptAction(observation) {
  const items = observation?.items || [];
  if (findStrictPhrase(items, '添加到主屏幕') || findStrictPhrase(items, '轻触并按住此微件')) {
    const cancel = exactActionBox(items, ['取消']);
    return cancel ? { label: '取消快捷组件', box: cancel } : null;
  }
  const height = Number(observation?.height) || 640;
  const bottomHalf = item => item.centerY >= height * 0.42;
  const allowLabels = [
    '同意并继续', '同意并使用', '使用应用时允许', '仅在使用时允许',
    '仅此次允许', '始终允许', '允许',
  ];
  const dismissLabels = [
    '继续使用', '我知道了', '知道了', '稍后再说', '以后再说', '跳过',
    '关闭', '确定', '下一步', '继续',
  ];

  for (const label of allowLabels) {
    const box = exactActionBox(items, [label]);
    if (box && (bottomHalf(box) || promptCue(items))) return { label, box };
  }

  // “同意” is deliberately separate from the allow list so that it cannot
  // match “不同意”. It is expected on privacy/terms dialogs.
  const agree = exactActionBox(items, ['同意']);
  if (agree && (bottomHalf(agree) || promptCue(items))) return { label: '同意', box: agree };

  // Generic dismiss/continue actions are accepted only when OCR also sees a
  // dialog cue. This prevents a normal map control from being mistaken for a
  // popup button.
  if (promptCue(items)) {
    for (const label of dismissLabels) {
      const box = exactActionBox(items, [label]);
      if (box && (bottomHalf(box) || ['关闭', '确定', '知道了'].includes(label))) {
        return { label, box };
      }
    }
  }
  return null;
}

async function openGaode(phone, control, worker, directory, state, found, options) {
  return openAppWithRecovery(phone, control, worker, directory, state, found, options, {
    appName: '高德地图', targetName: '地图首页或首次权限提示', label: 'gaode', targetBox: gaodeTargetBox,
    isTarget: observation => gaodeMapReady(observation.items) || Boolean(findPromptAction(observation)),
    isLauncher: observation => launcherVisible(observation.items),
    launchTimeoutMs: Math.min(options.appTimeoutMs, options.openAttemptTimeoutMs),
  });
}

async function initializeGaode(phone, control, worker, directory, state, opened, options) {
  let observation = opened;
  let stableObservations = 0;
  let promptActions = [];
  let promptActionCount = 0;
  const deadline = Date.now() + options.initTimeoutMs;
  const maxPromptActions = numberOr(options?.maxPromptActions, DEFAULT_MAX_PROMPT_ACTIONS);

  while (Date.now() <= deadline) {
    const action = findPromptAction(observation);
    if (action && promptActionCount < maxPromptActions) {
      const point = tapBox(control, action.box, observation);
      await control.tap(point.x, point.y);
      await control.flush();
      promptActions.push({ label: action.label, point });
      promptActionCount += 1;
      stableObservations = 0;
      await sleep(options.promptSettleMs);
      state.counter += 1;
      observation = await screenshotAndOcr(phone, worker, directory, state.counter);
      observation.label = 'gaode-after-prompt';
      continue;
    }

    if (gaodeMapReady(observation.items) && !findPromptAction(observation)) {
      stableObservations += 1;
      if (stableObservations >= options.stableObservations) {
        return { ready: observation, promptActions };
      }
    } else {
      stableObservations = 0;
    }

    await sleep(options.pollMs);
    state.counter += 1;
    observation = await screenshotAndOcr(phone, worker, directory, state.counter);
    observation.label = 'gaode-initializing';
  }

  const detail = observation?.text?.slice(0, 1000) || 'no OCR observation';
  throw new Error(
    `高德地图初始化超时（已处理弹窗 ${promptActionCount} 个）：${detail}`,
  );
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }
  if (process.env.YUNMOMO_CONFIRM_GAODE_INIT !== 'YES' && !process.argv.includes('--execute')) {
    throw new Error(
      '脚本7会打开高德地图、处理权限弹窗并发送 HOME；确认执行请设置 '
      + 'YUNMOMO_CONFIRM_GAODE_INIT=YES 或传入 --execute',
    );
  }

  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID);
  const options = {
    pollMs: numberOr(process.env.YUNMOMO_OCR_POLL_MS, DEFAULT_POLL_MS),
    homeTimeoutMs: numberOr(process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
    appTimeoutMs: numberOr(process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    openAttemptTimeoutMs: numberOr(
      process.env.YUNMOMO_GAODE_OPEN_TIMEOUT_MS,
      DEFAULT_OPEN_ATTEMPT_TIMEOUT_MS,
    ),
    initTimeoutMs: numberOr(process.env.YUNMOMO_GAODE_INIT_TIMEOUT_MS, DEFAULT_INIT_TIMEOUT_MS),
    promptSettleMs: numberOr(process.env.YUNMOMO_GAODE_PROMPT_SETTLE_MS, DEFAULT_PROMPT_SETTLE_MS),
    appVisibleMs: numberOr(process.env.YUNMOMO_GAODE_VISIBLE_MS, DEFAULT_APP_VISIBLE_MS),
    stableObservations: numberOr(
      process.env.YUNMOMO_GAODE_STABLE_OBSERVATIONS,
      DEFAULT_STABLE_OBSERVATIONS,
    ),
    maxPromptActions: numberOr(process.env.YUNMOMO_GAODE_MAX_PROMPTS, 12),
    maxPagesPerDirection: numberOr(
      process.env.YUNMOMO_MAX_HOME_PAGES,
      DEFAULT_MAX_PAGES_PER_DIRECTION,
    ),
  };

  const client = new YunmomoClient({ timeoutMs: 100000 });
  const devices = await client.listDevices({ size: 50000 });
  const target = devices.records.find(record => deviceIdOf(record) === targetDeviceId);
  if (!target) throw new Error('所选设备不在当前账号设备列表中: ' + targetDeviceId);

  const phone = client.device(targetDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const directory = await require('../../automation/screen').createOcrDirectory('yunmomo-script7-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let homeRestored = false;

  try {
    await control.connect();
    await runGaodeWorkflow({
      phone,
      control,
      worker,
      directory,
      state,
      options,
      targetDeviceId,
      targetDeviceName: formatDeviceLabel(target)
    });
    homeRestored = true;
  } finally {
    if (!homeRestored && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
      try {
        await sendHome(control);
        homeRestored = true;
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

async function runGaodeWorkflow({ phone, control, worker, directory, state = { counter: 0 }, options = {}, targetDeviceId, targetDeviceName = '设备' }) {
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
    gaodeTargetBox,
    '高德地图',
  );
  const opened = await openGaode(phone, control, worker, directory, state, found, options);
  const initialized = await initializeGaode(
    phone,
    control,
    worker,
    directory,
    state,
    opened.opened,
    options,
  );

  await sleep(options.appVisibleMs || DEFAULT_APP_VISIBLE_MS);
  const finalHome = await confirmHome(phone, control, worker, directory, state, {
    ...options,
    homeConfirmation: {
      settleMs: 300,
      firstAttemptTimeoutMs: 900,
      retryDelayMs: 300,
      retryTimeoutMs: 1500,
      pollMs: 300,
      allowClipboardToast: true,
    },
  });
  const finalAnchors = homeAnchorMatches(finalHome.items);
  const homeRestored = finalAnchors.length >= 2;
  const success = gaodeMapReady(initialized.ready.items) && homeRestored;

  const result = {
    ok: success,
    script: '高德初始化',
    targetDeviceId,
    targetDeviceName,
    ocr: 'RapidOCR (local worker)',
    initialHomeAnchors: homeAnchorMatches(home.items),
    appLocated: true,
    appTap: opened.point,
    appTapRetried: opened.retried,
    appNavigationRecoveries: state.appNavigationRecoveries ?? [],
    initialized: gaodeMapReady(initialized.ready.items),
    promptActions: initialized.promptActions,
    initializedText: initialized.ready.text.slice(0, 600),
    finalHomeAnchors: finalAnchors,
    homeRestored,
    homeReturnElapsedMs: finalHome.homeConfirmation?.elapsedMs,
    homeReturnAttempts: finalHome.homeConfirmation?.attempts,
    screenshotObservations: state.counter,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    throw new Error('高德地图初始化未完全成功或未能成功恢复主屏幕');
  }
  if (state) {
    state.lastObservation = finalHome;
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
    openAttemptTimeoutMs: numberOr(process.env.YUNMOMO_OPEN_ATTEMPT_TIMEOUT_MS, DEFAULT_OPEN_ATTEMPT_TIMEOUT_MS),
    initTimeoutMs: numberOr(process.env.YUNMOMO_GAODE_INIT_TIMEOUT_MS, DEFAULT_INIT_TIMEOUT_MS),
    promptSettleMs: numberOr(process.env.YUNMOMO_PROMPT_SETTLE_MS, DEFAULT_PROMPT_SETTLE_MS),
    appVisibleMs: numberOr(process.env.YUNMOMO_GAODE_APP_VISIBLE_MS, DEFAULT_APP_VISIBLE_MS),
    stableObservations: numberOr(process.env.YUNMOMO_STABLE_OBSERVATIONS, DEFAULT_STABLE_OBSERVATIONS),
    maxPromptActions: numberOr(process.env.YUNMOMO_GAODE_MAX_PROMPTS, DEFAULT_MAX_PROMPT_ACTIONS),
    maxPagesPerDirection: numberOr(process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
    ...(context.options || {})
  };

  const targetDir = directory || path.join(PROJECT_ROOT, 'logs', 'screenshots', 'session');
  await fs.mkdir(targetDir, { recursive: true });

  return await runGaodeWorkflow({
    phone,
    control,
    worker,
    directory: targetDir,
    state: state || { counter: 0 },
    options,
    targetDeviceId: phone.deviceId,
    targetDeviceName: formatDeviceLabel(target)
  });
}

openGaode = require('../../automation/timing').timed('workflow.initialize-gaode.openGaode', openGaode);
initializeGaode = require('../../automation/timing').timed('workflow.initialize-gaode.initializeGaode', initializeGaode);
runGaodeWorkflow = require('../../automation/timing').timed('workflow.initialize-gaode.runWorkflow', runGaodeWorkflow);
main = require('../../automation/timing').timedScript('script.src.workflows.v3.initialize-gaode', main);

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  runStep,
  runGaodeWorkflow,
  gaodeTargetBox,
  gaodeLaunchEvidence,
  gaodeMapReady,
  findPromptAction,
};
