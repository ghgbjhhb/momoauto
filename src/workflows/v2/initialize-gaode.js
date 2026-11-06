'use strict';

// Script 7: 打开高德地图并完成首次初始化 (V2 专属脚本)。
//
// 云机只提供视频流，因此启动应用、处理首次权限/提示和判断地图已就绪，
// 都通过 RapidOCR 找文字坐标；实际点击仍走现有云机控制通道。完成后会
// 先让高德界面稳定可见一小段时间，再发送 HOME 并确认回到桌面。
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { YunmomoClient } = require('../../index');
const { formatDeviceLabel } = require('../../automation/runtime');
const { PROJECT_ROOT } = require('../../automation/runtime');
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

const DEFAULT_DEVICE_ID = '1920787319565701122';
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

function matchesDevice(record, targetId) {
  if (!record) return false;
  const id = deviceIdOf(record);
  if (id !== targetId) return false;
  const sdk = String(record.sdkVersion || '').trim().toLowerCase();
  return !sdk || sdk === 'v2';
}

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
    '地图', '定位', '高德地图', '首页', '打车', '消息',
  ];
  return phrases.reduce((count, phrase) => count + (findPhrase(items, phrase) ? 1 : 0), 0);
}

function gaodeLaunchEvidence(items) {
  const mapControls = [
    '搜索', '路线', '导航', '我的', '附近', '驾车', '步行', '公交', '首页', '打车', '消息',
  ].reduce((count, phrase) => count + (findPhrase(items, phrase) ? 1 : 0), 0);
  const privacyOrPermission = Boolean(
    findPhrase(items, '隐私政策') ||
    findPhrase(items, '个人信息保护') ||
    findPhrase(items, '权限') ||
    findPhrase(items, '允许') ||
    findPhrase(items, '同意')
  );
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
    '搜索', '路线', '导航', '我的', '附近', '驾车', '步行', '公交', '图层', '更多', '首页', '打车', '消息',
  ].reduce((count, phrase) => count + (findStrictPhrase(items, phrase) ? 1 : 0), 0);
  return mapControls >= 2;
}

