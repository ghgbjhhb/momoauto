'use strict';

/**
 * MOMO 一键上号工作流 (第一阶段)
 *
 * 业务流程规范（严格参照 momo-contact-sync 与 momo-ai-reply 工业级标准）：
 * 1. 设备与控制通道就绪，记录起始现场截图；
 * 2. 状态机识别与执行：
 *    - 若在桌面：定位「MOMO陌陌」图标并点击唤起应用；
 *    - 若出现首次启动隐私弹窗「欢迎使用MOMO陌陌APP」：定位并点击「同意」；
 *    - 若处于登录主界面：精准定位绿色「微信登录」按钮并点击；
 *    - 若弹出「用户使用协议」提示框：定位并点击蓝底「同意」按钮；
 * 3. 动作发出后上一轮观察证据立即强制失效，杜绝 TOCTOU 时差误判；
 * 4. 关键里程碑全程截图留痕存盘归档；
 * 5. 止于同意协议，保留当前页面，报告第一阶段执行完成并等待后续指令。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROJECT_ROOT, redact } = require('../../automation/runtime');
const { YunmomoClient } = require('../../index');
const shared = require('../../automation/screen');

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
  tapBox,
  homeAnchorMatches,
} = shared;

const DEFAULT_DEVICE_ID = '2002637309737881601';
const DEFAULT_POLL_MS = 700;
const DEFAULT_TIMEOUT_MS = 60000;

function formatLogTime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

function createLogger(logFilePath) {
  return {
    logPath: logFilePath,
    console(msg) {
      console.log(`${formatLogTime()} ${msg}`);
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

/**
 * 采集关键里程碑截图并存盘
 */
