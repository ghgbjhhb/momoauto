'use strict';

// Script 08: 打开丫丫(YY)并登录指定账号密码 (V2 专属脚本)。
//
// 业务流程：
// 1. 确认主屏幕就绪；
// 2. 在桌面多向/分页定位并打开“YY”(丫丫)应用；
// 3. 自动识别并处理启动权限、用户协议或温馨提示弹窗；
// 4. 定位账号和密码输入框，填入凭证并点击登录提交（主动收起软键盘防遮挡）；
// 5. 严格后验核查登录结果与三态确认，确保成功进入【项目/历史/我的】主界面。

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { YunmomoClient } = require('../../index');
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
  mergedBox,
} = require('../../automation/screen');

const DEFAULT_DEVICE_ID = '2002637309737881601';
const DEFAULT_ACCOUNT = process.env.YAYA_ACCOUNT || 'aa12345600';
const DEFAULT_PASSWORD = process.env.YAYA_PASSWORD || 'Aa123123';
const DEFAULT_POLL_MS = 700;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_APP_TIMEOUT_MS = 25000;
const DEFAULT_OPEN_ATTEMPT_TIMEOUT_MS = 12000;
const DEFAULT_LOGIN_TIMEOUT_MS = 90000;
const DEFAULT_PROMPT_SETTLE_MS = 900;
const DEFAULT_MAX_PAGES_PER_DIRECTION = 5;

function matchesDevice(record, targetId) {
  if (!record) return false;
  const id = deviceIdOf(record);
  if (id !== targetId) return false;
  const sdk = String(record.sdkVersion || '').trim().toLowerCase();
  return !sdk || sdk === 'v2';
}

function yayaTargetBox(items) {
  // 1. 直接文字精准匹配
  const exact = findStrictPhrase(items, 'YY') ||
                findPhrase(items, 'YY') ||
                findStrictPhrase(items, '丫丫') ||
                findPhrase(items, '丫丫') ||
                findStrictPhrase(items, 'Y Y') ||
                findPhrase(items, 'Y Y');
  if (exact) return exact;

  // 2. 不分大小写或清洗空格匹配
  for (const item of items) {
    const clean = normalizeText(item.text).toUpperCase().replace(/\s+/g, '');
    if (clean === 'YY' || clean === '丫丫') {
      return mergedBox([item]);
    }
  }

  // 3. 桌面网格拓扑相对定位兜底：
  // 在当前云机桌面排布中：
  // 第2行依次为：抖音(第1列)、MOMO陌陌(第2列)、高德地图(第3列)、YY(第4列)
  // 第1行第4列为 美团外卖
  // 若因桌面壁纸浅色或红线遮挡导致文字漏识，借由第4列与第2行交叉点精准锁定 YY
  const gaode = findPhrase(items, '高德地图') || findPhrase(items, '高德');
  const meituan = findPhrase(items, '美团外卖') || findPhrase(items, '美团');
  if (gaode && meituan) {
    return {
      left: meituan.left,
      right: meituan.right,
      top: gaode.top,
      bottom: gaode.bottom
    };
  }

  return null;
}

function launcherVisible(items) {
  return homeAnchorMatches(items).length >= 2 || (
    Boolean(findStrictPhrase(items, '微信')) &&
    (Boolean(findStrictPhrase(items, 'QQ音乐')) || Boolean(findStrictPhrase(items, '高德地图')) || Boolean(findStrictPhrase(items, '美团外卖')))
  );
}

function isYayaLoginScreen(items) {
  const hasLogin = Boolean(findStrictPhrase(items, '登录') || findPhrase(items, '登录'));
  const hasAccount = Boolean(findPhrase(items, '账号') || findPhrase(items, '手机号') || findPhrase(items, '用户名'));
  const hasPassword = Boolean(findPhrase(items, '密码'));
  return hasLogin && (hasAccount || hasPassword);
}

