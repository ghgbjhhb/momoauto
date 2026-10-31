'use strict';

/**
 * MOMO 监听中枢 (Deterministic & Responsive Watcher)
 *
 * 两种纯粹运行模式：
 * 1. 挂机模式 (watch) : 负责巡查前几页（默认前 4 屏），有未读即处理，巡查完毕或触底后自动回顶持续巡检。
 * 2. 全量模式 (drain) : 必须翻到底！逐屏向下扫描清空整个列表所有未读，直到彻底触底才回顶完成。
 *
 * 核心不变量：
 * - 退出聊天详情唯一动作：点击左上角[<]箭头（物理杜绝退回桌面）。
 * - 弹窗遮罩前置清洗：操作菜单、语聊邀请、来电、更新弹窗绝不渗透到联系人提取中。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../index');
const { runMomoAiReplyOnce } = require('./momo-ai-reply');
const { observePage } = require('../automation/page-service');
const { scanMessageListCandidates } = require('../tools/momo/message-list-parser');
const { classifyGreetingsScreen } = require('../tools/momo/greetings-layout');
const { extractChatContactName, normalize } = require('../tools/momo/chat-history-sync');
const { defaultArbiter } = require('../server/device-arbiter');
const { sleep } = require('../automation/cancellation');
const { PROJECT_ROOT, redact, targetDeviceId } = require('../automation/runtime');

const DESCRIPTION = 'MOMO 监听中枢：支持挂机巡检模式与全量翻底模式，执行入库 -> AI回复 -> 二次入库闭环';

// 定时支线配置
const DEFAULT_GREETINGS_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
const DEFAULT_WARMUP_MIN_MINUTES = 25;
const DEFAULT_WARMUP_MAX_MINUTES = 70;
const DEFAULT_MAX_WATCH_PAGES = 4; // 挂机模式巡查深度（前 4 屏，覆盖约 15~20 位联系人）

let activeRunDir = null;
let activeLogFile = null;

function nowTime() {
  const d = new Date();
  const pad = n => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function log(level, message, meta = null) {
  const lvl = String(level).toUpperCase();
  const line = `[${nowTime()}] [${lvl}] ${message}`;
  console.log(line);
  if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
    console.log('   ' + JSON.stringify(meta));
  }
  if (activeLogFile) {
    const fullText = (meta && typeof meta === 'object' && Object.keys(meta).length > 0)
      ? `${line}\n   ${JSON.stringify(meta)}\n`
      : `${line}\n`;
    await fs.appendFile(activeLogFile, fullText, 'utf8').catch(() => {});
  }
}

async function captureStepScreenshot(tools, dir, filename, desc) {
  if (!tools || typeof tools.screenshot !== 'function' || !dir) return null;
  try {
    const shot = await tools.screenshot({ source: 'stream', maxSize: 1280 }).catch(() => null);
    const imgBuf = shot?.data?.data?.image
      || shot?.data?.image
      || (Buffer.isBuffer(shot?.data) ? shot.data : null)
      || shot?.image;
    if (!imgBuf || (!Buffer.isBuffer(imgBuf) && !(imgBuf instanceof Uint8Array))) return null;
    await fs.mkdir(dir, { recursive: true });
    const targetPath = path.join(dir, `${filename}.png`);
    await fs.writeFile(targetPath, imgBuf);
    const rel = path.relative(PROJECT_ROOT, targetPath);
    await log('DEBUG', `保存截图 [${desc}]: ${filename}.png -> ${rel}`);
    return targetPath;
  } catch (err) {
    await log('WARN', `保存截图 [${desc}] 失败: ${err.message}`);
    return null;
  }
}

/**
 * 统一弹窗与遮罩清理
 * 处理：1. 领红包来电悬浮窗 2. 版本升级弹窗 3. 长按会话菜单 4. 语聊邀请弹窗
 */
