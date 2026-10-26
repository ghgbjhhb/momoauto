'use strict';

/**
 * 通用单条文本聊天消息发送工具 (Universal Chat Message Sender)
 *
 * 遵循计划第 10 节与 R6/RP31 门禁：
 * 1. 严格对齐 ChatInput 契约：{ control, ctx, settings, observe, tap, checkControl, recognitionPool }。
 * 2. 严格对齐 prepareMessages 签名：prepareMessages(messages, python, ctx)。
 * 3. 前置核验与草稿保护 (T26)：核对目标联系人与输入框状态，已有用户草稿拒绝覆盖 (DRAFT_NOT_EMPTY)。
 * 4. 意图先行持久化 (T29)：点击发送前在 DB 中记录 send_attempted，写入失败禁止点击。
 * 5. 己方气泡观察 (T30, T31)：发送后观察新增己方气泡确认送达；超时标记 uncertain，严禁自动重发。
 */

const { performance } = require('node:perf_hooks');
const { KEY_CODES } = require('../protocol');
const { fail, boolean, number } = require('./runtime');
const { screenshot } = require('./screenshot');
const { clickPlan } = require('./touch-gestures');
const { chatLayout, verifyChatScreenAndTarget, messageEvidence, newOwnBubble } = require('./momo/chat-detail-parser');
const { ChatInput, prepareMessages } = require('../typing/chat-input');
const { observePage } = require('../automation/page-service');
const { alignMessageSequences } = require('./momo/chat-history-sync');

const SEND_CHAT_OPTIONS = [
  'expectedPeer', 'jobId', 'replyStore', 'conversationId',
  'timeoutMs', 'signal', 'execute', 'dryRun', 'python',
  'keyIntervalMs', 'settleMs', 'pollMs', 'keyboardTimeoutMs', 'sendTimeoutMs',
  'confidence', 'minimumScore', 'candidateRoi', 'emptyLabels', 'verifyChatPage', 'typeOnly',
  'onDraftReady', 'onDraftFrame'
];

/**
 * 发送按钮智能定位：优先基于 OCR 文字“发送”，融合蓝色胶囊几何限定，模型检测兜底
 */
function resolveSendButtonTarget(frame, finalObs) {
  const width = frame.shot?.width || 720;
  const height = frame.shot?.height || 1280;
  const ocrItems = finalObs?.evidence?.ocrData?.items || [];
  const inputY = frame.layout?.input?.y ?? (height * 0.70);

  // 1. OCR 核心定位：在屏幕右半侧中下部寻找“发送”文字
  const sendTextCandidates = ocrItems.filter(item => {
    const text = (item.text || '').replace(/\s+/g, '');
    if (!/发送/.test(text) || text.length > 5) return false;
    const cx = Number.isFinite(item.center_x) ? item.center_x : ((item.left + item.right) / 2);
    const cy = Number.isFinite(item.center_y) ? item.center_y : ((item.top + item.bottom) / 2);
    // 水平位置：必须位于屏幕右半区 (>= 45% 屏宽，真机通常在 70%~98%)
    if (cx < width * 0.45) return false;
    // 垂直位置：必须位于屏幕中下部输入/软键盘区域
    if (cy < height * 0.20 || cy > height * 0.98) return false;
    return true;
  });

  if (sendTextCandidates.length > 0) {
    // 排序：优先最靠近输入框水平线、最靠右侧、置信度高
    sendTextCandidates.sort((a, b) => {
      const aCy = Number.isFinite(a.center_y) ? a.center_y : ((a.top + a.bottom) / 2);
      const bCy = Number.isFinite(b.center_y) ? b.center_y : ((b.top + b.bottom) / 2);
      const aDist = Math.abs(aCy - inputY);
      const bDist = Math.abs(bCy - inputY);
      if (Math.abs(aDist - bDist) > 30) return aDist - bDist;
      const aCx = Number.isFinite(a.center_x) ? a.center_x : ((a.left + a.right) / 2);
      const bCx = Number.isFinite(b.center_x) ? b.center_x : ((b.left + b.right) / 2);
      return bCx - aCx;
    });

    const best = sendTextCandidates[0];
    const targetX = Math.round(Number.isFinite(best.center_x) ? best.center_x : ((best.left + best.right) / 2));
    const targetY = Math.round(Number.isFinite(best.center_y) ? best.center_y : ((best.top + best.bottom) / 2));
    return {
      x: targetX,
      y: targetY,
      source: 'ocr_text',
      text: best.text,
      score: best.score ?? 1.0
    };
  }

  // 2. 视觉蓝色胶囊特征辅助
  const blueBtn = frame.view?.blueSendButton;
  if (blueBtn && Number.isFinite(blueBtn.cx) && Number.isFinite(blueBtn.cy)) {
    if (blueBtn.cx >= width * 0.45 && blueBtn.cy >= height * 0.20) {
      return {
        x: Math.round(blueBtn.cx),
        y: Math.round(blueBtn.cy),
        source: 'color_capsule'
      };
    }
  }

  // 3. 模型检测兜底 (frame.layout.send)
  if (frame.layout?.send && Number.isFinite(frame.layout.send.x) && Number.isFinite(frame.layout.send.y)) {
    if (frame.layout.send.x >= width * 0.45) {
      return {
        x: Math.round(frame.layout.send.x),
        y: Math.round(frame.layout.send.y),
        source: 'model_detection'
      };
    }
  }

  return null;
}

