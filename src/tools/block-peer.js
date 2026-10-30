'use strict';

/**
 * MOMO 聊天详情页拉黑执行中枢 (Block Peer Automation)
 *
 * 聚合原:
 * 1. screen-text.js (单次拉黑私有 OCR 文本提取适配器)
 * 2. block-layout.js (顶部头像定位、聊天设置菜单与拉黑确认弹窗几何分析)
 * 3. block-peer.js (拉黑主状态机与手势下发)
 */

const { performance } = require('node:perf_hooks');
const { boolean, number, fail } = require('./runtime');
const { screenshot } = require('./screenshot');
const { clickPlan } = require('./touch-gestures');
const { RapidOcrWorker } = require('../automation/ocr');

// ====================================================
// 1. 本地私有 OCR 文本适配器 (Screen Text Adapter)
// ====================================================

class ScreenText {
  constructor(pool) { this.pool = pool; }
  async read(shot, ctx) {
    ctx.check(); ctx.stage = 'screen_ocr';
    if (!this.worker) this.worker = new RapidOcrWorker({ recognitionPool: this.pool });
    let result;
    try { result = await ctx.wait(this.worker.recognize(shot.image, { signal: ctx.signal, timeoutMs: ctx.remaining() })); }
    catch (error) { ctx.check(); fail('OCR_FAILED', 'Local screen text recognition failed',
      { causeCode: error.code ?? 'UNKNOWN', recognitionStage: error.stage ?? 'unknown' }); }
    ctx.check();
    if (result?.ok !== true || result.width !== shot.width || result.height !== shot.height || !Array.isArray(result.items)) {
      fail('OCR_PROTOCOL_ERROR', 'Screen OCR does not match the current screenshot');
    }
    return result;
  }

  async close() {
    if (this.worker) await this.worker.close();
  }
}

// ====================================================
// 2. 顶栏头像定位 (Header Avatar)
//
// 拉黑流只点右上角头像，不做整页锚点校验，也不受聊天助手面板遮挡影响；
// 点错页面的风险由后续 OCR 确认「聊天设置页 + 拉黑行」兜底。
// ====================================================

function topChatAvatar(view) {
  const { width: w, height: h } = view ?? {};
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 100 || h < 200) {
    fail('VISION_PROTOCOL_ERROR', 'Model 2 returned invalid dimensions');
  }
  if (!Array.isArray(view.avatars)) fail('VISION_PROTOCOL_ERROR', 'Model 2 avatar list is missing');
  const back = view.elements?.back_btn?.box;
  const backY = Array.isArray(back) && back.length === 4 && back.every(Number.isFinite)
    ? (back[1] + back[3]) / 2 : null;
  if (backY === null) fail('TOP_AVATAR_NOT_FOUND', 'Chat header back button is unavailable for avatar row alignment');
  const inHeader = item => {
    const b = item?.box;
    if (item?.class !== 'avatar' || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) ||
        !Number.isFinite(item.confidence)) return null;
    const [x1, y1, x2, y2] = b;
    if (x1 < 0 || y1 < 0 || x2 > w || y2 > h || x1 >= x2 || y1 >= y2) return null;
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    // 顶栏头像 = 右上区域 + 与返回键同一行；消息气泡头像天然落在区域外
    return x >= w * .70 && y >= h * .025 && y <= h * .16 && Math.abs(y - backY) <= h * .04
      ? { box: b, x, y, confidence: item.confidence } : null;
  };
  const best = view.avatars.map(inHeader).filter(Boolean).sort((a, b) => b.confidence - a.confidence)[0];
  if (!best || best.confidence < .28) {
    fail('TOP_AVATAR_NOT_FOUND', 'No top-right chat header avatar aligned with the back button');
  }
  return best;
}

const normalized = value => (value || '').replace(/\s+/g, '');

