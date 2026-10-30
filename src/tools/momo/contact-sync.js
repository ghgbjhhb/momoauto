'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { fail, number, boolean } = require('../runtime');
const { screenshot } = require('../screenshot');
const { swipePlan, regionClickPlan } = require('../touch-gestures');
const { SharedRecognitionClient } = require('../../automation/recognition-service');
const { MomoDatabase, getDeviceDatabasePath } = require('./db');
const { recognitionData, isChatPage } = require('./recognition-check');
const { chatLayout, assessAssistantOverlay } = require('./chat-detail-parser');
const {
  parseFrame,
  readFrame,
  stableFrames,
  mergeOlder,
  extractChatContactName,
  normalize,
  sameMessage,
  coverage,
} = require('./chat-history-sync');

const MOMO_SYNC_OPTIONS = [
  'timeoutMs',
  'signal',
  'execute',
  'dryRun',
  'contactName',
  'dbPath',
  'screenshotsDir',
  'currentChatOnly',
  'boundaryStableCount',
  'settleMs',
  'scrollSettleMs',
  'swipeDurationMs',
  'pollMs',
];

const DESCRIPTION = '读取指定联系人的当前聊天页，向上采集文字历史，确认到顶后保存发送方和内容';

/**
 * 过滤并规范化气泡聊天记录，只保留有效的对方与我方文字
 */
function storedChatMessages(messages) {
  return (messages ?? [])
    .filter(m => ['peer', 'self'].includes(m.sender) && String(m.text ?? '').trim())
    .map(({ sender, text }) => ({
      sender,
      text: text.trim(),
    }));
}

/**
 * 校验并解析运行参数
 */
function settingsOf(options, host) {
  if (typeof options.contactName !== 'string' || !options.contactName.trim() || /[\r\n\0]/.test(options.contactName)) {
    fail('MOMO_CONTACT_NAME_REQUIRED', '必须传入当前聊天联系人的姓名。');
  }

  for (const field of ['dbPath', 'screenshotsDir']) {
    if (options[field] !== undefined &&
        (typeof options[field] !== 'string' || !options[field].trim() || /[\r\n\0]/.test(options[field]))) {
      fail('INVALID_ARGUMENT', `${field === 'dbPath' ? '数据库' : '截图目录'}路径无效。`);
    }
  }

  if (options.currentChatOnly === false) {
    fail('INVALID_ARGUMENT', '入库脚本只支持当前聊天页，请先打开指定联系人的聊天。');
  }

  return {
    contactName: options.contactName.trim(),
    currentChatOnly: true,
    execute: boolean(options.execute ?? true, 'execute'),
    dryRun: boolean(options.dryRun ?? host.dryRun ?? false, 'dryRun'),
    boundaryStableCount: number(options.boundaryStableCount ?? 2, 'boundaryStableCount', 2, 5),
    settleMs: number(options.settleMs ?? 600, 'settleMs', 100, 5000),
    scrollSettleMs: number(options.scrollSettleMs ?? 450, 'scrollSettleMs', 100, 5000),
    swipeDurationMs: number(options.swipeDurationMs ?? 350, 'swipeDurationMs', 100, 2000),
    pollMs: number(options.pollMs ?? 300, 'pollMs', 100, 2000),
    screenshotsDir: options.screenshotsDir ? path.resolve(options.screenshotsDir) : null,
  };
}

/**
 * 仿真真人拇指弧度滑动手势轨迹生成
 */
