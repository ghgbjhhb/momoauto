'use strict';

/**
 * MOMO 监听中枢（flow-15 自动挂机回复）
 *
 * 本脚本只负责「认路、找人、调度」，具体业务全部调用已有子脚本：
 *   13 联系人及消息入库  tools.syncMomoContacts
 *   14 AI 回复           runMomoAiReplyOnce
 *   12 招呼处理          tools.processMomoGreetings
 *   11 首页养号          tools.browseMomoHome
 *
 * 结构：
 * - 导航 toMessageList()：全脚本唯一负责「回到消息列表」的地方。每步观测一帧 -> 做一个纠正动作 -> 再观测。
 *   认不出的页面、纠正无效、安全守卫一律保存截图后停止。以后要支持新的异常，只改 correct()/dismissOverlay()。
 * - 任务：处理联系人 / 招呼 / 养号各自独立，从消息列表出发，做完交回导航，自己不找路。
 * - 调度：有未读先回复；空闲时执行到期的招呼或养号；否则停在列表顶部等待。
 *
 * 挂机模式：启动时先全量清一遍积压未读；之后停在列表顶部，每隔几秒看首屏（新消息会排到最上面）。
 *   回复过的人会跳到顶部、把其余未读往下推，所以首屏最下面一张卡片是本批处理过的人时，继续往下看一屏。
 * 全量模式：从顶部逐屏处理到底，再回顶复查，直到一整遍没有可处理的未读。
 *
 * 点进去不是聊天页的卡片记入设备数据目录下的 watch-ignored-cards.json，以后不再点击（删掉对应条目即可恢复）。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../index');
const { runMomoAiReplyOnce } = require('./momo-ai-reply');
const { observePage } = require('../automation/page-service');
const { returnMessageListTop, listSignature, sameContactNames } = require('../automation/message-list-navigation');
const { scanMessageListCandidates } = require('../tools/momo/message-list-parser');
const { classifyGreetingsScreen } = require('../tools/momo/greetings-layout');
const { candidateSignature } = require('../tools/momo/message-list-watcher');
const { extractChatContactName, normalize } = require('../tools/momo/chat-history-sync');
const { getDeviceDatabasePath } = require('../tools/momo/db');
const { defaultArbiter } = require('../server/device-arbiter');
const { sleep } = require('../automation/cancellation');
const { imageExtension } = require('../automation/image-format');
const { PROJECT_ROOT, targetDeviceId } = require('../automation/runtime');

const DESCRIPTION = 'MOMO 监听中枢：支持挂机巡检模式与全量翻底模式，执行入库 -> AI回复 -> 二次入库闭环';

const DEFAULT_GREETINGS_MIN_MINUTES = 8;    // 招呼处理间隔下限
const DEFAULT_GREETINGS_MAX_MINUTES = 30;   // 招呼处理间隔上限
const DEFAULT_WARMUP_MIN_MINUTES = 10;
const DEFAULT_WARMUP_MAX_MINUTES = 25;
const DEFAULT_MAX_WATCH_PAGES = 5;          // 挂机模式顺着本批未读往下看的最多屏数（含首屏）
const MIN_APPROVED_GREETINGS = 3;           // 每次招呼处理通过人数下限
const MAX_APPROVED_GREETINGS = 6;           // 每次招呼处理通过人数上限
const DEFAULT_IDLE_INTERVAL_MS = 2500;      // 挂机空闲时两次看首屏的间隔
const DRAIN_MAX_PAGES = 40;                 // 全量模式单遍最多翻屏数
const DRAIN_MAX_ROUNDS = 5;                 // 全量模式最多复查遍数
const PEER_COOLDOWN_MS = 10 * 60 * 1000;    // 进入失败的联系人冷却时间（不确定原因，暂不标记）
const GREETINGS_RETRY_MS = 5 * 60 * 1000;   // 首屏没找到招呼入口时的重试间隔
const NAV_MAX_STEPS = 8;                    // 单次回到消息列表最多纠正步数
const NAV_MAX_SAME_STATE = 3;               // 同一画面连续出现多少次视为纠正无效
const MAX_OBSERVE_FAILURES = 3;             // 连续截图/识别失败多少次停止
const MAX_LIST_MODEL_MISSING = 5;           // 消息列表模型连续多少帧没返回卡片就停止
const RISK_RECHECKS = 2;                    // 频率提示（风控）出现后等待复查的次数，仍在则停止
const RISK_WAIT_MS = 5000;
const MAX_OPEN_FAILURES = 3;                // 连续多少个联系人进不去聊天页就停止
const MAX_REPLY_FAILURES = 3;               // 连续多少次回复未成功就停止
const STOP_OVERLAYS = new Set(['captcha', 'login', 'permission', 'exit_confirm', 'assistant_unconfirmed']);

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
  const hasMeta = meta && typeof meta === 'object' && Object.keys(meta).length > 0;
  if (hasMeta) console.log('   ' + JSON.stringify(meta));
  if (activeLogFile) {
    const text = hasMeta ? `${line}\n   ${JSON.stringify(meta)}\n` : `${line}\n`;
    await fs.appendFile(activeLogFile, text, 'utf8').catch(() => {});
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
    const extension = imageExtension(imgBuf);
    if (!extension) { await log('WARN', `截图 [${desc}] 格式未知，未保存`); return null; }
    await fs.mkdir(dir, { recursive: true });
    const targetPath = path.join(dir, `${filename}${extension}`);
    await fs.writeFile(targetPath, imgBuf);
    await log('DEBUG', `保存截图 [${desc}]: ${path.relative(PROJECT_ROOT, targetPath)}`);
    return targetPath;
  } catch (err) {
    await log('WARN', `保存截图 [${desc}] 失败: ${err.message}`);
    return null;
  }
}

function safeDirName(value) {
  return String(value ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60) || 'unknown';
}

/** 需要停止脚本的异常。 */
function fatal(code, message) {
  return Object.assign(new Error(message), { code, fatal: true });
}

function minutes(ms) {
  return Math.round(ms / 60000);
}

function calcNextWarmupIntervalMs() {
  return Math.round((DEFAULT_WARMUP_MIN_MINUTES + Math.random() *
    (DEFAULT_WARMUP_MAX_MINUTES - DEFAULT_WARMUP_MIN_MINUTES)) * 60 * 1000);
}

function calcNextGreetingsIntervalMs() {
  return Math.round((DEFAULT_GREETINGS_MIN_MINUTES + Math.random() *
    (DEFAULT_GREETINGS_MAX_MINUTES - DEFAULT_GREETINGS_MIN_MINUTES)) * 60 * 1000);
}