function blockPage(ocr, minimumScore = .55) {
  const { width: w, height: h } = ocr ?? {};
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 100 || h < 200 || !Array.isArray(ocr.items)) {
    fail('OCR_PROTOCOL_ERROR', 'Screen text result has invalid dimensions or items');
  }
  const items = ocr.items.filter(item => typeof item?.text === 'string' && Number.isFinite(item.score) && item.score >= minimumScore &&
    ['left', 'top', 'right', 'bottom', 'center_x', 'center_y'].every(key => Number.isFinite(item[key])) &&
    item.left >= 0 && item.top >= 0 && item.right <= w && item.bottom <= h && item.left < item.right && item.top < item.bottom);
  const exact = text => items.filter(item => normalized(item.text) === text);
  const target = item => ({ text: normalized(item.text), x: item.center_x, y: item.center_y,
    box: [item.left, item.top, item.right, item.bottom], confidence: item.score });
  const buttons = exact('拉黑').filter(item => item.center_x >= w * .6 && item.center_x <= w * .92 &&
    item.center_y >= h * .3 && item.center_y <= h * .82);
  const dialogs = [];
  for (const button of buttons) {
    const cancel = exact('取消').filter(item => item.center_x < button.center_x && item.center_x > w * .35 &&
      Math.abs(item.center_y - button.center_y) < h * .025);
    const body = items.filter(item => item.center_y < button.center_y - h * .025 &&
      item.center_y > button.center_y - h * .24 && item.left >= w * .08 && item.right <= w * .94)
      .sort((a, b) => a.center_y - b.center_y).map(item => normalized(item.text)).join('');
    if (cancel.length === 1 && body.includes('拉黑后') && body.includes('消息') && /是否拉黑[?？]?/.test(body)) {
      dialogs.push({ scene: 'block_dialog', target: target(button), alreadyBlocked: false });
    }
  }
  if (dialogs.length > 1) fail('BLOCK_DIALOG_AMBIGUOUS', 'More than one block confirmation button matched');
  if (dialogs.length === 1) return dialogs[0];

  if (buttons.length || items.some(item => /拉黑后|是否拉黑/.test(normalized(item.text))) ||
      exact('取消').some(item => item.center_y > h * .25 && item.center_y < h * .85)) {
    return { scene: 'unknown', target: null, alreadyBlocked: false };
  }
  const title = exact('聊天设置').filter(item => item.center_y < h * .16);
  const anchorNames = ['置顶聊天', '查找聊天记录', '聊天图片', '设置当前聊天背景', '消息同步', '消息拦截'];
  const anchors = anchorNames.filter(name => exact(name).some(item => item.center_x < w * .6 && item.center_y > h * .18));
  if (title.length !== 1 || anchors.length < 2) return { scene: 'unknown', target: null, alreadyBlocked: false };
  const undo = items.filter(item => ['解除拉黑', '取消拉黑', '移出黑名单'].includes(normalized(item.text)) &&
    item.center_x < w * .5 && item.center_y > h * .35);
  const menu = exact('拉黑').filter(item => item.center_x < w * .4 && item.center_y > h * .4 && item.bottom < h * .97);
  if (undo.length > 1 || menu.length > 1 || (undo.length && menu.length)) fail('BLOCK_MENU_AMBIGUOUS', 'Chat settings contain ambiguous block actions');
  if (undo.length === 1) return { scene: 'chat_settings', target: null, alreadyBlocked: true };
  return { scene: 'chat_settings', target: menu.length === 1 ? target(menu[0]) : null, alreadyBlocked: false };
}

// ====================================================
// 3. 拉黑主流程 (Block Peer Flow)
// ====================================================

const BLOCK_OPTIONS = ['timeoutMs', 'signal', 'execute', 'dryRun', 'confidence', 'minimumScore',
  'pollMs', 'stepTimeoutMs'];