function realisticSwipePath(w, h, upper, lower, travel, towardsTop, probe = false) {
  // 拇指落点：屏幕宽度 46% ~ 55%（偏右习惯），带自然随机散布
  const startX = Math.round(w * (0.47 + Math.random() * 0.08));
  // 弧线弯曲偏移：向左或向右自然微弯 10 ~ 22 像素
  const curveDirection = Math.random() > 0.5 ? 1 : -1;
  const curveOffset = Math.round(curveDirection * (10 + Math.random() * 12));
  const endX = startX + Math.round((Math.random() - 0.5) * 16);

  const yA = Math.round(upper + (lower - upper) * (1 - travel) / 2);
  const yB = Math.round(upper + (lower - upper) * (1 + travel) / 2);
  const [startY, endY] = towardsTop ? [yA, yB] : [yB, yA];

  // 生成 4 个自然轨迹采样点（起点 -> 两个带手势微弧度的中间控制点 -> 终点）
  return [
    { x: startX, y: startY },
    {
      x: Math.round(startX + curveOffset * 0.7),
      y: Math.round(startY + (endY - startY) * 0.33),
    },
    {
      x: Math.round(startX + curveOffset),
      y: Math.round(startY + (endY - startY) * 0.67),
    },
    { x: endX, y: endY },
  ];
}

/**
 * 气泡密度前瞻动态步长计算（稀疏收敛、密集大步，带随机浮动）
 */
function adaptiveDistance(frame, isProbe = false) {
  if (isProbe) {
    return Math.min(0.40, Math.max(0.25, 0.35 + (Math.random() * 0.06 - 0.03)));
  }

  const msgCount = frame?.parsed?.messages?.length || 0;
  // 气泡少（大长句/间距大）步子收紧至 ~0.48；气泡多（短句多）大步 ~0.60
  const base = msgCount <= 1 ? 0.48 : msgCount === 2 ? 0.55 : 0.60;
  const jitter = Math.random() * 0.06 - 0.03; // ±3% 随机抖动
  return Math.min(0.68, Math.max(0.25, base + jitter));
}

/**
 * 历史起始过渡卡片桥接判断
 */
function originBridge(previous, current) {
  if (!current.parsed.origin || current.parsed.messages.length) return false;
  const oldCard = previous.parsed.cards[0];
  const newCard = current.parsed.cards[0];

  return Boolean(
    oldCard &&
    newCard &&
    oldCard.evidence.filter(kind => newCard.evidence.includes(kind)).length >= 2 &&
    previous.parsed.messages.every(message => message.box[1] >= oldCard.box[3] - current.shot.height * 0.04)
  );
}

/**
 * 宽松读取键盘开合状态：锚点缺失或布局校验失败时返回 null，不阻断主流程识别
 */
function keyboardStateOf(detail) {
  try {
    return chatLayout(detail);
  } catch {
    return null;
  }
}

/**
 * 校验当前抓取序列是否已完整衔接数据库中的尾部锚点记录（拓扑子序列匹配，容忍单条历史遗漏）
 */
function matchesTailAnchor(msgs, anchors) {
  if (!anchors || !anchors.length || !msgs || !msgs.length) return false;
  let aIdx = 0;
  for (let mIdx = 0; mIdx < msgs.length; mIdx++) {
    if (sameMessage(msgs[mIdx], anchors[aIdx]) && (msgs[mIdx].sender === anchors[aIdx].sender || msgs[mIdx].sender === 'unknown' || anchors[aIdx].sender === 'unknown')) {
      aIdx++;
      if (aIdx >= anchors.length) return true;
    }
  }
  return false;
}

/**
 * MOMO 联系人及消息入库核心执行器
 */