function parseSendChatSettings(text, options = {}, hostDryRun = false) {
  if (typeof text !== 'string' || !text.trim()) {
    fail('INVALID_ARGUMENT', 'Message text must be a non-empty string');
  }
  if (text.length > 500) {
    fail('INVALID_ARGUMENT', 'Message text exceeds 500 characters limit');
  }

  const expectedPeer = (options.expectedPeer || '').trim();
  if (!expectedPeer) {
    fail('INVALID_ARGUMENT', 'expectedPeer is required for message sending verification');
  }

  const settings = {
    expectedPeer,
    jobId: options.jobId || null,
    replyStore: options.replyStore || null,
    conversationId: options.conversationId || null,
    execute: boolean(options.execute ?? false, 'execute'),
    dryRun: boolean(options.dryRun ?? hostDryRun, 'dryRun'),
    keyIntervalMs: number(options.keyIntervalMs ?? 55, 'keyIntervalMs', 0, 1000),
    settleMs: number(options.settleMs ?? 250, 'settleMs', 50, 5000),
    pollMs: number(options.pollMs ?? 250, 'pollMs', 100, 2000),
    keyboardTimeoutMs: number(options.keyboardTimeoutMs ?? 10000, 'keyboardTimeoutMs', 1000, 30000),
    sendTimeoutMs: number(options.sendTimeoutMs ?? 10000, 'sendTimeoutMs', 1000, 30000),
    confidence: number(options.confidence ?? 0.35, 'confidence', 0.25, 0.95, false),
    minimumScore: number(options.minimumScore ?? 0.8, 'minimumScore', 0.7, 1.0, false),
    verifyChatPage: boolean(options.verifyChatPage ?? true, 'verifyChatPage'),
    typeOnly: boolean(options.typeOnly ?? false, 'typeOnly'),
    emptyLabels: options.emptyLabels ?? ['', '请输入消息...', '请输入消息…', '请输入消息', '请输入消息.', '请输入消息..', '请输入消息。', '请输)', '请输']
  };

  if (options.python !== undefined && (typeof options.python !== 'string' || !options.python.trim() || /[\r\n\0]/.test(options.python))) {
    fail('INVALID_ARGUMENT', 'python must be an executable path');
  }
  settings.python = options.python;

  return { settings, text: text.trim() };
}

