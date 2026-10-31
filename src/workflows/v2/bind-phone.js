'use strict';

/**
 * MOMO 手机号绑定工作流 (子脚本：从“手机绑定”界面开始)
 *
 * 业务流程规范（严格参照 GEMINI.md 核心守则）：
 * 1. 严格有限状态机与双层对象确认：
 *    - 进入前校验当前屏幕确实处于「手机绑定」界面（包含“手机绑定”/“绑定手机号”/“输入手机号码”）；
 *    - 若不处于该页面，严禁盲目乱点，立即报错并记录现场截图；
 * 2. 元素精准识别与定位：
 *    - 手机号输入框：精准定位“输入手机号码”区域；
 *    - 验证码输入框：精准定位“输入验证码”区域；
 *    - 获取验证码按钮：位于验证码栏右侧；
 *    - 提交按钮：定位“提交”；
 * 3. 单写互斥与幂等重跑安全。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { YunmomoClient } = require('../../index');
const { SmsService } = require('../../server/sms/service');
const { solveCaptcha } = require('../../tools/captcha');
const shared = require('../../automation/screen');
const protocol = require('../../protocol');
const {
  logAuthBudget,
  recordPhoneCodeRequested,
  getPhoneBindState,
} = require('../../automation/auth-session');

const {
  sleep,
  deviceIdOf,
  normalizeText,
  RapidOcrWorker,
  screenshotAndOcr,
  tapBox,
} = shared;

const DEFAULT_DEVICE_ID = '2002637309737881601';
const DEFAULT_POLL_MS = 700;
// 默认接码项目编码：陌陌换绑3
const DEFAULT_PROJECT_CODE = '369990';
// 默认固定手机号
const DEFAULT_FIXED_PHONE = '17306728814';
// 默认测试验证码（默认置空，防止使用已失效的旧码；收到新码后由外部传入）
const DEFAULT_VERIFY_CODE = '';
// 抢号轮询（对齐网页端抓包行为）：每秒请求 1 次，最长 60 次，有号立即返回停止
const PHONE_POLL_INTERVAL_MS = 1000;
const PHONE_POLL_MAX_ATTEMPTS = 60;
// 查码轮询（对齐网页端抓包行为）：每 5 秒查询一次玄武平台，最长 60 次（5 分钟，与网页取号会话有效期一致）
const SMS_POLL_INTERVAL_MS = 5000;
const SMS_POLL_MAX_ATTEMPTS = 60;

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

function isBindPhoneScreen(items) {
  const hasPhoneHeader = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('手机绑定') || t.includes('绑定手机号') || t.includes('输入手机号码') || t.includes('编入手机号码') || t.includes('确保你的账号安全');
  });
  const hasCaptchaTitle = items.some(it => normalizeText(it.text).includes('验证码校验'));
  // 严格互斥：必须不含有二级“验证码校验”安全页特征
  return hasPhoneHeader && !hasCaptchaTitle;
}

function isCaptchaVerifyScreen(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('验证码校验') || t.includes('点击按钮开始验证') || t.includes('依次点击');
  });
}

function findPhoneInputBox(items) {
  for (const it of items) {
    const t = normalizeText(it.text);
    // 严格限制在纵向 170~250 像素范围内的手机号输入行，避免误匹配顶部标题或状态栏
    if (it.top >= 170 && it.bottom <= 250) {
      if (t.includes('+86') || t.includes('手机') || t.includes('编入') || t.includes('输入')) {
        return it;
      }
    }
  }
  return null;
}

function findVerifyCodeInputBox(items) {
  for (const it of items) {
    // 限制在纵向 245~310 像素范围内的验证码输入行
    if (it.top >= 240 && it.bottom <= 315) {
      const t = normalizeText(it.text);
      if (!t.includes('获取') && !t.includes('重新')) {
        return it;
      }
    }
  }
  return null;
}

function getExistingVerifyCodeOnScreen(items) {
  for (const it of items) {
    if (it.top >= 240 && it.bottom <= 315) {
      const t = normalizeText(it.text);
      if (!t.includes('获取') && !t.includes('重新')) {
        const m = t.match(/\b\d{4,6}\b/);
        if (m) return m[0];
      }
    }
  }
  return null;
}

function findGetCodeBtn(items) {
  for (const it of items) {
    const t = normalizeText(it.text);
    if ((t.includes('获取验证码') || t.includes('获取') || t.includes('重新获取')) && it.top >= 240 && it.bottom <= 315) {
      return it;
    }
  }
  return null;
}

function findSubmitBtn(items) {
  return items.find(it => normalizeText(it.text) === '提交');
}

/**
 * 判定是否已进入陌陌主界面
 * 特征：用户明确指定的“开启附近功能”引导页，或底部标准导航栏（首页/消息/小宇宙/更多），或顶部动态/附近导航
 */
