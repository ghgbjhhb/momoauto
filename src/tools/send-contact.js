'use strict';

const { performance } = require('node:perf_hooks');
const { boolean, number, fail } = require('./runtime');
const { screenshot } = require('./screenshot');
const { clickPlan } = require('./touch-gestures');
const { chatLayout } = require('./momo/chat-detail-parser');
const { ChatInput, prepareMessages } = require('../typing/chat-input');

const CONTACT_OPTIONS = ['timeoutMs', 'signal', 'execute', 'dryRun', 'introText', 'python',
  'keyIntervalMs', 'settleMs', 'messageIntervalMs', 'pollMs', 'keyboardTimeoutMs', 'sendTimeoutMs',
  'confidence', 'minimumScore', 'candidateRoi', 'emptyLabels'];

function contactSettings(contact, options, hostDryRun) {
  if (typeof contact !== 'string' || !contact.trim() || Array.from(contact).length > 64 ||
      /[\s\p{Cc}\p{Cf}]/u.test(contact)) {
    fail('CONTACT_INVALID', 'Contact must be a non-empty string of at most 64 characters, without whitespace or controls');
  }
  const introText = options.introText ?? '1，那你看好了';
  if (typeof introText !== 'string' || !introText.trim() || Array.from(introText).length > 80 || /[\p{Cc}\p{Cf}]/u.test(introText)) {
    fail('INVALID_ARGUMENT', 'introText must be a single-line string of 1 to 80 characters');
  }
  const settings = { execute: boolean(options.execute ?? false, 'execute'),
    dryRun: boolean(options.dryRun ?? hostDryRun, 'dryRun'), introText,
    keyIntervalMs: number(options.keyIntervalMs ?? 55, 'keyIntervalMs', 0, 1000),
    settleMs: number(options.settleMs ?? 250, 'settleMs', 50, 5000),
    messageIntervalMs: number(options.messageIntervalMs ?? 400, 'messageIntervalMs', 0, 10000),
    pollMs: number(options.pollMs ?? 250, 'pollMs', 100, 2000),
    keyboardTimeoutMs: number(options.keyboardTimeoutMs ?? 10000, 'keyboardTimeoutMs', 1000, 30000),
    sendTimeoutMs: number(options.sendTimeoutMs ?? 10000, 'sendTimeoutMs', 1000, 30000),
    confidence: number(options.confidence ?? .35, 'confidence', .25, .95, false),
    minimumScore: number(options.minimumScore ?? .8, 'minimumScore', .7, 1, false),
    emptyLabels: options.emptyLabels ?? ['', '请输入消息...', '请输入消息…', '请输入消息', '请输入消息.', '请输入消息..', '请输入消息。'] };
  if (!Array.isArray(settings.emptyLabels) || !settings.emptyLabels.length || settings.emptyLabels.length > 10 ||
      settings.emptyLabels.some(label => typeof label !== 'string' || label.length > 30)) {
    fail('INVALID_ARGUMENT', 'emptyLabels must contain at most 10 short strings');
  }
  if (options.python !== undefined && (typeof options.python !== 'string' || !options.python.trim() || /[\r\n\0]/.test(options.python))) {
    fail('INVALID_ARGUMENT', 'python must be an executable path');
  }
  settings.python = options.python;
  if (options.candidateRoi !== undefined) {
    const roi = options.candidateRoi;
    if (!Array.isArray(roi) || roi.length !== 4 || roi.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) ||
        roi[0] >= roi[2] || roi[1] >= roi[3]) fail('INVALID_ARGUMENT', 'candidateRoi must be normalized [left,top,right,bottom]');
    settings.candidateRoi = roi;
  }
  const chars = Array.from(contact);
  const parts = [chars.slice(0, 3), chars.slice(3, 6), chars.slice(6)].map(value => value.join('')).filter(Boolean);
  return { settings, messages: [introText, ...parts] };
}