async function dismissOverlays(tools, control, observation, options = {}) {
  const items = observation?.evidence?.ocrData?.items || observation?.ocrData?.items || [];
  const w = observation?.width || 720;
  const h = observation?.height || 1280;
  const allText = items.map(it => it.text).join(' ');

  const healDir = activeRunDir ? path.join(activeRunDir, 'healing') : null;

  // 1. 来电悬浮窗拒接
  if (/正打给你|打给你|正在呼叫|呼叫中|聊.*(?:分|秒).*红包/.test(allText)) {
    const bannerItems = items.filter(it => it.top < h * 0.25 && /打给你|呼叫|红包/.test(it.text));
    const centerY = bannerItems.length
      ? Math.round((Math.min(...bannerItems.map(it => it.top)) + Math.max(...bannerItems.map(it => it.bottom))) / 2)
      : Math.round(h * 0.15);
    await log('WARN', '检测到来电/红包悬浮窗，点击红色拒接挂断...');
    await captureStepScreenshot(tools, healDir, `heal-${Date.now()}-call-overlay`, '来电悬浮窗拒接前现场');
    if (tools?.clickRegion) {
      await tools.clickRegion([Math.round(w * 0.67), centerY - 25, Math.round(w * 0.76), centerY + 25], {
        coordinateSpace: { width: w, height: h }
      });
    }
    await sleep(options.settleMs ?? 800, options.signal).catch(() => {});
    return true;
  }

  // 2. 版本升级弹窗 (右上角 X)
  if (/(?:新版本可升级|发现新版本|版本更新)/.test(allText) && /更新内容|立即升级|马上升级/.test(allText)) {
    await log('WARN', '检测到版本更新弹窗，点击右上角关闭(X)...');
    await captureStepScreenshot(tools, healDir, `heal-${Date.now()}-app-update`, '版本更新弹窗关闭前现场');
    const closeX = Math.round(w * 0.903);
    const closeY = Math.round(h * 0.207);
    if (tools?.clickRegion) {
      await tools.clickRegion([closeX - 20, closeY - 20, closeX + 20, closeY + 20], {
        coordinateSpace: { width: w, height: h }
      });
    }
    await sleep(options.settleMs ?? 800, options.signal).catch(() => {});
    return true;
  }

  // 3. 长按操作菜单弹窗 ("操作 / 删除对话 / 聊天记录将会被永久删除，请谨慎操作")
  if (/删除对话|谨慎操作/.test(allText) && items.some(it => /删除对话/.test(it.text))) {
    await log('WARN', '检测到长按会话操作菜单弹窗，点击外部空白区域关闭...');
    await captureStepScreenshot(tools, healDir, `heal-${Date.now()}-context-menu`, '操作菜单弹窗关闭前现场');
    if (tools?.clickRegion) {
      await tools.clickRegion([80, 120, 160, 180], { coordinateSpace: { width: w, height: h } });
    }
    await sleep(options.settleMs ?? 800, options.signal).catch(() => {});
    return true;
  }

  // 4. 语聊房邀请弹窗 ("邀请你一起聊 / 接受邀请")
  if (/邀请你一起聊|接受邀请/.test(allText)) {
    await log('WARN', '检测到语聊房邀请弹窗，下发返回键关闭...');
    await captureStepScreenshot(tools, healDir, `heal-${Date.now()}-voice-invite`, '语聊邀请弹窗关闭前现场');
    if (control?.back) {
      await control.back();
      if (control.flush) await control.flush();
    }
    await sleep(options.settleMs ?? 800, options.signal).catch(() => {});
    return true;
  }

  return false;
}

/**
 * 退出聊天详情页：唯一动作是点击左上角 [<] 箭头返回
 * 优先采用 YOLO (Model 2) 或 OCR 实时识别出的 back_btn 目标坐标，无识别数据时使用顶栏左侧几何区域兜底。
 * 物理杜绝下发安卓物理返回键导致退到桌面的问题！
 */
async function exitChatDetailToMessageList(tools, control, width = 720, height = 1280, options = {}) {
  const detectedBox = options.targetBox
    || options.observation?.targets?.backBtn
    || options.observation?.evidence?.detailRaw?.elements?.back_btn?.box;

  let targetBox = detectedBox;

  // 1. 如果没有检测到模型 box，尝试使用 OCR 在顶栏左侧寻找返回键特征 (<、〈、←、返回)
  if (!targetBox) {
    const items = options.observation?.evidence?.ocrData?.items || [];
    const backItem = items.find(it => it.top < height * 0.15 && it.left < width * 0.25 &&
      (/^[<〈‹＜←]$/.test(it.text.trim()) || /返回/.test(it.text)));
    if (backItem) {
      targetBox = [backItem.left - 5, backItem.top - 5, backItem.right + 5, backItem.bottom + 5];
      await log('INFO', `通过 OCR 识别到左上角返回按钮坐标: [${targetBox.join(', ')}]`);
    }
  }

  // 2. 自愈兜底：无识别数据时使用左上角物理几何区域兜底点击，杜绝死锁卡死
  if (!targetBox) {
    if (options.allowFallback !== false) {
      targetBox = [
        Math.round(width * 0.02),
        Math.round(height * 0.035),
        Math.round(width * 0.16),
        Math.round(height * 0.095)
      ];
      await log('INFO', `未识别到返回键真实坐标，使用左上角返回键几何区域兜底点击 [${targetBox.join(', ')}]`);
    } else {
      await log('WARN', '未识别到返回键真实坐标，拒绝盲目下发固定坐标点击');
      return false;
    }
  }

  if (tools?.clickRegion) {
    await tools.clickRegion(targetBox, { coordinateSpace: { width, height } });
  }
  await sleep(options.settleMs ?? 700, options.signal).catch(() => {});
  return true;
}

/**
 * 快速回到消息列表顶部（点击底栏[消息]Tab）
 */
async function scrollToTop(tools, width = 720, height = 1280, options = {}) {
  const msgTabBox = [
    Math.round(width * 0.44), Math.round(height * 0.92),
    Math.round(width * 0.56), Math.round(height * 0.98)
  ];
  if (tools?.clickRegion) {
    await tools.clickRegion(msgTabBox, { coordinateSpace: { width, height } });
  }
  await sleep(options.settleMs ?? 800, options.signal).catch(() => {});
}

