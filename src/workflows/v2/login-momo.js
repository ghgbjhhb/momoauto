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
const { generateGirlNickname } = require('../../automation/nickname-generator');
const { SmsService } = require('../../server/sms/service');

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
// 默认使用【直接一键授权模式 (direct)】；若遇到超时(>8分钟)或服务端提示“请重新授权”，脚本会自动触发【历史复扫模式 (relogin)】自愈
const DEFAULT_YAYA_MODE = 'direct';
// 默认女网名仅作随机生成失败时的兜底；正常每次运行由 python_workers/nickname 离线生成
const DEFAULT_NICKNAME = '菲菲菲';
// 命中这些关键字时触发随机网名生成（与任务配置表单默认值保持一致）
const AUTO_NICKNAME_KEYWORDS = new Set(['随机生成', '随机', '自动生成', '自动']);

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

// 系统权限弹窗判定与按钮定位（位置/存储/通知/设备权限，若出现自动点允许，若未出现秒过）
function isSystemPermissionDialog(items) {
  const fullText = items.map(it => normalizeText(it.text)).join('');
  const hasAllowBtn = items.some(it => {
    const t = normalizeText(it.text);
    return t === '允许' || t === '始终允许' || t === '仅在使用中允许';
  });
  const hasPermissionKeywords = fullText.includes('照片') || fullText.includes('媒体') || fullText.includes('存储') || fullText.includes('访问您设备') || fullText.includes('权限') || fullText.includes('位置信息') || fullText.includes('通知');
  return hasAllowBtn && (hasPermissionKeywords || fullText.includes('不允许') || fullText.includes('拒绝'));
}