function isYayaHomeScreen(items) {
  // YY 接码/平台真实主界面特征：
  // 底部导航栏：【项目】、【历史】、【我的】
  // 页面内容：【我的收藏】、【全部】、【搜索名称或AppID】、【先看收藏，再看全部】
  const markers = ['项目', '历史', '我的', '我的收藏', '全部', '搜索名称', 'AppID', '收藏'];
  const matched = markers.filter(m => Boolean(findPhrase(items, m)));
  return matched.length >= 2 && !isYayaLoginScreen(items);
}

function findPromptAction(observation) {
  const items = observation.items;
  const candidates = [
    { label: '同意并继续', exact: false },
    { label: '同意并进入', exact: false },
    { label: '同意', exact: true },
    { label: '始终允许', exact: false },
    { label: '仅在使用中允许', exact: false },
    { label: '在使用中允许', exact: false },
    { label: '允许', exact: true },
    { label: '确定', exact: true },
    { label: '我知道了', exact: false },
    { label: '跳过', exact: true },
    { label: '下次再说', exact: false },
    { label: '关闭', exact: true },
  ];

  for (const { label, exact } of candidates) {
    const box = exact ? findStrictPhrase(items, label) : findPhrase(items, label);
    if (box) return { label, box };
  }

  // 安卓原生权限弹窗兜底
  for (const item of items) {
    const norm = normalizeText(item.text);
    if ((norm.includes('允许') || norm.includes('充许')) && !norm.includes('不允许') && !norm.includes('拒绝')) {
      if (item.top > observation.height * 0.4) {
        return { label: item.text, box: item };
      }
    }
  }

  return null;
}

async function openYaya(phone, control, worker, directory, state, found, options) {
  return openAppWithRecovery(phone, control, worker, directory, state, found, options, {
    appName: 'YY',
    targetName: 'YY登录界面或主页或权限提示',
    label: 'yaya',
    targetBox: yayaTargetBox,
    isTarget: observation => isYayaLoginScreen(observation.items) || isYayaHomeScreen(observation.items) || Boolean(findPromptAction(observation)),
    isLauncher: observation => launcherVisible(observation.items),
    launchTimeoutMs: Math.min(options.appTimeoutMs, options.openAttemptTimeoutMs),
  });
}