/**
 * 向下滑动列表翻到下一屏
 */
async function swipeDownNextPage(tools, width = 720, height = 1280, options = {}) {
  if (typeof tools?.swipe !== 'function') return false;
  const result = await tools.swipe([
    { x: Math.round(width * 0.50), y: Math.round(height * 0.82) },
    { x: Math.round(width * 0.50), y: Math.round(height * 0.28) }
  ], {
    coordinateSpace: { width, height },
    durationMs: options.durationMs ?? 550
  });
  await sleep(options.settleMs ?? 800, options.signal).catch(() => {});
  return result?.ok === true;
}

/**
 * 确保界面处于消息列表页 (message_list)
 */
async function ensureMessageListPage(tools, control, observation, session, options = {}) {
  const w = observation?.width || 720;
  const h = observation?.height || 1280;
  const page = observation?.page || 'unknown';
  const subPage = observation?.evidence?.pageRaw?.sub_page;
  const items = observation?.evidence?.ocrData?.items || [];

  const allText = items.map(it => it.text).join(' ');
  const hasBottomTabs = items.some(it => it.top > h * 0.82 && /首页|直播|小宇宙|更多/.test(it.text));
  const hasTopMsg = items.some(it => it.top < h * 0.16 && /消息/.test(it.text));
  const hasChatCards = (observation?.evidence?.listRaw?.chat_cards?.length || 0) > 0;
  const hasChatTimestamps = items.some(it => /(?:昨天|前天|刚刚|\d{1,2}:\d{2})/.test(it.text));
  const hasMsgListContent = items.some(it => /互动通知|收到的招呼|最近在线/.test(it.text)) || hasChatCards || hasChatTimestamps;

  const healDir = activeRunDir ? path.join(activeRunDir, 'healing') : null;

  // 1. 如果误入了“马上聊”发现匹配页（底栏有Tab，有马上聊且完全无会话内容），点击顶栏“消息”Tab 切换回来
  const topMsgItem = items.find(it => it.text === '消息' && it.top < h * 0.15 && it.left > w * 0.20 && it.left < w * 0.45);
  const hasMatchFeatures = /开始匹配|马上匹配|连线|换一批|去匹配|匹配中|即时通话|快速匹配/.test(allText);
  const onMatchTab = hasBottomTabs && (hasMatchFeatures || (!hasMsgListContent && items.some(it => it.text === '马上聊' && it.top < h * 0.15)));
  if (onMatchTab && topMsgItem) {
    await log('INFO', '检测到停留在 [马上聊] 匹配页，点击顶栏 [消息] 切回会话列表...');
    await captureStepScreenshot(tools, healDir, `heal-${Date.now()}-match-tab`, '切回消息Tab前现场');
    await tools.clickRegion([topMsgItem.left - 10, topMsgItem.top - 5, topMsgItem.right + 10, topMsgItem.bottom + 5], {
      coordinateSpace: { width: w, height: h }
    });
    await sleep(800, options.signal).catch(() => {});
    return false;
  }

  // 2. 核心确认：处于会话列表（底栏Tab + 顶栏消息/列表内容，或模型判定），100%直接通过！
  if ((hasBottomTabs && (hasTopMsg || hasMsgListContent)) || page === 'message_list' || subPage === '消息列表') {
    return true;
  }

  // 3. 检测到在安卓桌面
  const isLauncher = observation?.app === 'android_launcher' || page === 'android_launcher';
  if (isLauncher) {
    await log('WARN', '检测到当前退出了应用处于桌面，正在重新拉起 MOMO...');
    await captureStepScreenshot(tools, healDir, `heal-${Date.now()}-open-momo`, '重新拉起MOMO前现场');
    if (tools?.openMomo) {
      await tools.openMomo({ signal: options.signal, timeoutMs: 15000 });
      await sleep(1500, options.signal).catch(() => {});
    }
    return false;
  }

  // 4. 停留在真正的聊天详情页（一票否决：物理上绝对不能含有底栏5个导航Tab！）
  const isRealChat = (page === 'chat_detail' || subPage === 'chat_detail' || items.some(it => it.top < h * 0.16 && /与.*对话/.test(it.text))) && !hasBottomTabs;
  if (isRealChat) {
    await log('WARN', '当前停留在聊天详情页，点击左上角 [<] 箭头退回消息列表...');
    await captureStepScreenshot(tools, healDir, `heal-${Date.now()}-exit-chat`, '退出聊天详情页前现场');
    await exitChatDetailToMessageList(tools, control, w, h, { ...options, observation });
    return false;
  }

  // 5. 停留在首页或其他一级Tab -> 点击底栏 [消息]
  if (page === 'home_feed' || subPage === '首页' || (observation?.evidence?.pageRaw?.page_level === '1级页面' && hasBottomTabs)) {
    await log('INFO', '检测到停留在首页/其他一级Tab，点击底栏 [消息] 切回列表...');
    await captureStepScreenshot(tools, healDir, `heal-${Date.now()}-switch-tab`, '点击底栏消息切回前现场');
    await scrollToTop(tools, w, h, options);
    return false;
  }

  // 兜底：如果未知且没有底栏，才尝试点返回
  if (!hasBottomTabs) {
    await log('WARN', `当前处于非消息列表页 (${page || subPage || '未知'})，尝试点击左上角返回...`);
    await captureStepScreenshot(tools, healDir, `heal-${Date.now()}-unknown-exit`, '未知页面退回前现场');
    const exitOk = await exitChatDetailToMessageList(tools, control, w, h, { ...options, observation });
    if (!exitOk && control?.back) {
      await log('WARN', '左上角返回未执行，下发系统返回键兜底...');
      await control.back();
      if (control.flush) await control.flush();
      await sleep(options.settleMs ?? 800, options.signal).catch(() => {});
    }
  } else {
    await scrollToTop(tools, w, h, options);
  }
  return false;
}