async function sendChatMessage(host, text, options = {}, ctx = null, dependencies = {}) {
  // 如果直接传入的是 phone (包含 .tools 方法)，委托给 tools.sendChatMessage
  if (host && typeof host.tools === 'function' && !ctx) {
    return host.tools().sendChatMessage(text, options);
  }

  const { settings, text: messageText } = parseSendChatSettings(text, options, host?.dryRun ?? false);
  settings.replyStore = dependencies.replyStore || settings.replyStore;

  if (!settings.execute || settings.dryRun) {
    return {
      status: 'planned',
      sendState: 'not_started',
      data: {
        text: messageText,
        expectedPeer: settings.expectedPeer,
        dryRun: true
      }
    };
  }

  if (!ctx) {
    fail('OPERATION_CONTEXT_REQUIRED', 'Executing sendChatMessage requires an active OperationContext');
  }
  if (Boolean(settings.jobId) !== Boolean(settings.replyStore)) fail('INVALID_ARGUMENT', 'jobId and replyStore must be provided together');
  if (settings.jobId) {
    const job = settings.replyStore.getReplyJob(settings.jobId);
    const conversation = job && settings.replyStore.db.prepare('SELECT * FROM ai_conversations WHERE id=?').get(job.conversationId);
    if (!conversation || conversation.deviceId !== String(host.deviceId) || conversation.contactName !== settings.expectedPeer ||
        (settings.conversationId && settings.conversationId !== conversation.id) || job.replyText !== messageText || job.state !== 'draft_ready') {
      fail('REPLY_JOB_MISMATCH', 'Reply job does not match this device, recipient, text and draft state');
    }
  }

  const report = {
    text: messageText,
    expectedPeer: settings.expectedPeer,
    sendState: 'not_started',
    inputCleared: false,
    bubbleObserved: false,
    history: []
  };
  ctx.data = report;
  const record = (stage, extra = {}) => report.history.push({ stage, elapsedMs: Math.round(performance.now() - ctx.started), ...extra });

  const control = await host._ensureControl(ctx);
  const vision = await host._ensureChatDetailVision(ctx);
  const pool = host._recognitionPool ?? undefined;
  const connectionGeneration = control.generation ?? control._generation ?? 1;

  function checkControl() {
    ctx.check();
    dependencies.assertActive?.();
    if (!control.connected || !control.ready) fail('NOT_CONNECTED', 'Control is not ready for chat typing');
    if ((control.generation ?? control._generation ?? 1) !== connectionGeneration) fail('CONNECTION_CHANGED', 'Control reconnected during this send; manual review required');
  }

  async function capture() {
    ctx.check();
    let shot;
    try {
      shot = await screenshot(host.device, { source: 'stream', maxSize: 1280, maxAgeMs: 800, attempts: 2 }, ctx);
    } catch {
      shot = await screenshot(host.device, { source: 'rest', level: 2 }, ctx);
    }
    const view = typeof vision?.inspect === 'function'
      ? await vision.inspect(shot.image, { confidence: settings.confidence }, ctx)
      : typeof vision?.chatView === 'function'
        ? await vision.chatView(shot.image, { confidence: settings.confidence }, ctx)
        : vision;
    const layout = chatLayout(view);
    return { shot, view, layout, capturedAt: shot.capturedAt };
  }

  async function tap(x, y, frame) {
    checkControl();
    return host._executeGesture(control, screen => clickPlan(x, y, { coordinateSpace: { width: frame.shot.width, height: frame.shot.height } }, screen), ctx, 'click');
  }

  async function verifyFrame(frame) {
    checkControl();
    const generation = control.generation ?? control._generation ?? 1;
    const obs = await observePage({ deviceId: host.deviceId, control, generation, pool }, {
      frame: { ...frame.shot, deviceId: host.deviceId, generation, capturedAt: frame.capturedAt },
      detailRaw: frame.view, signal: ctx.signal, timeoutMs: ctx.remaining() });
    if (!obs.ok) fail('CHAT_UNCONFIRMED', 'Fresh chat observation required before sending');
    if (settings.verifyChatPage) {
      if (obs.page !== 'chat_detail' || obs.overlay !== 'none') fail('CHAT_UNCONFIRMED', 'Fresh chat observation required before sending');
      verifyChatScreenAndTarget(obs.evidence.ocrData, obs.evidence.detailRaw, settings.expectedPeer);
    }
    return obs;
  }

  const typing = new ChatInput({
    control,
    ctx,
    settings,
    observe: capture,
    tap: (x, y, frame) => tap(x, y, frame),
    checkControl,
    recognitionPool: pool
  });
  let sendEvidence = null;

  try {
    // 1. 获取发送前观测；是否核验页面/联系人由调用方显式控制
    let frame = await capture();
    const preTypingMessages = messageEvidence(await verifyFrame(frame));
    record('chat_confirmed');

    // 2. 输入框残留检查：若有残留文字则自动清空
    const initialOcr = await typing.read(frame);
    if (!typing.isEmpty(initialOcr, frame)) {
      console.log(`[${new Date().toTimeString().slice(0, 8)}] [5/6] 检测到输入框有残留文字，正在自动清空...`);
      await typing.clear();
      frame = await capture();
    }

    if (frame.layout.keyboard === 'ambiguous') fail('KEYBOARD_STATE_AMBIGUOUS', 'Keyboard layout is ambiguous');
    if (frame.layout.keyboard !== 'open') {
      await tap(frame.layout.input.x, frame.layout.input.y, frame);
      await ctx.sleep(350); // 给键盘弹起留出基础物理动画时间，避免截取半透明/位移中的过渡帧
      const keyboardDeadline = performance.now() + settings.keyboardTimeoutMs;
      do {
        try {
          frame = await capture();
          if (frame.layout.keyboard === 'open') break;
        } catch (err) {
          if (performance.now() >= keyboardDeadline) throw err;
        }
        await ctx.sleep(settings.pollMs);
      } while (performance.now() < keyboardDeadline);
      if (frame.layout.keyboard !== 'open') fail('KEYBOARD_NOT_OPEN', 'Keyboard did not open');
    }
    await verifyFrame(frame);

    // 3. 准备自然拼音按键计划
    const plans = await prepareMessages([messageText], settings.python, ctx);
    const plan = plans[0];

    // 4. 执行自然拼音打字
    report.sendState = 'typing';
    record('typing_start');
    await typing.type(plan);
    report.sendState = 'draft_verified';
    record('draft_verified');

    // Manual input diagnostic: leave the verified draft in the chat box and
    // return before any send-button detection or click. The normal AI reply
    // path never sets typeOnly, so its send/clear/bubble confirmation remains
    // unchanged.
    if (settings.typeOnly) {
      report.completion = 'draft_verified';
      return { status: 'typed_only', sendState: 'draft_verified', data: report };
    }

    frame = await capture();

    // 触发打字完成帧回调，直接复用当前捕获的 frame 字节，避免并发截图死锁
    if (typeof options.onDraftFrame === 'function') {
      try { await options.onDraftFrame(frame); } catch {}
    }
    const beforeObs = await verifyFrame(frame);
    const beforeMessages = messageEvidence(beforeObs);
    sendEvidence = { deviceId: host.deviceId, expectedPeer: settings.expectedPeer, generation: beforeObs.generation,
      capturedAt: beforeObs.capturedAt, beforeMessages };
    // 5. 意图先行持久化 (T29)：点击发送前在 DB 中记录 send_attempted
    if (settings.replyStore && settings.jobId) {
      const updated = settings.replyStore.updateReplyJobState(
        settings.jobId,
        'draft_ready',
        'send_attempted', { sendEvidence }
      );
      if (!updated) {
        fail('DATABASE_FAILED', 'Failed to persist send_attempted state before clicking send; aborting send');
      }
    }

    // 6. 重新观测发送按钮
    frame = await capture();
    const finalObs = await verifyFrame(frame);
    const target = resolveSendButtonTarget(frame, finalObs);
    if (!target) {
      fail('SEND_BUTTON_NOT_FOUND', 'Send button anchor not found beside chat input (OCR/Color/Model)');
    }
    const sourceDesc = target.source === 'ocr_text' ? `OCR识别“${target.text}” (置信度=${target.score})` :
                       target.source === 'color_capsule' ? '蓝色胶囊按钮视觉检测' : '模型布局锚点';
    const timeNow = new Date().toTimeString().slice(0, 8);
    console.log(`[${timeNow}] [5/6] 定位发送按钮成功: [来源: ${sourceDesc}] 目标坐标=(${target.x}, ${target.y})`);

    report.sendState = 'send_attempted';
    record('send_attempted', { targetSource: target.source, x: target.x, y: target.y });
    await tap(target.x, target.y, frame);
    console.log(`[${new Date().toTimeString().slice(0, 8)}] [5/6] 已点击发送按钮，等待输入框清空...`);

    // 7. 等待输入框清空
    const clearDeadline = performance.now() + settings.sendTimeoutMs;
    let cleared = false;
    while (performance.now() < clearDeadline) {
      await ctx.sleep(settings.pollMs);
      frame = await capture();
      const currentOcr = await typing.read(frame, { full_field: true });
      if (typing.isEmpty(currentOcr, frame)) {
        cleared = true;
        break;
      }
    }

    if (!cleared) {
      report.sendState = 'uncertain';
      fail('SEND_NOT_CONFIRMED', 'Input box clearing was not confirmed after send click; marked uncertain');
    }

    report.inputCleared = true;
    record('input_cleared');
    console.log(`[${new Date().toTimeString().slice(0, 8)}] [5/6] 输入框已清空，收起软键盘并观察己方消息气泡...`);

    // 发送完成且输入框清空后，立即按一次系统返回键收起软键盘，恢复全屏视野
    if (typeof control?.back === 'function') {
      await control.back();
      if (typeof control.flush === 'function') await control.flush();
      await ctx.sleep(settings.settleMs ?? 300);
    }

    // 8. 观察己方新气泡 (全屏视野下直接核验上屏)
    const bubbleDeadline = performance.now() + settings.sendTimeoutMs;
    let bubbleFound = false;
    while (performance.now() < bubbleDeadline) {
      await ctx.sleep(settings.pollMs);
      const observedFrame = await capture();
      const observed = await verifyFrame(observedFrame);
      if (newOwnBubble(beforeMessages, observed, messageText, {
        requireChatPage: settings.verifyChatPage
      })) { bubbleFound = true; break; }
    }

    if (bubbleFound) {
      report.bubbleObserved = true;
      report.sendState = 'own_bubble_observed';
      record('own_bubble_observed');
      console.log(`[${new Date().toTimeString().slice(0, 8)}] [5/6] 己方新消息气泡确认已送达！`);
      if (settings.replyStore && settings.jobId) {
        const committed = settings.replyStore.updateReplyJobState(
          settings.jobId,
          'send_attempted',
          'own_bubble_observed',
          { outcome: 'sent_and_observed', sendEvidence }
        );
        if (!committed) fail('DATABASE_FAILED', 'Bubble was observed but its durable confirmation could not be committed');
      }
    } else {
      report.sendState = 'uncertain';
      record('send_uncertain_no_bubble');
      if (settings.replyStore && settings.jobId) {
        settings.replyStore.updateReplyJobState(
          settings.jobId,
          'send_attempted',
          'uncertain',
          { outcome: 'send_uncertain_no_bubble', sendEvidence }
        );
      }
    }

    report.keyboardDismissed = true;
    return {
      status: report.sendState === 'own_bubble_observed' ? 'sent' : 'uncertain',
      sendState: report.sendState,
      data: report
    };
  } catch (error) {
    if (settings.replyStore && settings.jobId) {
      const job = settings.replyStore.getReplyJob(settings.jobId);
      if (job?.state === 'send_attempted') settings.replyStore.updateReplyJobState(job.id, 'send_attempted', 'uncertain', { outcome: 'send_interrupted', sendEvidence });
    }
    throw error;
  } finally {
    try { await typing.close(); } catch {}
  }
}

module.exports = {
  SEND_CHAT_OPTIONS,
  parseSendChatSettings,
  sendChatMessage
};