function findSystemPermissionAllowButton(items) {
  return items.find(it => {
    const t = normalizeText(it.text);
    return t === '允许' || t === '始终允许' || t === '仅在使用中允许';
  }) || null;
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
 * 判定是否已进入陌陌主界面
 * 特征：用户明确指定的“开启附近功能”引导页，或底部标准导航栏（首页/消息/小宇宙/更多），或顶部动态/附近导航
 */
function isMomoHomeScreen(items, screenHeight = 640) {
  if (isLauncherScreen(items)) return false;
  // 排除冷启动未登录时的动态页（必须无“注册/登录”浮动按钮）
  const hasFeedLogin = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('注册/登录') || t.includes('注册登录');
  });
  if (hasFeedLogin) return false;

  // 特征1：用户明确指定的画面 —— “开启附近功能”引导页
  const hasNearbyGuide = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('开启附近功能') ||
           t.includes('启用位置权限和定位服务') ||
           t.includes('才可以看到附近的动态') ||
           (t.includes('一键开启') && it.top > screenHeight * 0.45);
  });

  // 特征2：底部标准导航栏 (首页, 直播/动态, 消息, 小宇宙/小宇宜/小宇霜, 更多)
  const bottomItems = items.filter(it => it.top > screenHeight * 0.78);
  const hasHomeTab = bottomItems.some(it => {
    const t = normalizeText(it.text);
    return t === '首页' || t.includes('首页');
  });
  const hasOtherTabs = bottomItems.some(it => {
    const t = normalizeText(it.text);
    return t.includes('消息') || t.includes('小宇宙') || t.includes('小宇宜') || t.includes('小宇霜') || t.includes('更多') || t.includes('直播');
  });
  const hasBottomNav = hasHomeTab && hasOtherTabs;

  // 特征3：顶部动态/附近导航
  const topItems = items.filter(it => it.top < screenHeight * 0.2);
  const hasTopNav = topItems.some(it => {
    const t = normalizeText(it.text);
    return t.includes('动态') || t.includes('附近') || t.includes('发动态');
  });

  // 特征4：动态信息流交互（如打招呼、发动态）
  const hasFeedInteraction = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('打招呼') || t.includes('抢首赞');
  });

  return hasNearbyGuide || (hasBottomNav && hasTopNav) || (hasBottomNav && hasFeedInteraction) || (hasNearbyGuide && hasBottomNav);
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

  // 检查是否出现系统启动权限弹窗（若出现则自动点击允许，若未出现秒过无延迟）
  if (isSystemPermissionDialog(obs.items)) {
    log.console('[自愈恢复 2/4] 检测到系统启动权限弹窗，自动点击允许...');
    const allowBtn = findSystemPermissionAllowButton(obs.items);
    if (allowBtn) {
      const pt = tapBox(control, allowBtn, obs);
      await control.tap(pt.x, pt.y);
      await control.flush();
      await sleep(1500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, 'recover-after-perm-' + (state.counter++));
    }
  }

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
  // 网名解析：'随机生成' 等关键字 → 调用离线生成器 (python_workers/nickname)；
  // 生成失败回退默认网名；显式指定则原样使用。
  const nicknameSetting = String(options.nickname ?? process.env.YUNMOMO_MOMO_NICKNAME ?? '').trim() || DEFAULT_NICKNAME;
  let nickname;
  if (AUTO_NICKNAME_KEYWORDS.has(nicknameSetting)) {
    try {
      nickname = await generateGirlNickname({ style: '混合' });
      log.console(`[人设网名] 已随机生成女生网名: "${nickname}"`);
    } catch (err) {
      nickname = DEFAULT_NICKNAME;
      log.console(`[人设网名] ⚠️ 随机生成失败 (${err.message})，回退默认网名 "${DEFAULT_NICKNAME}"`);
    }
  } else {
    nickname = nicknameSetting;
  }
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

  // B线：一键登录启动即并行抢号 (平均约 2 分钟到手)，与桌面搜寻/登录/资料完善同步进行；
  // 显式指定手机号时保持旧的固定号模式，不启动抢号。
  const smsProjectCode = String(options.projectCode || process.env.YUNMOMO_MOMO_PROJECT_CODE || '369990').trim();
  const smsClient = new SmsService().getClient();
  const grabber = createPhoneGrabber(smsClient, smsProjectCode, log);
  const explicitPhone = Boolean(options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE);
  if (!explicitPhone) {
    log.console('[抢号线 B] 一键登录启动，并行开抢玄武号码 (与登录/资料完善同步进行)...');
    grabber.start();
  } else {
    log.console('[抢号线 B] 检测到指定手机号，跳过玄武取号 (固定号模式)。');
  }

  try {
    await control.connect();
    await log.file('Control connected successfully', { screen: `${control.screenWidth}x${control.screenHeight}` });

    // 1. 观察当前屏幕
    log.console('[1/5] 分析当前屏幕状态...');
    let obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-inspect-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '01-initial-inspect', '初始分析画面', log);

    // 0. 检查是否需要清理后台重开（如参数要求 clean/restart，或既有微信授权已超期）
    const { getAuthSession } = require('../../automation/auth-session');
    const existingSession = await getAuthSession(resolvedDeviceId);
    const sessionExpired = existingSession && existingSession.isExpired;
    const shouldClean = Boolean(options.clean || sessionExpired);

    if (shouldClean) {
      log.console(`[初始化] ${sessionExpired ? '微信授权会话已超期 (>8分钟)' : '参数指定全新运行'}，执行多任务清后台与桌面复位...`);
      await clearAllRecentTasks(phone, control, worker, ocrDir, state, log);
      await sleep(1000);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-clean-${state.counter++}`);
    }

    // 检查是否已经处于陌陌主界面 (开启附近功能/动态主页) (且未触发强制清后台)
    if (!shouldClean && isMomoHomeScreen(obs.items, obs.height)) {
      log.console('[1/5] 🎉 检测到当前设备已处于陌陌主界面（识别到“开启附近功能”或主页导航栏），陌陌上号已成功达成！');
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '06-momo-home-success', '陌陌主页上号成功现场', log);
      return {
        ok: true,
        state: 'login_success',
        loginSuccess: true,
        runId,
        targetTime,
        nickname,
        phoneNumber: options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE || '17306728814',
        screenshotsDir,
        lastScreenshotPath,
        completedTimeFormatted: new Date().toLocaleString('zh-CN', { hour12: false }),
        message: '当前设备已处于陌陌主界面，上号成功！',
      };
    }

    // 检查是否已经处于手机绑定界面 (且未触发强制清后台)
    if (!shouldClean && isFinalPhoneBindScreen(obs.items)) {
      log.console('[1/5] 当前已处于手机绑定界面，直接推进手机号绑定阶段！');
      const bindResult = await runBindWithSessions(client, resolvedDeviceId, options, {
        client, resolvedDeviceId, options,
        phone, control, worker, ocrDir, state, screenshotsDir, log, targetTime, yayaMode,
      }, grabber, log);

      if (bindResult?.state === 'waiting_verify_code') {
        log.console('[1/5] 验证码已触发发送，8分钟授权计时正在进行中！等待用户提供最新验证码...');
        return {
          ok: true,
          state: 'waiting_verify_code',
          runId,
          targetTime,
          nickname,
          phoneNumber: bindResult.phoneNumber,
          authSession: bindResult.authSession,
          bindResult,
          screenshotsDir,
          lastScreenshotPath: bindResult.lastScreenshotPath || lastScreenshotPath,
        };
      }

      const isSuccess = Boolean(bindResult?.loginSuccess || bindResult?.ok);
      lastScreenshotPath = bindResult?.lastScreenshotPath || lastScreenshotPath;
      return {
        ok: isSuccess,
        state: isSuccess ? 'login_success' : (bindResult?.state || 'completed'),
        loginSuccess: isSuccess,
        runId,
        targetTime,
        nickname,
        phoneNumber: bindResult?.phoneNumber || options.phoneNumber,
        bindResult,
        screenshotsDir,
        lastScreenshotPath,
        completedTimeFormatted: new Date().toLocaleString('zh-CN', { hour12: false }),
        message: isSuccess ? '陌陌一键上号成功，已成功进入主页！' : '手机绑定执行完成',
      };
    }

    // 检查是否已处于资料填写阶段（已完成微信登录授权）
    const alreadyAuthed = isProfileSetupStage(obs.items);
    if (!alreadyAuthed) {
      // 若不在陌陌任何界面，则在桌面搜寻并打开应用
      const inMomoFlow = isPrivacyDialog(obs.items) || isMomoFeedScreen(obs.items) || isLoginPage(obs.items) || isUserAgreementDialog(obs.items);
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

        // 检查可能出现的系统启动权限弹窗（若出现则自动点击允许，若未出现秒过无延迟）
        if (isSystemPermissionDialog(obs.items)) {
          log.console('[1/5] 检测到系统启动权限弹窗，自动点击允许...');
          const allowBtn = findSystemPermissionAllowButton(obs.items);
          if (allowBtn) {
            const pt = tapBox(control, allowBtn, obs);
            await control.tap(pt.x, pt.y);
            await control.flush();
            await sleep(1500);
            obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-after-perm-${state.counter++}`);
          }
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

      // 处理可能处于的陌陌动态信息流页（点击浮动的「注册/登录」胶囊按钮）
      if (isMomoFeedScreen(obs.items)) {
        log.console('[2/5] 检测到陌陌动态信息流页，点击浮动「注册/登录」按钮...');
        const feedBtn = findFeedLoginButton(obs.items);
        if (feedBtn) {
          const pt = tapBox(control, feedBtn, obs);
          await control.tap(pt.x, pt.y);
        } else {
          await control.tap(Math.round(control.screenWidth * 0.5), Math.round(control.screenHeight * 0.84));
        }
        await control.flush();
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '04-feed-login-clicked', '已点击动态页注册登录', log);
        await sleep(2500);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step2-after-feed-${state.counter++}`);
      }

      // 等待并确认登录主界面
      const loginDeadline = Date.now() + 15000;
      while (!isLoginPage(obs.items) && !isUserAgreementDialog(obs.items) && !isProfileSetupStage(obs.items) && !isFinalPhoneBindScreen(obs.items) && Date.now() < loginDeadline) {
        if (isMomoFeedScreen(obs.items)) {
          log.console('[2/5] 动态页尚未进入登录页，补击「注册/登录」...');
          const feedBtn = findFeedLoginButton(obs.items);
          if (feedBtn) {
            const pt = tapBox(control, feedBtn, obs);
            await control.tap(pt.x, pt.y);
            await control.flush();
            await sleep(2000);
          }
        }
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
      screenshotsDir,
    }, profileLogger);

    log.console('[5/5] 资料完善完成，启动陌陌手机号绑定流程 (手机号打字/验证码过盾/打字提交)...');
    lastScreenshotPath = profileResult.lastScreenshotPath || lastScreenshotPath;

    const bindResult = await runBindWithSessions(client, resolvedDeviceId, options, {
      client, resolvedDeviceId, options,
      phone, control, worker, ocrDir, state, screenshotsDir, log, targetTime, yayaMode,
    }, grabber, log);

    if (bindResult?.state === 'waiting_verify_code') {
      log.console('[5/5] 验证码已成功触发发送，8分钟微信授权生命周期正在计时！等待用户提供最新验证码...');
      return {
        ok: true,
        state: 'waiting_verify_code',
        runId,
        targetTime,
        nickname,
        phoneNumber: bindResult.phoneNumber,
        authSession: bindResult.authSession,
        profileResult,
        bindResult,
        screenshotsDir,
        lastScreenshotPath: bindResult.lastScreenshotPath || lastScreenshotPath,
      };
    }

    const isSuccess = Boolean(bindResult?.loginSuccess || bindResult?.ok);
    lastScreenshotPath = bindResult?.lastScreenshotPath || lastScreenshotPath;
    log.console('[5/5] 🎉【一键上号全流程达成】账号资料完善与手机号绑定已全部完成，已成功进入陌陌主界面！');

    return {
      ok: isSuccess,
      state: isSuccess ? 'login_success' : (bindResult?.state || 'completed'),
      loginSuccess: isSuccess,
      runId,
      targetTime,
      nickname,
      phoneNumber: bindResult?.phoneNumber || options.phoneNumber,
      yayaResult,
      profileResult,
      bindResult,
      screenshotsDir,
      lastScreenshotPath,
      completedTimeFormatted: new Date().toLocaleString('zh-CN', { hour12: false }),
      message: '陌陌一键上号全流程达成，已成功进入陌陌主页！',
    };
  } catch (error) {
    if (phone) {
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '99-error-snapshot', '失败现场截图', log);
    }
    // 异常收场：释放未消费的玄武号码，避免号池占用与预占资金悬挂
    await grabber.releaseCurrent().catch(() => {});
    throw Object.assign(error, { screenshotsDir, lastScreenshotPath, yayaResult });
  } finally {
    // 成功/人工等待收尾仅停看护：号码仍在使用中或已被消费，严禁在此释放
    grabber.dispose();
    await control.close().catch(() => {});
    await worker.close().catch(() => {});
    if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
      await fs.rm(ocrDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ==================== 玄武并行抢号调度 (B 线) ====================
// 抢号平均耗时约 2 分钟，因此与主流程 (A线: 登录/资料完善) 并行开抢；
// 玄武号码的验证码 5 分钟码窗自取号成功起算，保鲜看护在号龄超限时自动释放旧号换新号，
// 绑定停靠点通过 acquire() 取用号龄受控的会话。扣费仅在验证码到达时发生，
// 释放走 feedback 31=老号（来码前唯一合法免扣费收尾），预占金额立即归还。
const PHONE_KEEPER_INTERVAL_MS = 5000;          // 保鲜看护巡检间隔
const PHONE_KEEPER_MAX_AGE_MS = 3 * 60 * 1000;  // 触发后台续抢的号龄上限 (3 分钟)
const PHONE_DOCK_MAX_AGE_MS = 2 * 60 * 1000;    // 绑定停靠点允许的最大号龄 (保证 5 分钟码窗完整)
const AUTH_RESUME_MIN_MS = 4 * 60 * 1000;       // 授权剩余低于 4 分钟 → 复扫重置后重新抢号
const MAX_BIND_ROUNDS = 3;                      // 一轮绑定最多消耗的玄武号码数

function createPhoneGrabber(smsClient, projectCode, log) {
  let current = null;      // 最近抢到的会话 {phoneNumber, sessionId, grabbedAt, attempts}
  let grabPromise = null;  // 在途抢号 (永不 reject，失败折叠为 {grabError})
  let keeperTimer = null;
  let stopped = true;
  let grabbing = false;

  const ageMsOf = s => (s ? Date.now() - s.grabbedAt : Infinity);

  async function doGrab(reason) {
    grabbing = true;
    try {
      log.console(`[抢号线 B] 向玄武抢号 (项目 ${projectCode})${reason ? ` [${reason}]` : ''}...`);
      const session = await smsClient.grabPhoneSession(projectCode, {
        maxAttempts: 60,
        intervalMs: 1000,
        onRetry: info => log.console(`[抢号线 B] 第 ${info.attempt}/${info.maxAttempts} 次未果 (${info.message})...`),
      });
      current = session;
      log.console(`[抢号线 B] 抢号成功: ${session.phoneNumber} (sessionId: ${session.sessionId}, 第 ${session.attempts} 次请求)`);
      return session;
    } catch (err) {
      log.console(`[抢号线 B] 抢号失败: ${err.message}`);
      return { grabError: err };
    } finally {
      grabbing = false;
    }
  }

  async function keeperTick() {
    if (stopped || grabbing || !current) return;
    if (ageMsOf(current) <= PHONE_KEEPER_MAX_AGE_MS) return;
    const stale = current;
    current = null;
    log.console(`[抢号线 B] 号码 ${stale.phoneNumber} 号龄 ${Math.round((Date.now() - stale.grabbedAt) / 1000)}s 超限，自动续抢保鲜...`);
    await smsClient.releasePhone(stale.sessionId, stale.phoneNumber).catch(() => {});
    grabPromise = doGrab('保鲜续抢');
  }

  function stopKeeper() {
    stopped = true;
    if (keeperTimer) {
      clearInterval(keeperTimer);
      keeperTimer = null;
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      grabPromise = doGrab('并行预抢');
      keeperTimer = setInterval(() => { keeperTick().catch(() => {}); }, PHONE_KEEPER_INTERVAL_MS);
      if (typeof keeperTimer.unref === 'function') keeperTimer.unref();
    },
    // 绑定停靠点取号：停看护 → 等在途抢号落地 → 号龄超限则释放重抢 → 返回受控新鲜会话
    async acquire() {
      stopKeeper();
      if (grabPromise) {
        const pending = await grabPromise;
        grabPromise = null;
        if (pending && !pending.grabError) current = pending;
      }
      if (current && ageMsOf(current) <= PHONE_DOCK_MAX_AGE_MS) {
        return current;
      }
      if (current) {
        log.console(`[抢号线 B] 停靠点发现号龄 ${Math.round(ageMsOf(current) / 1000)}s 超限，释放后现场重抢...`);
        await smsClient.releasePhone(current.sessionId, current.phoneNumber).catch(() => {});
        current = null;
      }
      const fresh = await doGrab('停靠点重抢');
      if (fresh && fresh.grabError) throw fresh.grabError;
      return fresh;
    },
    // 释放未消费的号码（错误收场/复扫前），尽力而为
    async releaseCurrent() {
      stopKeeper();
      if (grabPromise) {
        try {
          const pending = await grabPromise;
          if (pending && !pending.grabError) current = pending;
        } catch {}
        grabPromise = null;
      }
      if (current) {
        await smsClient.releasePhone(current.sessionId, current.phoneNumber).catch(() => {});
        log.console(`[抢号线 B] 已释放未消费号码 ${current.phoneNumber}`);
        current = null;
      }
    },
    // 仅停看护（成功/人工等待收尾时调用，号码仍在使用中，严禁释放）
    dispose() {
      stopKeeper();
    },
  };
}

// 绑定停靠点的号码调度决策：
// - 授权剩余 < 4 分钟 → 释放旧号，复扫重置 8 分钟授权生命周期，复扫完成后重新抢号；
// - 其余情况 → 取用保鲜看护下号龄受控的预抢号。
async function preparePhoneSession(grabber, ctx, log) {
  const { getAuthSession } = require('../../automation/auth-session');
  const authSession = await getAuthSession(ctx.resolvedDeviceId);
  const remainingMs = authSession ? authSession.remainingMs : null;
  const remainingStr = authSession ? authSession.remainingFormatted : '未记录(视为充足)';
  if (remainingMs !== null && remainingMs < AUTH_RESUME_MIN_MS) {
    log.console(`[号码调度] 授权剩余仅 ${remainingStr} (<4分钟)，5 分钟验证码码窗撑不住绑定链路，先复扫重置授权再重新抢号...`);
    await grabber.releaseCurrent();
    await recoverViaRescan(ctx.client, ctx.resolvedDeviceId, ctx.options, ctx);
    log.console('[号码调度] 复扫完成、授权计时已重置，重新抢号以保证 5 分钟码窗完整...');
    return await grabber.acquire();
  }
  log.console(`[号码调度] 授权剩余 ${remainingStr}，直接取用预抢号。`);
  return await grabber.acquire();
}

// 绑定执行环：号码调度 → 绑定 → (phone_expired 换号重跑 / reauth_required 复扫重跑)
// 最多消耗 MAX_BIND_ROUNDS 个玄武号码；验证码超时不再转人工等待。
async function runBindWithSessions(client, resolvedDeviceId, options, ctx, grabber, log) {
  const { runBindPhone } = require('./bind-phone');
  const fixedPhone = String(options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE || '').trim();
  let bindResult = null;
  for (let round = 1; round <= MAX_BIND_ROUNDS; round++) {
    let phoneSession = null;
    if (!fixedPhone) {
      log.console(`[绑定环] 第 ${round}/${MAX_BIND_ROUNDS} 轮：执行号码调度...`);
      phoneSession = await preparePhoneSession(grabber, ctx, log);
    }
    bindResult = await runBindPhone(client, resolvedDeviceId, {
      ...options,
      phoneNumber: fixedPhone || undefined,
      phoneSession,
      forceGetCode: round > 1,
      phone: ctx.phone,
      control: ctx.control,
      worker: ctx.worker,
      screenshotsDir: ctx.screenshotsDir,
    }, log);
    if (bindResult?.state === 'phone_expired' && round < MAX_BIND_ROUNDS) {
      log.console(`[绑定环] 号码 ${bindResult.phoneNumber} 码窗耗尽 (${bindResult.message})，换新号重跑...`);
      continue;
    }
    if (bindResult?.state === 'reauth_required' && round < MAX_BIND_ROUNDS) {
      log.console('[绑定环] 服务端返回“请重新授权”，触发复扫自愈后重跑绑定...');
      await recoverViaRescan(client, resolvedDeviceId, options, ctx);
      continue;
    }
    break;
  }
  return bindResult;
}

function parseCliArgs(argv) {
  const opts = {
    execute: argv.includes('--execute'),
    clean: argv.includes('--clean') || argv.includes('--restart'),
    deviceId: process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID,
    targetTime: process.env.YAYA_TARGET_TIME || DEFAULT_TARGET_TIME,
    yayaMode: process.env.YAYA_MODE || DEFAULT_YAYA_MODE,
    nickname: process.env.YUNMOMO_MOMO_NICKNAME || '随机生成',
    phoneNumber: process.env.YUNMOMO_MOMO_PHONE || '',
    verifyCode: process.env.YUNMOMO_MOMO_VERIFY_CODE || '',
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
    } else if (a === '--clean' || a === '--restart') {
      opts.clean = true;
    }
  }
  return opts;
}

function printSummary(result, duration, error = null) {
  console.log('\n' + '='.repeat(60));
  if (result?.state === 'waiting_verify_code') {
    console.log('【执行结果】：等待输入验证码 (新码已触发下发)');
    console.log('【任务名称】：陌陌一键上号全流程 (授权/资料完善/手机绑定)');
    console.log('【退出状态码】：0');
    console.log(`【已完成阶段】：打开陌陌 -> 微信登录 -> 丫丫授权 -> 资料完善(女生/网名/生日) -> 头像上传 -> 手机号键入 [${result.phoneNumber}] -> 验证码过盾成功已触发下发！`);
    if (result.authSession) {
      console.log(`【微信授权生命周期倒计时】：8分钟时限剩余可用 ${result.authSession.remainingFormatted}`);
    }
    console.log('【下一步行动】：请在对话中发送您收到的 6 位短信验证码，收到后脚本将直接推进打字提交！');
    console.log(`【执行耗时】：${duration} 秒`);
  } else if (result?.ok) {
    console.log('【执行结果】：🎉 陌陌一键上号成功！');
    console.log('【任务名称】：陌陌一键上号全流程 (登录授权/资料完善/头像上传/手机绑定)');
    console.log('【退出状态码】：0');
    console.log('【主页终态】：已成功进入陌陌主界面 (识别到“开启附近功能”与底栏导航)');
    if (result.nickname) {
      console.log(`【账号网名】：${result.nickname}`);
    }
    if (result.phoneNumber) {
      console.log(`【绑定手机】：${result.phoneNumber}`);
    }
    if (result.targetTime) {
      console.log(`【复扫订单】：${result.targetTime}`);
    }
    if (result.profileResult?.proxyRecorded) {
      console.log(`【代理状态】：${result.profileResult.proxyRecorded}`);
    }
    const shotPath = result?.lastScreenshotPath;
    if (shotPath) {
      console.log(`【现场截图】：${path.relative(PROJECT_ROOT, shotPath)}`);
    }
    console.log(`【完成时间】：${result.completedTimeFormatted || new Date().toLocaleString('zh-CN', { hour12: false })}`);
    console.log(`【执行耗时】：${duration} 秒`);
    console.log('='.repeat(60) + '\n');
    console.log(`[RESULT_JSON] ${JSON.stringify({
      success: true,
      message: '陌陌一键上号成功',
      state: 'login_success',
      nickname: result.nickname,
      phoneNumber: result.phoneNumber,
      targetTime: result.targetTime,
      screenshot: shotPath ? path.relative(PROJECT_ROOT, shotPath) : null,
      completedTime: result.completedTimeFormatted || new Date().toLocaleString('zh-CN', { hour12: false }),
      durationSeconds: Number(duration),
    })}`);
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