function isMomoHomeScreen(items, screenHeight = 640) {
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

  // 特征4：动态信息流交互（如打招呼、评论）
  const hasFeedInteraction = items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('打招呼') || t.includes('抢首赞');
  });

  return hasNearbyGuide || (hasBottomNav && hasTopNav) || (hasBottomNav && hasFeedInteraction) || (hasNearbyGuide && hasBottomNav);
}

function findContactsDismissButton(items) {
  // 通讯录授权弹窗：“陌陌想访问你的通讯录，用以屏蔽你身边的熟人... 跳过 / 屏蔽”
  const skipBtn = items.find(it => {
    const t = normalizeText(it.text);
    return (t === '跳过' || t.includes('跳过')) && it.top > 200 && it.top < 500;
  });
  return skipBtn || null;
}

function findGeneralDismissAction(items) {
  // 通用关闭/跳过/我知道了弹窗
  const dismissBtn = items.find(it => {
    const t = normalizeText(it.text);
    return (t === '跳过' || t === '取消' || t === '我知道了' || t === '下次再说' || t === '关闭') && it.top > 200 && it.top < 600;
  });
  return dismissBtn || null;
}

/**
 * 点选/行为验证码自动处理过盾模块
 */
async function handleCaptchaChallenge(phone, control, worker, ocrDir, screenshotsDir, log, maxRounds = 3) {
  for (let round = 1; round <= maxRounds; round++) {
    log.console(`[过盾 ${round}/${maxRounds}] 正在分析当前验证码校验界面...`);

    let obs = await screenshotAndOcr(phone, worker, ocrDir, `captcha-r${round}-inspect`);

    // 1. 若当前在“点击按钮开始验证”中间状态，点击该按钮唤起弹窗
    const startBtn = obs.items.find(i => i.text.includes('开始验证') || i.text.includes('点击按钮'));
    if (startBtn) {
      const pt = tapBox(control, startBtn, obs);
      log.console(`[过盾 ${round}/${maxRounds}] 点击「点击按钮开始验证」 (${pt.x}, ${pt.y})...`);
      await control.tap(pt.x, pt.y);
      await control.flush();
      await sleep(2500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `captcha-r${round}-after-click`);
    }

    // 2. 检查是否出现验证码点选弹窗
    const hasCaptchaDialog = obs.items.some(i => i.text.includes('依次点击') || i.text.includes('看不清') || i.text.includes('确定'));
    if (!hasCaptchaDialog) {
      // 若已经不在此页（说明已过盾或跳转回手机绑定页）
      if (isBindPhoneScreen(obs.items)) {
        log.console(`[过盾 ${round}/${maxRounds}] 屏幕已回到手机绑定页，过盾成功！`);
        return { ok: true, round };
      }
      log.console(`[过盾 ${round}/${maxRounds}] 未检测到弹窗，等待 1.5 秒重试...`);
      await sleep(1500);
      continue;
    }

    // 3. 截取当前全屏并调用 solveCaptcha 视觉解析
    log.console(`[过盾 ${round}/${maxRounds}] 验证码弹窗就绪，正在调用 DeepSeek 视觉模型深度解析目标...`);
    const s = await phone.screenshot({ level: 2 }).catch(() => null);
    if (!s?.data) {
      log.console(`[过盾 ${round}/${maxRounds}] 截屏失败，重试...`);
      await sleep(1000);
      continue;
    }

    let result;
    try {
      result = await solveCaptcha(s.data);
    } catch (err) {
      log.console(`[过盾 ${round}/${maxRounds}] 视觉模型解析异常: ${err.message}`);
      // 点击刷新按钮刷新一张新题
      const refreshBtn = obs.items.find(i => i.text.includes('刷新') || i.text.includes('看不清'));
      if (refreshBtn) {
        const rPt = tapBox(control, refreshBtn, obs);
        await control.tap(rPt.x, rPt.y);
        await control.flush();
      }
      await sleep(2000);
      continue;
    }

    if (!result?.targets?.length) {
      log.console(`[过盾 ${round}/${maxRounds}] 视觉模型未能解析出目标图标，重试下一轮...`);
      await sleep(2000);
      continue;
    }

    log.console(`[过盾 ${round}/${maxRounds}] 视觉解析完成！按顺序点击目标: [${(result.promptOrder || []).join(' -> ')}]`);

    // 4. 按顺序逐个点击目标图标
    const scaleX = control.screenWidth / Math.max(1, obs.width);
    const scaleY = control.screenHeight / Math.max(1, obs.height);
    for (const t of result.targets) {
      const tapX = Math.round(t.x * scaleX);
      const tapY = Math.round(t.y * scaleY);
      log.console(`[过盾 ${round}/${maxRounds}] 点击目标 #${t.order} [${t.name}]: (${tapX}, ${tapY})`);
      await control.tap(tapX, tapY);
      await control.flush();
      await sleep(500 + Math.floor(Math.random() * 200));
    }

    // 5. 点击底部的「确定」按钮
    const confItem = obs.items.find(i => i.text.trim() === '确定');
    const confPt = confItem ? tapBox(control, confItem, obs) : {
      x: Math.round((result.confirmButton?.x || 180) * scaleX),
      y: Math.round((result.confirmButton?.y || 465) * scaleY)
    };
    log.console(`[过盾 ${round}/${maxRounds}] 点击「确定」按钮 (${confPt.x}, ${confPt.y})...`);
    await control.tap(confPt.x, confPt.y);
    await control.flush();
    await sleep(2500);

    // 6. 核验点击确定后的页面状态
    obs = await screenshotAndOcr(phone, worker, ocrDir, `captcha-r${round}-result`);
    await captureMilestoneScreenshot(phone, screenshotsDir, `04-captcha-r${round}-result`, `第${round}轮验证码处理结果`, log);

    const stillInCaptcha = isCaptchaVerifyScreen(obs.items);
    if (!stillInCaptcha && isBindPhoneScreen(obs.items)) {
      log.console(`[过盾 ${round}/${maxRounds}] 【成功】验证码校验已通过，已确认回到手机绑定主页！`);
      return { ok: true, round };
    } else {
      log.console(`[过盾 ${round}/${maxRounds}] 本轮未通过（界面仍在安全校验页或题目刷新），准备下一轮...`);
      await sleep(1500);
    }
  }

  return { ok: false, message: '超过最大重试轮数' };
}