async function captureMilestoneScreenshot(phone, dir, filename, desc, log = null) {
  if (!phone || typeof phone.screenshot !== 'function' || !dir) return null;
  try {
    const res = await phone.screenshot({ level: 2 }).catch(() => null);
    if (!res?.data) return null;
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${filename}.png`);
    await fs.writeFile(filePath, res.data);
    const rel = path.relative(PROJECT_ROOT, filePath);
    if (log) log.console(`【截图记录】：${desc} -> ${rel}`);
    return filePath;
  } catch {
    return null;
  }
}

function matchesDevice(record, targetId) {
  if (!record) return false;
  const id = deviceIdOf(record);
  if (id !== targetId) return false;
  const sdk = String(record.sdkVersion || '').trim().toLowerCase();
  return !sdk || sdk === 'v2';
}

// 桌面图标标签查找：仅匹配单行短标签，排除“欢迎使用MOMO陌陌APP”等长标题
function findMomoLauncherIcon(items) {
  return items.find(it => {
    const norm = normalizeText(it.text);
    return (norm === 'MOMO陌陌' || norm === '陌陌' || norm === 'MOMO') && it.text.length <= 6;
  }) || null;
}

// 系统桌面判定：必须具备系统桌面特征，且严禁把带有弹窗或登录特征的页面误判为桌面
function isLauncherScreen(items) {
  const hasDialogOrLogin = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('欢迎使用') || t.includes('输入手机号码') || t.includes('用户使用协议') || t.includes('微信号');
  });
  if (hasDialogOrLogin) return false;
  return homeAnchorMatches(items).length >= 2 || (
    Boolean(findStrictPhrase(items, '微信')) &&
    Boolean(findStrictPhrase(items, '设置')) &&
    Boolean(findMomoLauncherIcon(items))
  );
}

// 首次启动隐私弹窗「欢迎使用MOMO陌陌APP」
function isPrivacyDialog(items) {
  const hasTitle = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('欢迎使用MOMO') || t.includes('陌陌隐私权政策') || t.includes('规范地收集');
  });
  const hasAgree = items.some(it => normalizeText(it.text) === '同意');
  return hasTitle && hasAgree;
}

function findPrivacyAgreeBox(items) {
  const agrees = items.filter(it => normalizeText(it.text) === '同意');
  return agrees[0] || null;
}

// 陌陌登录主页面
function isLoginPage(items) {
  if (isLauncherScreen(items)) return false;
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('想认识的新朋友') || t.includes('输入手机号码') || t.includes('获取验证码') || t.includes('插入手机号码');
  });
}

// 用户使用协议弹窗
function isUserAgreementDialog(items) {
  if (isLauncherScreen(items)) return false;
  const hasTitle = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('用户使用协议') || (t.includes('阅读并同意') && t.includes('陌陌用户协议'));
  });
  const hasAgree = items.some(it => normalizeText(it.text) === '同意');
  return hasTitle || (hasAgree && items.some(it => normalizeText(it.text).includes('暂不同意')));
}

function findUserAgreementAgreeBox(items) {
  const agrees = items.filter(it => normalizeText(it.text) === '同意');
  if (!agrees.length) return null;
  const disagree = items.find(it => normalizeText(it.text).includes('暂不同意'));
  if (disagree) {
    const disagreeY = disagree.centerY ?? (disagree.top + disagree.bottom) / 2;
    const above = agrees.filter(it => {
      const cy = it.centerY ?? (it.top + it.bottom) / 2;
      return cy < disagreeY;
    });
    if (above.length) return above[0];
  }
  return agrees[0];
}

// 最终完成状态（已进入微信授权界面或已进入个人资料填写界面）
function isStep1FinishedState(items) {
  if (isLauncherScreen(items)) return false;
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('登录微信') || t.includes('微信号QQ号') || t.includes('同意并登录') ||
           t.includes('你的性别是') || t.includes('让大家了解下你是男生还是女生');
  });
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
  const screenshotsDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'login-momo', runId);
  const ocrDir = await shared.createOcrDirectory('yunmomo-momo-login-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let lastScreenshotPath = null;

  try {
    await control.connect();
    await log.file('Control connected successfully', { screen: `${control.screenWidth}x${control.screenHeight}` });

    // 1. 观察当前屏幕
    log.console('[1/4] 正在分析当前屏幕状态...');
    let obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-inspect-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '01-initial-inspect', '初始分析画面', log);

    // 检查是否已经处于第一阶段完成后的界面
    if (isStep1FinishedState(obs.items)) {
      log.console('[1/4] 检测到当前已处于微信授权或登录后资料页，第一阶段目标已达成。');
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '07-final-state', '已处于目标完成页', log);
      return { ok: true, state: 'completed', screenshotsDir, lastScreenshotPath };
    }

    // 若不在陌陌任何界面，则回桌面打开应用
    const inMomoFlow = isPrivacyDialog(obs.items) || isLoginPage(obs.items) || isUserAgreementDialog(obs.items);
    if (!inMomoFlow) {
      log.console('[1/4] 当前未处于陌陌界面，正在回到桌面...');
      if (!isLauncherScreen(obs.items)) {
        await control.home();
        await control.flush();
        await sleep(1000);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-home-${state.counter++}`);
      }
      await captureMilestoneScreenshot(phone, screenshotsDir, '02-launcher-screen', '桌面基准页', log);

      log.console('[1/4] 正在桌面定位应用“MOMO陌陌”...');
      const iconItem = findMomoLauncherIcon(obs.items);
      if (!iconItem) {
        throw new Error('桌面未找到“MOMO陌陌”应用图标标签');
      }

      // 图标在文字上方 55px（在 360x640 下约 -55）
      const clickPoint = tapBox(control, iconItem, obs, -55);
      log.console(`[2/4] 点击应用图标启动陌陌 (坐标: x=${clickPoint.x}, y=${clickPoint.y})...`);
      await control.tap(clickPoint.x, clickPoint.y);
      await control.flush();

      // 动作后旧证据立即作废，等待应用启动渲染
      await sleep(2500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step2-after-open-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '03-app-opened', '应用打开响应画面', log);
    } else {
      log.console('[1/4] 当前已处于陌陌界面，直接推进流程。');
    }

    // 2. 处理可能出现的首次启动隐私政策弹窗「欢迎使用MOMO陌陌APP」
    if (isPrivacyDialog(obs.items)) {
      log.console('[2/4] 检测到首次启动隐私政策弹窗「欢迎使用MOMO陌陌APP」，准备点击「同意」...');
      const agreeBox = findPrivacyAgreeBox(obs.items);
      if (!agreeBox) throw new Error('检测到隐私政策弹窗，但未找到「同意」按钮');

      const point = tapBox(control, agreeBox, obs);
      log.console(`[2/4] 点击隐私弹窗「同意」按钮 (坐标: x=${point.x}, y=${point.y})`);
      await control.tap(point.x, point.y);
      await control.flush();
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '04-privacy-agreed', '已点击隐私政策同意', log);

      // 动作后旧证据作废，等待开屏过渡并进入登录页
      await sleep(2500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step2-after-privacy-${state.counter++}`);
    }

    // 3. 等待并确认登录主界面
    const loginDeadline = Date.now() + 15000;
    while (!isLoginPage(obs.items) && !isUserAgreementDialog(obs.items) && !isStep1FinishedState(obs.items) && Date.now() < loginDeadline) {
      log.console('[3/4] 正在等待陌陌登录页面渲染...');
      await sleep(DEFAULT_POLL_MS);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-wait-login-${state.counter++}`);
    }

    if (isStep1FinishedState(obs.items)) {
      log.console('[3/4] 检测到已跳过二次确认直接进入后续阶段，第一阶段目标达成。');
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '07-final-state', '已处于目标完成页', log);
      return { ok: true, state: 'completed', screenshotsDir, lastScreenshotPath };
    }

    // 4. 在登录主界面点击绿色「微信登录」按钮
    if (isLoginPage(obs.items)) {
      log.console('[3/4] 已确认处于陌陌登录界面，正在定位微信登录图标...');
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '05-login-page', '登录主界面就绪', log);

      // 微信登录图标物理坐标精准计算：居于右侧（宽度比 0.585），底部靠下（高度比 0.887）
      const wechatX = Math.round(control.screenWidth * 0.585);
      const wechatY = Math.round(control.screenHeight * 0.887);

      log.console(`[3/4] 正在点击微信登录图标 (物理坐标: x=${wechatX}, y=${wechatY})...`);
      await control.tap(wechatX, wechatY);
      await control.flush();

      // 动作后旧证据作废，等待弹出使用协议
      await sleep(1800);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-after-wechat-${state.counter++}`);
    }

    // 5. 处理「用户使用协议」提示框
    const agreementDeadline = Date.now() + 15000;
    while (!isUserAgreementDialog(obs.items) && !isStep1FinishedState(obs.items) && Date.now() < agreementDeadline) {
      log.console('[4/4] 正在等待「用户使用协议」提示框弹出...');
      await sleep(DEFAULT_POLL_MS);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step4-wait-agreement-${state.counter++}`);
    }

    if (isUserAgreementDialog(obs.items)) {
      log.console('[4/4] 检测到「用户使用协议」弹窗，正在定位蓝底「同意」按钮...');
      const agreeBox = findUserAgreementAgreeBox(obs.items);
      if (!agreeBox) throw new Error('检测到用户使用协议弹窗，但未找到「同意」按钮');

      const point = tapBox(control, agreeBox, obs);
      log.console(`[4/4] 点击协议弹窗「同意」按钮 (坐标: x=${point.x}, y=${point.y})`);
      await control.tap(point.x, point.y);
      await control.flush();
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '06-agreement-agreed', '已点击使用协议同意', log);

      // 动作后旧证据作废，等待界面响应授权
      await sleep(2500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step4-after-agree-${state.counter++}`);
    } else if (isStep1FinishedState(obs.items)) {
      log.console('[4/4] 点击微信登录后已直接进入后续授权界面。');
    }

    // 6. 截取并保存第一阶段最终状态
    log.console('[4/4] 第一阶段流程已执行完毕（打开陌陌 -> 点击微信登录 -> 点击同意协议）。');
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '07-final-state', '第一阶段最终保持画面', log);

    return {
      ok: true,
      state: 'completed',
      runId,
      screenshotsDir,
      lastScreenshotPath,
    };
  } catch (error) {
    if (phone) {
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '99-error-snapshot', '失败现场截图', log);
    }
    throw Object.assign(error, { screenshotsDir, lastScreenshotPath });
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

function printSummary(result, duration, error = null) {
  console.log('\n' + '='.repeat(60));
  if (result?.ok) {
    console.log('【执行结果】：成功');
    console.log('【任务名称】：陌陌一键上号 (第一阶段)');
    console.log('【退出状态码】：0');
    console.log(`【完成步骤】：已完成打开陌陌、点击微信登录与点击同意协议`);
    console.log('【当前状态】：保留当前界面，等待下一步指令');
    if (result.lastScreenshotPath) {
      console.log(`【现场截图】：${path.relative(PROJECT_ROOT, result.lastScreenshotPath)}`);
    }
    if (result.screenshotsDir) {
      console.log(`【截图归档】：${path.relative(PROJECT_ROOT, result.screenshotsDir)}`);
    }
    console.log(`【执行耗时】：${duration} 秒`);
  } else {
    console.log('【执行结果】：失败');
    console.log('【任务名称】：陌陌一键上号 (第一阶段)');
    console.log('【退出状态码】：1');
    console.log(`【失败原因】：${error?.message || '未知错误'}`);
    const shotPath = error?.lastScreenshotPath || result?.lastScreenshotPath;
    if (shotPath) {
      console.log(`【现场截图】：${path.relative(PROJECT_ROOT, shotPath)}`);
    }
    const dir = error?.screenshotsDir || result?.screenshotsDir;
    if (dir) {
      console.log(`【截图归档】：${path.relative(PROJECT_ROOT, dir)}`);
    }
    console.log(`【执行耗时】：${duration} 秒`);
  }
  console.log('='.repeat(60) + '\n');
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
    printSummary(result, duration, null);
    process.exitCode = 0;
  } catch (error) {
    const duration = ((Date.now() - startMs) / 1000).toFixed(2);
    printSummary(null, duration, error);
    process.exitCode = 1;
    throw error;
  }
}

module.exports = {
  main,
  runMomoLogin,
  isPrivacyDialog,
  isLoginPage,
  isUserAgreementDialog,
};
