'use strict';

/**
 * MOMO 一键上号全流程工作流 (阶段一：打开陌陌/微信登录/丫丫授权 + 阶段二：资料完善/头像上传/到达手机绑定停靠)
 *
 * 业务流程规范（严格参照 GEMINI.md 核心守则）：
 * 1. 桌面搜寻与启动：通过 findApp 在桌面左右多页搜寻「MOMO陌陌」并点击唤起；
 * 2. 状态机识别与执行：
 *    - 若出现首次启动隐私弹窗「欢迎使用MOMO陌陌APP」：定位并点击「同意」；
 *    - 若处于登录主界面：精准定位绿色「微信登录」按钮并点击；
 *    - 若弹出「用户使用协议」提示框：定位并点击蓝底「同意」按钮；
 * 3. 丫丫授权：调用丫丫登录工作流（复扫模式 relogin 或 direct），在历史订单中精准检索并点击复扫；
 * 4. 资料完善与头像配置（第二阶段已无缝合并）：
 *    - 选择女生 -> 清空微信旧网名并填入新女名（默认“菲菲菲”） -> 拟人仿真滑动生日滚轮并确定 -> 下一步；
 *    - 点击头像热区 -> 监听下载网速（<500KB/s自动记录并关闭代理恢复直连） -> 授权前云盘随机挑选2张图片传输至手机 -> 点击权限允许；
 *    - 自动选择相册第一张头像图片 -> 若弹出素材包更新提示自动点确认 -> 裁切图片确认 -> 滤镜美化页面出现完成时先加回原有代理，再点击完成；
 *    - 返回头像页后点击底部的「进入陌陌」；
 *    - 最终到达「手机绑定」界面（出现“绑定手机号”/“输入手机号码”），全流程圆满达成并安全停下！
 * 5. 断点自愈与防卡死：若任何步骤中途已进入资料页或手机绑定页，直接平滑衔接推进或直接安全停靠。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { YunmomoClient } = require('../../index');
const shared = require('../../automation/screen');
const { logAuthBudget, recordAuthStart } = require('../../automation/auth-session');

const {
  numberOr,
  sleep,
  deviceIdOf,
  findPhrase,
  findStrictPhrase,
  normalizeText,
  RapidOcrWorker,
  screenshotAndOcr,
  findApp,
  sendHome,
  clearAllRecentTasks,
  tapBox,
  homeAnchorMatches,
} = shared;

const DEFAULT_DEVICE_ID = '2002637309737881601';
const DEFAULT_POLL_MS = 700;
const DEFAULT_TARGET_TIME = '16:05';
// TODO: 当前默认使用【历史复扫模式 (relogin)】，方便下次随时修改切换为【直接一键授权模式 (direct)】
const DEFAULT_YAYA_MODE = 'relogin';
// TODO: 当前默认女网名“菲菲菲”，方便后续随时接入外部词库动态生成网名
const DEFAULT_NICKNAME = '菲菲菲';

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
    },
    async init() {},
    get relativeLogPath() {
      return logFilePath ? path.relative(PROJECT_ROOT, logFilePath).replace(/\\/g, '/') : '';
    }
  };
}

/**
 * 采集关键里程碑截图并存盘（静默写入文件与日志，不刷屏终端）
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
    if (log?.file) await log.file(`Screenshot saved: ${desc}`, { file: rel });
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

// 桌面图标标签查找：仅匹配短标签，排除“欢迎使用MOMO陌陌APP”等长标题
function momoTargetBox(items) {
  for (const item of items) {
    const norm = normalizeText(item.text);
    if ((norm === 'MOMO陌陌' || norm === '陌陌' || norm === 'MOMO') && item.text.length <= 6) {
      return item;
    }
  }
  for (const item of items) {
    const norm = normalizeText(item.text);
    if (norm.includes('陌陌') && !norm.includes('欢迎') && !norm.includes('协议') && !norm.includes('政策') && item.text.length <= 8) {
      return item;
    }
  }
  return null;
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
    Boolean(findStrictPhrase(items, '设置'))
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

// 陌陌动态信息流浏览页（冷启动时若未登录可能出现带“注册/登录”浮动按钮的动态页）
function isMomoFeedScreen(items) {
  if (isLauncherScreen(items)) return false;
  const hasFeedContent = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('发动态') || t.includes('动态') || t.includes('开云体育') || t.includes('打招呼');
  });
  const hasFeedLogin = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('注册/登录') || t.includes('注册登录');
  });
  return hasFeedContent && hasFeedLogin;
}

function findFeedLoginButton(items) {
  return items.find(it => {
    const t = normalizeText(it.text);
    return t.includes('注册/登录') || t.includes('注册登录');
  }) || null;
}

// 陌陌登录主页面
function isLoginPage(items) {
  if (isLauncherScreen(items)) return false;
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('想认识的新朋友') ||
      t.includes('想认识的那个人') ||
      t.includes('输入手机号码') ||
      t.includes('箍入手机号码') ||
      t.includes('编入手机号码') ||
      t.includes('获取验证码') ||
      t.includes('插入手机号码');
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

// 资料填写阶段（已完成微信登录授权）
function isProfileSetupStage(items) {
  if (isLauncherScreen(items)) return false;
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('你的性别是') ||
      t.includes('男生还是女生') ||
      t.includes('你的昵称和生日是') ||
      t.includes('最后上传一张头像') ||
      t.includes('相册') ||
      t.includes('裁切图片') ||
      t.includes('进入陌陌');
  });
}

// 终态判定：已进入手机绑定界面（或陌陌首页）
function isFinalPhoneBindScreen(items) {
  if (isLauncherScreen(items)) return false;
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('手机绑定') ||
      t.includes('绑定手机号') ||
      t.includes('输入手机号码') ||
      t.includes('切换登录账号') ||
      t.includes('附近的人');
  });
}


/**
 * 陌陌自愈复扫闭环：当遇到“请重新授权”时，自动清后台 -> 重新打开陌陌 -> 动态页点登录 -> 微信登录 -> 丫丫复扫 -> 重置计时器
 */