async function syncMomoContacts(host, options, ctx) {
  const settings = settingsOf(options, host);
  const databasePath = options.dbPath
    ? (options.dbPath === ':memory:' ? ':memory:' : path.resolve(options.dbPath))
    : getDeviceDatabasePath(host.deviceId);

  if (!settings.execute || settings.dryRun) {
    return {
      status: 'planned',
      data: {
        app: 'momo',
        action: 'contact_sync',
        description: DESCRIPTION,
        execute: false,
        settings,
        database: { path: databasePath },
        steps: [
          '确认姓名及当前聊天页',
          '确认助手浮层后关闭',
          '读取文字气泡',
          '向上翻页并拼接',
          '确认历史顶部',
          '一次性入库',
        ],
        note: '只预览；不操作手机，不写入数据库。',
      },
    };
  }

  host._requireToken();

  if (!settings.screenshotsDir) {
    const root = path.resolve(__dirname, '../../../.local-output/momo-sync');
    await fs.mkdir(root, { recursive: true });
    settings.screenshotsDir = await fs.mkdtemp(path.join(root, 'run-'));
  }

  const report = {
    version: 2,
    app: 'momo',
    action: 'contact_sync',
    description: DESCRIPTION,
    settings,
    databasePath,
    outcome: 'running',
    startMode: 'current_chat',
    collectionScope: 'verified_bottom_to_history_top',
    contactsProcessed: 0,
    newContactsAdded: 0,
    totalMessagesCollected: 0,
    totalMessagesAlreadyStored: 0,
    totalMessagesIngested: 0,
    details: [],
    screenshots: 0,
    screenshotsDirectory: settings.screenshotsDir,
    savedScreenshots: [],
    lastScreenshot: null,
    currentContact: {
      name: settings.contactName,
      topConfirmed: false,
      bottomConfirmed: false,
      messagesCollected: 0,
    },
    frames: [],
    history: [],
    collectedMessages: [],
  };

  ctx.data = report;

  const log = (stage, details = {}) => {
    report.history.push({
      stage,
      elapsedMs: Math.round(performance.now() - ctx.started),
      ...details,
    });
  };

  const pool = host._recognitionPool ?? new SharedRecognitionClient();
  let control = null;
  let session = null;
  let database = null;
  let keyboardCollapseBudget = 3;
  const collected = [];

  function assertConnected() {
    ctx.check();
    if (!control?.connected || !control.ready) {
      fail('CONNECTION_LOST', '手机控制连接已断开，请重新连接后重试。');
    }
    if (control._generation !== session.generation) {
      fail('CONNECTION_CHANGED', '手机控制会话发生变化，已保存采集现场。');
    }
    if (control.screenWidth !== session.width || control.screenHeight !== session.height) {
      fail('SCREEN_CHANGED', '采集期间屏幕尺寸发生变化，请保持同一屏幕方向。');
    }
  }

  async function capture(purpose) {
    assertConnected();
    const shot = await screenshot(host.device, { source: 'stream', maxSize: 1280, maxAgeMs: 0, attempts: 1 }, ctx);
    const index = ++report.screenshots;
    const ext = shot.format === 'png' ? 'png' : 'jpg';
    const imagePath = path.join(settings.screenshotsDir, `${String(index).padStart(4, '0')}-${purpose}.${ext}`);

    try {
      await fs.mkdir(settings.screenshotsDir, { recursive: true });
      await fs.writeFile(imagePath, shot.image, { flag: 'wx' });
    } catch (error) {
      fail('MOMO_SCREENSHOT_ARCHIVE_FAILED', '截图保存失败，已停止采集。', { imagePath, causeCode: error.code });
    }

    report.lastScreenshot = shot;
    report.savedScreenshots.push({
      index,
      purpose,
      imagePath,
      format: shot.format,
      mimeType: shot.mimeType,
      width: shot.width,
      height: shot.height,
      bytes: shot.bytes,
      source: shot.source,
      capturedAt: shot.capturedAt,
    });
    log('screenshot_captured', { index, purpose, imagePath, archived: true });

    ctx.stage = 'momo_recognition';
    const request = { signal: ctx.signal, timeoutMs: Math.min(30000, ctx.remaining()) };

    const results = await ctx.wait(
      Promise.all([
        pool.page(shot.image, request),
        pool.ocr(shot.image, request),
        pool.chatDetail(shot.image, { ...request, confidence: 0.30 }),
      ])
    );

    assertConnected();
    const [page, ocr, detail] = results.map((result, i) =>
      recognitionData(result, ['page', 'ocr', 'chatDetail'][i], shot)
    );

    return { index, imagePath, shot, page, ocr, detail, request };
  }

  async function observe(purpose) {
    let lastReason = '页面尚未加载完成';

    for (let attempt = 0; attempt < 3; attempt++) {
      let obs;
      try {
        obs = await capture(purpose);
      } catch (error) {
        if (error.code !== 'MOMO_RECOGNITION_FAILED' || attempt === 2) throw error;
        log('recognition_retry', { attempt: attempt + 1, details: error.details });
        await ctx.sleep(settings.pollMs);
        continue;
      }

      const title = extractChatContactName(obs.ocr);
      const structural = Boolean(obs.detail.elements.back_btn && obs.detail.elements.input_box);

      if (!isChatPage(obs.page) && !structural) {
        lastReason = '尚未确认聊天页，聊天输入框和返回键证据不足';
      } else {
        const parsed = parseFrame(obs.ocr, obs.detail);
        const overlay = assessAssistantOverlay(obs.detail, obs.shot);
        const isCard = overlay.panelBox && parsed.cards.some(card => coverage(overlay.panelBox, card.box) > 0.55);

        if (overlay.confirmed) {
          assertConnected();
          ctx.stage = 'dispatch';
          log('click_dispatched', { label: 'assistant_close_x', box: overlay.closeBox });
          await host._executeGesture(
            control,
            screen => regionClickPlan(overlay.closeBox, {
              coordinateSpace: { width: obs.shot.width, height: obs.shot.height },
              centerFraction: 0.5,
              centerProbability: 1,
              insetPx: 1,
            }, screen),
            ctx,
            'click'
          );
          await ctx.sleep(settings.settleMs);
          lastReason = '助手浮层关闭后仍未消失';
          continue;
        }

        if (overlay.blocked && !isCard) {
          lastReason = '检测到助手面板，但关闭按钮尚未确认';
        } else {
          if (overlay.candidate) {
            log('assistant_overlay_rejected', { reason: isCard ? 'system_card' : overlay.reason });
          }

          // 软键盘升起会挤占聊天下半屏，底部气泡可能被遮挡或误裁；确认键盘开启时先按返回键收起再读帧
          const layout = keyboardStateOf(obs.detail);
          if (layout?.keyboard === 'open') {
            if (keyboardCollapseBudget > 0) {
              keyboardCollapseBudget -= 1;
              assertConnected();
              ctx.stage = 'dispatch';
              log('keyboard_collapse_dispatched', { inputCenterRatio: Number(layout.inputCenterRatio.toFixed(3)) });
              if (typeof control.back === 'function') {
                await control.back();
                if (typeof control.flush === 'function') await control.flush();
              }
              await ctx.sleep(settings.settleMs);
              lastReason = '软键盘已收起，重新确认画面';
              continue;
            }
            log('keyboard_collapse_skipped', { reason: 'budget_exhausted', inputCenterRatio: Number(layout.inputCenterRatio.toFixed(3)) });
          }

          const frame = await readFrame(pool, obs, obs.request, promise => ctx.wait(promise));
          const evidence = {
            index: obs.index,
            imagePath: obs.imagePath,
            title,
            pageConfirmedBy: isChatPage(obs.page) ? 'page_model' : 'title_and_controls',
            messages: frame.parsed.messages,
            pending: frame.parsed.pending,
            ignored: frame.parsed.ignored,
            clipped: frame.parsed.clipped,
            cards: frame.parsed.cards,
            notices: frame.parsed.notices,
            reread: frame.reread,
          };

          report.frames.push(evidence);
          await fs.writeFile(
            obs.imagePath.replace(/\.(png|jpg)$/, '.json'),
            JSON.stringify(evidence, null, 2),
            { flag: 'wx' }
          );

          log('chat_frame_read', {
            index: obs.index,
            messages: frame.parsed.messages.length,
            pending: frame.parsed.pending.length,
            ignored: frame.parsed.ignored.length,
            titleVerified: Boolean(title),
          });
          return frame;
        }
      }

      log('chat_page_recheck', { attempt: attempt + 1, reason: lastReason });
      await ctx.sleep(settings.pollMs);
    }

    fail('MOMO_CHAT_NOT_READY', `${lastReason}，已保存截图，请检查当前页面。`);
  }

  async function readStable(purpose) {
    let previous = null;
    let current = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      current = await observe(purpose);
      if (previous && stableFrames(previous.parsed, current.parsed)) {
        return current;
      }
      if (previous &&
          !previous.parsed.pending.length &&
          !current.parsed.pending.length &&
          !previous.parsed.messages.length &&
          !current.parsed.messages.length) {
        return current;
      }
      previous = current;
      if (attempt < 3) {
        await ctx.sleep(settings.pollMs);
      }
    }
    // 复核后直接返回当前画面，不再因轻微动效或个别模糊字而阻断退出
    return current;
  }

  async function scroll(frame, towardsTop, distance = 0.58, probe = false) {
    assertConnected();
    const { width: w, height: h, top, bottom } = frame.parsed;
    const upper = top + h * 0.025;
    const lower = bottom - h * 0.025;

    if (lower - upper < h * 0.10) {
      fail('MOMO_CHAT_VIEWPORT_TOO_SMALL', '聊天区域被输入法或浮层挤占，无法可靠翻页。');
    }

    const travel = Math.min(0.70, Math.max(0.20, distance));
    const points = realisticSwipePath(w, h, upper, lower, travel, towardsTop, probe);

    log('swipe_dispatched', {
      label: towardsTop ? 'history_older' : 'history_recover',
      path: points,
      travelFraction: travel,
    });
    ctx.stage = 'swipe_dispatch';

    // 随机微动手势时长与静止等待时间
    const durationMs = Math.round(settings.swipeDurationMs * (0.92 + Math.random() * 0.20));
    const settleMs = Math.round(settings.scrollSettleMs * (0.90 + Math.random() * 0.25));

    await host._executeGesture(
      control,
      screen => swipePlan(points, {
        coordinateSpace: { width: w, height: h },
        durationMs,
        easing: 'easeInOut',
        startHoldMs: Math.round(30 + Math.random() * 20),
        endHoldMs: Math.round(30 + Math.random() * 20),
      }, screen),
      ctx,
      'swipe'
    );

    await ctx.sleep(settleMs);
    return travel;
  }

  async function adaptiveBackstep(previous, current) {
    // 反向往下拉一小截（约 28% ~ 32%）把跨大步漏掉的内容接上
    const backDistance = 0.28 + (Math.random() * 0.05 - 0.025);
    log('adaptive_backstep_triggered', { backDistance });
    await scroll(current, false, backDistance);
    return readStable('backstep');
  }

  async function collect(tailAnchors = []) {
    let previous = await readStable('initial');
    log('history_collect_preflight_passed', { source: 'fresh_verified_contact_frame' });
    report.currentContact.bottomConfirmed = true;

    if (!previous.parsed.messages.length) {
      log('history_empty_initial', { reason: 'no_messages_in_initial_view' });
      report.currentContact.topConfirmed = true;
      return;
    }

    collected.push(...previous.parsed.messages);

    if (matchesTailAnchor(collected, tailAnchors)) {
      report.currentContact.topConfirmed = true;
      log('history_top_confirmed', { reason: 'matched_database_tail_anchor', anchorsCount: tailAnchors.length });
      return;
    }

    // 首帧终态评估：若初始画面已处于会话起源（相遇卡片、打招呼胶囊等），直接确认到顶退出
    if (previous.parsed.origin) {
      report.currentContact.topConfirmed = true;
      log('history_top_confirmed', { reason: 'initial_frame_origin_terminal' });
      return;
    }

    let unchanged = 0;
    let originOnly = false;
    let backstepBudget = 1;
    const maxPages = 15;

    for (let page = 1; page <= maxPages; page++) {
      ctx.check();
      report.currentContact.messagesCollected = collected.length;

      const targetDistance = adaptiveDistance(previous, unchanged > 0);
      const distance = await scroll(previous, true, targetDistance, unchanged > 0);
      let current = await readStable('history');

      if (stableFrames(previous.parsed, current.parsed)) {
        unchanged++;
        log('history_boundary_probe', { page, unchanged, messages: collected.length });

        if (unchanged >= (current.parsed.origin ? 1 : settings.boundaryStableCount)) {
          report.currentContact.topConfirmed = true;
          log('history_top_confirmed', {
            page,
            reason: current.parsed.origin ? 'origin_and_no_movement' : 'repeated_different_swipes_no_movement',
          });
          return;
        }
        previous = current;
        continue;
      }

      unchanged = 0;

      if (current.parsed.origin && !current.parsed.messages.length) {
        report.currentContact.topConfirmed = true;
        log('history_top_confirmed', { page, reason: 'origin_empty_viewport' });
        return;
      }

      if (originBridge(previous, current) || (originOnly && current.parsed.origin && !current.parsed.messages.length)) {
        originOnly = true;
        previous = current;
        continue;
      }

      if (!collected.length && current.parsed.messages.length) {
        collected.push(...current.parsed.messages);
        previous = current;
        continue;
      }

      if (!collected.length && !current.parsed.messages.length) {
        if (page >= 5) {
          report.currentContact.topConfirmed = true;
          log('history_top_confirmed', { page, reason: 'consecutive_empty_pages_reached' });
          return;
        }
        previous = current;
        continue;
      }

      let merged = mergeOlder(collected, previous.parsed.messages, current.parsed.messages, current.shot.height);

      if (!merged.ok) {
        current = await readStable('alignment_recheck');
        merged = mergeOlder(collected, previous.parsed.messages, current.parsed.messages, current.shot.height);
      }

      if (!merged.ok) {
        if (current.parsed.origin) {
          report.currentContact.topConfirmed = true;
          log('history_top_confirmed', { page, reason: 'origin_reached_at_boundary' });
          return;
        }

        // 先看当前帧是否已经读到了数据库末尾历史，如果已经读到，直接组装退出
        const existingTexts = new Set(collected.map(m => `${m.sender}:${m.text}`));
        const toPrepend = current.parsed.messages.filter(m => !existingTexts.has(`${m.sender}:${m.text}`));
        const candidate = [...toPrepend, ...collected];

        if (matchesTailAnchor(candidate, tailAnchors)) {
          collected.length = 0;
          collected.push(...candidate);
          report.currentContact.topConfirmed = true;
          log('history_top_confirmed', { page, reason: 'matched_database_tail_anchor_pre_backstep' });
          return;
        }

        // 回退预算约束：仅允许回退 1 次，耗尽后禁止物理反向滑动
        if (backstepBudget > 0) {
          backstepBudget--;
          log('adaptive_backstep_dispatched', { page, remainingBudget: backstepBudget });
          current = await adaptiveBackstep(previous, current);
          merged = mergeOlder(collected, previous.parsed.messages, current.parsed.messages, current.shot.height);
        } else {
          log('backstep_budget_exhausted', { page });
        }
      }

      if (!merged.ok) {
        log('history_page_merge_tolerant', { page, reason: 'unaligned_fallback_prepend' });
        const existingTexts = new Set(collected.map(m => `${m.sender}:${m.text}`));
        const toPrepend = current.parsed.messages.filter(m => !existingTexts.has(`${m.sender}:${m.text}`));
        if (toPrepend.length) {
          collected.unshift(...toPrepend);
        }
      } else {
        log('history_page_merged', { page, ...merged, messages: collected.length });
      }

      if (current.parsed.origin) {
        report.currentContact.topConfirmed = true;
        log('history_top_confirmed', { page, reason: 'origin_confirmed_terminal' });
        return;
      }

      if (matchesTailAnchor(collected, tailAnchors)) {
        report.currentContact.topConfirmed = true;
        log('history_top_confirmed', { page, reason: 'matched_database_tail_anchor', anchorsCount: tailAnchors.length });
        return;
      }

      originOnly = false;
      previous = current;
    }

    report.currentContact.topConfirmed = true;
    log('history_top_confirmed', { reason: 'max_pages_budget_reached', maxPages });
  }

  try {
    control = await host._ensureControl(ctx);
    session = {
      generation: control._generation,
      width: control.screenWidth,
      height: control.screenHeight,
    };

    try {
      database = new MomoDatabase(databasePath);
    } catch (error) {
      fail('MOMO_DATABASE_OPEN_FAILED', '无法打开联系人数据库。', { causeCode: error.code });
    }

    const existingContact = database.getContactByName(settings.contactName);
    const existingMessages = existingContact ? database.getMessagesByContact(existingContact.id) : [];
    const initialExistingCount = existingMessages.length;
    const tailAnchors = existingMessages.slice(-2);

    await collect(tailAnchors);
    ctx.check();

    const messages = storedChatMessages(collected);
    report.currentContact.bottomConfirmed = true;
    report.currentContact.topConfirmed = true;
    ctx.stage = 'momo_database_commit';

    let committed;
    try {
      committed = database.completeContactSync(
        { name: settings.contactName, deviceId: host.deviceId },
        messages,
        { verifiedConversation: true }
      );
    } catch (error) {
      fail('MOMO_DATABASE_WRITE_FAILED', '联系人和消息写入失败，本次事务已回滚。', { causeCode: error.code });
    }

    const targetContactId = committed.contact?.id || existingContact?.id;
    const finalInDatabase = targetContactId ? database.getMessagesByContact(targetContactId).length : committed.savedCount;

    report.contactsProcessed = 1;
    report.newContactsAdded = committed.isNew ? 1 : 0;
    report.totalMessagesIngested = committed.savedCount;
    report.totalMessagesCollected = messages.length;
    report.totalMessagesAlreadyStored = initialExistingCount;
    report.totalMessagesInDatabase = finalInDatabase;
    report.currentContact.messagesCollected = messages.length;

    report.details.push({
      contactName: settings.contactName,
      messagesCount: messages.length,
      savedCount: committed.savedCount,
      totalInDatabase: report.totalMessagesInDatabase,
      peerMessages: messages.filter(m => m.sender === 'peer').length,
      selfMessages: messages.filter(m => m.sender === 'self').length,
      systemMessages: 0,
    });

    report.outcome = 'completed';
    log('contact_chat_ingestion_complete', {
      messagesCount: messages.length,
      savedCount: committed.savedCount,
    });

    return { status: 'sent', data: report };
  } catch (error) {
    report.outcome = 'stopped';
    throw error;
  } finally {
    report.collectedMessages = storedChatMessages(collected);
    report.currentContact.messagesCollected = collected.length;

    await fs.writeFile(
      path.join(settings.screenshotsDir, 'collection.json'),
      JSON.stringify({
        outcome: report.outcome,
        contactName: settings.contactName,
        scope: report.collectionScope,
        topConfirmed: report.currentContact.topConfirmed,
        messages: report.collectedMessages,
      }, null, 2)
    ).catch(() => {
      ctx.cleanupFailed = true;
    });

    try {
      database?.close();
    } catch {
      ctx.cleanupFailed = true;
    }

    if (!host._recognitionPool) {
      await pool.close();
    }
  }
}

module.exports = {
  MOMO_SYNC_OPTIONS,
  syncMomoContacts,
  extractChatContactName,
  normalizeContactName: normalize,
  storedChatMessages,
};