async function performLogin(phone, control, worker, directory, state, opened, credentials, options, logger) {
  let observation = opened;
  let promptActionCount = 0;
  const promptActions = [];
  const maxWaitMs = options.loginTimeoutMs || DEFAULT_LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() <= deadline) {
    // 1. 检查权限/协议等前置弹窗
    const action = findPromptAction(observation);
    if (action && promptActionCount < options.maxPromptActions) {
      const point = tapBox(control, action.box, observation);
      logger?.file(`Found prompt action: "${action.label}" at (${point.x}, ${point.y})`, { action, point });
      logger?.console(`[弹窗处理] 检测并点击: "${action.label}"...`);
      await control.tap(point.x, point.y);
      await control.flush();
      promptActions.push({ label: action.label, point });
      promptActionCount += 1;
      await sleep(options.promptSettleMs || 1000);
      state.counter += 1;
      observation = await screenshotAndOcr(phone, worker, directory, state.counter);
      continue;
    }

    // 2. 检查是否已经处于登录状态 (主页)
    if (isYayaHomeScreen(observation.items)) {
      logger?.console('[登录状态] 已检测到YY处于已登录状态（首页就绪）');
      return { success: true, alreadyLoggedIn: true, observation, promptActions };
    }

    // 3. 登录界面交互
    if (isYayaLoginScreen(observation.items)) {
      logger?.console(`[登录准备] 已定位登录界面，准备输入凭据 (账号: ${credentials.account})...`);

      // 3.1 账号输入
      const accountBox = findPhrase(observation.items, '账号') || findPhrase(observation.items, '手机号');
      if (!accountBox) {
        throw new Error('YY登录界面未找到“账号”输入框');
      }
      const accountTapBox = {
        left: accountBox.right + 20,
        right: Math.min(observation.width - 30, accountBox.right + 180),
        top: accountBox.top,
        bottom: accountBox.bottom
      };
      const accountPoint = tapBox(control, accountTapBox, observation);
      logger?.console(`[输入账号] 点击输入框 (${accountPoint.x}, ${accountPoint.y}) 并粘贴账号...`);
      await control.tap(accountPoint.x, accountPoint.y);
      await control.flush();
      await sleep(400);

      await control.paste(credentials.account);
      await control.flush();
      await sleep(500);

      // 主动收起软键盘，避免遮挡下方的“密码”输入框与布局上移
      control.back();
      await control.flush();
      await sleep(500);

      // 动作后强制失效，重新拍照取证
      state.counter += 1;
      observation = await screenshotAndOcr(phone, worker, directory, state.counter);

      // 3.2 密码输入
      const passwordBox = observation.items.find(i => i.text.includes('密码') && !i.text.includes('记住'));
      if (!passwordBox) {
        throw new Error('YY登录界面未找到“密码”输入框');
      }
      const passwordTapBox = {
        left: passwordBox.right + 20,
        right: Math.min(observation.width - 30, passwordBox.right + 180),
        top: passwordBox.top,
        bottom: passwordBox.bottom
      };
      const passwordPoint = tapBox(control, passwordTapBox, observation);
      logger?.console(`[输入密码] 点击输入框 (${passwordPoint.x}, ${passwordPoint.y}) 并填入密码...`);
      await control.tap(passwordPoint.x, passwordPoint.y);
      await control.flush();
      await sleep(400);

      await control.paste(credentials.password);
      await control.flush();
      await sleep(500);

      // 再次收起软键盘，暴露“登录”提交大按钮
      control.back();
      await control.flush();
      await sleep(500);

      // 动作后强制失效，重新拍照取证
      state.counter += 1;
      observation = await screenshotAndOcr(phone, worker, directory, state.counter);

      // 3.3 定位并点击“登录”提交按钮
      let loginButtonBox = observation.items.find(item => {
        const text = normalizeText(item.text);
        return text === '登录' && item.top > (passwordBox ? passwordBox.bottom - 10 : 400);
      });

      // 若未直接识别到登录按钮文字（由于按钮底色对比度差异），通过几何位置兜底定位：
      // 登录按钮居中于“记住密码”与“没有账号”之间
      if (!loginButtonBox) {
        const rememberBox = findPhrase(observation.items, '记住密码');
        const noAccountBox = findPhrase(observation.items, '没有账号');
        if (rememberBox && noAccountBox) {
          loginButtonBox = {
            left: Math.round(observation.width * 0.15),
            right: Math.round(observation.width * 0.85),
            top: rememberBox.bottom + 10,
            bottom: noAccountBox.top - 10
          };
          logger?.console('[按钮定位] 依据卡片拓扑位置锁定登录按钮区域');
        }
      }

      if (!loginButtonBox) {
        throw new Error('未在界面中定位到底部“登录”提交按钮');
      }

      const loginPoint = tapBox(control, loginButtonBox, observation);
      logger?.console(`[提交登录] 点击登录按钮 (${loginPoint.x}, ${loginPoint.y})...`);
      await control.tap(loginPoint.x, loginPoint.y);
      await control.flush();
      await sleep(2500);

      // 3.4 登录后验等待与三态判定
      logger?.console('[后验核查] 正在校验登录后状态与界面响应...');
      const verifyDeadline = Date.now() + 30000;
      while (Date.now() <= verifyDeadline) {
        state.counter += 1;
        observation = await screenshotAndOcr(phone, worker, directory, state.counter);

        // 检查异常提示
        const errorItem = observation.items.find(item => {
          const t = normalizeText(item.text);
          return (t.includes('错误') || t.includes('失败') || t.includes('不存在') || t.includes('冻结')) &&
                 !t.includes('没有账号');
        });
        if (errorItem) {
          logger?.console(`[登录失败] 界面提示异常信息: ${errorItem.text}`);
          throw new Error(`YY登录失败提示: ${errorItem.text}`);
        }

        const captchaItem = observation.items.find(item => {
          const t = normalizeText(item.text);
          return t.includes('验证码') || t.includes('安全验证') || t.includes('拖动滑块') || t.includes('点击倒立');
        });
        if (captchaItem) {
          logger?.console(`[风控拦截] 检测到安全验证码: ${captchaItem.text}`);
          throw new Error(`YY登录触发安全验证: ${captchaItem.text}`);
        }

        // 检查登录后系统权限或新版欢迎提示
        const postAction = findPromptAction(observation);
        if (postAction) {
          const pt = tapBox(control, postAction.box, observation);
          logger?.console(`[后置弹窗] 自动点击: "${postAction.label}"...`);
          await control.tap(pt.x, pt.y);
          await control.flush();
          await sleep(1000);
          continue;
        }

        // 检查是否已进入主页
        if (isYayaHomeScreen(observation.items)) {
          logger?.console('[登录成功] 已确认成功登录并进入YY主界面！');
          return { success: true, observation, promptActions };
        }

        await sleep(options.pollMs || 800);
      }

      throw new Error('YY登录提交后等待进入主界面超时');
    }

    await sleep(options.pollMs || 800);
    state.counter += 1;
    observation = await screenshotAndOcr(phone, worker, directory, state.counter);
  }

  throw new Error('YY流程执行超时');
}