/**
 * 消息入库
 */
async function syncContact(tools, peerName, options = {}) {
  if (typeof tools?.syncMomoContacts !== 'function') return null;
  const isPost = options.stage === 'post_reply_sync';
  const stageName = isPost ? '二次入库' : '初始入库';
  try {
    const result = await tools.syncMomoContacts({
      execute: true,
      dryRun: false,
      currentChatOnly: true,
      contactName: peerName,
      signal: options.signal,
      dbPath: options.dbPath,
      ...options.contactSyncOptions,
    });
    if (result?.ok) {
      const count = result.data?.totalMessagesIngested ?? 0;
      await log('INFO', `[${peerName}] ${stageName}完成 (写入 ${count} 条)`);
    }
    return result;
  } catch (err) {
    await log('ERROR', `[${peerName}] ${stageName}失败: ${err.message}`);
    return null;
  }
}

/**
 * AI 回复执行
 */
async function replyContact(client, deviceId, peerName, context = {}) {
  await log('INFO', `[${peerName}] 正在调用 AI 生成回复并发送...`);
  try {
    const result = await runMomoAiReplyOnce(client, deviceId, {
      mode: 'execute',
      contactName: peerName,
      tools: context.tools,
      control: context.control,
      signal: context.signal,
      dbPath: context.dbPath,
      screenshotsDir: activeRunDir ? path.join(activeRunDir, 'ai-replies', peerName) : undefined,
      ...context.aiReplyOptions,
    });
    if (!result?.ok) {
      const err = result?.data?.error || result?.error || {};
      const errMsg = err.message ? `${err.code || 'FAILED'}: ${err.message}` : (err.code || 'MOMO AI reply failed');
      throw new Error(errMsg);
    }
    await log('INFO', `[${peerName}] AI 回复发送成功`);
    return result;
  } catch (err) {
    await log('ERROR', `[${peerName}] AI 回复失败: ${err.message}`);
    return null;
  }
}

/**
 * 识别并处理“收到的招呼”支线
 */
async function tryHandleGreetings(tools, control, observation, session, options = {}) {
  const ocrData = observation?.evidence?.ocrData;
  const pageRaw = observation?.evidence?.pageRaw;
  const w = observation?.width || 720;
  const h = observation?.height || 1280;

  let entryBox = null;
  let unreadCount = null;

  if (typeof classifyGreetingsScreen === 'function') {
    const cls = classifyGreetingsScreen(ocrData, pageRaw);
    if (cls?.greetingsEntryBox) {
      entryBox = cls.greetingsEntryBox;
      unreadCount = cls.unreadCount ?? null;
    }
  }

  if (!entryBox) {
    const items = ocrData?.items || [];
    const item = items.find(it => /收到的招呼|未读招呼/.test(it.text) && it.top > h * 0.10 && it.top < h * 0.88);
    if (item) {
      entryBox = [Math.round(w * 0.05), Math.max(0, item.top - 15), Math.round(w * 0.95), Math.min(h * 0.88, item.bottom + 25)];
    }
  }

  if (!entryBox) return false;

  await log('INFO', `识别到系统条目 [收到的招呼]${unreadCount ? ` (未读: ${unreadCount})` : ''}，点击进入...`);
  await tools.clickRegion(entryBox, { coordinateSpace: { width: w, height: h } });
  await sleep(1000, options.signal).catch(() => {});

  const maxApproved = options.maxApprovedGreetings ?? 5;
  await log('INFO', `开始处理打招呼 (目标通过 ${maxApproved} 人)...`);
  try {
    const result = await tools.processMomoGreetings({
      execute: true,
      maxApproved,
      approveProbability: 0.9,
      rejectProbability: 0.1,
      cycles: 1,
      skipBack: false,
      signal: options.signal,
      timeoutMs: 180000,
    });
    const approved = result?.data?.totalApproved ?? result?.data?.approvedCount ?? 0;
    const outcome = result?.data?.cycles?.[0]?.outcome || result?.data?.outcome;
    const exitVerified = Boolean(result?.data?.exitVerified);
    await log('INFO', `打招呼处理完毕: 成功通过 ${approved} 位 (终态: ${outcome}${exitVerified ? '，已核验返回主列表' : ''})`);
    if (!exitVerified) {
      await log('WARN', '打招呼未确认回到消息列表，尝试兜底返回...');
      await exitChatDetailToMessageList(tools, control, w, h, options);
    }
  } catch (err) {
    await log('ERROR', `打招呼处理异常: ${err.message}`);
    await exitChatDetailToMessageList(tools, control, w, h, options);
  }
  return true;
}