/** 一帧画面的粗粒度状态，用来判断纠正动作有没有让画面变化。 */
function pageKey(obs) {
  return `${obs.app}:${obs.page}:${obs.scene}:${obs.overlay}:${listSignature(obs)}`;
}

/**
 * 把一帧观测解释为可扫描的消息列表。不是列表、有遮挡、或停在「马上聊」匹配页时返回 null。
 * 联系人按从上到下排序。listModelMissing 表示列表模型本帧没返回结果（无法判断红点）。
 */
function listReady(obs, options = {}) {
  if (!obs?.ok || obs.page !== 'message_list' || obs.overlay !== 'none') return null;
  const { ocrData, listRaw, pageRaw } = obs.evidence || {};
  const scan = scanMessageListCandidates(ocrData, listRaw, pageRaw, { onlyContacts: options.onlyContacts });
  if (scan.isOnMatchTab) return null;
  scan.candidates = [...(scan.candidates || [])].sort((a, b) => a.box[1] - b.box[1]);
  return { obs, scan, listModelMissing: !listRaw };
}

/** 底栏唯一的「消息」Tab；要求底栏其他 Tab 同时存在，排除聊天内容里的同名文字。 */
function findBottomMessageTab(obs) {
  const items = obs?.evidence?.ocrData?.items || [];
  const w = obs.width, h = obs.height;
  if (!items.some(it => it.top > h * 0.85 && /首页|直播|小宇宙|更多/.test(it.text))) return null;
  const matches = items.filter(it => it.text?.trim() === '消息' && it.top > h * 0.85 &&
    it.left > w * 0.20 && it.right < w * 0.80);
  if (matches.length !== 1) return null;
  const it = matches[0];
  return [it.left - 12, it.top - 8, it.right + 12, it.bottom + 8];
}

/** 一级页面特征：底栏 Tab。一级页绝不按返回键（会退到桌面）。 */
function hasBottomTabs(obs) {
  const items = obs?.evidence?.ocrData?.items || [];
  return items.some(it => it.top > obs.height * 0.85 && /首页|直播|小宇宙|更多/.test(it.text));
}

/** 「马上聊」匹配页顶栏的「消息」Tab。 */
function findTopMessageTab(obs) {
  const items = obs?.evidence?.ocrData?.items || [];
  const it = items.find(item => item.text === '消息' && item.top < obs.height * 0.15 &&
    item.left > obs.width * 0.20 && item.left < obs.width * 0.45);
  return it ? [it.left - 10, it.top - 5, it.right + 10, it.bottom + 5] : null;
}

/** 首屏「收到的招呼」入口。 */
function findGreetingsEntry(obs) {
  const ocrData = obs.evidence?.ocrData;
  const cls = classifyGreetingsScreen(ocrData, obs.evidence?.pageRaw);
  if (cls?.greetingsEntryBox) return { box: cls.greetingsEntryBox, unreadCount: cls.unreadCount ?? null };
  const w = obs.width, h = obs.height;
  const item = (ocrData?.items || []).find(it => /收到的招呼|未读招呼/.test(it.text) && it.top > h * 0.10 && it.top < h * 0.88);
  if (!item) return null;
  return {
    box: [Math.round(w * 0.05), Math.max(0, item.top - 15), Math.round(w * 0.95), Math.min(Math.round(h * 0.88), item.bottom + 25)],
    unreadCount: null,
  };
}

/** 联系人卡片点击区域：避开左侧头像（防误入个人资料页）与右侧角标。 */
function contactClickBox(candidate, obs) {
  const [x1, y1, x2, y2] = candidate.box;
  const box = [Math.max(x1, Math.round(obs.width * 0.28)), y1 + 4, Math.min(x2, Math.round(obs.width * 0.72)), y2 - 4];
  if (box[2] <= box[0]) {
    box[0] = Math.round(obs.width * 0.28);
    box[2] = Math.round(obs.width * 0.65);
  }
  return box;
}

/**
 * 「点进去不是聊天页」的卡片名单，按设备持久化，跨运行生效。
 * 文件是普通 JSON：{ "名字": { reason, page, scene, markedAt } }，删掉某条即恢复自动处理。
 */