async function recoverViaRescan(client, resolvedDeviceId, options, ctx) {
  const { phone, control, worker, ocrDir, state, screenshotsDir, log, targetTime, yayaMode } = ctx;
  log.console('[自愈恢复 1/4] 清除后台并返回桌面...');
  await clearAllRecentTasks(phone, control, worker, ocrDir, state, log);
  await sleep(1000);

  // 桌面打开陌陌
  log.console('[自愈恢复 2/4] 从桌面重新打开陌陌应用...');
  let obs = await screenshotAndOcr(phone, worker, ocrDir, 'recover-home-' + (state.counter++));
  const found = await findApp(
    phone, control, worker, ocrDir, state, obs,
    { maxPagesPerDirection: 5, pollMs: DEFAULT_POLL_MS },
    momoTargetBox,
    'MOMO陌陌'
  );
  if (!found?.box) throw new Error('桌面翻页未找到“MOMO陌陌”图标');
  const clickPoint = tapBox(control, found.box, found.observation, -55);
  await control.tap(clickPoint.x, clickPoint.y);
  await control.flush();
  await sleep(3000);

  obs = await screenshotAndOcr(phone, worker, ocrDir, 'recover-after-open-' + (state.counter++));

  // 如果进入动态信息流页，点击浮动注册/登录
  if (isMomoFeedScreen(obs.items)) {
    log.console('[自愈恢复 2/4] 点击动态页浮动「注册/登录」按钮...');
    const feedBtn = findFeedLoginButton(obs.items);
    if (feedBtn) {
      const pt = tapBox(control, feedBtn, obs);
      await control.tap(pt.x, pt.y);
    } else {
      await control.tap(Math.round(control.screenWidth * 0.5), Math.round(control.screenHeight * 0.84));
    }
    await control.flush();
    await sleep(2500);
    obs = await screenshotAndOcr(phone, worker, ocrDir, 'recover-after-feed-' + (state.counter++));
  }

  // 等待并点击绿色微信登录
  const wechatX = Math.round(control.screenWidth * 0.585);
  const wechatY = Math.round(control.screenHeight * 0.887);
  log.console('[自愈恢复 3/4] 点击微信登录...');
  await control.tap(wechatX, wechatY);
  await control.flush();
  await sleep(1800);
  obs = await screenshotAndOcr(phone, worker, ocrDir, 'recover-after-wechat-' + (state.counter++));

  // 处理使用协议弹窗
  if (isUserAgreementDialog(obs.items)) {
    log.console('[自愈恢复 3/4] 同意用户使用协议...');
    const agreeBox = findUserAgreementAgreeBox(obs.items);
    if (agreeBox) {
      const pt = tapBox(control, agreeBox, obs);
      await control.tap(pt.x, pt.y);
      await control.flush();
      await sleep(2500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, 'recover-after-agree-' + (state.counter++));
    }
  }

  // 唤起丫丫执行复扫
  log.console('[自愈恢复 4/4] 唤起丫丫执行历史订单复扫 (匹配: ' + targetTime + ')...');
  const { runYayaWorkflow } = require('./login-yaya');
  await runYayaWorkflow({
    client,
    deviceId: resolvedDeviceId,
    mode: 'relogin',
    targetTime,
    control,
    worker,
    logger: log,
  });

  log.console('[自愈恢复 4/4] 【复扫完成】已重新获取微信授权，8分钟生命周期已重置！');
  await sleep(2500);

  // 观察是否进入资料设置
  obs = await screenshotAndOcr(phone, worker, ocrDir, 'recover-final-' + (state.counter++));
  if (isProfileSetupStage(obs.items)) {
    log.console('[自愈恢复] 识别当前处于资料完善页，继续推进资料设置...');
    const { runSetupProfile } = require('./setup-profile');
    await runSetupProfile(client, resolvedDeviceId, {
      ...options,
      nickname: options.nickname || DEFAULT_NICKNAME,
      phone,
      control,
      worker,
    }, log);
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
  const targetTime = String(options.targetTime || process.env.YAYA_TARGET_TIME || DEFAULT_TARGET_TIME).trim();
  const yayaMode = String(options.yayaMode || process.env.YAYA_MODE || DEFAULT_YAYA_MODE).trim();
  const nickname = String(options.nickname || process.env.YUNMOMO_MOMO_NICKNAME || DEFAULT_NICKNAME).trim();
  const modeLabel = yayaMode === 'relogin' ? '历史复扫' : '直接授权';

  await log.file('Target device resolved', { deviceName, resolvedDeviceId, sdkVersion: target.sdkVersion, targetTime, yayaMode, nickname });

  log.console(`[目标设备] ${deviceName} (${resolvedDeviceId}) | V2 (安卓 12)`);
  log.console(`[执行操作] 陌陌一键上号 (登录授权 -> 资料完善 -> 头像上传 -> 手机绑定停靠)`);

  const phone = client.device(resolvedDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const runId = randomUUID();
  const screenshotsDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'login-momo', runId);
  const ocrDir = await shared.createOcrDirectory('yunmomo-momo-login-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let lastScreenshotPath = null;
  let yayaResult = null;
  let profileResult = null;

  try {
    await control.connect();
    await log.file('Control connected successfully', { screen: `${control.screenWidth}x${control.screenHeight}` });

    // 1. 观察当前屏幕
    log.console('[1/5] 分析当前屏幕状态...');
    let obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-inspect-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '01-initial-inspect', '初始分析画面', log);

    // 检查是否已经处于手机绑定界面
    if (isFinalPhoneBindScreen(obs.items)) {
      log.console('[1/5] 当前已处于手机绑定界面，直接推进手机号绑定阶段！');
      const { runBindPhone } = require('./bind-phone');
      let bindResult = await runBindPhone(client, resolvedDeviceId, {
        ...options,
        phoneNumber: options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE,
        verifyCode: options.verifyCode || process.env.YUNMOMO_MOMO_VERIFY_CODE,
        phone,
        control,
        worker,
      }, log);

      if (bindResult?.state === 'reauth_required') {
        log.console('[1/5] ⚠️ 检测到服务端返回“请重新授权”，触发自动复扫自愈机制！');
        await recoverViaRescan(client, resolvedDeviceId, options, {
          phone, control, worker, ocrDir, state, screenshotsDir, log, targetTime, yayaMode
        });
        log.console('[1/5] 复扫自愈完成，重新执行手机绑定提交...');
        bindResult = await runBindPhone(client, resolvedDeviceId, {
          ...options,
          phoneNumber: options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE,
          verifyCode: options.verifyCode || process.env.YUNMOMO_MOMO_VERIFY_CODE,
          phone,
          control,
          worker,
        }, log);
      }

      lastScreenshotPath = bindResult?.lastScreenshotPath || lastScreenshotPath;
      return {
        ok: bindResult?.ok,
        state: bindResult?.state || 'completed',
        runId,
        targetTime,
        nickname,
        bindResult,
        screenshotsDir,
        lastScreenshotPath,
      };
    }

    // 检查是否已处于资料填写阶段（已完成微信登录授权）
    const alreadyAuthed = isProfileSetupStage(obs.items);
    if (!alreadyAuthed) {
      // 若不在陌陌任何界面，则在桌面搜寻并打开应用
      const inMomoFlow = isPrivacyDialog(obs.items) || isLoginPage(obs.items) || isUserAgreementDialog(obs.items);
      if (!inMomoFlow) {
        log.console('[1/5] 打开陌陌应用...');
        if (!isLauncherScreen(obs.items)) {
          await sendHome(control);
          await sleep(800);
          obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-home-${state.counter++}`);
        }
        await captureMilestoneScreenshot(phone, screenshotsDir, '02-launcher-screen', '桌面基准页', log);

        const navOptions = {
          maxPagesPerDirection: 5,
          pollMs: DEFAULT_POLL_MS,
        };

        const found = await findApp(
          phone,
          control,
          worker,
          ocrDir,
          state,
          obs,
          navOptions,
          momoTargetBox,
          'MOMO陌陌'
        );

        if (!found?.box) {
          throw new Error('桌面翻页未找到“MOMO陌陌”应用图标标签');
        }

        // 图标在文字上方 55px（在 360x640 下约 -55）
        const clickPoint = tapBox(control, found.box, found.observation, -55);
        await control.tap(clickPoint.x, clickPoint.y);
        await control.flush();

        // 等待应用启动渲染
        await sleep(2500);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-after-open-${state.counter++}`);
        await captureMilestoneScreenshot(phone, screenshotsDir, '03-app-opened', '应用打开响应画面', log);

        // 若点击后仍在桌面，尝试点击文字框中心一次
        if (isLauncherScreen(obs.items)) {
          const retryPoint = tapBox(control, found.box, found.observation, 0);
          await control.tap(retryPoint.x, retryPoint.y);
          await control.flush();
          await sleep(2500);
          obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-after-open-retry-${state.counter++}`);
        }
      } else {
        log.console('[1/5] 当前已处于陌陌界面');
      }

      // 2. 处理可能出现的首次启动隐私政策弹窗「欢迎使用MOMO陌陌APP」
      if (isPrivacyDialog(obs.items)) {
        log.console('[2/5] 检测到首次启动隐私政策弹窗，确认同意...');
        const agreeBox = findPrivacyAgreeBox(obs.items);
        if (!agreeBox) throw new Error('检测到隐私政策弹窗，但未找到「同意」按钮');

        const point = tapBox(control, agreeBox, obs);
        await control.tap(point.x, point.y);
        await control.flush();
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '04-privacy-agreed', '已点击隐私政策同意', log);

        await sleep(2500);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step2-after-privacy-${state.counter++}`);
      }

      // 等待并确认登录主界面
      const loginDeadline = Date.now() + 15000;
      while (!isLoginPage(obs.items) && !isUserAgreementDialog(obs.items) && !isProfileSetupStage(obs.items) && !isFinalPhoneBindScreen(obs.items) && Date.now() < loginDeadline) {
        await sleep(DEFAULT_POLL_MS);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-wait-login-${state.counter++}`);
      }

      // 登录主界面点击绿色「微信登录」按钮
      if (isLoginPage(obs.items)) {
        log.console('[2/5] 点击微信登录...');
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '05-login-page', '登录主界面就绪', log);

        const wechatX = Math.round(control.screenWidth * 0.585);
        const wechatY = Math.round(control.screenHeight * 0.887);

        await control.tap(wechatX, wechatY);
        await control.flush();

        await sleep(1800);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-after-wechat-${state.counter++}`);
      }

      // 处理「用户使用协议」提示框
      const agreementDeadline = Date.now() + 15000;
      while (!isUserAgreementDialog(obs.items) && !isProfileSetupStage(obs.items) && !isFinalPhoneBindScreen(obs.items) && Date.now() < agreementDeadline) {
        await sleep(DEFAULT_POLL_MS);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-wait-agreement-${state.counter++}`);
      }

      if (isUserAgreementDialog(obs.items)) {
        log.console('[2/5] 同意登录协议...');
        const agreeBox = findUserAgreementAgreeBox(obs.items);
        if (!agreeBox) throw new Error('检测到用户使用协议弹窗，但未找到「同意」按钮');

        const point = tapBox(control, agreeBox, obs);
        await control.tap(point.x, point.y);
        await control.flush();
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '06-agreement-agreed', '已点击使用协议同意', log);

        await sleep(2500);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-after-agree-${state.counter++}`);
      }

      // 3. 丫丫登录授权
      if (!isProfileSetupStage(obs.items) && !isFinalPhoneBindScreen(obs.items)) {
        log.console(`[3/5] 丫丫${modeLabel}授权 (时间: ${targetTime})...`);
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '07-before-yaya-auth', '启动丫丫复扫前画面', log);

        const yayaLogger = {
          logPath: log.logPath,
          console(msg) {
            if (msg.includes('[目标设备]') || msg.includes('[运行模式]') || msg.includes('初始化：按 Home 键')) return;
            const simplified = msg.replace(/^\[\d\/\d\]\s*/, '');
            log.console(`[3/5] [丫丫] ${simplified}`);
          },
          file: (msg, extra) => log.file(msg, extra),
          init: () => {},
          get relativeLogPath() { return log.relativeLogPath || ''; }
        };

        const { runYayaWorkflow } = require('./login-yaya');
        yayaResult = await runYayaWorkflow({
          client,
          deviceId: resolvedDeviceId,
          mode: yayaMode, // TODO: 默认 relogin 复扫，方便下次随时修改为 direct
          targetTime,
          control,
          worker,
          logger: yayaLogger,
        });

        log.console('[3/5] 丫丫授权完成');
        await logAuthBudget(log, resolvedDeviceId, '微信授权完成');
        await sleep(2500);
      }
    } else {
      log.console('[1/5] 检测到当前已处于微信登录后阶段（资料完善界面），直接进入阶段二！');
      await logAuthBudget(log, resolvedDeviceId, '资料完善初始判定');
    }

    // 4 & 5. 第二阶段：资料完善与头像配置 (复用现有 phone, control, worker 管道)
    log.console('[4/5] 启动陌陌资料完善流程 (选择女生/网名/生日/选第一张头像/恢复代理)...');
    await logAuthBudget(log, resolvedDeviceId, '进入资料完善流程');
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '08-before-setup-profile', '进入资料完善前画面', log);

    const profileLogger = {
      logPath: log.logPath,
      console(msg) {
        if (msg.includes('[目标设备]') || msg.includes('[执行操作]')) return;
        const simplified = msg.replace(/^\[\d\/\d\]\s*/, '');
        log.console(`[4/5] [资料完善] ${simplified}`);
      },
      file: (msg, extra) => log.file(msg, extra),
      init: () => {},
      get relativeLogPath() { return log.relativeLogPath || ''; }
    };

    const { runSetupProfile } = require('./setup-profile');
    profileResult = await runSetupProfile(client, resolvedDeviceId, {
      ...options,
      nickname,
      phone,
      control,
      worker,
    }, profileLogger);

    log.console('[5/5] 资料完善完成，启动陌陌手机号绑定流程 (手机号打字/验证码过盾/打字提交)...');
    lastScreenshotPath = profileResult.lastScreenshotPath || lastScreenshotPath;

    const { runBindPhone } = require('./bind-phone');
    let bindResult = await runBindPhone(client, resolvedDeviceId, {
      ...options,
      phoneNumber: options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE,
      verifyCode: options.verifyCode || process.env.YUNMOMO_MOMO_VERIFY_CODE,
      phone,
      control,
      worker,
    }, log);

    // 检查是否遭遇“请重新授权” (生命周期超期自愈)
    if (bindResult?.state === 'reauth_required') {
      log.console('[5/5] ⚠️ 检测到服务端返回“请重新授权”，触发自动复扫自愈机制！');
      await recoverViaRescan(client, resolvedDeviceId, options, {
        phone, control, worker, ocrDir, state, screenshotsDir, log, targetTime, yayaMode
      });
      log.console('[5/5] 复扫自愈完成，重新执行手机绑定提交...');
      bindResult = await runBindPhone(client, resolvedDeviceId, {
        ...options,
        phoneNumber: options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE,
        verifyCode: options.verifyCode || process.env.YUNMOMO_MOMO_VERIFY_CODE,
        phone,
        control,
        worker,
      }, log);
    }

    lastScreenshotPath = bindResult?.lastScreenshotPath || lastScreenshotPath;
    log.console('[5/5] 【一键上号全流程大圆满达成】账号资料完善与手机号绑定已全部完成！');

    return {
      ok: bindResult?.ok,
      state: bindResult?.state || 'completed',
      runId,
      targetTime,
      nickname,
      yayaResult,
      profileResult,
      bindResult,
      screenshotsDir,
      lastScreenshotPath,
    };
  } catch (error) {
    if (phone) {
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '99-error-snapshot', '失败现场截图', log);
    }
    throw Object.assign(error, { screenshotsDir, lastScreenshotPath, yayaResult });
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
    targetTime: process.env.YAYA_TARGET_TIME || DEFAULT_TARGET_TIME,
    yayaMode: process.env.YAYA_MODE || DEFAULT_YAYA_MODE,
    nickname: process.env.YUNMOMO_MOMO_NICKNAME || DEFAULT_NICKNAME,
    phoneNumber: process.env.YUNMOMO_MOMO_PHONE || '17306728814',
    verifyCode: process.env.YUNMOMO_MOMO_VERIFY_CODE || '310742',
    projectCode: process.env.YUNMOMO_MOMO_PROJECT_CODE || '369990',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device-id') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.deviceId = val;
    } else if (a === '--target-time' || a === '--time') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.targetTime = val;
    } else if (a === '--yaya-mode' || a === '--mode') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.yayaMode = val;
    } else if (a === '--nickname' || a === '--name') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.nickname = val;
    } else if (a === '--phone' || a === '--number') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.phoneNumber = val;
    } else if (a === '--code' || a === '--verify-code') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.verifyCode = val;
    } else if (a === '--project-code' || a === '--project') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.projectCode = val;
    }
  }
  return opts;
}