/**
 * 首页养号支线
 */
async function tryHandleWarmup(tools, control, options = {}) {
  if (typeof tools?.browseMomoHome !== 'function') return false;
  await log('INFO', '到达设定周期，开始执行首页养号 (基础浏览与刷新)...');
  try {
    const result = await tools.browseMomoHome({
      execute: true,
      cycles: options.warmupCycles ?? 1,
      mode: options.warmupMode ?? 'random',
      refreshCount: options.warmupRefreshCount ?? { min: 2, max: 5 },
      scrollCount: options.warmupScrollCount ?? { min: 3, max: 6 },
      scrollIntervalMs: options.warmupScrollIntervalMs ?? { min: 1000, max: 3500 },
      signal: options.signal,
      timeoutMs: 180000,
    });
    const report = result?.data || {};
    await log('INFO', `首页养号执行完毕: 刷新 ${report.refreshesSent || 0} 次，滑动浏览 ${report.scrollsSent || 0} 次`);
  } catch (err) {
    await log('ERROR', `首页养号执行异常: ${err.message}`);
  }

  await log('INFO', '养号完毕，点击底栏 [消息] 切回列表...');
  await scrollToTop(tools, 720, 1280, options);
  return true;
}

function calcNextWarmupIntervalMs(options = {}) {
  if (options.warmupIntervalOverrideMs !== null && options.warmupIntervalOverrideMs !== undefined) {
    return Math.max(0, Number(options.warmupIntervalOverrideMs));
  }
  const minMin = options.warmupMinMinutes ?? DEFAULT_WARMUP_MIN_MINUTES;
  const maxMin = options.warmupMaxMinutes ?? DEFAULT_WARMUP_MAX_MINUTES;
  const randomMinutes = minMin + Math.random() * (maxMin - minMin);
  return Math.round(randomMinutes * 60 * 1000);
}

/**
 * MOMO 监听中枢核心循环
 */