class IgnoredCards {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = {};
  }

  async load() {
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw fatal('IGNORED_CARDS_UNREADABLE', `无法读取忽略名单 ${this.filePath}: ${err.message}`);
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw fatal('IGNORED_CARDS_INVALID', `忽略名单格式不正确，请修正或删除: ${this.filePath}`);
    }
    this.entries = parsed;
  }

  has(name) {
    return Object.prototype.hasOwnProperty.call(this.entries, name);
  }

  get size() {
    return Object.keys(this.entries).length;
  }

  async add(name, info) {
    this.entries[name] = { ...info, markedAt: new Date().toISOString() };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.entries, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

function ignoredCardsPath(deviceId, dbPath) {
  const base = dbPath && dbPath !== ':memory:' ? path.dirname(path.resolve(dbPath)) : path.dirname(getDeviceDatabasePath(deviceId));
  return path.join(base, 'watch-ignored-cards.json');
}

class WatchHub {
  constructor(client, deviceId, options = {}) {
    this.client = client;
    this.deviceId = String(deviceId);
    this.options = options;
    this.signal = options.signal;
    this.isDrain = options.mode === 'drain';
    this.targetLimit = options.maxContacts ?? Infinity;
    this.maxWatchPages = Math.max(1, options.maxWatchPages ?? DEFAULT_MAX_WATCH_PAGES);
    this.maxDistanceKm = options.maxDistanceKm ?? null;
    this.ignored = new IgnoredCards(ignoredCardsPath(this.deviceId, options.dbPath));

    this.tools = null;
    this.lease = null;
    this.handledContacts = 0;
    this.attempts = 0;
    this.cooldowns = new Map();          // peerName -> 冷却截止时间
    this.handledSignatures = new Map();  // peerName -> 处理时的卡片签名；签名变了（来了新消息）才会再处理
    this.burst = new Set();              // 本批处理过的联系人（挂机模式判断是否需要往下多看一屏）
    this.reportedUnreadable = new Set();
    this.openFailures = 0;
    this.replyFailures = 0;
    this.listModelMissing = 0;
    this.nextWarmupAt = 0;
    this.nextGreetingsAt = 0;
  }

  get healDir() {
    return activeRunDir ? path.join(activeRunDir, 'healing') : null;
  }

  /** 单一控制连接：点击/滑动走 tools 队列，返回键与回顶读取同一个 tools._control。 */
  async ensureControl() {
    return this.tools._ensureControl({
      check: () => { if (this.signal?.aborted) throw Object.assign(new Error('ABORTED'), { code: 'ABORTED' }); },
      remaining: () => 30000,
      wait: p => p,
      execution: {},
    });
  }

  session() {
    const tools = this.tools;
    const hub = this;
    return {
      deviceId: this.deviceId,
      tools,
      pool: tools._recognitionPool,
      get control() { return tools._control; },
      get generation() { return tools._control?.generation ?? tools._control?._generation ?? 1; },
      assertActive: () => defaultArbiter.assertLease(hub.lease),
    };
  }

  observe(timeoutMs = 10000) {
    return observePage(this.session(), { signal: this.signal, timeoutMs });
  }

  pause(ms) {
    return sleep(ms, this.signal);
  }

  async tap(box, obs, desc) {
    const res = await this.tools.clickRegion(box.map(Math.round), {
      coordinateSpace: { width: obs.width, height: obs.height },
      signal: this.signal,
    });
    if (!res?.ok) {
      await log('WARN', `点击 [${desc}] 未成功下发: ${res?.error?.code || 'UNKNOWN'}`);
      return false;
    }
    return true;
  }

  async back(desc) {
    const control = await this.ensureControl();
    await log('INFO', `下发系统返回键 (${desc})`);
    await control.back();
    if (control.flush) await control.flush();
  }

  /** 截图留证后停止。 */
  async stop(code, message, shotName = code.toLowerCase()) {
    await captureStepScreenshot(this.tools, this.healDir, `heal-${Date.now()}-${shotName}`, message);
    throw fatal(code, message);
  }

  // ───────────────────────── 导航：回到消息列表 ─────────────────────────

  /**
   * 全脚本唯一的「找路」入口。每步：观测一帧 -> 已在列表就返回 -> 否则做一个纠正动作。
   * 返回 { obs, scan, corrected }；纠正不了就停止脚本（不会返回 null）。
   */
  async toMessageList() {
    let observeFailures = 0;
    let riskChecks = 0;
    let launched = false;
    let lastKey = null;
    let sameCount = 0;

    for (let step = 0; step < NAV_MAX_STEPS + MAX_OBSERVE_FAILURES + RISK_RECHECKS; step++) {
      const obs = await this.observe();
      if (!obs?.ok) {
        if (obs?.error?.code === 'ABORTED' || this.signal?.aborted) throw Object.assign(new Error('ABORTED'), { code: 'ABORTED' });
        observeFailures++;
        await log('WARN', `页面观测失败 (${obs?.error?.code || 'UNKNOWN'})，第 ${observeFailures}/${MAX_OBSERVE_FAILURES} 次`);
        if (observeFailures >= MAX_OBSERVE_FAILURES) {
          await this.stop('OBSERVE_FAILING', `连续 ${MAX_OBSERVE_FAILURES} 次截图/识别失败，脚本停止`);
        }
        await this.pause(1500);
        continue;
      }
      observeFailures = 0;

      if (STOP_OVERLAYS.has(obs.overlay)) {
        await this.stop(`GUARD_${obs.overlay.toUpperCase()}`, `检测到需要人工处理的页面 (${obs.overlay})，脚本停止`, `guard-${obs.overlay}`);
      }
      if (obs.overlay === 'risk') {
        // 「操作过于频繁/请稍后再试」多为几秒后消失的提示，等待复查，仍在则停止
        if (riskChecks >= RISK_RECHECKS) {
          await this.stop('GUARD_RISK', '频率限制/风控提示持续存在，脚本停止', 'guard-risk');
        }
        riskChecks++;
        await log('WARN', `检测到频率限制提示，${RISK_WAIT_MS / 1000} 秒后复查 (${riskChecks}/${RISK_RECHECKS})`);
        await this.pause(RISK_WAIT_MS);
        continue;
      }

      const ready = listReady(obs, this.options);
      if (ready) {
        if (ready.listModelMissing) {
          this.listModelMissing++;
          await log('WARN', `消息列表模型本帧没有返回卡片 (连续 ${this.listModelMissing}/${MAX_LIST_MODEL_MISSING} 次)`);
          if (this.listModelMissing >= MAX_LIST_MODEL_MISSING) {
            await this.stop('LIST_MODEL_MISSING', '消息列表模型连续没有结果，无法判断红点，脚本停止');
          }
        } else {
          this.listModelMissing = 0;
        }
        return { ...ready, corrected: step > 0 };
      }

      const key = pageKey(obs);
      sameCount = key === lastKey ? sameCount + 1 : 1;
      lastKey = key;
      if (sameCount >= NAV_MAX_SAME_STATE) {
        await this.stop('NAV_NO_PROGRESS', `纠正动作后画面没有变化 (${obs.app}/${obs.page}/${obs.scene})，脚本停止`);
      }

      if (obs.app === 'android_launcher') {
        if (launched) {
          await this.stop('LAUNCHER_LOOP', '拉起 MOMO 后仍被识别为桌面，脚本停止；请查看 healing 截图核对页面识别', 'launcher');
        }
        launched = true;
        await this.launchMomo();
        continue;
      }
      await this.correct(obs);
    }
    await this.stop('NAV_EXHAUSTED', `${NAV_MAX_STEPS} 步内没有回到消息列表，脚本停止`);
  }

  /**
   * 针对一帧非列表画面做一个纠正动作。新增异常处理只加在这里。
   * 认不出的情况一律停止，不猜测点击。
   */
  async correct(obs) {
    if (await this.dismissOverlay(obs)) return;

    if (obs.page === 'message_list') {
      // 被判为列表但扫描层认为停在「马上聊」匹配页
      const topMsg = findTopMessageTab(obs);
      if (topMsg) {
        await log('INFO', '停留在 [马上聊] 匹配页，点击顶栏 [消息] 切回会话列表');
        await this.tap(topMsg, obs, '顶栏消息');
        await this.pause(800);
        return;
      }
      await this.stop('LIST_STATE_UNKNOWN', '处于消息列表但无法确认会话列表状态，脚本停止');
    }

    if (obs.page === 'chat_detail') {
      await log('INFO', '当前在聊天详情页，点击左上角返回');
      return this.exitChat(obs);
    }

    // 一级 Tab（首页/直播/小宇宙/更多）：点底栏「消息」；绝不在一级页按返回键（会退到桌面）
    const bottomMsg = findBottomMessageTab(obs);
    if (bottomMsg) {
      await log('INFO', `当前在一级页面 (${obs.page})，点击底栏 [消息] 切回列表`);
      await this.tap(bottomMsg, obs, '底栏消息');
      await this.pause(900);
      return;
    }
    if (hasBottomTabs(obs)) {
      // 一级页但底栏「消息」没有唯一识别到：等一帧再看，同一画面重复出现会触发停止
      await log('WARN', '一级页面底栏 [消息] 未能唯一识别，等待后重新观测');
      await this.pause(1000);
      return;
    }

    // 已知的 MOMO 二级页（招呼页残留、个人资料页等）：一次返回键后重新判断
    if (obs.page === 'greetings' || (obs.page === 'other' && obs.app === 'momo')) {
      await log('INFO', `当前在二级页面 (${obs.page}/${obs.scene})，返回上一级`);
      await captureStepScreenshot(this.tools, this.healDir, `heal-${Date.now()}-subpage`, '二级页面返回前现场');
      await this.back(`离开 ${obs.page}/${obs.scene}`);
      await this.pause(900);
      return;
    }

    await this.stop('PAGE_UNKNOWN', `无法识别当前页面 (app=${obs.app}, page=${obs.page}, scene=${obs.scene})，脚本停止`, 'unknown-page');
  }

  /** 关闭遮挡层。page-service 已识别的用其给出的目标坐标；另外补两种它不识别的弹窗。 */
  async dismissOverlay(obs) {
    const t = obs.targets || {};
    const known = {
      incoming_call: [t.incomingCallReject, '来电/红包悬浮窗，点击拒接', 'call-overlay'],
      app_update: [t.updateCloseX, '版本更新弹窗，点击右上角关闭', 'app-update'],
      red_packet_promo: [t.redPacketCloseX, '语音聊天红包提现弹窗，点击右上角关闭', 'red-packet'],
      safe_dismissible: [t.assistantCloseX, '悬浮助手面板，点击关闭', 'assistant'],
    }[obs.overlay];
    if (known) {
      if (!known[0]) await this.stop(`OVERLAY_${obs.overlay.toUpperCase()}`, `检测到${known[1].split('，')[0]}但没有关闭坐标，脚本停止`);
      await log('WARN', `检测到${known[1]}`);
      await captureStepScreenshot(this.tools, this.healDir, `heal-${Date.now()}-${known[2]}`, `${known[1]}前现场`);
      await this.tap(known[0], obs, known[2]);
      await this.pause(900);
      return true;
    }

    const items = obs.evidence?.ocrData?.items || [];
    const allText = items.map(it => it.text).join(' ');
    if (items.some(it => /删除对话/.test(it.text)) && /谨慎操作|置顶聊天|标为未读/.test(allText)) {
      await log('WARN', '检测到长按会话操作菜单，点击菜单外空白处关闭');
      await captureStepScreenshot(this.tools, this.healDir, `heal-${Date.now()}-context-menu`, '操作菜单关闭前现场');
      const w = obs.width, h = obs.height;
      await this.tap([w * 0.11, h * 0.094, w * 0.22, h * 0.14], obs, '菜单外空白处');
      await this.pause(800);
      return true;
    }
    if (/邀请你一起聊|接受邀请/.test(allText)) {
      await log('WARN', '检测到语聊房邀请弹窗，返回键关闭');
      await captureStepScreenshot(this.tools, this.healDir, `heal-${Date.now()}-voice-invite`, '语聊邀请关闭前现场');
      await this.back('关闭语聊邀请');
      await this.pause(800);
      return true;
    }
    return false;
  }

  async launchMomo() {
    await captureStepScreenshot(this.tools, this.healDir, `heal-${Date.now()}-open-momo`, '拉起MOMO前现场');
    await log('WARN', '当前在 Android 桌面，拉起 MOMO');
    const res = await this.tools.openMomo({ signal: this.signal });
    if (!res?.ok) {
      await this.stop('OPEN_MOMO_FAILED', `拉起 MOMO 失败: ${res?.error?.code || 'UNKNOWN'} ${res?.error?.message || ''}`.trim());
    }
    if (res.data?.alreadyOpen) {
      await log('WARN', 'openMomo 报告 MOMO 已在前台，但页面识别判为桌面，两者结论不一致');
    } else {
      await log('INFO', `MOMO 已拉起 (页面: ${res.data?.page || 'unknown'})`);
    }
    await this.pause(1500);
  }

  /** 退出聊天详情：只用当前这一帧识别出的返回键坐标，没有时点顶栏左侧返回键区域。 */
  async exitChat(obs) {
    let box = obs.targets?.backBtn;
    if (!box) {
      box = [obs.width * 0.02, obs.height * 0.035, obs.width * 0.16, obs.height * 0.095];
      await log('INFO', '本帧未识别到返回键坐标，点击顶栏左侧返回键区域');
    }
    await this.tap(box, obs, '左上角返回');
    await this.pause(800);
  }

  /**
   * 回到列表顶部。已在顶部时不滑动。中途离开列表就交给导航纠正后再试一次；确认不了顶部就停止。
   */
  async toTop(maxSteps = 8) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ready = await this.toMessageList();
      await this.ensureControl();
      const res = await returnMessageListTop(this.session(), ready.obs, { signal: this.signal, maxSteps, settleMs: 600 });
      if (res.ok) {
        const top = listReady(res.observation, this.options);
        if (top) {
          await log('INFO', `[回顶] 已确认在列表顶部 (滑动 ${res.steps ?? 0} 次)`);
          return { ...top, corrected: false };
        }
      }
      if (res.code === 'LIST_TOP_UNCONFIRMED') {
        await this.stop('LIST_TOP_UNCONFIRMED', `滑动 ${maxSteps} 次仍未确认到达列表顶部（顶部特征不足），脚本停止`, 'list-top');
      }
      await log('WARN', `回顶途中页面发生变化 (${res.code || 'UNKNOWN'})，重新回到列表后再试`);
    }
    await this.stop('LIST_TOP_UNCONFIRMED', '两次尝试都没能回到列表顶部，脚本停止', 'list-top');
  }

  /** 手指从下往上滑一屏（列表内容向下翻）。返回 { ready } 或 { end: 'bottom' | 'restart' }。 */
  async nextPage(ready) {
    const before = listSignature(ready.obs);
    const beforeNames = (ready.scan?.candidates || []).map(c => c.peerName);
    const obs = ready.obs;
    const x = Math.round(obs.width * 0.5);
    const res = await this.tools.swipe([
      { x, y: Math.round(obs.height * 0.82) },
      { x, y: Math.round(obs.height * 0.28) },
    ], { coordinateSpace: { width: obs.width, height: obs.height }, durationMs: 550, signal: this.signal });
    if (!res?.ok) {
      await this.stop('SWIPE_FAILED', `列表翻页滑动未成功下发 (${res?.error?.code || 'UNKNOWN'})，脚本停止`);
    }
    await this.pause(800);
    const next = await this.toMessageList();
    if (next.corrected) {
      this.bottomStrikes = 0;
      return { end: 'restart' };
    }
    if (listSignature(next.obs) === before) {
      this.bottomStrikes = 0;
      return { end: 'bottom' };
    }
    // 到底后画面可能有细微位移导致签名不同，联系人名单一致（OCR 容错）即视为原地未动；
    // 连续两屏一致才判定到底，防止单次滑动被设备静默吞掉造成误判
    if (sameContactNames(beforeNames, (next.scan?.candidates || []).map(c => c.peerName))) {
      this.bottomStrikes++;
      await log('DEBUG', `[翻页] 联系人名单与上一屏一致 (${this.bottomStrikes}/2)`);
      if (this.bottomStrikes >= 2) {
        this.bottomStrikes = 0;
        await log('DEBUG', '[翻页] 连续两屏名单一致，判定已到列表底部');
        return { end: 'bottom' };
      }
      return { ready: next };
    }
    this.bottomStrikes = 0;
    return { ready: next };
  }

  // ───────────────────────── 任务：处理一位未读联系人 ─────────────────────────

  isSkipped(candidate) {
    if (this.ignored.has(candidate.peerName)) return true;
    const until = this.cooldowns.get(candidate.peerName);
    if (until && until > Date.now()) return true;
    return this.handledSignatures.get(candidate.peerName) === candidateSignature(candidate);
  }

  pickUnread(scan) {
    return (scan.candidates || []).find(c => c.hasUnread && !this.isSkipped(c)) || null;
  }

  async coolDown(peerName, reason) {
    this.cooldowns.set(peerName, Date.now() + PEER_COOLDOWN_MS);
    await log('WARN', `[${peerName}] ${reason}，${minutes(PEER_COOLDOWN_MS)} 分钟内不再尝试`);
  }

  async reportUnreadable(scan) {
    const fresh = (scan.unreadableNames || []).filter(c => c.unread && !this.reportedUnreadable.has(c.peerName));
    if (!fresh.length) return;
    fresh.forEach(c => this.reportedUnreadable.add(c.peerName));
    await log('INFO', `跳过 ${fresh.length} 个纯emoji/符号名联系人（名字OCR不可读，按规则不自动处理）`);
  }

  /**
   * 点击后等待页面切换。返回：
   * - { kind: 'chat', obs }      进入聊天页
   * - { kind: 'list', obs }      仍在列表（点击没生效）
   * - { kind: 'not_chat', obs }  连续两帧停在同一个非聊天、非列表的 MOMO 页面
   * - { kind: 'unclear', obs }   有遮挡层、桌面或画面一直在变，原因不确定
   */
  async waitAfterTap() {
    let last = null;
    let lastKey = null;
    for (let i = 0; i < 5; i++) {
      await this.pause(i === 0 ? 900 : 700);
      const obs = await this.observe(8000);
      if (!obs?.ok) continue;
      last = obs;
      if (obs.overlay !== 'none' || obs.app === 'android_launcher') return { kind: 'unclear', obs };
      if (obs.page === 'chat_detail') return { kind: 'chat', obs };
      if (obs.page === 'message_list') {
        if (i >= 1) return { kind: 'list', obs };
        continue;
      }
      const key = pageKey(obs);
      if (key === lastKey) return { kind: 'not_chat', obs };
      lastKey = key;
    }
    return { kind: 'unclear', obs: last };
  }

  /** 点击联系人进入聊天。点击没生效时，在新截图里重新定位同名联系人再点一次。 */
  async openChat(candidate, listObs, contactDir) {
    let target = candidate;
    let obs = listObs;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const box = contactClickBox(target, obs);
      await log('INFO', `点击联系人 [${target.peerName}] (第 ${attempt}/2 次，区域: [${box.map(Math.round).join(', ')}])`);
      if (!await this.tap(box, obs, target.peerName)) return { kind: 'unclear', obs: null };

      const result = await this.waitAfterTap();
      if (result.kind !== 'list') return result;

      await captureStepScreenshot(this.tools, contactDir, `error-not-entered-${attempt}`, `[${candidate.peerName}] 点击后仍在列表`);
      const ready = listReady(result.obs, this.options);
      target = ready && (ready.scan.candidates || []).find(c => c.peerName === candidate.peerName);
      if (!target) return { kind: 'gone', obs: result.obs };
      obs = ready.obs;
    }
    return { kind: 'list', obs };
  }

  /** 子脚本 13：当前聊天页入库。 */
  async syncContact(peerName, stage) {
    const stageName = stage === 'post_reply_sync' ? '二次入库' : '初始入库';
    try {
      const res = await this.tools.syncMomoContacts({
        execute: true,
        dryRun: false,
        currentChatOnly: true,
        contactName: peerName,
        signal: this.signal,
        dbPath: this.options.dbPath,
        ...this.options.contactSyncOptions,
      });
      if (res?.ok) await log('INFO', `[${peerName}] ${stageName}完成 (写入 ${res.data?.totalMessagesIngested ?? 0} 条)`);
      else await log('WARN', `[${peerName}] ${stageName}未成功: ${res?.error?.code || 'UNKNOWN'}`);
      return Boolean(res?.ok);
    } catch (err) {
      if (this.signal?.aborted) throw err;
      await log('ERROR', `[${peerName}] ${stageName}失败: ${err.message}`);
      return false;
    }
  }

  /** 子脚本 14：AI 回复。发送状态未知时不重发（交给二次入库记录真实画面）。 */
  async replyContact(peerName) {
    await log('INFO', `[${peerName}] 正在调用 AI 生成回复并发送...`);
    try {
      const res = await runMomoAiReplyOnce(this.client, this.deviceId, {
        mode: 'execute',
        contactName: peerName,
        tools: this.tools,
        control: await this.ensureControl(),
        signal: this.signal,
        dbPath: this.options.dbPath,
        screenshotsDir: activeRunDir ? path.join(activeRunDir, 'ai-replies', safeDirName(peerName)) : undefined,
        leaseToken: this.lease.leaseToken,
        ...this.options.aiReplyOptions,
      });
      if (res?.ok) {
        await log('INFO', `[${peerName}] AI 回复发送成功 (${res.outcome || 'reply_observed'})`);
        return true;
      }
      const err = res?.data?.error || res?.error || {};
      const uncertain = res?.outcome === 'needs_review' || res?.outcome === 'handoff_uncertain';
      await log('ERROR', `[${peerName}] AI 回复${uncertain ? '发送状态未确认（不重发，请人工复核）' : '失败'}: ` +
        `${err.code || 'FAILED'}${err.message ? `: ${err.message}` : ''}`);
      return false;
    } catch (err) {
      if (this.signal?.aborted || err.code === 'LEASE_REVOKED') throw err;
      await log('ERROR', `[${peerName}] AI 回复失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 处理一位未读联系人：进入 -> 核对对象 -> 13 入库 -> 14 回复 -> 13 二次入库。
   * 不负责退出聊天页：结束后由调用方的 toMessageList() 基于新截图返回列表。
   */
  async handleContact(candidate, listObs) {
    const peerName = candidate.peerName;
    this.attempts++;
    this.burst.add(peerName);
    await log('INFO', `发现未读联系人: [${peerName}] (未读数: ${candidate.unreadCount ?? '未知'})`);
    const contactDir = activeRunDir ? path.join(activeRunDir, 'contacts', `${Date.now()}_${safeDirName(peerName)}`) : null;
    await captureStepScreenshot(this.tools, contactDir, '01-detected', `[${peerName}] 发现红点原始列表画面`);

    const opened = await this.openChat(candidate, listObs, contactDir);
    if (opened.kind === 'not_chat') {
      const { page, scene } = opened.obs;
      const shot = await captureStepScreenshot(this.tools, contactDir, 'not-chat-page', `[${peerName}] 点进去不是聊天页`);
      await this.ignored.add(peerName, { reason: 'not_chat_page', page, scene, screenshot: shot && path.relative(PROJECT_ROOT, shot) });
      await log('WARN', `[${peerName}] 点进去不是聊天页 (${page}/${scene})，已记入忽略名单，以后不再点击`);
      this.openFailures = 0;
      return;
    }
    if (opened.kind !== 'chat') {
      const reason = { list: '两次点击都没有进入', gone: '补点时已不在当前屏', unclear: '点击后出现遮挡或画面不稳定' }[opened.kind];
      await captureStepScreenshot(this.tools, contactDir, 'error-open', `[${peerName}] 进入失败现场`);
      await this.coolDown(peerName, `未能进入聊天页（${reason}）`);
      this.openFailures++;
      if (this.openFailures >= MAX_OPEN_FAILURES) {
        await this.stop('CONTACT_OPEN_FAILING', `连续 ${MAX_OPEN_FAILURES} 个联系人都没能进入聊天页，脚本停止`);
      }
      return;
    }
    this.openFailures = 0;

    const detail = opened.obs;
    const title = extractChatContactName(detail.evidence?.ocrData);
    if (title && normalize(title) !== normalize(peerName)) {
      await captureStepScreenshot(this.tools, contactDir, 'error-target-mismatch', `[${peerName}] 目标不匹配(${title})画面`);
      await this.coolDown(peerName, `顶栏联系人 [${title}] 与预期不符 (target_mismatch)`);
      return;
    }
    await captureStepScreenshot(this.tools, contactDir, '02-chat-detail', `[${peerName}] 成功进入聊天界面`);

    const sync = await this.syncContact(peerName, 'pre_reply_sync');
    const replied = await this.replyContact(peerName);
    await this.pause(600);
    await this.syncContact(peerName, 'post_reply_sync');
    await captureStepScreenshot(this.tools, contactDir, '04-after-post-sync', `[${peerName}] 第二次消息入库完成（含自身气泡）`);

    // 进入聊天后红点已清除；记录签名，只有对方再发新消息（签名变化）才会再处理
    this.handledSignatures.set(peerName, candidateSignature(candidate));
    if (!replied) {
      this.replyFailures++;
      if (this.replyFailures >= MAX_REPLY_FAILURES) {
        await this.stop('REPLY_FAILING', `连续 ${MAX_REPLY_FAILURES} 次回复未成功，脚本停止`);
      }
      return;
    }
    this.replyFailures = 0;
    this.handledContacts++;
    const limitDesc = this.targetLimit === Infinity ? '无限制' : `${this.targetLimit}人`;
    await log('INFO', `[${peerName}] 流程完成 (进度: ${this.handledContacts}/${limitDesc})`);
  }

  limitReached() {
    return this.targetLimit !== Infinity && this.handledContacts >= this.targetLimit;
  }

  // ───────────────────────── 全量清扫 ─────────────────────────

  /**
   * 一遍：回顶后逐屏向下；当前屏的未读处理完再翻页，直到触底。
   * 返回 'bottom' | 'page_budget' | 'restart' | 'limit'
   */
  async sweep() {
    this.bottomStrikes = 0;
    let ready = await this.toTop(DRAIN_MAX_PAGES + 5);  // 上一遍可能停在很深的位置
    for (let page = 1; page <= DRAIN_MAX_PAGES; page++) {
      for (;;) {
        await this.reportUnreadable(ready.scan);
        const candidate = this.pickUnread(ready.scan);
        if (!candidate) break;
        await this.handleContact(candidate, ready.obs);
        if (this.limitReached()) return 'limit';
        ready = await this.toMessageList();  // 处理后列表顺序会变，基于新截图继续本屏
      }
      const names = (ready.scan.candidates || []).map(c => c.peerName).join('、');
      await log('INFO', `[全量] 第 ${page} 屏 ${ready.scan.candidates?.length || 0} 位联系人 (${names}) 没有可处理的未读，向下翻页`);
      const next = await this.nextPage(ready);
      if (next.end === 'bottom') {
        await log('INFO', `[全量] 已翻到消息列表最底部（共 ${page} 屏）`);
        return 'bottom';
      }
      if (next.end === 'restart') {
        await log('WARN', '[全量] 翻页后页面被纠正过，本遍从顶部重新开始');
        return 'restart';
      }
      ready = next.ready;
    }
    return 'page_budget';
  }

  /** 反复整遍清扫，直到一整遍没有处理任何人。返回结束原因。 */
  async drainAll(label) {
    for (let round = 1; round <= DRAIN_MAX_ROUNDS; round++) {
      const before = this.attempts;
      await log('INFO', `[${label}] 第 ${round}/${DRAIN_MAX_ROUNDS} 遍扫描开始`);
      const result = await this.sweep();
      if (result === 'limit') return 'limit_reached';
      if (result === 'page_budget') await log('WARN', `[${label}] 单遍翻页达到上限 ${DRAIN_MAX_PAGES} 屏，未确认触底`);
      if (result === 'bottom' && this.attempts === before) {
        await log('INFO', `[${label}] 整遍没有可处理的未读，积压已清完`);
        return 'completed';
      }
    }
    await log('WARN', `[${label}] 已达到 ${DRAIN_MAX_ROUNDS} 遍复查上限`);
    return 'round_budget_exhausted';
  }

  async runDrain() {
    const endReason = await this.drainAll('全量模式');
    if (endReason !== 'limit_reached') await this.toTop(DRAIN_MAX_PAGES + 5);
    return endReason;
  }

  // ───────────────────────── 挂机模式 ─────────────────────────

  async runWatch() {
    await log('INFO', '[挂机模式] 启动先清理积压未读');
    if (await this.drainAll('启动清理') === 'limit_reached') return 'limit_reached';
    await this.toTop(DRAIN_MAX_PAGES + 5);  // 清理结束时停在列表底部，先回到顶部

    const now = Date.now();
    const warmupMs = calcNextWarmupIntervalMs();
    const greetingsMs = calcNextGreetingsIntervalMs();
    this.nextWarmupAt = now + warmupMs;
    this.nextGreetingsAt = now + greetingsMs;
    await log('INFO', `[挂机模式] 开始盯首屏。下次首页养号约 ${minutes(warmupMs)} 分钟后，下次招呼处理约 ${minutes(greetingsMs)} 分钟后`);

    this.burst.clear();
    while (!this.signal?.aborted) {
      const handled = await this.lookForNew();
      if (this.limitReached()) {
        await log('INFO', `达到设定回复人数上限 (${this.handledContacts}/${this.targetLimit}人)，任务结束`);
        return 'limit_reached';
      }
      if (handled) continue;          // 处理完一位立即回顶再看
      this.burst.clear();             // 本批已处理完，没有被推下去的未读了
      if (await this.runDueTimer()) continue;
      await this.pause(this.options.intervalMs ?? DEFAULT_IDLE_INTERVAL_MS);
    }
    return 'aborted';
  }

  /**
   * 回顶看首屏，处理第一位可处理的未读。
   * 首屏最下面一张卡片是本批处理过的人时，说明可能还有未读被挤到下面，继续往下看一屏（最多 maxWatchPages 屏）。
   * 返回是否处理了联系人。
   */
  async lookForNew() {
    let ready = await this.toTop(this.maxWatchPages + 3);
    for (let page = 1; ; page++) {
      await this.reportUnreadable(ready.scan);
      const candidate = this.pickUnread(ready.scan);
      if (candidate) {
        await this.handleContact(candidate, ready.obs);
        return true;
      }
      const cards = ready.scan.candidates || [];
      const lastCard = cards[cards.length - 1];
      if (page >= this.maxWatchPages || !lastCard || !this.burst.has(lastCard.peerName)) return false;

      await log('INFO', `[挂机模式] 第 ${page} 屏底部是本批处理过的 [${lastCard.peerName}]，往下多看一屏`);
      const next = await this.nextPage(ready);
      if (next.end) return false;     // 触底或页面被纠正：下一轮从顶部重新看
      ready = next.ready;
    }
  }

  /** 空闲时最多执行一个到期支线：养号优先，其次招呼。 */
  async runDueTimer() {
    const now = Date.now();
    if (now >= this.nextWarmupAt) {
      await this.runWarmup();
      return true;
    }
    if (now >= this.nextGreetingsAt) {
      await this.runGreetings();
      return true;
    }
    return false;
  }

  /** 子脚本 11：首页养号。它自己切到首页；结束后下一轮的 toMessageList() 负责切回列表。 */
  async runWarmup() {
    await log('INFO', '到达设定周期，开始执行首页养号...');
    const res = await this.tools.browseMomoHome({
      execute: true,
      cycles: this.options.warmupCycles ?? 1,
      mode: this.options.warmupMode ?? 'random',
      refreshCount: this.options.warmupRefreshCount ?? { min: 2, max: 5 },
      scrollCount: this.options.warmupScrollCount ?? { min: 3, max: 6 },
      scrollIntervalMs: this.options.warmupScrollIntervalMs ?? { min: 1000, max: 3500 },
      signal: this.signal,
      timeoutMs: 180000,
    });
    if (res?.ok) {
      await log('INFO', `首页养号完毕: 刷新 ${res.data?.refreshesSent || 0} 次，滑动浏览 ${res.data?.scrollsSent || 0} 次`);
    } else {
      await log('WARN', `首页养号未成功: ${res?.error?.code || 'UNKNOWN'} ${res?.error?.message || ''}`.trim());
    }
    const nextMs = calcNextWarmupIntervalMs();
    this.nextWarmupAt = Date.now() + nextMs;
    await log('INFO', `下次首页养号约 ${minutes(nextMs)} 分钟后`);
  }

  /** 子脚本 12：招呼处理。先回顶找入口，点进去后交给子脚本，结束后由导航核验回到列表。 */
  async runGreetings() {
    const ready = await this.toTop(8);
    const entry = findGreetingsEntry(ready.obs);
    if (!entry) {
      this.nextGreetingsAt = Date.now() + GREETINGS_RETRY_MS;
      await log('WARN', `首屏未找到 [收到的招呼] 入口，${minutes(GREETINGS_RETRY_MS)} 分钟后重试`);
      return;
    }
    const nextGreetingsMs = calcNextGreetingsIntervalMs();
    this.nextGreetingsAt = Date.now() + nextGreetingsMs;

    await log('INFO', `点击 [收到的招呼]${entry.unreadCount ? ` (未读: ${entry.unreadCount})` : ''}`);
    if (!await this.tap(entry.box, ready.obs, '收到的招呼')) return;
    await this.pause(1000);

    const maxApproved = MIN_APPROVED_GREETINGS +
      Math.floor(Math.random() * (MAX_APPROVED_GREETINGS - MIN_APPROVED_GREETINGS + 1));
    await log('INFO', `开始处理打招呼 (最多通过 ${maxApproved} 人)...`);
    if (this.maxDistanceKm !== null) {
      await log('INFO', `距离筛选: 仅通过 <= ${this.maxDistanceKm} 公里 (超出自动拒绝)`);
    }
    const res = await this.tools.processMomoGreetings({
      execute: true,
      maxApproved,
      approveProbability: 0.9,
      rejectProbability: 0.1,
      cycles: 1,
      maxDistanceKm: this.maxDistanceKm,
      skipBack: false,
      signal: this.signal,
      timeoutMs: 180000,
    });
    const data = res?.data || {};
    const approved = data.totalApproved ?? data.approvedCount ?? 0;
    const outcome = data.cycles?.[0]?.outcome || data.outcome || 'unknown';
    if (res?.ok) {
      await log('INFO', `打招呼处理完毕: 通过 ${approved} 位 (终态: ${outcome}${data.exitVerified ? '，已核验返回主列表' : ''})`);
    } else {
      await log('WARN', `打招呼处理未成功: ${res?.error?.code || 'UNKNOWN'} (已通过 ${approved} 位)`);
    }
    if (data.rateLimited) await log('WARN', '打招呼触发频率限制，按正常间隔等待下次');
    await log('INFO', `下次招呼处理约 ${minutes(nextGreetingsMs)} 分钟后`);
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  async run() {
    const runId = this.options.runId || 'watch_' + Date.now();
    const leaseRes = defaultArbiter.acquireDevice(this.deviceId, runId, { returnLease: true });
    if (!leaseRes.ok) {
      throw Object.assign(new Error(`Device ${this.deviceId} is busy (${leaseRes.reason})`), { code: leaseRes.reason });
    }
    this.lease = leaseRes.lease;

    let status = 'completed';
    let endReason = null;
    let error = null;
    try {
      await this.ignored.load();
      await log('INFO', `忽略名单: ${this.ignored.size} 个卡片 (${path.relative(PROJECT_ROOT, this.ignored.filePath)})`);
      this.tools = this.client.device(this.deviceId).tools();
      await this.ensureControl();
      endReason = this.isDrain ? await this.runDrain() : await this.runWatch();
      if (this.signal?.aborted) status = 'aborted';
    } catch (err) {
      if (this.signal?.aborted || err.code === 'ABORTED') {
        status = 'aborted';
      } else {
        status = 'failed';
        error = { code: err.code || 'WATCH_FAILED', message: err.message };
        await log('ERROR', `监听中枢停止: [${error.code}] ${error.message}`);
        if (!err.fatal) await captureStepScreenshot(this.tools, this.healDir, `heal-${Date.now()}-crash`, '异常停止现场');
      }
    } finally {
      try {
        await this.tools?.close();
        defaultArbiter.releaseLease(this.lease);
      } catch {
        defaultArbiter.quarantineDevice(this.deviceId, 'Watch control cleanup not confirmed');
      }
    }

    return {
      ok: status !== 'failed',
      status,
      endReason,
      mode: this.isDrain ? 'drain' : 'watch',
      handledContacts: this.handledContacts,
      attemptedContacts: this.attempts,
      ignoredCards: this.ignored.size,
      targetLimit: this.targetLimit === Infinity ? null : this.targetLimit,
      ...(error ? { error } : {}),
    };
  }
}

/**
 * MOMO 监听中枢入口
 */
async function runMomoMessageWatch(client, deviceId, options = {}) {
  const report = await new WatchHub(client, deviceId, options).run();
  if (activeRunDir) {
    const reportPath = path.join(activeRunDir, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8').catch(() => {});
    await log('INFO', `任务结束，报告已写入: ${path.relative(PROJECT_ROOT, reportPath)}`);
  }
  return report;
}

function intOption(raw, min, fallback) {
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

function parseArgs(argv) {
  const env = process.env;
  const options = {
    mode: env.YUNMOMO_MOMO_WATCH_MODE || 'watch', // 'watch' (挂机模式) | 'drain' (全量模式)
    maxContacts: Infinity,
    maxDistanceKm: null,
    maxWatchPages: DEFAULT_MAX_WATCH_PAGES,
  };

  if (env.YUNMOMO_MOMO_MAX_CONTACTS && env.YUNMOMO_MOMO_MAX_CONTACTS !== 'xx') {
    options.maxContacts = intOption(env.YUNMOMO_MOMO_MAX_CONTACTS, 1, Infinity);
  }
  if (env.YUNMOMO_MOMO_MAX_DISTANCE && env.YUNMOMO_MOMO_MAX_DISTANCE !== 'none') {
    const dist = Number(env.YUNMOMO_MOMO_MAX_DISTANCE);
    if (!Number.isNaN(dist) && dist > 0) options.maxDistanceKm = dist;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (argv[i + 1] === undefined) break;
    if (arg === '--mode') options.mode = argv[++i];
    else if (arg === '--device') options.deviceId = argv[++i];
    else if (arg === '--max-contacts') options.maxContacts = intOption(argv[++i], 1, Infinity);
    else if (arg === '--max-distance' || arg === '--distance') {
      const dist = Number(argv[++i]);
      if (!Number.isNaN(dist) && dist > 0) options.maxDistanceKm = dist;
    }
    else if (arg === '--watch-pages') options.maxWatchPages = intOption(argv[++i], 1, DEFAULT_MAX_WATCH_PAGES);
    else if (arg === '--run-dir') options.runDir = argv[++i];
  }

  if (!['watch', 'drain'].includes(options.mode)) options.mode = 'watch';
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

  const isDrain = options.mode === 'drain';
  const banner = [
    '--------------------------------------------------',
    'MOMO 监听中枢启动',
    `设备 ID   : ${options.deviceId}`,
    `工作模式  : ${isDrain ? '全量模式 (翻到底，复查到没有未读)' : '挂机模式 (先清积压，再盯首屏)'}`,
    `处理上限  : ${options.maxContacts === Infinity ? '无限制' : `${options.maxContacts} 位联系人`}`,
    isDrain ? '定时支线  : 全量模式不执行招呼处理与首页养号' :
      `招呼处理  : 一次最多通过 ${MIN_APPROVED_GREETINGS}~${MAX_APPROVED_GREETINGS} 人${options.maxDistanceKm !== null ? ` (距离≤${options.maxDistanceKm}km)` : ''} (间隔 ${DEFAULT_GREETINGS_MIN_MINUTES}~${DEFAULT_GREETINGS_MAX_MINUTES} 分钟随机)`,
    ...(isDrain ? [] : [`首页养号  : 每 ${DEFAULT_WARMUP_MIN_MINUTES}~${DEFAULT_WARMUP_MAX_MINUTES} 分钟随机触发`]),
    `日志文件  : ${path.relative(PROJECT_ROOT, activeLogFile)}`,
    '--------------------------------------------------\n',
  ].join('\n');
  console.log(banner);
  await fs.writeFile(activeLogFile, banner, 'utf8').catch(() => {});

  const client = new YunmomoClient({ token: process.env.YUNMOMO_TOKEN });
  const report = await runMomoMessageWatch(client, options.deviceId, options);
  if (report.status === 'failed') process.exitCode = 1;
  return report;
}

module.exports = {
  DESCRIPTION,
  runMomoMessageWatch,
  main,
};