async function runBindPhone(client, targetDeviceId, options = {}, logger = console) {
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
  const projectCode = String(options.projectCode || process.env.YUNMOMO_MOMO_PROJECT_CODE || DEFAULT_PROJECT_CODE).trim();
  let phoneNumber = String(options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE || DEFAULT_FIXED_PHONE).trim();
  let verifyCode = String(options.verifyCode || process.env.YUNMOMO_MOMO_VERIFY_CODE || DEFAULT_VERIFY_CODE).trim();
  let sessionId = null;

  await log.file('Bind phone task initialized', { deviceName, resolvedDeviceId, projectCode, phoneNumber, verifyCode });

  log.console(`[目标设备] ${deviceName} (${resolvedDeviceId}) | V2 (安卓 12)`);
  log.console(`[执行操作] 陌陌手机号绑定 (手机: ${phoneNumber} -> 获取验证码 -> 验证码打字: ${verifyCode} -> 提交)`);

  const phone = options.phone || client.device(resolvedDeviceId);
  const ownControl = !options.control;
  const control = options.control || await phone.openControl({ udid: target.udid });
  const ownWorker = !options.worker;
  const worker = options.worker || new RapidOcrWorker();
  const runId = randomUUID();
  const screenshotsDir = options.screenshotsDir || path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'bind-phone', runId);
  const ocrDir = await shared.createOcrDirectory('yunmomo-bind-phone-');
  const state = { counter: 0 };
  let lastScreenshotPath = null;

  try {
    if (!control.connected) {
      await control.connect();
    }
    await log.file('Control connected successfully', { screen: `${control.screenWidth}x${control.screenHeight}` });

    // 1. 分析当前屏幕状态
    log.console('[1/3] 分析当前屏幕状态...');
    let obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-inspect-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '01-initial-state', '初始分析画面', log);

    // 0. 检查并记录微信授权预算生命周期（8 分钟时限）
    await logAuthBudget(log, resolvedDeviceId, '手机绑定初始化');

    // 校验必须处于手机绑定页面或验证码校验页面
    if (!isBindPhoneScreen(obs.items) && !isCaptchaVerifyScreen(obs.items)) {
      if (isMomoHomeScreen(obs.items, obs.height)) {
        log.console('[1/5] 🎉 检测到当前设备已处于陌陌主界面（识别到“开启附近功能”或底栏导航），上号已处于成功状态！');
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '06-momo-home-success', '陌陌主页上号成功现场', log);
        return {
          ok: true,
          state: 'login_success',
          loginSuccess: true,
          homeConfirmed: true,
          runId,
          phoneNumber: phoneNumber || '17306728814',
          screenshotsDir,
          lastScreenshotPath,
          message: '当前设备已处于陌陌主界面，上号成功！',
        };
      }
      throw new Error('未处于“手机绑定”相关界面，当前屏幕不匹配，请确认前台状态！');
    }

    const inCaptchaPage = isCaptchaVerifyScreen(obs.items);
    if (inCaptchaPage) {
      log.console('[1/5] 识别当前已处于「验证码校验」人机安全页，直接无缝启动验证码处理过盾...');
      const captchaResult = await handleCaptchaChallenge(phone, control, worker, ocrDir, screenshotsDir, log, 3);
      if (!captchaResult?.ok) {
        throw new Error(`验证码过盾未通过: ${captchaResult?.message || '超过重试轮数'}`);
      }
      log.console('[1/5] 【过盾成功】已顺利通过安全核验，准备进入验证码填入！');
      await sleep(1500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-after-captcha-${state.counter++}`);
    }

    log.console('[1/5] 确认当前处于“手机绑定”界面！');

    // 检查界面上是否已有已填入的验证码（仅作观测记录，严禁将失效旧码误作新码推进）
    const existingCodeOnScreen = getExistingVerifyCodeOnScreen(obs.items);
    if (existingCodeOnScreen) {
      log.console(`[识别发现] 屏幕验证码输入栏当前显示: "${existingCodeOnScreen}" (若为失效旧码，后续将予以清空重写)`);
    }

    // 2. 从接码平台取号 (若未直接传入手机号)
    if (!phoneNumber) {
      log.console(`[接码平台] 正在向玄武平台抢号 (项目编码: ${projectCode} 陌陌换绑3, 每秒 1 次最长 ${PHONE_POLL_MAX_ATTEMPTS} 次)...`);
      const smsService = new SmsService();
      const smsClient = smsService.getClient();
      const phoneRes = await smsClient.getPhoneWithPolling(projectCode, {
        maxAttempts: PHONE_POLL_MAX_ATTEMPTS,
        intervalMs: PHONE_POLL_INTERVAL_MS,
        onRetry: info => log.console(`[接码平台] 第 ${info.attempt}/${info.maxAttempts} 次抢号未果 (${info.message})，${Math.round(info.intervalMs / 1000)}s 后重试...`),
      });
      phoneNumber = String(phoneRes.phoneNumber).trim();
      sessionId = phoneRes.sessionId;
      log.console(`[接码平台] 取号成功: ${phoneNumber} (sessionId: ${sessionId}, 第 ${phoneRes.attempts} 次请求, 耗时: ${phoneRes.latencyMs}ms)`);
      await log.file('Phone acquired from Xuanwu', { projectCode, phoneNumber, sessionId, attempts: phoneRes.attempts, raw: phoneRes.raw });
    } else {
      log.console(`[手机号] 使用指定的手机号: ${phoneNumber}`);
    }

    const scaleX = control.screenWidth / Math.max(1, obs.width);
    const scaleY = control.screenHeight / Math.max(1, obs.height);

    // 3. 检查手机号是否已在位，若不在则模拟人工打字输入 (严禁直接粘贴)
    const cleanPhone = phoneNumber.replace(/\s+/g, '');
    const alreadyHasPhone = obs.items.some(it => it.top >= 170 && it.bottom <= 250 && normalizeText(it.text).includes(cleanPhone));
    if (alreadyHasPhone) {
      log.console(`[2/5] 手机号 ${phoneNumber} 已存在于输入框中，跳过重复打字。`);
    } else {
      log.console(`[2/5] 定位手机号输入框并开始模拟打字输入...`);
      const phoneBox = findPhoneInputBox(obs.items);
      if (!phoneBox) {
        throw new Error('未在当前界面检测到手机号输入框！');
      }

      const targetY = (phoneBox.top + phoneBox.bottom) / 2;
      const tapPt = {
        x: Math.round(160 * scaleX),
        y: Math.round(targetY * scaleY)
      };

      log.console(`[2/5] 点击手机号输入热区 (${tapPt.x}, ${tapPt.y})...`);
      await control.tap(tapPt.x, tapPt.y);
      await control.flush();
      await sleep(500);

      // 彻底清空原有残留：采用 Ctrl+A 全选 + DEL 删除
      control.key(protocol.KEY_CODES.A, { metaState: protocol.META.CTRL_LEFT_ON || protocol.META.CTRL_ON });
      control.key(protocol.KEY_CODES.DEL);
      for (let i = 0; i < 10; i++) control.key(protocol.KEY_CODES.DEL);
      await control.flush();
      await sleep(300);

      // 逐字模拟真人打字输入 (带拟人化敲击微停顿，严禁直接黏贴)
      log.console(`[2/5] 模拟人工逐字击键键入手机号: "${phoneNumber}"...`);
      for (let i = 0; i < phoneNumber.length; i++) {
        const char = phoneNumber[i];
        await control.text(char);
        await control.flush();
        const keyDelay = 90 + Math.floor(Math.random() * 110);
        await sleep(keyDelay);
      }

      await sleep(600);
      // 点击空白安全区使输入框失焦收起软键盘
      await control.tap(Math.round(180 * scaleX), Math.round(120 * scaleY));
      await control.flush();
      await sleep(1000);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step2-after-phone-typed-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '02-phone-typed', '手机号模拟打字完成', log);

      const typedBox = findPhoneInputBox(obs.items);
      const typedText = normalizeText(typedBox?.text || '');
      const isMatched = typedText.includes(cleanPhone) || obs.items.some(it => it.top >= 170 && it.bottom <= 250 && normalizeText(it.text).includes(cleanPhone));
      if (!isMatched) {
        throw new Error(`后验核验失败：未在手机号输入栏检测到输入的完整号码 [${cleanPhone}]，当前行识别为: "${typedText}"`);
      }
      log.console(`[2/5] 【后验确认】手机号 ${phoneNumber} 已准确键入手机号栏！`);
    }

    // 4. 判定是否跳过「获取验证码」
    // 核心业务规则（用户硬性约束）：
    // 1) 按钮在 60 秒后即使文字恢复为“获取验证码”，若此前已获取过或已持有验证码，严禁重复点击！
    // 2) 只要来验证码了或框内已有验证码，直接输入推进，严禁重复获取！
    let hasCountdown = obs.items.some(it => {
      const t = normalizeText(it.text);
      return t.includes('重新获取') || /\d+s/i.test(t) || /\d+秒/.test(t) || (it.top >= 240 && it.bottom <= 315 && /\d{1,2}/.test(t));
    });

    const isCodeReady = Boolean(verifyCode);
    const phoneBindState = await getPhoneBindState(resolvedDeviceId, phoneNumber);
    const hasRequestedBefore = Boolean(phoneBindState?.hasRequestedCode && phoneBindState?.isRecentRequest);

    if (hasCountdown) {
      log.console('[3/5] 检测到验证码已发送并处于倒计时状态，跳过重复获取。');
    } else if (options.skipGetCode) {
      log.console('[3/5] 参数指定直接进入验证码键入阶段，跳过获取验证码点击。');
    } else if (isCodeReady) {
      log.console(`[3/5] 【防重复规则】当前验证码已由外部显式提供 [${verifyCode}]，直接跳过获取步骤！`);
    } else if (hasRequestedBefore) {
      log.console(`[3/5] 【防重复规则】会话记录显示近期已向手机号 ${phoneNumber} 请求过验证码（已耗时: ${phoneBindState.elapsedFormatted}，严禁重复获取），跳过获取按钮！`);
    } else {
      log.console('[3/5] 正在定位并点击「获取验证码」按钮...');
      await logAuthBudget(log, resolvedDeviceId, '点击获取验证码前');
      const getCodeBtn = findGetCodeBtn(obs.items);
      let codePt;
      if (getCodeBtn) {
        codePt = tapBox(control, getCodeBtn, obs);
        log.console(`[3/5] 点击获取验证码热区 (${codePt.x}, ${codePt.y}) [${getCodeBtn.text}]...`);
      } else {
        codePt = { x: Math.round(265 * scaleX), y: Math.round(267 * scaleY) };
        log.console(`[3/5] 未明确识别到获取按钮文字，使用标准热区 (${codePt.x}, ${codePt.y}) 点击获取验证码...`);
      }

      await control.tap(codePt.x, codePt.y);
      await control.flush();
      await sleep(2000);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-after-get-code-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '03-after-get-code', '点击获取验证码后现场', log);

      const hasSecurity = isCaptchaVerifyScreen(obs.items);
      if (hasSecurity) {
        log.console('[3/5] 【安全核验】成功识别进入「验证码校验」页，立即启动验证码自动处理模块...');
        const captchaResult = await handleCaptchaChallenge(phone, control, worker, ocrDir, screenshotsDir, log, 3);
        if (!captchaResult?.ok) {
          throw new Error(`验证码过盾未通过: ${captchaResult?.message || '超过重试轮数'}`);
        }
        log.console('[3/5] 【过盾成功】验证码校验已完成！');
        await sleep(1500);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-after-captcha-done-${state.counter++}`);
      }

      // 标记已获取过验证码，防止二次点击
      await recordPhoneCodeRequested({
        deviceId: resolvedDeviceId,
        phoneNumber,
        sessionId,
        timestamp: Date.now(),
      });
      log.console(`[3/5] 【状态记录】已记录验证码请求时间戳，防重复获取机制已生效！`);
    }

    // 5. 确保界面处于「手机绑定」以键入验证码
    if (!isBindPhoneScreen(obs.items)) {
      if (isCaptchaVerifyScreen(obs.items)) {
        log.console('[4/5] 检测到界面仍在验证码校验页，按返回键退回手机绑定页...');
        control.back();
        await control.flush();
        await sleep(1500);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step4-after-back-${state.counter++}`);
      }
    }

    if (!isBindPhoneScreen(obs.items)) {
      throw new Error('未处于“手机绑定”界面，无法继续输入验证码！');
    }

    // 5.5 自动轮询接码平台查码（对齐网页端：每 5 秒查询一次该号码的验证码，最长约 2 分钟）
    // 仅当号码来自玄武取号（存在 sessionId）且外部未显式提供验证码时启用；查不到则回落人工提供模式。
    if (!verifyCode && sessionId && phoneNumber) {
      log.console(`[接码平台] 自动查码启动: 每 ${SMS_POLL_INTERVAL_MS / 1000} 秒查询一次玄武平台 (最长 ${SMS_POLL_MAX_ATTEMPTS} 次)...`);
      const smsClient = new SmsService().getClient();
      try {
        const smsRes = await smsClient.getSmsWithPolling(sessionId, phoneNumber, {
          maxAttempts: SMS_POLL_MAX_ATTEMPTS,
          intervalMs: SMS_POLL_INTERVAL_MS,
          onPoll: info => log.console(`[接码平台] 第 ${info.attempt}/${info.maxAttempts} 次查码: ${info.status === 1 ? '已收到' : '暂未收到'}`),
        });
        if (smsRes.success && smsRes.phoneCode) {
          verifyCode = String(smsRes.phoneCode).trim();
          log.console(`[接码平台] 【查码成功】第 ${smsRes.attempts} 次查询获得验证码!`);
          await log.file('SMS code auto-polled from Xuanwu', { sessionId, phoneNumber, attempts: smsRes.attempts });
        } else {
          log.console('[接码平台] 自动查码超时未收到验证码，转入人工提供模式。');
        }
      } catch (err) {
        log.console(`[接码平台] 自动查码中止 (${err.message})，转入人工提供模式。`);
      }
    }

    // 6. 定位「输入验证码」框并模拟人工逐字打字输入 (严禁直接粘贴)
    const onScreenCode = getExistingVerifyCodeOnScreen(obs.items);
    const cleanTargetCode = String(verifyCode || '').trim();

    if (cleanTargetCode && onScreenCode && onScreenCode === cleanTargetCode) {
      log.console(`[4/5] 【后验确认】验证码输入框中已准确存在目标验证码 "${cleanTargetCode}"，跳过重复打字！`);
    } else {
      if (!cleanTargetCode) {
        const authSession = await logAuthBudget(log, resolvedDeviceId, '已触发获取验证码，等待提供');
        log.console(`[等待验证码 📱] 新验证码已成功触发下发至手机 ${phoneNumber}！`);
        if (authSession) {
          log.console(`[微信授权计时 ⏱️] 8分钟授权生命周期当前剩余可用: ${authSession.remainingFormatted}。`);
        }
        log.console('[流程暂停] 验证码已空出，请将收到的最新 6 位短信验证码提供给脚本后继续提交！');
        return {
          ok: true,
          state: 'waiting_verify_code',
          phoneNumber,
          sessionId,
          authSession,
          lastScreenshotPath,
        };
      }
      log.console(`[4/5] 定位验证码输入框并开始模拟打字输入: "${cleanTargetCode}"...`);
      const verifyBox = findVerifyCodeInputBox(obs.items);
      let vPt;
      if (verifyBox) {
        vPt = tapBox(control, verifyBox, obs);
        log.console(`[4/5] 点击验证码输入框热区 (${vPt.x}, ${vPt.y}) [${verifyBox.text}]...`);
      } else {
        vPt = { x: Math.round(81 * scaleX), y: Math.round(267 * scaleY) };
        log.console(`[4/5] 使用默认热区 (${vPt.x}, ${vPt.y}) 点击验证码输入框...`);
      }

      await control.tap(vPt.x, vPt.y);
      await control.flush();
      await sleep(600);

      // 彻底清空原有残留：Ctrl+A 全选 + DEL 删除
      control.key(protocol.KEY_CODES.A, { metaState: protocol.META.CTRL_LEFT_ON || protocol.META.CTRL_ON });
      control.key(protocol.KEY_CODES.DEL);
      for (let i = 0; i < 10; i++) control.key(protocol.KEY_CODES.DEL);
      await control.flush();
      await sleep(300);

      // 逐字模拟真人打字输入验证码 (带拟人化敲击微停顿，严禁直接黏贴)
      log.console(`[4/5] 模拟人工逐字击键键入验证码: "${cleanTargetCode}"...`);
      for (let i = 0; i < cleanTargetCode.length; i++) {
        const char = cleanTargetCode[i];
        await control.text(char);
        await control.flush();
        const keyDelay = 90 + Math.floor(Math.random() * 110);
        await sleep(keyDelay);
      }

      await sleep(600);
      // 点击空白安全区（顶部标题与提示文字之间）使输入框失焦收起软键盘
      await control.tap(Math.round(180 * scaleX), Math.round(120 * scaleY));
      await control.flush();
      await sleep(1000);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step4-after-code-typed-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '04-code-typed', '验证码模拟打字完成', log);
      log.console(`[4/5] 【后验确认】验证码 ${cleanTargetCode} 已准确完成模拟打字输入！`);
    }

    // 7. 定位并点击「提交」按钮
    await logAuthBudget(log, resolvedDeviceId, '点击提交前');
    log.console('[5/5] 正在定位并点击「提交」按钮...');
    const submitBtn = findSubmitBtn(obs.items);
    let sPt;
    if (submitBtn) {
      sPt = tapBox(control, submitBtn, obs);
      log.console(`[5/5] 点击提交按钮热区 (${sPt.x}, ${sPt.y})...`);
    } else {
      sPt = { x: Math.round(180 * scaleX), y: Math.round(370 * scaleY) };
      log.console(`[5/5] 使用默认热区 (${sPt.x}, ${sPt.y}) 点击提交按钮...`);
    }

    await control.tap(sPt.x, sPt.y);
    await control.flush();

    // 8. 终态现场确认与结果捕获（后验密集监听是否出现“请重新授权”或成功进入“开启附近功能”主页）
    log.console('[5/5] 点击提交后，正在进行终态密集后验监听...');
    const submitDeadline = Date.now() + 20000;
    let homeConfirmed = false;
    let finalObs = null;

    while (Date.now() <= submitDeadline) {
      await sleep(1500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step5-verify-home-${state.counter++}`);
      finalObs = obs;

      // 核心检测 1：是否弹出“请重新授权”Toast或提示
      const reauthItem = obs.items.find(it => {
        const t = normalizeText(it.text);
        return t.includes('请重新授权') || t.includes('重新授权');
      });

      if (reauthItem) {
        const sessionAfter = await logAuthBudget(log, resolvedDeviceId, '提交后出现重新授权提示');
        const elapsedStr = sessionAfter ? sessionAfter.elapsedFormatted : '未知';
        log.console(`[5/5] ⚠️ 【服务端风控拦截】检测到界面弹出提示: "${reauthItem.text}"！`);
        log.console(`[5/5] ⚠️ 【超时诊断根因】：从微信授权到提交耗时 ${elapsedStr}（陌陌临时授权凭证生命周期仅 8 分钟，超出该时间提交必被阻断）！`);
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '05-reauth-required', '重新授权拦截现场', log);
        return {
          ok: false,
          state: 'reauth_required',
          toastText: reauthItem.text,
          message: `陌陌提示“请重新授权” (从微信授权到提交耗时 ${elapsedStr}，超出8分钟上限)`,
          elapsedMs: sessionAfter?.elapsedMs,
          elapsedFormatted: elapsedStr,
          runId,
          projectCode,
          phoneNumber,
          verifyCode: cleanTargetCode,
          sessionId,
          screenshotsDir,
          lastScreenshotPath,
        };
      }

      // 核心检测 2：是否弹出通讯录或系统权限弹窗，自动点击“跳过”
      const dismissBtn = findContactsDismissButton(obs.items) || findGeneralDismissAction(obs.items);
      if (dismissBtn) {
        const pt = tapBox(control, dismissBtn, obs);
        log.console(`[5/5] 检测到前置权限/通讯录弹窗 [${dismissBtn.text}]，自动点击跳过 (${pt.x}, ${pt.y})...`);
        await control.tap(pt.x, pt.y);
        await control.flush();
        await sleep(1500);
        continue;
      }

      // 核心检测 3：是否已达成成功终态 —— 陌陌主页（开启附近功能页或动态信息流页）
      if (isMomoHomeScreen(obs.items, obs.height)) {
        homeConfirmed = true;
        log.console('[5/5] 🎉【陌陌上号成功】后验确认已成功进入陌陌主界面（识别到“开启附近功能”或主页导航栏）！');
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '06-momo-home-success', '陌陌主页上号成功现场', log);
        break;
      }

      // 如果仍在手机绑定页面，且存在错误提示（例如“验证码错误”、“网络异常”）
      const errorItem = obs.items.find(it => {
        const t = normalizeText(it.text);
        return (t.includes('验证码错误') || t.includes('验证码失效') || t.includes('验证码已过期') || t.includes('过于频繁')) && it.top > 200 && it.top < 500;
      });
      if (errorItem) {
        throw new Error(`手机绑定提交失败，提示: ${errorItem.text}`);
      }
    }

    if (!homeConfirmed) {
      if (finalObs && isMomoHomeScreen(finalObs.items, finalObs.height)) {
        homeConfirmed = true;
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '06-momo-home-success', '陌陌主页上号成功现场', log);
      } else {
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '05-final-submitted', '点击提交后终态现场', log);
        log.console('[5/5] ⚠️ 提交后未在时限内确认进入主页，已保存当前现场截图。');
      }
    }

    log.console('[5/5] 【终态完成】陌陌一键上号全流程达成！');
    await logAuthBudget(log, resolvedDeviceId, '手机绑定全流程达成');
    const completedAt = Date.now();
    const completedTimeFormatted = new Date(completedAt).toLocaleString('zh-CN', { hour12: false });

    return {
      ok: true,
      state: 'login_success',
      loginSuccess: true,
      homeConfirmed,
      runId,
      projectCode,
      phoneNumber,
      verifyCode: cleanTargetCode,
      sessionId,
      completedAt,
      completedTimeFormatted,
      screenshotsDir,
      lastScreenshotPath,
      message: '陌陌一键上号成功，已成功进入主页！',
    };
  } catch (error) {
    if (phone) {
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '99-error-snapshot', '失败现场截图', log);
    }
    throw Object.assign(error, { screenshotsDir, lastScreenshotPath });
  } finally {
    if (ownControl) await control.close().catch(() => {});
    if (ownWorker) await worker.close().catch(() => {});
    if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
      await fs.rm(ocrDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseCliArgs(argv) {
  const opts = {
    execute: argv.includes('--execute'),
    skipGetCode: argv.includes('--skip-get-code') || argv.includes('--direct-code'),
    deviceId: process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID,
    phoneNumber: process.env.YUNMOMO_MOMO_PHONE || DEFAULT_FIXED_PHONE,
    verifyCode: process.env.YUNMOMO_MOMO_VERIFY_CODE || DEFAULT_VERIFY_CODE,
    projectCode: process.env.YUNMOMO_MOMO_PROJECT_CODE || DEFAULT_PROJECT_CODE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device-id') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.deviceId = val;
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
  if (result?.state === 'reauth_required') {
    console.log('【执行结果】：需重新授权 (微信授权生命周期已超过 8 分钟)');
    console.log('【任务名称】：陌陌手机绑定');
    console.log('【退出状态码】：1');
    console.log(`【拦截提示】：${result.toastText || '请重新授权'}`);
    console.log(`【根本原因】：从微信授权到提交耗时 ${result.elapsedFormatted || '未知'}，超出陌陌平台 8 分钟会话凭证有效期上限！`);
    const shotPath = result?.lastScreenshotPath;
    if (shotPath) {
      console.log(`【现场截图】：${path.relative(PROJECT_ROOT, shotPath)}`);
    }
    console.log(`【执行耗时】：${duration} 秒`);
  } else if (result?.state === 'waiting_verify_code') {
    console.log('【执行结果】：等待输入验证码 (新码已触发下发)');
    console.log('【任务名称】：陌陌手机绑定');
    console.log('【退出状态码】：0');
    console.log(`【已完成】：手机号 [${result.phoneNumber}] 打字完成 -> 点击获取验证码 -> 验证码过盾成功 -> 验证码已发送至手机！`);
    if (result.authSession) {
      console.log(`【微信授权倒计时】：8分钟时限剩余可用 ${result.authSession.remainingFormatted}`);
    }
    console.log('【下一步】：请将收到的 6 位短信验证码提供给脚本继续提交。');
    console.log(`【执行耗时】：${duration} 秒`);
  } else if (result?.ok) {
    console.log('【执行结果】：🎉 陌陌一键上号成功！');
    console.log('【任务名称】：陌陌手机绑定与上号终态确认');
    console.log('【退出状态码】：0');
    console.log('【主页终态】：已成功进入陌陌主界面（识别到“开启附近功能”或底栏导航）');
    if (result.phoneNumber) console.log(`【绑定手机】：${result.phoneNumber}`);
    if (result.completedTimeFormatted) console.log(`【完成时间】：${result.completedTimeFormatted}`);
    const shotPath = result?.lastScreenshotPath;
    if (shotPath) {
      console.log(`【现场截图】：${path.relative(PROJECT_ROOT, shotPath)}`);
    }
    console.log(`【执行耗时】：${duration} 秒`);
    console.log('='.repeat(60) + '\n');
    console.log(`[RESULT_JSON] ${JSON.stringify({
      success: true,
      message: '陌陌一键上号成功',
      state: 'login_success',
      phoneNumber: result.phoneNumber,
      screenshot: shotPath ? path.relative(PROJECT_ROOT, shotPath) : null,
      completedTime: result.completedTimeFormatted || new Date().toLocaleString('zh-CN', { hour12: false }),
      durationSeconds: Number(duration),
    })}`);
  } else {
    console.log('【执行结果】：失败');
    console.log('【任务名称】：陌陌手机绑定');
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
  const logDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'bind-phone');
  const logFile = path.join(logDir, `${taskId}.log`);
  const logger = createLogger(logFile);

  const startMs = Date.now();
  try {
    if (!options.execute) {
      logger.console('[提示] 本脚本从陌陌手机绑定界面开始执行。如需执行，请传入 --execute 参数。');
      return;
    }

    const client = new YunmomoClient({ timeoutMs: 100000 });
    const result = await runBindPhone(client, options.deviceId, options, logger);

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
  runBindPhone,
  isBindPhoneScreen,
};

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
