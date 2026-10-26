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
const { chatLayout } = require('./momo/chat-detail-parser');
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
// 2. 页面与菜单布局分析 (Block Layout & Avatar)
// ====================================================

function topChatAvatar(view) {
  const layout = chatLayout(view);
  if (!Array.isArray(view.avatars)) fail('VISION_PROTOCOL_ERROR', 'Model 2 avatar list is missing');
  const { width: w, height: h } = layout;
  const avatars = view.avatars.map(item => {
    const b = item?.box;
    if (item?.class !== 'avatar' || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) ||
        b[0] < 0 || b[1] < 0 || b[2] > w || b[3] > h || b[0] >= b[2] || b[1] >= b[3] ||
        !Number.isFinite(item.confidence)) fail('VISION_PROTOCOL_ERROR', 'Model 2 returned an invalid avatar');
    return { box: b, x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2, confidence: item.confidence };
  }).sort((a, b) => a.y - b.y);
  const first = avatars[0];
  if (!first) fail('TOP_AVATAR_NOT_FOUND', 'No model 2 avatar was found in the chat header');
  const [x1, y1, x2, y2] = first.box;
  const back = view.elements.back_btn.box;
  if (first.confidence < .28 || first.x < w * .70 || y1 < h * .025 || y2 > h * .16 ||
      x2 - x1 < w * .04 || x2 - x1 > w * .18 ||
      Math.abs(first.y - (back[1] + back[3]) / 2) > h * .04) {
    fail('TOP_AVATAR_NOT_FOUND', 'The topmost detected avatar is not the top-right chat header avatar');
  }
  if (avatars.slice(1).some(item => Math.abs(item.y - first.y) < h * .025)) {
    fail('TOP_AVATAR_AMBIGUOUS', 'More than one avatar occupies the top chat header row');
  }
  return first;
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
  'pollMs', 'stepTimeoutMs', 'stableObservations'];

async function blockPeer(host, options, ctx) {
  const settings = { execute: boolean(options.execute ?? false, 'execute'),
    dryRun: boolean(options.dryRun ?? host.dryRun, 'dryRun'),
    confidence: number(options.confidence ?? .35, 'confidence', .28, .95, false),
    minimumScore: number(options.minimumScore ?? .55, 'minimumScore', .5, 1, false),
    pollMs: number(options.pollMs ?? 250, 'pollMs', 100, 2000),
    stepTimeoutMs: number(options.stepTimeoutMs ?? 15000, 'stepTimeoutMs', 1000, 30000),
    stableObservations: number(options.stableObservations ?? 2, 'stableObservations', 2, 4) };
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
          holdMs: { min: 65, max: 105 }, jitterPx: 1 }, screen);
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
        if (stable >= settings.stableObservations) return frame;
      } else { stable = 0; previous = null; }
      await ctx.sleep(settings.pollMs);
    }
    fail(code, message);
  }
  try {
    let frame, previous, header;
    for (let index = 0; index < settings.stableObservations; index++) {
      frame = await capture(); ctx.stage = 'top_avatar_detect';
      const view = await vision.inspect(frame.shot.image, settings, ctx);
      if (view.width !== frame.shot.width || view.height !== frame.shot.height) fail('VISION_PROTOCOL_ERROR', 'Avatar coordinates do not match the screenshot');
      report.lastObservation = { source: 'model2', scene: 'chat_detail', avatars: view.avatars };
      const avatar = topChatAvatar(view);
      if (!Array.isArray(view.headerSignature) || view.headerSignature.length !== 384 || !view.headerSignature.every(Number.isFinite)) {
        fail('VISION_PROTOCOL_ERROR', 'Chat header signature is invalid');
      }
      if (header && view.headerSignature.reduce((sum, value, i) => sum + Math.abs(value - header[i]), 0) / header.length > 18) {
        fail('CHAT_CHANGED', 'Chat header changed before clicking the avatar');
      }
      header = view.headerSignature;
      if (previous && Math.hypot(avatar.x - previous.x, avatar.y - previous.y) > frame.shot.height * .015) {
        fail('TOP_AVATAR_UNSTABLE', 'Top header avatar moved between observations');
      }
      report.avatar = avatar; previous = avatar;
      if (index + 1 < settings.stableObservations) await ctx.sleep(settings.pollMs);
    }
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
