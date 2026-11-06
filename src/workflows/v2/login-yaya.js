'use strict';

// Script 08: 打开丫丫(YY)并登录指定账号密码，支持直接登录(一键授权)与历史复扫双模式 (V2 专属脚本)。
//
// 业务流程：
// 1. 通用前置：确认主屏幕，定位并打开“YY”(丫丫)；
// 2. 账号登录：若未登录则填入指定账号密码并提交，主动收起软键盘防遮挡；
// 3. 页面就绪：确保切换至【项目】主列表；
// 4. 双模式分流：
//    - 模式一（direct，默认）：点击“MOMO陌陌”条目进入详情，点击“一键授权”，
//      高精度记录点击物理时间戳，高频监听“授权成功，已跳转”Toast或MOMO跳转页，
//      完成后返回并持久化授权记录供后续脚本比对；
//    - 模式二（relogin/history）：进入【历史】列表，依据历史时间戳检索订单执行复扫。

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
  mergedBox,
} = require('../../automation/screen');
const { recordAuthStart } = require('../../automation/auth-session');

const DEFAULT_DEVICE_ID = '2002637309737881601';
const DEFAULT_ACCOUNT = process.env.YAYA_ACCOUNT || 'aa12345600';
const DEFAULT_PASSWORD = process.env.YAYA_PASSWORD || 'Aa123123';
const DEFAULT_MODE = process.env.YAYA_MODE || 'direct'; // 'direct' | 'relogin' | 'history'
const DEFAULT_POLL_MS = 700;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_APP_TIMEOUT_MS = 25000;
const DEFAULT_OPEN_ATTEMPT_TIMEOUT_MS = 12000;
const DEFAULT_LOGIN_TIMEOUT_MS = 90000;
const DEFAULT_PROMPT_SETTLE_MS = 900;
const DEFAULT_MAX_PAGES_PER_DIRECTION = 5;

const HISTORY_FILE = path.join(PROJECT_ROOT, '.local-output', 'yaya-auth-history.json');