function printSummary(result, duration, error = null) {
  console.log('\n' + '='.repeat(60));
  if (result?.ok) {
    console.log('【执行结果】：成功');
    console.log('【任务名称】：陌陌一键上号 (登录授权/资料完善/头像上传/手机绑定停靠)');
    console.log('【退出状态码】：0');
    console.log(`【完成步骤】：打开陌陌 -> 微信登录 -> 丫丫授权 -> 资料完善(女生/网名/生日) -> 头像配置(网速监控/云盘传图/裁切美化/加回代理) -> 手机绑定停下`);
    if (result.targetTime) {
      console.log(`【复扫订单】：${result.targetTime}`);
    }
    if (result.nickname) {
      console.log(`【设置网名】：${result.nickname}`);
    }
    if (result.profileResult?.proxyRecorded) {
      console.log(`【代理状态】：${result.profileResult.proxyRecorded}`);
    }
    console.log(`【执行耗时】：${duration} 秒`);
  } else {
    console.log('【执行结果】：失败');
    console.log('【任务名称】：陌陌一键上号 (登录授权/资料完善/头像上传/手机绑定停靠)');
    console.log('【退出状态码】：1');
    console.log(`【失败原因】：${error?.message || '未知错误'}`);
    const shotPath = error?.lastScreenshotPath || result?.lastScreenshotPath;
    if (shotPath) {
      console.log(`【现场截图】：${path.relative(PROJECT_ROOT, shotPath)}`);
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
      logger.console('[提示] 本脚本将打开陌陌、点击微信登录、同意协议并调用丫丫复扫。如需执行，请传入 --execute 参数。');
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

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