async function blockPeer(host, options, ctx) {
  const settings = { execute: boolean(options.execute ?? false, 'execute'),
    dryRun: boolean(options.dryRun ?? host.dryRun, 'dryRun'),
    confidence: number(options.confidence ?? .35, 'confidence', .28, .95, false),
    minimumScore: number(options.minimumScore ?? .55, 'minimumScore', .5, 1, false),
    pollMs: number(options.pollMs ?? 250, 'pollMs', 100, 2000),
    stepTimeoutMs: number(options.stepTimeoutMs ?? 15000, 'stepTimeoutMs', 1000, 30000) };
  if (!settings.execute || settings.dryRun) return { status: 'planned', data: { app: 'momo', execute: false,
    avatarSelection: 'model2_topmost_header_avatar_only', steps: ['click_topmost_header_avatar', 'click_block_text_in_chat_settings',
      'click_block_in_confirmation_dialog'], note: 'No screenshots, model startup or phone input in preview' } };
  const report = { avatarClickAttempted: false, avatarClickSent: false, menuClickAttempted: false, menuClickSent: false,
    confirmationClickAttempted: false, confirmationClickSent: false, blockedUiConfirmed: false,
    outcome: 'not_started', screenshots: 0, avatar: null, lastScreenshot: null, lastObservation: null, history: [], vision: null };
  ctx.data = report;
  const record = (stage, extra = {}) => report.history.push({ stage, elapsedMs: Math.round(performance.now() - ctx.started), ...extra });
  host._requireToken(); ctx.stage = 'vision_start';
  const vision = await host._ensureChatDetailVision(ctx);
  report.vision = vision.info;
  ctx.attempt = 1;
  const control = await host._ensureControl(ctx);
  const initial = { generation: control._generation, width: control.screenWidth, height: control.screenHeight };
  const text = new ScreenText(host._recognitionPool ?? undefined);
  function checkControl() {
    ctx.check();
    if (!control.connected || !control.ready) fail('CONNECTION_LOST', 'Control is no longer ready');
    if (control._generation !== initial.generation) fail('CONNECTION_CHANGED', 'Control connection changed; block will not be replayed');
    if (control.screenWidth !== initial.width || control.screenHeight !== initial.height) fail('SCREEN_CHANGED', 'Phone resolution changed');
  }
  async function capture() {
    checkControl();
    const shot = await screenshot(host.device, { source: 'stream', maxSize: 1280, maxAgeMs: 0, attempts: 1 }, ctx);
    report.lastScreenshot = shot; report.screenshots++;
    return { shot, observedAt: performance.now() };
  }
  async function tap(frame, target, role) {
    checkControl();
    const fresh = () => { if (performance.now() - frame.observedAt > 3000) fail('STALE_TARGET', 'Block target expired; no click was sent'); };
    fresh(); record(role + '_attempted'); report[role + 'ClickAttempted'] = true;
    if (role === 'confirmation') report.outcome = 'unknown_after_confirm';
    try {
      await host._executeGesture(control, screen => {
        checkControl(); fresh();
        return clickPlan(target.x, target.y, { coordinateSpace: { width: frame.shot.width, height: frame.shot.height },
          holdMs: 80, jitterPx: 1 }, screen);
      }, ctx, 'click');
      report[role + 'ClickSent'] = true; record(role + '_clicked');
    } finally { ctx.data = report; }
  }
  async function readPage() {
    const frame = await capture();
    const ocr = await text.read(frame.shot, ctx);
    checkControl(); ctx.stage = 'block_page_check';
    frame.page = blockPage(ocr, settings.minimumScore);
    report.lastObservation = { source: 'local_text', scene: frame.page.scene,
      target: frame.page.target, alreadyBlocked: frame.page.alreadyBlocked };
    return frame;
  }
  async function waitPage(wanted, code, message) {
    const deadline = performance.now() + settings.stepTimeoutMs;
    let stable = 0, previous;
    while (performance.now() < deadline) {
      const frame = await readPage();
      if (wanted(frame.page)) {
        const current = frame.page.target;
        const same = previous && previous.scene === frame.page.scene && previous.alreadyBlocked === frame.page.alreadyBlocked &&
          ((!current && !previous.target) || (current && previous.target &&
            Math.hypot(current.x - previous.target.x, current.y - previous.target.y) < frame.shot.height * .015));
        stable = same ? stable + 1 : 1; previous = frame.page;
        if (stable >= 2) return frame; // 连续两次同景观测才算稳定，避免点进过渡动画
      } else { stable = 0; previous = null; }
      await ctx.sleep(settings.pollMs);
    }
    fail(code, message);
  }
  try {
    // 单次观测即点头像：点击后由 waitPage 用 OCR 确认落在聊天设置页，页面过渡导致的误点会安全失败
    let frame = await capture();
    ctx.stage = 'top_avatar_detect';
    const view = await vision.inspect(frame.shot.image, settings, ctx);
    if (view.width !== frame.shot.width || view.height !== frame.shot.height) {
      fail('VISION_PROTOCOL_ERROR', 'Avatar coordinates do not match the screenshot');
    }
    report.lastObservation = { source: 'model2', scene: 'chat_detail', avatars: view.avatars };
    report.avatar = topChatAvatar(view);
    await tap(frame, report.avatar, 'avatar');
    frame = await waitPage(page => page.scene === 'chat_settings' && (page.target || page.alreadyBlocked),
      'BLOCK_MENU_NOT_FOUND', 'Chat settings and its exact block row were not confirmed');
    if (frame.page.alreadyBlocked) {
      report.blockedUiConfirmed = true; report.outcome = 'already_blocked_ui'; record('already_blocked_ui');
      return { status: 'sent', data: report };
    }
    await tap(frame, frame.page.target, 'menu');
    frame = await waitPage(page => page.scene === 'block_dialog', 'BLOCK_DIALOG_NOT_FOUND',
      'Block dialog with its explanation, Cancel and Block buttons was not confirmed');
    await tap(frame, frame.page.target, 'confirmation');
    report.outcome = 'confirmation_clicked';
    // 拉黑是否生效的权威凭证是 MOMO 自己弹出的「拉黑成功」toast；
    // 读到即确证，读不到（竞态/时机）保持 confirmation_clicked 未知态，不判失败。
    try {
      await ctx.sleep(900);
      const confirmedFrame = await capture();
      const confirmedOcr = await text.read(confirmedFrame.shot, ctx);
      checkControl();
      if (confirmedOcr.items.some(item => item.text === '拉黑成功')) {
        report.blockedUiConfirmed = true;
        report.outcome = 'blocked_confirmed';
        record('block_toast_confirmed');
      }
    } catch (error) {
      if (ctx.signal?.aborted || error?.code === 'CANCELLED') throw error;
    }
    return { status: 'sent', data: report };
  } finally {
    ctx.data = report;
    try { await text.close(); } catch { ctx.cleanupFailed = true; }
  }
}

module.exports = {
  BLOCK_OPTIONS,
  blockPeer,
  topChatAvatar,
  blockPage,
  ScreenText
};