function promptCue(items) {
  const cues = [
    '权限', '允许', '隐私', '协议', '用户协议', '服务协议', '个人信息',
    '定位', '通知', '温馨提示', '提示', '更新', '版本', '授权', '政策',
    '高德地图', '功能推荐', '体验',
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

function findPromptAction(observation) {
  const items = observation?.items || [];
  if (findStrictPhrase(items, '添加到主屏幕') || findStrictPhrase(items, '轻触并按住此微件')) {
    const cancel = exactActionBox(items, ['取消']);
    return cancel ? { label: '取消快捷组件', box: cancel } : null;
  }
  const height = Number(observation?.height) || 640;
  const bottomHalf = item => item.centerY >= height * 0.42;

  // 安卓 12 及各平台系统权限文案（包含“允许”与常见OCR误识“充许”）
  const allowLabels = [
    '同意并继续', '同意并使用',
    '仅在使用该应用时允许', '仅在使用该应用时充许',
    '使用该应用时允许', '使用该应用时充许',
    '使用应用时允许', '使用应用时充许',
    '仅在使用中允许', '仅在使用中充许',
    '仅在使用时允许', '仅在使用时充许',
    '仅限这一次', '仅这一次', '仅此次允许',
    '始终允许', '始终充许', '允许', '充许',
  ];
  const dismissLabels = [
    '继续使用', '我知道了', '知道了', '稍后再说', '以后再说', '跳过',
    '关闭', '确定', '下一步', '继续', '暂不开启', '暂不体验', '暂不', '以后', '放弃',
  ];

  for (const label of allowLabels) {
    const box = exactActionBox(items, [label]);
    if (box && (bottomHalf(box) || promptCue(items))) return { label, box };
  }

  // 针对“仅在使用该应用时允许/充许”进行原生抗畸变防御（严格排除“不允许/不同意/拒绝/禁止”）
  if (promptCue(items)) {
    const isAllowLike = text => {
      const norm = normalizeText(text);
      if (norm.includes('不允许') || norm.includes('不同意') || norm.includes('拒绝') || norm.includes('禁止')) return false;
      return (
        (norm.includes('使用') && (norm.includes('允许') || norm.includes('充许'))) ||
        norm.includes('仅限这一次') || norm.includes('仅这一次') || norm.includes('仅此次')
      );
    };
    const candidates = items
      .filter(item => isAllowLike(item.text) && bottomHalf(item))
      .sort((a, b) => b.centerY - a.centerY);
    if (candidates[0]) {
      return { label: candidates[0].text, box: candidates[0] };
    }
  }

  const agree = exactActionBox(items, ['同意']);
  if (agree && (bottomHalf(agree) || promptCue(items))) return { label: '同意', box: agree };

  if (promptCue(items)) {
    for (const label of dismissLabels) {
      const box = exactActionBox(items, [label]);
      if (box && (bottomHalf(box) || ['关闭', '确定', '知道了', '跳过', '暂不开启', '暂不体验'].includes(label))) {
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

async function initializeGaode(phone, control, worker, directory, state, opened, options, logger) {
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
      logger?.file(`Found prompt action: "${action.label}" at (${point.x}, ${point.y})`, { action, point });
      logger?.console(`🎯 [3/4] 处理弹窗: "${action.label}" (第 ${promptActionCount + 1} 个)...`);

      await control.tap(point.x, point.y);
      await control.flush();
      promptActions.push({ label: action.label, point });
      promptActionCount += 1;
      stableObservations = 0;
      await sleep(options.promptSettleMs);
      state.counter += 1;
      observation = await screenshotAndOcr(phone, worker, directory, state.counter);
      observation.label = 'gaode-after-prompt';
      logger?.file(`OCR after prompt #${promptActionCount}`, { text: observation.text });
      continue;
    }

    if (gaodeMapReady(observation.items) && !findPromptAction(observation)) {
      stableObservations += 1;
      logger?.file(`Map ready stable observation #${stableObservations}/${options.stableObservations}`);
      if (stableObservations >= options.stableObservations) {
        logger?.console(`✅ [3/4] 地图首页已打开 (共处理 ${promptActionCount} 个弹窗)`);
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

class Logger {
  constructor(taskId) {
    this.taskId = taskId;
    this.logDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'initialize-gaode');
    this.logFile = path.join(this.logDir, `${taskId}.log`);
  }

  async init() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
      await fs.writeFile(this.logFile, `=== Gaode Map Init V2 Task Log [ID: ${this.taskId}] ===\nStarted: ${new Date().toISOString()}\n\n`, 'utf8');
    } catch {}
  }

  file(message, meta) {
    const time = new Date().toISOString();
    let text = `[${time}] ${message}`;
    if (meta !== undefined) {
      text += typeof meta === 'string' ? `\n${meta}` : `\n${JSON.stringify(meta, null, 2)}`;
    }
    fs.appendFile(this.logFile, text + '\n', 'utf8').catch(() => {});
  }

  console(message) {
    console.log(message);
    this.file(`[CONSOLE] ${message}`);
  }

  get relativeLogPath() {
    return path.relative(PROJECT_ROOT, this.logFile).replace(/\\/g, '/');
  }
}

async function ensureToken() {
  if (process.env.YUNMOMO_TOKEN) return process.env.YUNMOMO_TOKEN;
  try {
    const localEnvPath = path.join(PROJECT_ROOT, '.env.local');
    const content = await fs.readFile(localEnvPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('YUNMOMO_TOKEN=')) {
        const token = trimmed.slice('YUNMOMO_TOKEN='.length).trim();
        if (token) {
          process.env.YUNMOMO_TOKEN = token;
          return token;
        }
      }
    }
  } catch {}
  throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
}

async function main() {
  const taskId = process.env.YUNMOMO_TIMING_RUN_ID || process.env.RUN_ID || randomUUID();
  const logger = new Logger(taskId);
  await logger.init();

  if (process.argv.includes('--execute')) {
    process.env.YUNMOMO_CONFIRM_GAODE_INIT = 'YES';
  }

  logger.console(`[任务ID] ${taskId}`);

  try {
    await ensureToken();

    const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID).trim();
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
    let target = (devices.records || []).find(record => matchesDevice(record, targetDeviceId));
    if (!target && devices.records?.length > 0 && !process.env.YUNMOMO_DEVICE_ID) {
      target = (devices.records || []).find(record => {
        const sdk = String(record.sdkVersion || '').trim().toLowerCase();
        return sdk === 'v2';
      });
    }
    if (!target) throw new Error(`未找到匹配的 V2 设备: ${targetDeviceId}`);

    const resolvedDeviceId = deviceIdOf(target);
    const devLabel = (customParams && customParams.deviceName) ? customParams.deviceName : formatDeviceLabel(target);
    logger.file('Target device resolved', { deviceName, resolvedDeviceId, sdkVersion: target.sdkVersion });

    logger.console(`[目标设备] ${devLabel} | V2 (安卓 12)`);
    logger.console(`[执行操作] 高德地图首次启动与初始化`);

    if (process.env.YUNMOMO_CONFIRM_GAODE_INIT !== 'YES') {
      logger.console('[提示] 本脚本将打开高德地图、处理权限弹窗并返回桌面。如需执行，请传入 --execute 参数。');
      logger.console(`[完整日志] ${logger.relativeLogPath}`);
      return;
    }

    const phone = client.device(resolvedDeviceId);
    const control = await phone.openControl({ udid: target.udid });
    const directory = await require('../../automation/screen').createOcrDirectory('yunmomo-script7-');
    const worker = new RapidOcrWorker();
    const state = { counter: 0 };
    let homeRestored = false;

    try {
      await control.connect();
      logger.file('Control connected successfully');
      await runGaodeWorkflow({ phone, control, worker, directory, state, options, logger, deviceName, resolvedDeviceId });
      homeRestored = true;
    } finally {
      if (!homeRestored && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
        try {
          await sendHome(control);
          homeRestored = true;
          logger.file('Fallback sendHome executed in finally');
        } catch {
          // Preserve the original failure; cleanup below still runs.
        }
      }
      await worker.close();
      await control.close();
      if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
        await fs.rm(directory, { recursive: true, force: true });
      } else {
        logger.console(`[截图归档] ${directory}`);
      }
    }
  } catch (err) {
    logger.file('TASK EXCEPTION', { message: err.message, stack: err.stack });
    logger.console(`[执行结果] 失败: ${err.message}`);
    logger.console(`[完整日志] ${logger.relativeLogPath}`);
    throw err;
  }
}

async function runGaodeWorkflow({ phone, control, worker, directory, state = { counter: 0 }, options = {}, logger = defaultLogger(), deviceName = '设备', resolvedDeviceId = '' }) {
  if (!control.connected) {
    await control.connect();
    logger.file('Control connected successfully');
  }

  // 1. 确认主屏幕就绪
  logger.console('🏠 [1/4] 检查桌面状态...');
  const home = await confirmHome(phone, control, worker, directory, state, options);
  logger.file('Home confirmed', { anchors: homeAnchorMatches(home.items).length, ocrText: home.text });

  // 2. 寻找并打开高德地图
  logger.console('🔍 [2/4] 在桌面寻找高德地图...');
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
  logger.file('App located on launcher', { page: found.page, point: found.point });

  const opened = await openGaode(phone, control, worker, directory, state, found, options);
  logger.console('👆 [2/4] 已点击高德地图图标，等待启动...');
  logger.file('App opened observation', { text: opened.opened.text });

  // 3. 处理初始化权限弹窗与地图就绪
  logger.console('🎯 [3/4] 检查权限与隐私弹窗...');
  const initialized = await initializeGaode(
    phone,
    control,
    worker,
    directory,
    state,
    opened.opened,
    options,
    logger,
  );

  await sleep(options.appVisibleMs || DEFAULT_APP_VISIBLE_MS);

  // 4. 返回桌面并确认
  logger.console('🏠 [4/4] 地图已打开，正在返回桌面...');
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

  logger.file('Task execution summary', {
    success,
    promptActions: initialized.promptActions,
    finalAnchorsCount: finalAnchors.length,
    homeRestored,
    screenshotObservations: state.counter,
  });

  if (!success) {
    throw new Error('高德地图初始化未完全成功或未能成功恢复主屏幕');
  }

  logger.console('✅ 高德地图初始化完成，已回到桌面');
  if (resolvedDeviceId) {
    logger.console(`   📱 目标设备: ${devLabel}`);
  }
  logger.console(`   🎯 处理弹窗: ${initialized.promptActions.length} 个`);
  logger.console('✅ 执行成功');

  if (state) {
    state.lastObservation = finalHome;
  }
  return { success: true, initialized, finalHome };
}

function defaultLogger() {
  return {
    console: (...args) => console.log(...args),
    file: () => {},
    relativeLogPath: 'session'
  };
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
    logger: defaultLogger(),
    deviceName: target?.deviceName || target?.name || '云机',
    resolvedDeviceId: phone.deviceId
  });
}

openGaode = require('../../automation/timing').timed('workflow.initialize-gaode.openGaode', openGaode);
initializeGaode = require('../../automation/timing').timed('workflow.initialize-gaode.initializeGaode', initializeGaode);
runGaodeWorkflow = require('../../automation/timing').timed('workflow.initialize-gaode.runWorkflow', runGaodeWorkflow);
main = require('../../automation/timing').timedScript('script.src.workflows.v2.initialize-gaode', main);

if (require.main === module) {
  main().catch(error => {
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
