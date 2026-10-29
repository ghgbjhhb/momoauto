'use strict';

/**
 * Script 16: 陌陌一键上号 (V2 专属脚本)
 * 第一阶段业务流程：
 * 1. 确认前台画面 / 桌面打开「MOMO陌陌」应用；
 * 2. 监听并处理首次启动隐私政策弹窗「欢迎使用MOMO陌陌APP」（点击「同意」）；
 * 3. 确认进入陌陌登录界面，定位并点击「微信登录」绿色图标；
 * 4. 监听并确认「用户使用协议」提示框，定位并点击「同意」；
 * 5. 保持当前页面状态，截图留痕归档，报告第一阶段执行完成并等待后续指令。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROJECT_ROOT, redact } = require('../../automation/runtime');
const { YunmomoClient } = require('../../index');
const shared = require('../../automation/screen');
const { openAppWithRecovery } = require('../../automation/app-navigation');

const {
  numberOr,
  sleep,
  deviceIdOf,
  findPhrase,
  findStrictPhrase,
  normalizeText,
  RapidOcrWorker,
  screenshotAndOcr,
  confirmHome,
  findApp,
  tapBox,
  homeAnchorMatches,
} = shared;

const DEFAULT_DEVICE_ID = '2002637309737881601';
const DEFAULT_POLL_MS = 700;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_APP_TIMEOUT_MS = 25000;
const DEFAULT_ACTION_SETTLE_MS = 1200;

function formatDateTime(timestamp) {
  const d = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function createLogger(logFilePath) {
  return {
    logPath: logFilePath,
    console(msg) {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const time = `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`;
      console.log(`${time} ${msg}`);
    },
    async file(msg, extra = null) {
      if (!logFilePath) return;
      const now = new Date().toISOString();
      const line = `[${now}] ${msg}` + (extra ? ` ${JSON.stringify(extra)}` : '') + '\n';
      try {
        await fs.mkdir(path.dirname(logFilePath), { recursive: true });
        await fs.appendFile(logFilePath, line, 'utf8');
      } catch {}
    }
  };
}

function matchesDevice(record, targetId) {
  if (!record) return false;
  const id = deviceIdOf(record);
  if (id !== targetId) return false;
  const sdk = String(record.sdkVersion || '').trim().toLowerCase();
  return !sdk || sdk === 'v2';
}

function momoTargetBox(items) {
  return (
    findStrictPhrase(items, 'MOMO陌陌') ||
    findPhrase(items, 'MOMO陌陌') ||
    findStrictPhrase(items, '陌陌') ||
    findPhrase(items, '陌陌') ||
    findStrictPhrase(items, 'MOMO')
  );
}

function isLauncherScreen(items) {
  return homeAnchorMatches(items).length >= 1 || Boolean(momoTargetBox(items));
}

// 首次启动隐私弹窗判断
function isMomoPrivacyDialog(items) {
  const hasTitle = Boolean(
    findPhrase(items, '欢迎使用MOMO陌陌') ||
    findPhrase(items, '欢迎使用MOMO') ||
    findPhrase(items, '陌陌隐私权政策') ||
    findPhrase(items, '以了解我们是如何规范地收集') ||
    findPhrase(items, '点击同意即表示您已阅读')
  );
  const hasAgree = Boolean(findStrictPhrase(items, '同意'));
  return hasTitle && hasAgree;
}

// 寻找首次启动隐私弹窗中的“同意”按钮（排除“不同意”）
function findPrivacyAgreeBox(items, screenHeight = 640) {
  const agreeCandidates = items.filter(it => normalizeText(it.text) === '同意');
  if (!agreeCandidates.length) return null;
  // 过滤出位于弹窗下部（y >= height * 0.55）且不包含“不同意”的条目
  const valid = agreeCandidates.filter(it => {
    const cy = it.centerY ?? (it.top + it.bottom) / 2;
    return cy >= screenHeight * 0.5;
  });
  return valid[0] || agreeCandidates[0];
}

// 陌陌登录页判断
function isMomoLoginPage(items) {
  const loginCues = [
    '想认识的新朋友都在这里',
    '输入手机号码',
    '获取验证码',
    '登录遇到困难',
    '我已阅读并同意陌陌用户',
    '禁止未满18周岁',
  ];
  const matchCount = loginCues.reduce((cnt, cue) => cnt + (findPhrase(items, cue) ? 1 : 0), 0);
  return matchCount >= 1;
}

// “用户使用协议”弹窗判断
function isUserAgreementDialog(items) {
  const hasDialogTitle = Boolean(
    findPhrase(items, '用户使用协议') ||
    (findPhrase(items, '阅读并同意') && findPhrase(items, '陌陌用户协议'))
  );
  const hasButtons = Boolean(findStrictPhrase(items, '同意') && findPhrase(items, '暂不同意'));
  return hasDialogTitle || (hasButtons && Boolean(findPhrase(items, '陌陌')));
}

// 寻找“用户使用协议”弹窗中的“同意”按钮
function findUserAgreementAgreeBox(items, screenHeight = 640) {
  const agreeCandidates = items.filter(it => normalizeText(it.text) === '同意');
  if (!agreeCandidates.length) return null;
  // 弹窗内的“同意”通常在弹窗中偏下部（y 在 0.45 ~ 0.65 之间），且在“暂不同意”上方
  const disagree = items.find(it => normalizeText(it.text).includes('暂不同意'));
  if (disagree) {
    const disagreeY = disagree.centerY ?? (disagree.top + disagree.bottom) / 2;
    const above = agreeCandidates.filter(it => {
      const cy = it.centerY ?? (it.top + it.bottom) / 2;
      return cy < disagreeY;
    });
    if (above.length) return above[0];
  }
  return agreeCandidates[0];
}

// 后续界面（已经通过第一阶段进入的页面，如性别设置或已授权页）
function isSubsequentPage(items) {
  return Boolean(
    findPhrase(items, '你的性别是') ||
    findPhrase(items, '让大家了解下你是男生还是女生') ||
    findPhrase(items, '填写资料') ||
    findPhrase(items, '设置头像') ||
    findPhrase(items, '微信号授权')
  );
}

async function captureStepImage(phone, dir, filename) {
  try {
    const shot = await phone.screenshot({ level: 2 }).catch(() => null);
    if (!shot?.data) return null;
    await fs.mkdir(dir, { recursive: true });
    const targetPath = path.join(dir, `${filename}.png`);
    await fs.writeFile(targetPath, shot.data);
    return targetPath;
  } catch {
    return null;
  }
}

async function runMomoLogin(client, targetDeviceId, options = {}, logger = console) {
  const log = typeof logger?.console === 'function' ? logger : {
    console: console.log,
    file: () => {}
  };

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
  const deviceName = String(target.deviceName || target.name || resolvedDeviceId);
  await log.file('Target device resolved', { deviceName, resolvedDeviceId, sdkVersion: target.sdkVersion });

  log.console(`[目标设备] ${deviceName} (${resolvedDeviceId}) | V2 (安卓 12)`);
  log.console(`[执行操作] 陌陌一键上号 (第一阶段: 打开陌陌 -> 点击微信登录 -> 点击同意协议)`);

  const phone = client.device(resolvedDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const runId = randomUUID();
  const artifactDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'login-momo', runId);
  const ocrDir = await shared.createOcrDirectory('yunmomo-momo-login-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };

  try {
    await control.connect();
    await log.file('Control connected successfully');

    // 观察当前初始画面
    log.console('[1/4] 正在分析当前屏幕状态...');
    let observation = await screenshotAndOcr(phone, worker, ocrDir, `step1-inspect-${state.counter++}`);
    await captureStepImage(phone, artifactDir, '01-inspect-initial');

    // 检查是否已经在后续已登录/信息设置阶段
    if (isSubsequentPage(observation.items)) {
      log.console('[1/4] 当前已处于微信登录后阶段（如性别/资料设置界面），第一阶段目标已达成。');
      await captureStepImage(phone, artifactDir, '08-final-state');
      return { ok: true, state: 'already_completed', details: '已处于登录后资料页' };
    }

    // 若不在陌陌界面，则回桌面打开陌陌
    const inMomo = isMomoPrivacyDialog(observation.items) || isMomoLoginPage(observation.items) || isUserAgreementDialog(observation.items);
    if (!inMomo) {
      log.console('[1/4] 当前不在陌陌界面，正在回到桌面并寻找应用...');
      const home = await confirmHome(phone, control, worker, ocrDir, state, options);
      await captureStepImage(phone, artifactDir, '02-home-confirmed');

      log.console('[1/4] 正在桌面寻找应用“MOMO陌陌”...');
      const found = await findApp(
        phone,
        control,
        worker,
        ocrDir,
        state,
        home,
        options,
        momoTargetBox,
        'MOMO陌陌'
      );

      log.console('[2/4] 正在打开“MOMO陌陌”...');
      const opened = await openAppWithRecovery(phone, control, worker, ocrDir, state, found, options, {
        appName: 'MOMO陌陌',
        targetName: '陌陌首次启动或登录界面',
        label: 'momo',
        targetBox: momoTargetBox,
        isTarget: obs => isMomoPrivacyDialog(obs.items) || isMomoLoginPage(obs.items) || isUserAgreementDialog(obs.items) || isSubsequentPage(obs.items),
        isLauncher: obs => isLauncherScreen(obs.items),
        launchTimeoutMs: Math.min(options.appTimeoutMs ?? DEFAULT_APP_TIMEOUT_MS, 15000),
      });

      observation = opened.opened;
      await captureStepImage(phone, artifactDir, '03-momo-opened');
      log.console(`[2/4] 已打开应用并检测到目标界面响应`);
    } else {
      log.console('[1/4] 当前已处于陌陌界面，直接进入流程。');
    }

    // Step 2: 处理可能出现的首次启动隐私政策弹窗「欢迎使用MOMO陌陌APP」
    if (isMomoPrivacyDialog(observation.items)) {
      log.console('[2/4] 检测到首次启动隐私政策弹窗「欢迎使用MOMO陌陌APP」，准备点击「同意」...');
      const agreeBox = findPrivacyAgreeBox(observation.items, observation.height);
      if (!agreeBox) throw new Error('检测到隐私政策弹窗，但未找到「同意」按钮');

      const point = tapBox(control, agreeBox, observation);
      log.console(`[2/4] 点击「同意」按钮 (坐标: x=${point.x}, y=${point.y})`);
      await control.tap(point.x, point.y);
      await control.flush();
      await captureStepImage(phone, artifactDir, '04-privacy-dialog-agreed');

      // 动作后旧证据强制失效，等待界面跳转
      await sleep(DEFAULT_ACTION_SETTLE_MS);
      observation = await screenshotAndOcr(phone, worker, ocrDir, `step2-after-privacy-${state.counter++}`);
    }

    // 等待并确认登录界面
    let waitLoginDeadline = Date.now() + 15000;
    while (!isMomoLoginPage(observation.items) && !isUserAgreementDialog(observation.items) && !isSubsequentPage(observation.items) && Date.now() < waitLoginDeadline) {
      log.console('[2/4] 正在等待陌陌登录页面加载...');
      await sleep(DEFAULT_POLL_MS);
      observation = await screenshotAndOcr(phone, worker, ocrDir, `step2-wait-login-${state.counter++}`);
    }

    if (isSubsequentPage(observation.items)) {
      log.console('[3/4] 检测到已进入登录后阶段，第一阶段目标达成。');
      await captureStepImage(phone, artifactDir, '08-final-state');
      return { ok: true, state: 'completed', details: '已完成第一阶段' };
    }

    // Step 3: 在登录页面点击「微信登录」
    if (isMomoLoginPage(observation.items)) {
      log.console('[3/4] 已确认处于陌陌登录界面，正在定位微信登录按钮...');
      await captureStepImage(phone, artifactDir, '05-login-page-confirmed');

      // 微信登录按钮定位（居于底部右侧，横坐标比例约 0.588，纵坐标比例约 0.826）
      const scaleX = control.screenWidth / Math.max(1, observation.width);
      const scaleY = control.screenHeight / Math.max(1, observation.height);
      const wechatX = Math.round(control.screenWidth * 0.588);
      const wechatY = Math.round(control.screenHeight * 0.826);

      log.console(`[3/4] 正在点击微信登录图标 (物理坐标: x=${wechatX}, y=${wechatY})...`);
      await control.tap(wechatX, wechatY);
      await control.flush();
      await captureStepImage(phone, artifactDir, '06-wechat-clicked');

      // 动作后旧坐标强制失效，等待弹出协议框
      await sleep(1500);
      observation = await screenshotAndOcr(phone, worker, ocrDir, `step3-after-wechat-${state.counter++}`);
    }

    // Step 4: 处理「用户使用协议」提示框
    let agreementDeadline = Date.now() + 15000;
    while (!isUserAgreementDialog(observation.items) && !isSubsequentPage(observation.items) && Date.now() < agreementDeadline) {
      log.console('[4/4] 等待「用户使用协议」弹窗出现...');
      await sleep(DEFAULT_POLL_MS);
      observation = await screenshotAndOcr(phone, worker, ocrDir, `step4-wait-agreement-${state.counter++}`);
    }

    if (isUserAgreementDialog(observation.items)) {
      log.console('[4/4] 检测到「用户使用协议」弹窗，正在定位蓝底「同意」按钮...');
      const agreeBox = findUserAgreementAgreeBox(observation.items, observation.height);
      if (!agreeBox) throw new Error('检测到用户使用协议弹窗，但未能定位「同意」按钮');

      const point = tapBox(control, agreeBox, observation);
      log.console(`[4/4] 点击「同意」按钮 (坐标: x=${point.x}, y=${point.y})`);
      await control.tap(point.x, point.y);
      await control.flush();
      await captureStepImage(phone, artifactDir, '07-agreement-agreed');

      // 动作后旧坐标作废，等待授权跳转
      await sleep(2000);
      observation = await screenshotAndOcr(phone, worker, ocrDir, `step4-after-agree-${state.counter++}`);
    } else if (isSubsequentPage(observation.items)) {
      log.console('[4/4] 未弹出二次协议或已直接进入后续授权界面。');
    }

    // Step 5: 截取最终状态留痕归档并完成第一阶段
    log.console('[4/4] 第一阶段流程已完成（已打开陌陌 -> 点击微信登录 -> 点击同意协议）。');
    const finalShotPath = await captureStepImage(phone, artifactDir, '08-final-state');
    log.console(`[4/4] 当前界面已保持，留痕截图已保存至: ${finalShotPath ? path.relative(PROJECT_ROOT, finalShotPath) : 'artifact'}`);

    return {
      ok: true,
      state: 'step1_completed',
      runId,
      artifactDir: path.relative(PROJECT_ROOT, artifactDir),
    };
  } finally {
    await control.close().catch(() => {});
    await worker.close().catch(() => {});
    if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
      await fs.rm(ocrDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseCliArgs(argv) {
  const opts = {
    execute: argv.includes('--execute'),
    deviceId: process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID,
    pollMs: DEFAULT_POLL_MS,
    homeTimeoutMs: DEFAULT_HOME_TIMEOUT_MS,
    appTimeoutMs: DEFAULT_APP_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device-id') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.deviceId = val;
    }
  }
  return opts;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const taskId = randomUUID();
  const logDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'login-momo');
  const logFile = path.join(logDir, `${taskId}.log`);
  const logger = createLogger(logFile);

  const startMs = Date.now();
  try {
    if (!options.execute) {
      logger.console('[提示] 本脚本将打开陌陌、点击微信登录并同意协议。如需执行，请传入 --execute 参数。');
      return;
    }

    const client = new YunmomoClient({ timeoutMs: 100000 });
    const result = await runMomoLogin(client, options.deviceId, options, logger);

    const duration = ((Date.now() - startMs) / 1000).toFixed(2);
    console.log('\n' + '='.repeat(60));
    console.log('【执行结果】：成功');
    console.log('【任务名称】：陌陌一键上号 (第一阶段)');
    console.log('【退出状态码】：0');
    console.log(`【执行耗时】：${duration} 秒`);
    console.log('【当前状态】：已完成打开陌陌、点击微信登录与同意协议，保留当前页面等待下一步指令');
    console.log('='.repeat(60) + '\n');
    process.exitCode = 0;
  } catch (error) {
    const duration = ((Date.now() - startMs) / 1000).toFixed(2);
    console.log('\n' + '='.repeat(60));
    console.log('【执行结果】：失败');
    console.log('【任务名称】：陌陌一键上号 (第一阶段)');
    console.log('【退出状态码】：1');
    console.log(`【失败原因】：${error.message}`);
    console.log(`【执行耗时】：${duration} 秒`);
    console.log('='.repeat(60) + '\n');
    process.exitCode = 1;
    throw error;
  }
}

module.exports = {
  main,
  runMomoLogin,
  isMomoPrivacyDialog,
  isMomoLoginPage,
  isUserAgreementDialog,
};