async function sendContact(host, contact, options, ctx) {
  const { settings, messages } = contactSettings(contact, options, host.dryRun);
  const report = { messages: messages.map((text, index) => ({ index, text, state: 'pending' })),
    completedMessages: 0, uncertainMessageIndex: null, screenshots: 0, inputClicks: 0,
    keyboard: 'unknown', lastScreenshot: null, lastObservation: null, vision: null,
    completion: 'not_started', history: [] };
  ctx.data = report;
  const record = (stage, extra = {}) => report.history.push({ stage, elapsedMs: Math.round(performance.now() - ctx.started), ...extra });
  if (!settings.execute || settings.dryRun) {
    return { status: 'planned', data: { messages, split: '3+3+remainder', execute: false,
      steps: ['model2_chat_check', 'open_keyboard_if_input_at_bottom', 'type_and_verify_draft', 'detect_and_click_send_once', 'wait_input_clear_before_next_message'] } };
  }
  host._requireToken();
  // Validate every keystroke before opening the phone control or sending anything.
  const plans = await prepareMessages(messages, settings.python, ctx);
  ctx.stage = 'vision_start';
  const vision = await host._ensureChatDetailVision(ctx);
  report.vision = vision.info;
  ctx.attempt = 1;
  const control = await host._ensureControl(ctx);
  const initial = { generation: control._generation, width: control.screenWidth, height: control.screenHeight };
  let header = null, typing;
  const checkControl = () => {
    ctx.check();
    if (!control.connected || !control.ready) fail('CONNECTION_LOST', 'Control connection is no longer ready');
    if (control._generation !== initial.generation) fail('CONNECTION_CHANGED', 'Control generation changed; do not replay');
    if (control.screenWidth !== initial.width || control.screenHeight !== initial.height) fail('SCREEN_CHANGED', 'Phone resolution changed');
  };
  async function observe() {
    checkControl();
    const shot = await screenshot(host.device, { source: 'stream', maxSize: 1280, maxAgeMs: 0, attempts: 1 }, ctx);
    const observedAt = performance.now();
    ctx.data = report;
    report.screenshots++; report.lastScreenshot = shot;
    ctx.stage = 'chat_detect';
    const view = await vision.inspect(shot.image, settings, ctx);
    report.lastObservation = view;
    if (view.width !== shot.width || view.height !== shot.height) fail('VISION_PROTOCOL_ERROR', 'Model dimensions differ from the screenshot');
    const layout = chatLayout(view);
    checkControl();
    const signature = view.headerSignature;
    if (!Array.isArray(signature) || signature.length !== 384 || !signature.every(Number.isFinite)) {
      fail('VISION_PROTOCOL_ERROR', 'Chat header signature is invalid');
    }
    if (!header) header = signature;
    else {
      const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
      const a = mean(header), b = mean(signature);
      const difference = signature.reduce((sum, value, i) => sum + Math.abs(value - b - header[i] + a), 0) / signature.length;
      if (difference > 18) fail('CHAT_CHANGED', 'Chat header changed during sending; manual review is required');
    }
    report.keyboard = layout.keyboard;
    return { shot, view, layout, observedAt };
  }
  async function tap(x, y, frame, jitterPx = 1) {
    checkControl();
    if (performance.now() - frame.observedAt > 3000) fail('STALE_TARGET', 'Target coordinates are stale; no click was sent');
    try {
      await host._executeGesture(control, screen => {
        checkControl();
        if (performance.now() - frame.observedAt > 3000) fail('STALE_TARGET', 'Target expired in the control queue; no click was sent');
        return clickPlan(x, y, { coordinateSpace: { width: frame.shot.width, height: frame.shot.height },
          jitterPx }, screen);
      }, ctx, 'click');
    } finally { ctx.data = report; }
  }
  const capture = observe;
  async function ensureKeyboard() {
    let frame = await capture();
    if (frame.layout.keyboard === 'ambiguous') fail('INPUT_POSITION_AMBIGUOUS', 'Input position is between middle and bottom thresholds');
    if (frame.layout.keyboard === 'open') { record('keyboard_already_open'); return frame; }
    await typing.verify('', { empty: true, attempts: 1, code: 'DRAFT_NOT_EMPTY' });
    frame = await capture();
    if (frame.layout.keyboard === 'open') return frame;
    if (frame.layout.keyboard !== 'closed') fail('INPUT_POSITION_AMBIGUOUS', 'Input moved while preparing to focus');
    // Click the text area, not the smiley at the input's right edge.
    await tap(frame.layout.input.box[0] + (frame.layout.input.box[2] - frame.layout.input.box[0]) * .35,
      frame.layout.input.y, frame);
    report.inputClicks++; record('input_clicked');
    const deadline = performance.now() + settings.keyboardTimeoutMs;
    let stable = 0;
    while (performance.now() < deadline) {
      await ctx.sleep(settings.pollMs);
      frame = await capture();
      stable = frame.layout.keyboard === 'open' ? stable + 1 : 0;
      if (stable >= 2) return frame;
    }
    fail('KEYBOARD_NOT_OPEN', 'Input did not move to the middle after clicking');
  }
  typing = new ChatInput({ control, ctx, settings, observe: capture, tap: (x, y, frame) => tap(x, y, frame, 0), checkControl,
    recognitionPool: host._recognitionPool ?? undefined });
  try {
    await capture(); record('chat_confirmed');
    for (let index = 0; index < plans.length; index++) {
      const message = report.messages[index];
      await ensureKeyboard();
      await typing.verify('', { empty: true, requireKeyboard: true, code: 'DRAFT_NOT_EMPTY' });
      message.state = 'typing'; record('typing', { index });
      await typing.type(plans[index]);
      message.state = 'draft_verified';
      // Reacquire both model and exact draft on two observations before each Send.
      let frame;
      const deadline = performance.now() + settings.sendTimeoutMs;
      let stable = 0, previous;
      while (performance.now() < deadline) {
        ({ frame } = await typing.verify(message.text, { attempts: 1 }));
        const target = frame.layout.send;
        stable = target && frame.layout.keyboard === 'open' && (!previous ||
          Math.hypot(target.x - previous.x, target.y - previous.y) < frame.shot.height * .015) ? stable + 1 : 0;
        previous = target;
        if (stable >= 2) break;
        await ctx.sleep(settings.pollMs);
      }
      if (stable < 2 || !frame.layout.send) fail('SEND_BUTTON_NOT_FOUND', 'No stable model 2 send button was found');
      message.state = 'send_attempted'; report.uncertainMessageIndex = index;
      ctx.stage = 'send_click'; record('send_attempted', { index });
      await tap(frame.layout.send.x, frame.layout.send.y, frame);
      // No resend loop. Empty input + inactive Send is UI evidence only, not delivery.
      const clearDeadline = performance.now() + settings.sendTimeoutMs;
      let cleared = 0;
      while (performance.now() < clearDeadline) {
        await ctx.sleep(settings.pollMs);
        frame = await capture();
        const ocr = await typing.read(frame, { full_field: true });
        cleared = typing.isEmpty(ocr, frame) ? cleared + 1 : 0;
        if (cleared >= 2) break;
      }
      if (cleared < 2) fail('SEND_NOT_CONFIRMED', 'Send was attempted but input clearing was not confirmed; do not resend automatically', { messageIndex: index });
      message.state = 'input_cleared'; report.completedMessages++;
      report.uncertainMessageIndex = null; record('input_cleared', { index });
      if (index + 1 < plans.length) await ctx.sleep(settings.messageIntervalMs);
    }
    report.completion = 'ui_input_cleared';
    return { status: 'sent', data: report };
  } finally {
    ctx.data = report;
    try { await typing.close(); }
    catch { ctx.cleanupFailed = true; }
    if (host._ownsControl && ctx.execution.state === 'partial') {
      try { await host._retire(control); } catch { ctx.cleanupFailed = true; }
    }
  }
}

module.exports = { CONTACT_OPTIONS, sendContact, contactSettings };