class Logger {
  constructor(taskId) {
    this.taskId = taskId;
    this.logDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'login-yaya');
    this.logFile = path.join(this.logDir, `${taskId}.log`);
  }

  async init() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
      await fs.writeFile(this.logFile, `=== YY Login V2 Task Log [ID: ${this.taskId}] ===\nStarted: ${new Date().toISOString()}\n\n`, 'utf8');
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
        return trimmed.slice('YUNMOMO_TOKEN='.length).replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
  return null;
}

function parseCliArgs() {
  const args = {
    execute: process.argv.includes('--execute'),
    account: DEFAULT_ACCOUNT,
    password: DEFAULT_PASSWORD,
  };
  const accIdx = process.argv.indexOf('--account');
  if (accIdx !== -1 && process.argv[accIdx + 1]) {
    args.account = process.argv[accIdx + 1].trim();
  }
  const pwdIdx = process.argv.indexOf('--password');
  if (pwdIdx !== -1 && process.argv[pwdIdx + 1]) {
    args.password = process.argv[pwdIdx + 1].trim();
  }
  return args;
}

async function main() {
  const taskId = process.env.YUNMOMO_SCRIPT_RUN_ID || randomUUID();
  const logger = new Logger(taskId);
  await logger.init();

  try {
    const token = await ensureToken();
    if (!token) throw new Error('缺少 YUNMOMO_TOKEN，请配置环境变量或 .env.local');
    process.env.YUNMOMO_TOKEN = token;

    const cliArgs = parseCliArgs();
    const targetDeviceId = process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID;
    const credentials = {
      account: cliArgs.account,
      password: cliArgs.password,
    };

    const options = {
      pollMs: numberOr(process.env.YUNMOMO_POLL_MS, DEFAULT_POLL_MS),
      homeTimeoutMs: numberOr(process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
      appTimeoutMs: numberOr(process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
      openAttemptTimeoutMs: numberOr(process.env.YUNMOMO_OPEN_ATTEMPT_TIMEOUT_MS, DEFAULT_OPEN_ATTEMPT_TIMEOUT_MS),
      loginTimeoutMs: numberOr(process.env.YUNMOMO_LOGIN_TIMEOUT_MS, DEFAULT_LOGIN_TIMEOUT_MS),
      promptSettleMs: numberOr(process.env.YUNMOMO_PROMPT_SETTLE_MS, DEFAULT_PROMPT_SETTLE_MS),
      maxPromptActions: numberOr(process.env.YUNMOMO_YAYA_MAX_PROMPTS, 12),
      maxPagesPerDirection: numberOr(process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
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
    const deviceName = String(target.deviceName || target.name || resolvedDeviceId);
    logger.file('Target device resolved', { deviceName, resolvedDeviceId, sdkVersion: target.sdkVersion });

    logger.console(`[目标设备] ${deviceName} (${resolvedDeviceId}) | V2 (安卓 12)`);
    logger.console(`[执行操作] 丫丫(YY)应用启动与登录 (账号: ${credentials.account})`);

    const shouldExecute = cliArgs.execute || process.env.YUNMOMO_CONFIRM_YAYA_LOGIN === 'YES';
    if (!shouldExecute) {
      logger.console('[提示] 本脚本将打开YY应用并执行账号登录。如需执行，请传入 --execute 参数。');
      logger.console(`[完整日志] ${logger.relativeLogPath}`);
      return;
    }

    const phone = client.device(resolvedDeviceId);
    const control = await phone.openControl({ udid: target.udid });
    const directory = await require('../../automation/screen').createOcrDirectory('yunmomo-yaya-');
    const worker = new RapidOcrWorker();
    const state = { counter: 0 };
    let success = false;

    try {
      await control.connect();
      logger.file('Control connected successfully');

      // 1. 确认主屏幕就绪
      logger.console('[1/3] 正在确认主屏幕状态...');
      const home = await confirmHome(phone, control, worker, directory, state, options);
      logger.file('Home confirmed', { anchors: homeAnchorMatches(home.items).length, ocrText: home.text });

      // 2. 寻找并打开 YY
      logger.console('[2/3] 正在桌面寻找并打开应用“YY”...');
      const found = await findApp(
        phone,
        control,
        worker,
        directory,
        state,
        home,
        options,
        yayaTargetBox,
        'YY',
      );
      logger.file('App located on launcher', { page: found.page, point: found.point });

      const opened = await openYaya(phone, control, worker, directory, state, found, options);
      logger.console(`[2/3] 已点击应用图标并进入应用 (坐标: x=${opened.point.x}, y=${opened.point.y})`);
      logger.file('App opened observation', { text: opened.opened.text });

      // 3. 执行登录与弹窗处理
      logger.console('[3/3] 正在执行YY账号密码登录与状态核验...');
      const loginResult = await performLogin(
        phone,
        control,
        worker,
        directory,
        state,
        opened.opened,
        credentials,
        options,
        logger,
      );

      success = loginResult.success;

      logger.file('Task execution summary', {
        success,
        alreadyLoggedIn: loginResult.alreadyLoggedIn,
        promptActions: loginResult.promptActions,
        screenshotObservations: state.counter,
      });

      if (!success) {
        throw new Error('丫丫(YY)登录流程未完全成功');
      }

      logger.console(`[完成] 丫丫(YY)登录成功并已就绪！`);
      logger.console(`       目标设备: ${deviceName} (${resolvedDeviceId})`);
      logger.console(`       登录账号: ${credentials.account}`);
      logger.console(`[执行结果] 成功`);
      logger.console(`[完整日志] ${logger.relativeLogPath}`);
    } finally {
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

openYaya = require('../../automation/timing').timed('workflow.login-yaya.openYaya', openYaya);
performLogin = require('../../automation/timing').timed('workflow.login-yaya.performLogin', performLogin);
main = require('../../automation/timing').timedScript('script.src.workflows.v2.login-yaya', main);

if (require.main === module) {
  main().catch(error => {
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  yayaTargetBox,
  isYayaLoginScreen,
  isYayaHomeScreen,
  findPromptAction,
  openYaya,
  performLogin,
};