async function runMomoMessageWatch(client, deviceId, options = {}) {
  const signal = options.signal;
  const targetLimit = options.maxContacts ?? Infinity;
  const isDrainMode = options.mode === 'drain'; // true = 2. 全量模式 (必须翻到底), false = 1. 挂机模式 (巡查前几页)
  const maxWatchPages = options.maxWatchPages ?? DEFAULT_MAX_WATCH_PAGES;

  let handledContacts = 0;
  let currentScrollPage = 0; // 当前向下翻页深度
  let lastScreenSignature = ''; // 用于检测是否触底
  let consecutiveBottomHits = 0;
  let consecutiveOffListHits = 0;

  // 1. 获取设备单写互斥锁
  const watchRunId = options.runId || 'watch_' + Date.now();
  const leaseRes = defaultArbiter.acquireDevice(deviceId, watchRunId, { returnLease: true });
  if (!leaseRes.ok) {
    throw Object.assign(new Error(`Device ${deviceId} is busy (${leaseRes.reason})`), { code: leaseRes.reason });
  }
  const watchLease = leaseRes.lease;
  options.aiReplyOptions = { ...options.aiReplyOptions, leaseToken: watchLease.leaseToken };

  const device = client.device(deviceId);
  const tools = device.tools();
  const pool = tools._recognitionPool;

  const control = await device.tools()._ensureControl({
    check: () => { if (signal?.aborted) throw new Error('ABORTED'); },
    remaining: () => 30000,
    wait: p => p,
    execution: {},
  });

  const session = { tools, control, deviceId, pool };

  const greetingsIntervalMs = options.greetingsIntervalMs ?? DEFAULT_GREETINGS_INTERVAL_MS;
  let lastGreetingsAt = Date.now();
  let nextWarmupIntervalMs = calcNextWarmupIntervalMs(options);
  let nextWarmupAt = Date.now() + nextWarmupIntervalMs;

  await log('INFO', `定时支线就绪: 下次首页养号预计在 约 ${Math.round(nextWarmupIntervalMs / 60000)} 分钟 后触发`);
  await log('INFO', `定时支线就绪: 下次招呼处理预计在 约 ${Math.round(greetingsIntervalMs / 60000)} 分钟 后触发`);

  // 主循环
  try {
    while (!signal?.aborted) {
    // 1. 观测当前屏幕
    const obs = await observePage({ tools, control, deviceId, pool }, {
      signal,
      timeoutMs: 10000,
    }).catch(err => {
      log('WARN', `页面观测异常: ${err.message}`);
      return null;
    });

    if (!obs || !obs.ok) {
      await sleep(1000, signal).catch(() => {});
      continue;
    }

    // 2. 清理顶层遮挡弹窗
    const overlayDismissed = await dismissOverlays(tools, control, obs, { signal });
    if (overlayDismissed) {
      await sleep(500, signal).catch(() => {});
      continue;
    }

    // 3. 确保位于消息列表页
    const onList = await ensureMessageListPage(tools, control, obs, session, { signal });
    if (!onList) {
      consecutiveOffListHits++;
      if (consecutiveOffListHits >= 3) {
        await log('WARN', `连续 ${consecutiveOffListHits} 次处于非列表页，尝试重新拉起 MOMO 应用切回消息列表...`);
        if (tools?.openMomo) {
          await tools.openMomo({ signal, timeoutMs: 15000 });
          await sleep(1500, signal).catch(() => {});
        }
        await scrollToTop(tools, obs.width, obs.height, { signal });
        consecutiveOffListHits = 0;
      }
      await sleep(800, signal).catch(() => {});
      continue;
    }
    consecutiveOffListHits = 0;

    // 4. 扫描视口联系人
    const scan = scanMessageListCandidates(obs.evidence.ocrData, obs.evidence.listRaw, obs.evidence.pageRaw, {
      onlyContacts: options.onlyContacts,
    });

    const candidates = scan.candidates || [];

    // 纯 emoji/符号名联系人已由扫描层过滤：仅在带未读红点被跳过时提示一次，避免巡查刷屏
    const unreadableUnread = (scan.unreadableNames || []).filter(c => c.unread);
    if (unreadableUnread.length) {
      await log('INFO', `跳过 ${unreadableUnread.length} 个纯emoji/符号名联系人（名字OCR不可读，按规则不自动处理）`);
    }

    const unreadCandidate = candidates.find(c => c.hasUnread);

    // 5. 发现未读联系人 -> 执行对话流程
    if (unreadCandidate) {
      const peerName = unreadCandidate.peerName;
      await log('INFO', `发现未读联系人: [${peerName}] (未读数: ${unreadCandidate.unreadCount ?? '未知'})`);

      const contactDir = activeRunDir ? path.join(activeRunDir, 'contacts', `${Date.now()}_${peerName}`) : null;
      await captureStepScreenshot(tools, contactDir, '01-detected', `[${peerName}] 发现红点原始列表画面`);

      // 5.1 点击联系人卡片（限定点击区域 X >= width * 0.28，避开左侧头像，防止误入个人资料页）
      const cardBox = unreadCandidate.box;
      const avatarBoundaryX = Math.round(obs.width * 0.28);
      const clickBox = [
        Math.max(cardBox[0], avatarBoundaryX),
        cardBox[1] + 4,
        Math.min(cardBox[2], Math.round(obs.width * 0.72)),
        cardBox[3] - 4,
      ];
      if (clickBox[2] <= clickBox[0]) {
        clickBox[0] = avatarBoundaryX;
        clickBox[2] = Math.round(obs.width * 0.65);
      }
      await log('INFO', `点击联系人 [${peerName}] 进入聊天 (避开头像，点击区域: [${clickBox.join(', ')}])`);
      await tools.clickRegion(clickBox, {
        coordinateSpace: { width: obs.width, height: obs.height },
      });
      await sleep(1000, signal).catch(() => {});

      // 5.2 验证是否成功进入聊天详情页
      const detailObs = await observePage({ tools, control, deviceId, pool }, { signal, timeoutMs: 8000 }).catch(() => null);
      const inChat = detailObs?.ok && (detailObs.page === 'chat_detail' || detailObs.evidence?.pageRaw?.sub_page === 'chat_detail');

      if (!inChat) {
        await log('WARN', `未能进入 [${peerName}] 聊天详情页 (当前: ${detailObs?.page || '未知'})`);
        await captureStepScreenshot(tools, contactDir, 'error-deviated-page', `[${peerName}] 未能进入聊天页面画面`);
        // 若当前已经处于消息列表，严禁执行退出手势；仅当进入了未知非列表页面时安全退回
        if (detailObs?.page !== 'message_list') {
          await exitChatDetailToMessageList(tools, control, obs.width, obs.height, {
            signal,
            targetBox: detailObs?.targets?.backBtn,
            observation: detailObs,
          });
        }
        continue;
      }

      // 第二层：对象核验（联系人顶栏名称与预期目标一致性）
      const topTitle = extractChatContactName(detailObs.evidence?.ocrData);
      if (topTitle && normalize(topTitle) !== normalize(peerName)) {
        await log('WARN', `顶栏联系人 [${topTitle}] 与预期 [${peerName}] 不符 (target_mismatch)，安全退回`);
        await captureStepScreenshot(tools, contactDir, 'error-target-mismatch', `[${peerName}] 目标不匹配(${topTitle})画面`);
        await exitChatDetailToMessageList(tools, control, obs.width, obs.height, {
          signal,
          observation: detailObs,
        });
        continue;
      }

      await captureStepScreenshot(tools, contactDir, '02-chat-detail', `[${peerName}] 成功进入聊天界面`);

      // 5.3 初始入库
      await syncContact(tools, peerName, { signal, dbPath: options.dbPath, stage: 'pre_reply_sync' });

      // 5.4 AI 回复与打字发送
      const replyRes = await replyContact(client, deviceId, peerName, {
        tools,
        control,
        signal,
        dbPath: options.dbPath,
        aiReplyOptions: options.aiReplyOptions,
      });

      // 5.5 二次入库
      await sleep(600, signal).catch(() => {});
      await syncContact(tools, peerName, { signal, dbPath: options.dbPath, stage: 'post_reply_sync' });
      await captureStepScreenshot(tools, contactDir, '04-after-post-sync', `[${peerName}] 第二次消息入库完成（含自身气泡）`);

      // 5.6 退出聊天详情页：点击左上角 [<] 箭头返回 (优先使用实测识别出的 back_btn 坐标)
      await exitChatDetailToMessageList(tools, control, obs.width, obs.height, {
        signal,
        targetBox: detailObs?.targets?.backBtn,
      });
      await captureStepScreenshot(tools, contactDir, '05-back-list', `[${peerName}] 归位列表后画面`);
      await log('INFO', `[${peerName}] 处理完毕，返回消息列表`);

      // 5.7 更新计数与检查上限 (仅在真正回复成功时计入进度)
      const limitDesc = targetLimit === Infinity ? '无限制' : `${targetLimit}人`;
      if (replyRes && replyRes.ok) {
        handledContacts++;
        await log('INFO', `[${peerName}] 流程完成 (进度: ${handledContacts}/${limitDesc})`);
        if (targetLimit !== Infinity && handledContacts >= targetLimit) {
          await log('INFO', `达到设定回复人数上限 (${handledContacts}/${targetLimit}人)，任务结束`);
          break;
        }
      } else {
        await log('WARN', `[${peerName}] 回复未成功执行，不计入成功回复配额`);
      }

      // 如果是挂机模式，处理完一条未读后，自动回顶重新开始巡查（确保顶部最新跳出的消息被第一时间捕获）
      if (!isDrainMode && currentScrollPage > 0) {
        await scrollToTop(tools, obs.width, obs.height, { signal });
        currentScrollPage = 0;
        lastScreenSignature = '';
      }

      continue;
    }

    // 6. 当前视口无未读联系人 -> 模式分流（翻页与触底检测）
    const count = candidates.length;
    const currentSignature = candidates.map(c => c.peerName).join('|');

    if (isDrainMode) {
      // ==========================================
      // 模式 2: 全量模式（必须翻到底）
      // ==========================================
      await log('INFO', `[全量模式] 视口 ${count} 位联系人暂无未读，正在向下翻页寻找下屏... (当前第 ${currentScrollPage + 1} 页)`);

      // 检查是否触底（连续滑动后，屏幕上的联系人完全没变，说明无法再往下滑了）
      if (currentSignature && currentSignature === lastScreenSignature) {
        consecutiveBottomHits++;
      } else {
        consecutiveBottomHits = 0;
      }
      lastScreenSignature = currentSignature;

      if (consecutiveBottomHits >= 1) {
        await log('INFO', `[全量模式] 已彻底翻到消息列表最底部，所有积压未读已全部排查处理完毕。`);
        await scrollToTop(tools, obs.width, obs.height, { signal });
        break; // 全量模式翻到底后圆满完成
      }

      // 向下翻页
      currentScrollPage++;
      await swipeDownNextPage(tools, obs.width, obs.height, { signal });
      continue;
    } else {
      // ==========================================
      // 模式 1: 挂机模式（巡查前几页）
      // ==========================================
      if (currentScrollPage < maxWatchPages) {
        // 前几页还没看完，继续向下巡视一屏
        currentScrollPage++;
        await log('INFO', `[挂机模式] 视口 ${count} 位联系人暂无未读，向下巡查第 ${currentScrollPage + 1}/${maxWatchPages + 1} 页...`);

        // 触底检测：如果列表本来就短，提前触底了，直接回顶
        if (currentSignature && currentSignature === lastScreenSignature) {
          await log('INFO', `[挂机模式] 列表已触底（共 ${currentScrollPage} 页），回滚到顶部继续挂机巡查`);
          await scrollToTop(tools, obs.width, obs.height, { signal });
          currentScrollPage = 0;
          lastScreenSignature = '';
        } else {
          lastScreenSignature = currentSignature;
          await swipeDownNextPage(tools, obs.width, obs.height, { signal });
          continue;
        }
      } else {
        // 前几页已经巡视完毕，均无未读 -> 回到顶部，等待新消息并检查定时支线
        await log('INFO', `[挂机模式] 已巡查完前 ${maxWatchPages + 1} 屏所有联系人，未发现新未读，回滚到顶部挂机巡检`);
        await scrollToTop(tools, obs.width, obs.height, { signal });
        currentScrollPage = 0;
        lastScreenSignature = '';
      }

      const now = Date.now();

      // 支线 1: 首页养号
      if (now >= nextWarmupAt) {
        await tryHandleWarmup(tools, control, options);
        nextWarmupIntervalMs = calcNextWarmupIntervalMs(options);
        nextWarmupAt = Date.now() + nextWarmupIntervalMs;
        await log('INFO', `下次首页养号预计在 约 ${Math.round(nextWarmupIntervalMs / 60000)} 分钟 后触发`);
        continue;
      }

      // 支线 2: 招呼处理
      if (now - lastGreetingsAt >= greetingsIntervalMs) {
        lastGreetingsAt = Date.now();
        await tryHandleGreetings(tools, control, obs, session, options);
        await log('INFO', `下次招呼处理预计在 约 ${Math.round(greetingsIntervalMs / 60000)} 分钟 后触发`);
        continue;
      }

      // 稍作等待进入下一轮巡查
      await sleep(options.intervalMs ?? 2500, signal).catch(() => {});
    }
  }
} finally {
  if (watchLease) {
    defaultArbiter.releaseLease(watchLease);
  }
  if (tools) {
    await tools.close().catch(() => {});
  }
}

  // 生成执行报告
  const report = {
    ok: true,
    status: signal?.aborted ? 'aborted' : 'completed',
    mode: isDrainMode ? 'drain' : 'watch',
    handledContacts,
    targetLimit: targetLimit === Infinity ? null : targetLimit,
  };
  if (activeRunDir) {
    const reportPath = path.join(activeRunDir, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8').catch(() => {});
    await log('INFO', `任务结束，报告已写入: ${path.relative(PROJECT_ROOT, reportPath)}`);
  }

  return report;
}

function parseArgs(argv) {
  const envMode = process.env.YUNMOMO_MOMO_WATCH_MODE;
  const envMax = process.env.YUNMOMO_MOMO_MAX_CONTACTS;
  const envWarmup = process.env.YUNMOMO_MOMO_WARMUP_INTERVAL;
  const envGreetings = process.env.YUNMOMO_MOMO_GREETINGS_INTERVAL;

  const options = {
    mode: envMode || 'watch', // 'watch' (1. 挂机模式) | 'drain' (2. 全量模式)
    maxContacts: Infinity,
    greetingsIntervalMs: DEFAULT_GREETINGS_INTERVAL_MS,
    warmupMinMinutes: DEFAULT_WARMUP_MIN_MINUTES,
    warmupMaxMinutes: DEFAULT_WARMUP_MAX_MINUTES,
    warmupIntervalOverrideMs: null,
    maxWatchPages: DEFAULT_MAX_WATCH_PAGES,
  };

  if (envMax && envMax !== 'xx') {
    const parsed = parseInt(envMax, 10);
    if (Number.isInteger(parsed) && parsed > 0) options.maxContacts = parsed;
  }
  if (envWarmup && envWarmup !== 'default') {
    options.warmupIntervalOverrideMs = parseInt(envWarmup, 10);
  }
  if (envGreetings) {
    options.greetingsIntervalMs = parseInt(envGreetings, 10);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode' && argv[i + 1]) {
      options.mode = argv[++i];
    } else if (arg === '--device' && argv[i + 1]) {
      options.deviceId = argv[++i];
    } else if (arg === '--max-contacts' && argv[i + 1]) {
      const parsed = parseInt(argv[++i], 10);
      options.maxContacts = Number.isInteger(parsed) && parsed > 0 ? parsed : Infinity;
    } else if (arg === '--greetings-interval' && argv[i + 1]) {
      options.greetingsIntervalMs = parseInt(argv[++i], 10);
    } else if (arg === '--warmup-interval' && argv[i + 1]) {
      options.warmupIntervalOverrideMs = parseInt(argv[++i], 10);
    } else if (arg === '--run-dir' && argv[i + 1]) {
      options.runDir = argv[++i];
    }
  }

  options.deviceId = targetDeviceId(options.deviceId);
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  activeRunDir = options.runDir || path.join(PROJECT_ROOT, '.local-output', 'momo-watch', `run_${timestamp}_${randomSuffix}`);
  await fs.mkdir(activeRunDir, { recursive: true });
  activeLogFile = path.join(activeRunDir, 'watch.log');

  const modeTitle = options.mode === 'drain' ? '全量模式 (必须翻到底)' : '挂机模式 (巡视前几页)';

  const banner = [
    '--------------------------------------------------',
    'MOMO 监听中枢启动',
    `设备 ID   : ${options.deviceId}`,
    `工作模式  : ${modeTitle}`,
    `处理上限  : ${options.maxContacts === Infinity ? '无限制' : `${options.maxContacts} 位联系人`}`,
    `招呼处理  : 一次通过 5 人 (间隔: ${options.greetingsIntervalMs}ms)`,
    `首页养号  : 每 ${options.warmupMinMinutes}~${options.warmupMaxMinutes} 分钟随机触发`,
    `日志文件  : ${path.relative(PROJECT_ROOT, activeLogFile)}`,
    '--------------------------------------------------\n',
  ].join('\n');
  console.log(banner);
  await fs.writeFile(activeLogFile, banner, 'utf8').catch(() => {});

  const client = new YunmomoClient({ token: process.env.YUNMOMO_TOKEN });
  return await runMomoMessageWatch(client, options.deviceId, options);
}

module.exports = {
  DESCRIPTION,
  runMomoMessageWatch,
  main,
};