function formatDateTime(timestamp) {
  const d = new Date(timestamp);
  const pad = n => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

async function recordAuthHistory(record) {
  try {
    await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    let list = [];
    try {
      const content = await fs.readFile(HISTORY_FILE, 'utf8');
      list = JSON.parse(content);
      if (!Array.isArray(list)) list = [];
    } catch {}
    list.unshift(record);
    // 保留最近 100 条记录
    if (list.length > 100) list = list.slice(0, 100);
    await fs.writeFile(HISTORY_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch {}
}

async function getLatestAuthHistory(deviceId) {
  try {
    const content = await fs.readFile(HISTORY_FILE, 'utf8');
    const list = JSON.parse(content);
    if (!Array.isArray(list)) return null;
    return list.find(item => !deviceId || item.deviceId === deviceId) || null;
  } catch {
    return null;
  }
}

async function getLatestAuthTargetTime(deviceId) {
  try {
    const content = await fs.readFile(HISTORY_FILE, 'utf8');
    const list = JSON.parse(content);
    if (!Array.isArray(list)) return null;
    const item = list.find(it => (!deviceId || it.deviceId === deviceId) && (it.targetTimeMatched || it.mode === 'direct'));
    if (!item) return null;
    if (item.targetTimeMatched) return item.targetTimeMatched;
    const timeMatch = item.clickedTimeFormatted?.match(/(\d{2}:\d{2})/);
    return timeMatch ? timeMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * 解析并提取丫丫订单卡片时间信息
 * 支持 "10-25 19:16"、"19:16"、"到期:10-25 19:16"、"到期: 16:05" 等
 */
function parseYayaOrderTime(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const clean = rawText.replace(/[：]/g, ':').trim();

  // 1. 匹配 MM-DD HH:mm (例如 "10-25 19:16")
  const fullMatch = clean.match(/(?:到期[:：]?)?\s*(\d{1,2})[-/](\d{1,2})\s+(\d{1,2})[:：](\d{2})/);
  if (fullMatch) {
    const month = parseInt(fullMatch[1], 10);
    const day = parseInt(fullMatch[2], 10);
    const hours = parseInt(fullMatch[3], 10);
    const minutes = parseInt(fullMatch[4], 10);
    const totalMinutes = (month * 31 + day) * 1440 + hours * 60 + minutes;
    const timeHm = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    const dateMd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return {
      full: `${dateMd} ${timeHm}`,
      dateStr: dateMd,
      timeStr: timeHm,
      month,
      day,
      hours,
      minutes,
      totalMinutes,
      hasDate: true,
    };
  }

  // 2. 匹配仅 HH:mm (例如 "16:05" 或 "到期:16:05")
  const hmMatch = clean.match(/(?:到期[:：]?)?\s*(\d{1,2})[:：](\d{2})/);
  if (hmMatch) {
    const hours = parseInt(hmMatch[1], 10);
    const minutes = parseInt(hmMatch[2], 10);
    const totalMinutes = hours * 60 + minutes;
    const timeHm = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    return {
      full: timeHm,
      dateStr: null,
      timeStr: timeHm,
      month: 0,
      day: 0,
      hours,
      minutes,
      totalMinutes,
      hasDate: false,
    };
  }

  return null;
}

/**
 * 从页面 OCR 项中提取所有订单时间条目，并按屏幕 y 坐标升序排序 (从顶到底，对应时间降序：新 -> 旧)
 * 智能支持：
 * 1) 完整单条 "10-25 19:16" / "到期:10-25 19:16"
 * 2) 跨行拼接：上一行包含 "到期:10-25"，下一行包含 "19:16"
 * 3) 纯时间形式 "19:16" / "16:05"
 */
function extractScreenOrderTimes(items, screenHeight = 640) {
  const list = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // 排除顶部状态栏与底部导航栏区域
    if (it.top < 75 || it.top > screenHeight * 0.85) continue;

    // 检查是否匹配时间 HH:mm
    const hmMatch = it.text.match(/^(\d{1,2})[:：](\d{2})$/) || it.text.match(/(?:到期[:：]?)?\s*(\d{1,2})[:：](\d{2})/);
    if (hmMatch) {
      const hours = parseInt(hmMatch[1], 10);
      const minutes = parseInt(hmMatch[2], 10);
      const timeHm = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

      // 检查本条或前面紧邻条目是否有日期 MM-DD
      let dateMd = null;
      let month = 0, day = 0;
      const dateMatchSelf = it.text.match(/(\d{1,2})[-/](\d{1,2})/);
      if (dateMatchSelf) {
        month = parseInt(dateMatchSelf[1], 10);
        day = parseInt(dateMatchSelf[2], 10);
        dateMd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      } else if (i > 0 && Math.abs(it.top - items[i - 1].top) < 70) {
        const prev = items[i - 1];
        const dateMatchPrev = prev.text.match(/(\d{1,2})[-/](\d{1,2})/);
        if (dateMatchPrev) {
          month = parseInt(dateMatchPrev[1], 10);
          day = parseInt(dateMatchPrev[2], 10);
          dateMd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }

      const totalMinutes = (dateMd ? (month * 31 + day) * 1440 : 0) + hours * 60 + minutes;
      const full = dateMd ? `${dateMd} ${timeHm}` : timeHm;

      // 检查该卡片上下文是否有“有效”或“已过期”标签
      const nearbyItems = items.filter(other => Math.abs(other.top - it.top) < 70);
      let status = 'unknown';
      if (nearbyItems.some(o => o.text.includes('有效'))) {
        status = 'valid';
      } else if (nearbyItems.some(o => o.text.includes('过期'))) {
        status = 'expired';
      }

      list.push({
        parsed: {
          full,
          dateStr: dateMd,
          timeStr: timeHm,
          month,
          day,
          hours,
          minutes,
          totalMinutes,
          hasDate: Boolean(dateMd),
        },
        status,
        item: it,
        top: it.top,
      });
    }
  }
  // 按垂直坐标升序排序（自上而下，对应时间降序：新 -> 旧）
  list.sort((a, b) => a.top - b.top);
  return list;
}

/**
 * 检查当前历史列表是否已经处于最顶部 (顶部搜索框完全露出且位于高位)
 */
function isHistoryListAtTop(items) {
  const searchBox = items.find(it => it.text.includes('搜项目') || it.text.includes('订单') || it.text.includes('搜项目、订单'));
  if (searchBox && searchBox.top < 160) {
    return true;
  }
  const countBox = items.find(it => it.text.includes('已加载') && it.text.includes('共'));
  if (countBox && countBox.top < 100) {
    return true;
  }
  return false;
}

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
  // 第2行第4列（美团外卖下方、高德地图右侧）
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
  // YY 主界面特征：底部包含【项目】、【历史】、【我的】等导航
  const markers = ['项目', '历史', '我的', '我的收藏', '全部', '搜索名称', 'AppID', '收藏'];
  const matched = markers.filter(m => Boolean(findPhrase(items, m)));
  return matched.length >= 2 && !isYayaLoginScreen(items);
}

function isYayaProjectListScreen(items) {
  // 【项目】主列表特征
  return Boolean(
    findPhrase(items, '搜索名称或') ||
    findPhrase(items, '我的收藏') ||
    findPhrase(items, '先看收藏') ||
    (findPhrase(items, '项目') && findPhrase(items, 'MOMO陌陌'))
  );
}

function isYayaAuthDetailScreen(items) {
  // MOMO 授权详情页特征
  return Boolean(findPhrase(items, '一键授权')) &&
         (Boolean(findPhrase(items, 'MOMO陌陌')) || Boolean(findPhrase(items, '显示二维码')));
}

function isMomoTargetScreen(items) {
  // MOMO 跳转后落地页特征（绑定手机号或登录界面）
  return Boolean(
    findPhrase(items, '手机绑定') ||
    findPhrase(items, '绑定手机号') ||
    findPhrase(items, '输入手机号码') ||
    findPhrase(items, '输入验证码')
  );
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
    isTarget: observation => isYayaLoginScreen(observation.items) || isYayaHomeScreen(observation.items) || isYayaAuthDetailScreen(observation.items) || Boolean(findPromptAction(observation)),
    isLauncher: observation => launcherVisible(observation.items),
    launchTimeoutMs: Math.min(options.appTimeoutMs, options.openAttemptTimeoutMs),
  });
}

// 确保 YY 登录并进入应用主界面
async function ensureYayaLoggedInAndReady(phone, control, worker, directory, state, opened, credentials, options, logger) {
  let observation = opened;
  let promptActionCount = 0;
  const promptActions = [];
  const maxWaitMs = options.loginTimeoutMs || DEFAULT_LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + maxWaitMs;
  const maxPromptActions = numberOr(options?.maxPromptActions, 12);

  while (Date.now() <= deadline) {
    // 1. 检查权限/协议等前置弹窗
    const action = findPromptAction(observation);
    if (action && promptActionCount < maxPromptActions) {
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

    // 2. 检查是否已经在主页或授权详情页
    if (isYayaHomeScreen(observation.items) || isYayaAuthDetailScreen(observation.items)) {
      logger?.console('[就绪状态] YY 已处于已登录状态');
      return { success: true, observation, promptActions };
    }

    // 3. 登录界面交互
    if (isYayaLoginScreen(observation.items)) {
      logger?.console(`[登录准备] 已定位登录界面，准备输入凭据 (账号: ${credentials.account})...`);

      // 3.1 账号输入
      const accountBox = findPhrase(observation.items, '账号') || findPhrase(observation.items, '手机号');
      if (!accountBox) throw new Error('YY登录界面未找到“账号”输入框');
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

      // 主动收起软键盘，避免遮挡下方密码框与布局位移
      control.back();
      await control.flush();
      await sleep(500);

      state.counter += 1;
      observation = await screenshotAndOcr(phone, worker, directory, state.counter);

      // 3.2 密码输入
      const passwordBox = observation.items.find(i => i.text.includes('密码') && !i.text.includes('记住'));
      if (!passwordBox) throw new Error('YY登录界面未找到“密码”输入框');
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

      // 再次收起软键盘
      control.back();
      await control.flush();
      await sleep(500);

      state.counter += 1;
      observation = await screenshotAndOcr(phone, worker, directory, state.counter);

      // 3.3 定位并点击“登录”按钮
      let loginButtonBox = observation.items.find(item => {
        const text = normalizeText(item.text);
        return text === '登录' && item.top > (passwordBox ? passwordBox.bottom - 10 : 400);
      });

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
        }
      }

      if (!loginButtonBox) throw new Error('未在界面中定位到底部“登录”提交按钮');

      const loginPoint = tapBox(control, loginButtonBox, observation);
      logger?.console(`[提交登录] 点击登录按钮 (${loginPoint.x}, ${loginPoint.y})...`);
      await control.tap(loginPoint.x, loginPoint.y);
      await control.flush();
      await sleep(2500);

      // 3.4 登录后验等待
      const verifyDeadline = Date.now() + 30000;
      while (Date.now() <= verifyDeadline) {
        state.counter += 1;
        observation = await screenshotAndOcr(phone, worker, directory, state.counter);

        const errorItem = observation.items.find(item => {
          const t = normalizeText(item.text);
          return (t.includes('错误') || t.includes('失败') || t.includes('不存在') || t.includes('冻结')) && !t.includes('没有账号');
        });
        if (errorItem) throw new Error(`YY登录失败提示: ${errorItem.text}`);

        const captchaItem = observation.items.find(item => {
          const t = normalizeText(item.text);
          return t.includes('验证码') || t.includes('安全验证') || t.includes('拖动滑块') || t.includes('点击倒立');
        });
        if (captchaItem) throw new Error(`YY登录触发安全验证: ${captchaItem.text}`);

        const postAction = findPromptAction(observation);
        if (postAction) {
          const pt = tapBox(control, postAction.box, observation);
          await control.tap(pt.x, pt.y);
          await control.flush();
          await sleep(1000);
          continue;
        }

        if (isYayaHomeScreen(observation.items) || isYayaAuthDetailScreen(observation.items)) {
          logger?.console('[登录成功] 已确认成功登录并进入主界面！');
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

  throw new Error('YY登录确认流程超时');
}

// 确保位于【项目】主列表界面
async function ensureProjectTab(phone, control, worker, directory, state, initialObservation, logger) {
  let observation = initialObservation;
  if (isYayaProjectListScreen(observation.items)) {
    return observation;
  }

  // 如果在详情页，先点击左上角返回
  if (isYayaAuthDetailScreen(observation.items)) {
    logger?.console('[切换页面] 当前在授权详情页，点击返回...');
    control.back();
    await control.flush();
    await sleep(600);
    state.counter += 1;
    observation = await screenshotAndOcr(phone, worker, directory, state.counter);
    if (isYayaProjectListScreen(observation.items)) return observation;
  }

  // 寻找底部“项目”Tab并点击
  const projectTab = observation.items.find(item => item.text.trim() === '项目' && item.top > observation.height * 0.75);
  if (projectTab) {
    const pt = tapBox(control, projectTab, observation);
    logger?.console(`[切换页面] 点击底部“项目”导航 (${pt.x}, ${pt.y})...`);
    await control.tap(pt.x, pt.y);
    await control.flush();
    await sleep(800);
    state.counter += 1;
    observation = await screenshotAndOcr(phone, worker, directory, state.counter);
  }

  if (!isYayaProjectListScreen(observation.items)) {
    logger?.file('Ensure project tab warning: not fully matched project list', { text: observation.text });
  }

  return observation;
}

// 模式一：直接登录模式 (点击陌陌 -> 点击一键授权 -> 记录时间戳 -> 捕获Toast/跳转)
async function executeDirectMode(phone, control, worker, directory, state, initialObservation, deviceId, options, logger) {
  let observation = await ensureProjectTab(phone, control, worker, directory, state, initialObservation, logger);

  // 1. 点击“MOMO陌陌”卡片进入详情
  let momoCard = observation.items.find(i => (i.text.includes('MOMO陌陌') || i.text === 'MOMO') && i.top > 150 && i.top < observation.height * 0.75);
  if (!momoCard) {
    // 尝试在搜索框输入或滚动，先直接查找包含“陌陌”的项
    momoCard = observation.items.find(i => i.text.includes('陌陌'));
  }
  if (!momoCard) {
    throw new Error('在【项目】列表中未找到“MOMO陌陌”项目条目');
  }

  const cardPoint = tapBox(control, momoCard, observation);
  logger?.console(`[1/3] 点击“MOMO陌陌”项目条目 (${cardPoint.x}, ${cardPoint.y})...`);
  await control.tap(cardPoint.x, cardPoint.y);
  await control.flush();
  await sleep(1200);

  state.counter += 1;
  observation = await screenshotAndOcr(phone, worker, directory, state.counter);

  // 2. 确认到达授权页并定位“一键授权”
  if (!isYayaAuthDetailScreen(observation.items)) {
    // 若未进入，稍作重试等待
    await sleep(1000);
    state.counter += 1;
    observation = await screenshotAndOcr(phone, worker, directory, state.counter);
    if (!isYayaAuthDetailScreen(observation.items)) {
      throw new Error('点击MOMO卡片后未成功进入授权详情界面');
    }
  }

  const authBtn = observation.items.find(i => i.text.includes('一键授权'));
  if (!authBtn) {
    throw new Error('授权详情界面中未找到“一键授权”按钮');
  }

  const authPoint = tapBox(control, authBtn, observation);

  // 3. 点击“一键授权”并高精度记录物理点击时间
  const clickedAt = Date.now();
  const clickedTimeFormatted = formatDateTime(clickedAt);
  const clickedAtIso = new Date(clickedAt).toISOString();

  logger?.console(`[2/3] 点击“一键授权”按钮 (${authPoint.x}, ${authPoint.y})...`);
  logger?.console(`[记录时间] 授权点击物理时间: ${clickedTimeFormatted} (时间戳: ${clickedAt})`);

  await control.tap(authPoint.x, authPoint.y);
  await control.flush();

  // 4. 密集高频轮询监听“授权成功，已跳转”Toast提示或MOMO跳转
  logger?.console('[3/3] 正在密集监听“授权成功，已跳转”提示与页面跳转...');
  const pollDeadline = Date.now() + 10000;
  let capturedToast = null;
  let jumpedToMomo = false;
  let finalObservation = null;

  while (Date.now() <= pollDeadline) {
    state.counter += 1;
    const shot = await screenshotAndOcr(phone, worker, directory, state.counter);
    finalObservation = shot;

    const toastItem = shot.items.find(i => i.text.includes('授权成功') || i.text.includes('已跳转'));
    if (toastItem) {
      capturedToast = toastItem.text;
      logger?.console(`[成功捕获] 检测到授权提示: "${capturedToast}"`);
    }

    if (isMomoTargetScreen(shot.items)) {
      jumpedToMomo = true;
      logger?.console(`[跳转确认] 检测到手机已成功进入MOMO绑定页面`);
    }

    // 只要出现提示或确认已跳转，即可快速返回完成
    if (capturedToast || jumpedToMomo) {
      break;
    }

    // 200ms 密集观察
    await sleep(200);
  }

  if (!capturedToast && !jumpedToMomo) {
    // 兜底检查是否已经由于提示消失而停留在MOMO界面
    if (finalObservation && isMomoTargetScreen(finalObservation.items)) {
      jumpedToMomo = true;
    } else {
      throw new Error('点击“一键授权”后超时未捕获到“授权成功，已跳转”或目标界面跳转');
    }
  }

  const result = {
    ok: true,
    mode: 'direct',
    status: 'authorized',
    deviceId,
    clickedAt,
    clickedAtIso,
    clickedTimeFormatted,
    toastDetected: Boolean(capturedToast),
    toastText: capturedToast || '授权成功，已跳转',
    targetAppJumped: jumpedToMomo,
    message: '一键授权成功，已跳转',
    summary: `一键授权成功 [${clickedTimeFormatted}] 时间戳=${clickedAt}`,
  };

  // 持久化记录到本地历史供后续跨脚本检索
  await recordAuthHistory(result);
  await recordAuthStart({ deviceId, source: 'yaya_direct', timestamp: clickedAt });
  logger?.console(`[微信授权计时 ⏱️] 微信授权计时已启动！8分钟（480秒）生命周期倒计时开始...`);
  logger?.file('Direct auth result recorded', result);

  return result;
}

// 模式二：历史复扫模式 (依据目标时间在【历史】列表中精准滚动检索并点击“复扫”)
async function executeReloginMode(phone, control, worker, directory, state, initialObservation, deviceId, options, logger) {
  let observation = initialObservation;

  // 1. 确保切换到底部“历史”Tab并复位到列表顶部
  const historyTab = observation.items.find(item => item.text.trim() === '历史' && item.top > observation.height * 0.75);
  if (historyTab) {
    const pt = tapBox(control, historyTab, observation);
    logger?.console(`[历史模式] 点击底部“历史”Tab (${pt.x}, ${pt.y})...`);
    await control.tap(pt.x, pt.y);
    await control.flush();
    await sleep(800);

    // 下拉复位确保从列表顶部（最新订单）开始向下检索
    await control.swipe(
      { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.4) },
      { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.75) },
      { durationMs: 250, steps: 8 }
    );
    await control.flush();
    await sleep(600);

    state.counter += 1;
    observation = await screenshotAndOcr(phone, worker, directory, state.counter);
  }

  // 2. 确定目标时间匹配条件 (优先入参，次取环境变量，再次自动提取历史有效订单到期时间，兜底默认16:05)
  let targetTime = options.targetTime || process.env.YAYA_TARGET_TIME;
  if (!targetTime) {
    const autoTime = await getLatestAuthTargetTime(deviceId);
    if (autoTime) {
      targetTime = autoTime;
      logger?.console(`[智能关联] 未显式传参，自动从历史授权记录中继承目标订单时间: "${targetTime}"`);
    }
  }
  if (!targetTime) targetTime = '16:05';
  logger?.console(`[历史检索] 正在检索目标订单，目标时间特征: "${targetTime}"...`);

  // 3. 在列表中滚动查找包含目标时间特征的卡片
  // 业务规则（用户硬性守则）：
  // 1) 历史列表按到期时间降序（从新到旧）排列；
  // 2) 优先匹配状态为“有效”的目标卡片；
  // 3) 若发现当前视口时间已过（早于目标时间），自动切换方向【往回找】（向下拉动屏幕）；
  // 4) 若往回滑到列表最顶部仍未找到，判定为【订单失败/没有这个订单】，明确报错并提示联系管理员！
  let targetTimeItem = null;
  let orderNumber = null;
  const maxSwipes = options.maxHistorySwipes || 15;
  const parsedTarget = parseYayaOrderTime(targetTime);
  let searchDirection = 'down'; // 'down': 向下翻找更早订单; 'up': 发现时间过了往回找
  let previousScreenDigest = '';
  let upSwipeCount = 0;

  for (let swipeCount = 0; swipeCount < maxSwipes; swipeCount++) {
    // 提取当前屏幕上所有已识别的订单卡片时间
    const screenOrderTimes = extractScreenOrderTimes(observation.items, observation.height);
    const screenDigest = screenOrderTimes.map(t => `${t.parsed.full}(${t.status})`).join('|');

    // 打印当前屏幕的时间序诊断日志
    if (screenOrderTimes.length > 0) {
      const topOrder = screenOrderTimes[0];
      const bottomOrder = screenOrderTimes[screenOrderTimes.length - 1];
      logger?.console(`[时间序识别] 当前第 ${swipeCount + 1} 屏识别到 ${screenOrderTimes.length} 笔订单: [${topOrder.parsed.full}(${topOrder.status}) (顶) -> ${bottomOrder.parsed.full}(${bottomOrder.status}) (底)] | 检索目标: "${targetTime}" | 方向: [${searchDirection === 'down' ? '向下寻找 ⬇️' : '往回寻找 ⬆️'}]`);
    } else {
      logger?.console(`[时间序识别] 当前第 ${swipeCount + 1} 屏未提取到卡片时间戳，进行整屏文本匹配 | 检索目标: "${targetTime}"`);
    }

    // 检查当前画面中是否有匹配目标时间的卡片（优先选择“有效”订单）
    const matchedEntries = screenOrderTimes.filter(entry =>
      (parsedTarget && entry.parsed.timeStr === parsedTarget.timeStr) ||
      entry.parsed.full.includes(targetTime) ||
      normalizeText(entry.item.text).includes(normalizeText(targetTime))
    );

    if (matchedEntries.length > 0) {
      const validOne = matchedEntries.find(e => e.status === 'valid');
      targetTimeItem = validOne ? validOne.item : matchedEntries[0].item;
      logger?.console(`[定位成功] 在当前页面精确找到目标订单: "${targetTimeItem.text}" (y=${Math.round(targetTimeItem.top)}, 状态: ${validOne ? '有效' : '常规'})`);
      break;
    }

    // 兜底在全局 items 中模糊匹配 targetTime
    if (!targetTimeItem) {
      const candidate = observation.items.find(i => {
        if (i.top < 75 || i.top > observation.height * 0.85) return false;
        const t = normalizeText(i.text);
        return t.includes(normalizeText(targetTime));
      });
      if (candidate) {
        targetTimeItem = candidate;
        logger?.console(`[定位成功] 在当前页面模糊匹配到目标订单: "${targetTimeItem.text}" (y=${Math.round(targetTimeItem.top)})`);
        break;
      }
    }

    const isAtTop = isHistoryListAtTop(observation.items);

    // 核心判定 1（用户硬性规则）：
    // “如果滑到顶了还没有，那就是订单失败/没有这个订单，直接报错联系管理员”
    if (searchDirection === 'up' && (isAtTop || (screenOrderTimes.length > 0 && screenDigest === previousScreenDigest && upSwipeCount > 0))) {
      logger?.console(`[订单失败 ❌] 已往回滑到历史列表最顶部（顶栏搜索框已完全展示），仍未找到时间为 "${targetTime}" 的订单！`);
      throw new Error(`【订单失败】：丫丫历史列表中未找到时间为 "${targetTime}" 的有效订单（已往回滑到最顶部确认），订单失败/没有这个订单，请联系管理员！`);
    }

    // 核心判定 2（用户硬性规则）：
    // “这个页面是根据时间排序的，如果发现时间过了，需要往回找”
    // 列表按时间降序（新 -> 旧）。
    // 若当前屏最底部订单的时间已经早于目标时间，说明时间滑过了，必须转入往回找！
    if (screenOrderTimes.length > 0 && parsedTarget) {
      const bottomOrder = screenOrderTimes[screenOrderTimes.length - 1];
      let isPastTarget = false;

      if (parsedTarget.hasDate && bottomOrder.parsed.hasDate) {
        if (bottomOrder.parsed.totalMinutes < parsedTarget.totalMinutes) {
          isPastTarget = true;
        }
      } else if (!parsedTarget.hasDate) {
        const targetMin = parsedTarget.hours * 60 + parsedTarget.minutes;
        const bottomMin = bottomOrder.parsed.hours * 60 + bottomOrder.parsed.minutes;
        if (bottomMin < targetMin) {
          isPastTarget = true;
        }
      }

      if (isPastTarget && searchDirection === 'down') {
        searchDirection = 'up';
        logger?.console(`[时间已过 ⚠️] 检测到当前屏底部时间 (${bottomOrder.parsed.full}) 已早于目标时间 (${targetTime})！`);
        logger?.console(`[往回寻找 ⬆️] 根据业务规则触发往回找，开始向下拉动查看上方更新的记录...`);
      }
    }

    // 触底回查：若向下翻到底部无新内容仍未找到，也转为往回找
    if (screenOrderTimes.length > 0 && screenDigest === previousScreenDigest && searchDirection === 'down' && swipeCount > 0) {
      searchDirection = 'up';
      logger?.console(`[触底回查 ⚠️] 列表已翻至最底部，未匹配到目标，切换为【往回寻找】向上回翻核验...`);
    }

    previousScreenDigest = screenDigest;

    // 根据当前方向执行滑动
    if (searchDirection === 'up') {
      upSwipeCount++;
      // 往回找：手势向下滑动（swipe down，屏幕内容向下滚，展示上方更新的记录）
      logger?.console(`[往回寻找 ⬆️] 正在向上回翻寻找更早前滑过的记录 (第 ${upSwipeCount} 次回翻)...`);
      await control.swipe(
        { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.35) },
        { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.65) },
        { durationMs: 320, steps: 10 }
      );
    } else {
      // 向下找：手势向上滑动（swipe up，屏幕内容向上滚，展示下方更早的记录）
      logger?.console(`[向下滚动 ⬇️] 当前屏未匹配到 "${targetTime}"，向下滚动查找更早记录 (第 ${swipeCount + 1} 次)...`);
      await control.swipe(
        { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.65) },
        { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.35) },
        { durationMs: 350, steps: 10 }
      );
    }

    await control.flush();
    await sleep(800);

    state.counter += 1;
    observation = await screenshotAndOcr(phone, worker, directory, state.counter);
  }

  if (!targetTimeItem) {
    throw new Error(`【订单失败】：在【历史】列表中检索未找到时间为 "${targetTime}" 的有效订单，订单失败/没有这个订单，请联系管理员！`);
  }

  // 4. 定位属于该订单卡片的“订单号”与“复扫”按钮
  const findRescanBtn = (items, timeItem) => items.find(i => {
    const t = normalizeText(i.text);
    return (t === '复扫' || t.includes('复扫')) &&
           i.top > timeItem.top &&
           i.top < timeItem.top + 130;
  });

  let cardRescanBtn = findRescanBtn(observation.items, targetTimeItem);

  // 若卡片位置过低（超过视口高度 55%）导致底部按键可能被底栏遮挡，或者初次未识别到复扫按钮，执行一次平滑上移微调
  if (!cardRescanBtn || targetTimeItem.top > observation.height * 0.55) {
    logger?.console(`[视口对齐] 目标卡片偏底 (y=${Math.round(targetTimeItem.top)})，执行平滑微调使其完整居中...`);
    await control.swipe(
      { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.6) },
      { x: Math.round(control.screenWidth * 0.5), y: Math.round(control.screenHeight * 0.4) },
      { durationMs: 300, steps: 8 }
    );
    await control.flush();
    await sleep(800);

    state.counter += 1;
    observation = await screenshotAndOcr(phone, worker, directory, state.counter);

    // 在新视口重新定位目标时间项与复扫按键
    const recheckedTime = observation.items.find(i => normalizeText(i.text).includes(normalizeText(targetTime)));
    if (recheckedTime) {
      targetTimeItem = recheckedTime;
      logger?.console(`[视口对齐] 微调后重新定位目标时间条目: "${targetTimeItem.text}" (y=${Math.round(targetTimeItem.top)})`);
    }
    cardRescanBtn = findRescanBtn(observation.items, targetTimeItem);
  }

  // 提取订单号
  const orderItem = observation.items.find(i => i.text.includes('订单号') && Math.abs(i.top - targetTimeItem.top) < 70);
  if (orderItem) {
    const match = orderItem.text.match(/订单号[：:]\s*([a-zA-Z0-9]+)/);
    orderNumber = match ? match[1] : orderItem.text;
    logger?.console(`[订单信息] 匹配到订单号: ${orderNumber}`);
  }

  if (!cardRescanBtn) {
    const nearby = observation.items.filter(i => Math.abs(i.top - targetTimeItem.top) < 160);
    logger?.file('Nearby items around targetTimeItem', { targetTimeItem, nearby });
    throw new Error(`已找到 "${targetTime}" 卡片，但未能定位到该卡片对应的“复扫”按钮`);
  }

  let rescanPoint;
  if (normalizeText(cardRescanBtn.text) === '复扫') {
    rescanPoint = tapBox(control, cardRescanBtn, observation);
  } else {
    // 若 OCR 将多个按钮合为一个文本框，例如“复制卡密 复扫”
    const norm = cardRescanBtn.text.replace(/\s+/g, '');
    const idx = norm.indexOf('复扫');
    const frac = norm.length > 0 ? (idx + 1) / norm.length : 0.5;
    const clickX = cardRescanBtn.left + cardRescanBtn.width * frac;
    const clickY = cardRescanBtn.centerY;
    rescanPoint = {
      x: Math.round(clickX * (control.screenWidth / observation.width)),
      y: Math.round(clickY * (control.screenHeight / observation.height)),
    };
  }
  const clickedAt = Date.now();
  const clickedTimeFormatted = formatDateTime(clickedAt);
  const clickedAtIso = new Date(clickedAt).toISOString();

  logger?.console(`[执行复扫] 点击对应卡片的“复扫”按钮 (${rescanPoint.x}, ${rescanPoint.y})...`);
  logger?.console(`[记录时间] 复扫点击物理时间: ${clickedTimeFormatted} (时间戳: ${clickedAt})`);

  await control.tap(rescanPoint.x, rescanPoint.y);
  await control.flush();

  // 5. 密集高频轮询监听“授权成功，已跳转”提示或进入MOMO
  logger?.console('[后验监听] 正在密集监听复扫后的“授权成功，已跳转”提示与页面跳转...');
  const pollDeadline = Date.now() + 10000;
  let capturedToast = null;
  let jumpedToMomo = false;

  while (Date.now() <= pollDeadline) {
    state.counter += 1;
    const shot = await screenshotAndOcr(phone, worker, directory, state.counter);

    const toastItem = shot.items.find(i => i.text.includes('授权成功') || i.text.includes('已跳转'));
    if (toastItem) {
      capturedToast = toastItem.text;
      logger?.console(`[成功捕获] 检测到复扫授权提示: "${capturedToast}"`);
    }

    if (isMomoTargetScreen(shot.items) || shot.items.some(i => i.text.includes('你的性别是') || i.text.includes('男生'))) {
      jumpedToMomo = true;
      logger?.console(`[跳转确认] 检测到手机已成功进入MOMO业务页面`);
    }

    if (capturedToast || jumpedToMomo) break;
    await sleep(200);
  }

  const result = {
    ok: true,
    mode: 'relogin',
    status: 'rescanned',
    deviceId,
    targetTimeMatched: targetTime,
    orderNumber: orderNumber || 'unknown',
    clickedAt,
    clickedAtIso,
    clickedTimeFormatted,
    toastDetected: Boolean(capturedToast),
    toastText: capturedToast || '授权成功，已跳转',
    targetAppJumped: jumpedToMomo,
    message: '历史订单复扫成功，已跳转',
    summary: `复扫成功 [匹配:${targetTime}] [${clickedTimeFormatted}] 时间戳=${clickedAt}`,
  };

  await recordAuthHistory(result);
  await recordAuthStart({ deviceId, source: 'yaya_relogin', timestamp: clickedAt });
  logger?.console(`[微信授权计时 ⏱️] 微信授权计时已启动！8分钟（480秒）生命周期倒计时开始...`);
  logger?.file('Relogin rescan result recorded', result);

  return result;
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
    mode: DEFAULT_MODE,
    targetTime: null,
  };
  const accIdx = process.argv.indexOf('--account');
  if (accIdx !== -1 && process.argv[accIdx + 1]) args.account = process.argv[accIdx + 1].trim();
  const pwdIdx = process.argv.indexOf('--password');
  if (pwdIdx !== -1 && process.argv[pwdIdx + 1]) args.password = process.argv[pwdIdx + 1].trim();
  const modeIdx = process.argv.indexOf('--mode');
  if (modeIdx !== -1 && process.argv[modeIdx + 1]) args.mode = process.argv[modeIdx + 1].trim();
  const timeIdx = process.argv.indexOf('--target-time');
  if (timeIdx !== -1 && process.argv[timeIdx + 1]) args.targetTime = process.argv[timeIdx + 1].trim();
  return args;
}

// 核心工作流函数：支持被其他业务脚本直接 require 调用并获取结构化返回值
async function runYayaWorkflow(customParams = {}) {
  const taskId = customParams.taskId || process.env.YUNMOMO_SCRIPT_RUN_ID || randomUUID();
  const logger = customParams.logger || new Logger(taskId);
  await logger.init();

  const token = customParams.token || await ensureToken();
  if (!token) throw new Error('缺少 YUNMOMO_TOKEN，请配置环境变量或 .env.local');
  process.env.YUNMOMO_TOKEN = token;

  const cliArgs = parseCliArgs();
  const targetDeviceId = customParams.deviceId || process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID;
  const mode = customParams.mode || cliArgs.mode || DEFAULT_MODE;
  const credentials = {
    account: customParams.account || cliArgs.account || DEFAULT_ACCOUNT,
    password: customParams.password || cliArgs.password || DEFAULT_PASSWORD,
  };

  const options = {
    pollMs: numberOr(customParams.pollMs ?? process.env.YUNMOMO_POLL_MS, DEFAULT_POLL_MS),
    homeTimeoutMs: numberOr(customParams.homeTimeoutMs ?? process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
    appTimeoutMs: numberOr(customParams.appTimeoutMs ?? process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    openAttemptTimeoutMs: numberOr(customParams.openAttemptTimeoutMs ?? process.env.YUNMOMO_OPEN_ATTEMPT_TIMEOUT_MS, DEFAULT_OPEN_ATTEMPT_TIMEOUT_MS),
    loginTimeoutMs: numberOr(customParams.loginTimeoutMs ?? process.env.YUNMOMO_LOGIN_TIMEOUT_MS, DEFAULT_LOGIN_TIMEOUT_MS),
    promptSettleMs: numberOr(customParams.promptSettleMs ?? process.env.YUNMOMO_PROMPT_SETTLE_MS, DEFAULT_PROMPT_SETTLE_MS),
    maxPromptActions: numberOr(customParams.maxPromptActions ?? process.env.YUNMOMO_YAYA_MAX_PROMPTS, 12),
    maxPagesPerDirection: numberOr(customParams.maxPagesPerDirection ?? process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
    targetTime: customParams.targetTime || cliArgs.targetTime || process.env.YAYA_TARGET_TIME || null,
  };

  const client = customParams.client || new YunmomoClient({ timeoutMs: 100000 });
  const devices = await client.listDevices({ size: 50000 });
  let target = (devices.records || []).find(record => matchesDevice(record, targetDeviceId));
  if (!target && devices.records?.length > 0 && !customParams.deviceId && !process.env.YUNMOMO_DEVICE_ID) {
    target = (devices.records || []).find(record => {
      const sdk = String(record.sdkVersion || '').trim().toLowerCase();
      return sdk === 'v2';
    });
  }
  if (!target) throw new Error(`未找到匹配的 V2 设备: ${targetDeviceId}`);

  const resolvedDeviceId = deviceIdOf(target);
  const devLabel = (customParams && customParams.deviceName) ? customParams.deviceName : formatDeviceLabel(target);
  logger.file('Target device resolved', { deviceName, resolvedDeviceId, sdkVersion: target.sdkVersion, mode });

  logger.console(`📱 目标设备: ${devLabel}`);
  logger.console(`⚙️ 运行模式: ${mode === 'direct' ? '直接登录 (一键授权)' : '历史复扫'}`);

  const phone = client.device(resolvedDeviceId);
  const control = customParams.control || await phone.openControl({ udid: target.udid });
  const ownsControl = !customParams.control;
  const directory = await require('../../automation/screen').createOcrDirectory('yunmomo-yaya-');
  const worker = customParams.worker || new RapidOcrWorker();
  const ownsWorker = !customParams.worker;
  const state = { counter: 0 };

  try {
    if (!control.connected) {
      await control.connect();
      logger.file('Control connected successfully');
    }

    // 0. 最前置：在执行流程前先按 Home 键退出任意前台应用，确保从桌面安全启动
    logger.console('🏠 [0/4] 按 Home 键返回桌面...');
    await sendHome(control);
    await sleep(800);

    // 1. 确认主屏幕就绪
    logger.console('🏠 [1/4] 检查桌面状态...');
    const home = await confirmHome(phone, control, worker, directory, state, options);
    logger.file('Home confirmed', { anchors: homeAnchorMatches(home.items).length, ocrText: home.text });

    // 2. 寻找并打开 YY
    logger.console('🔍 [2/4] 在桌面寻找 YY...');
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
    logger.console('👆 [2/4] 已点击 YY 图标，等待启动...');

    // 3. 通用前置：登录账号密码并确认主界面
    logger.console('🎯 [3/4] 检查登录状态与弹窗...');
    const loginResult = await ensureYayaLoggedInAndReady(
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

    // 4. 双模式分流执行
    logger.console(`▶️ [4/4] 开始执行业务模式: ${mode === 'direct' ? '直接登录' : '历史复扫'}...`);
    let workflowResult;
    if (mode === 'direct') {
      workflowResult = await executeDirectMode(
        phone,
        control,
        worker,
        directory,
        state,
        loginResult.observation,
        resolvedDeviceId,
        options,
        logger,
      );
    } else {
      workflowResult = await executeReloginMode(
        phone,
        control,
        worker,
        directory,
        state,
        loginResult.observation,
        resolvedDeviceId,
        options,
        logger,
      );
    }

    logger.console('✅ YY 执行完成');
    logger.console(`   ⚙️ 模式: ${workflowResult.mode} | 状态: ${workflowResult.status}`);
    logger.console(`   ⏰ 点击时间: ${workflowResult.clickedTimeFormatted}`);
    if (workflowResult.toastText) {
      logger.console(`   💬 提示: ${workflowResult.toastText}`);
    }
    logger.console('✅ 执行成功');

    return workflowResult;
  } finally {
    if (ownsWorker) await worker.close();
    if (ownsControl) await control.close();
    if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
      await fs.rm(directory, { recursive: true, force: true });
    } else {
      logger.console(`[截图归档] ${directory}`);
    }
  }
}

async function main() {
  const cliArgs = parseCliArgs();
  const shouldExecute = cliArgs.execute || process.env.YUNMOMO_CONFIRM_YAYA_LOGIN === 'YES';
  if (!shouldExecute) {
    console.log('[提示] 本脚本将打开YY应用并执行业务模式操作。如需执行，请传入 --execute 参数。');
    console.log('       支持模式: --mode direct (直接授权，默认) 或 --mode relogin (历史复扫)');
    return;
  }

  try {
    const result = await runYayaWorkflow();
    // 供其他以子进程调用的脚本解析结构化 JSON
    console.log('\n--- 结构化返回值 JSON ---');
    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    console.error(`[执行结果] 失败: ${err.message}`);
    throw err;
  }
}

runYayaWorkflow = require('../../automation/timing').timed('workflow.login-yaya.run', runYayaWorkflow);

async function runStep(context = {}) {
  const { phone, control, worker, directory, state, target, client, options } = context;
  if (!phone || !control || !worker) {
    throw new Error('runStep 必须提供 phone, control, worker 会话对象');
  }
  const result = await runYayaWorkflow({
    client,
    control,
    worker,
    deviceId: phone.deviceId,
    target,
    directory,
    state,
    ...(options || {})
  });
  return result;
}

main = require('../../automation/timing').timedScript('script.src.workflows.v2.login-yaya', main);

if (require.main === module) {
  main().catch(error => {
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  runStep,
  runYayaWorkflow,
  recordAuthHistory,
  getLatestAuthHistory,
  yayaTargetBox,
  isYayaLoginScreen,
  isYayaHomeScreen,
  isYayaProjectListScreen,
  isYayaAuthDetailScreen,
  isMomoTargetScreen,
  findPromptAction,
  openYaya,
  ensureYayaLoggedInAndReady,
  executeDirectMode,
  executeReloginMode,
};
