'use strict';

const { randomInt } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { fail, keys, number, boolean } = require('../runtime');
const { screenshot } = require('../screenshot');
const { regionClickPlan, chance } = require('../touch-gestures');
const { SharedRecognitionClient } = require('../../automation/recognition-service');
const { classifyGreetingsScreen } = require('./greetings-layout');
const { recognitionData } = require('./recognition-check');

const MAX_GREETINGS_TIMEOUT_MS = 2147483647;

const MOMO_GREETINGS_OPTIONS = [
  'timeoutMs', 'signal', 'execute', 'dryRun', 'maxApproved',
  'approveProbability', 'rejectProbability', 'cycles',
  'cycleIntervalMinutes', 'cardWaitMs', 'stepTimeoutMs', 'settleMs',
  'pollMs', 'centerFraction', 'centerProbability', 'insetPx',
  'onProgress', 'exitWaitMs', 'maxDistanceKm', 'skipBack',
];

const DESCRIPTION = 'MOMO打招呼页面自动处理：识别打招呼页面，批量点击通过/拒绝以完成次数，完成后返回并双层确认主列表';

const CONSTANTS = {
  DEFAULT_MAX_APPROVED: 6,
  DEFAULT_APPROVE_PROBABILITY: 0.9,
  DEFAULT_CARD_WAIT_MS: { min: 1200, max: 2500 },
  DEFAULT_EXIT_WAIT_MS: { min: 800, max: 1800 },
  DEFAULT_SETTLE_MS: 400,
  DEFAULT_STEP_TIMEOUT_MS: 15000,
  DEFAULT_CARD_TRANSITION_TIMEOUT_MS: 8000,
  DEFAULT_POLL_MS: 300,
  DEFAULT_CENTER_FRACTION: 0.5,
  DEFAULT_INSET_PX: 1,
  INITIAL_NON_GREETING_STABLE_MS: 1500,
  INITIAL_NON_GREETING_MIN_FRAMES: 2,
  EXHAUSTED_CONFIRM_MIN_FRAMES: 2,
  PER_CARD_TIME_BUDGET_MS: 15000,
};

function range(value, fallback, field, min, max) {
  const result = value ?? fallback;
  keys(result, ['min', 'max'], field);
  return {
    min: number(result.min, field + '.min', min, max),
    max: number(result.max, field + '.max', result.min, max),
  };
}

function pick(value) {
  return randomInt(value.min, value.max + 1);
}

function notify(callback, event) {
  if (typeof callback === 'function') {
    try {
      callback(event);
    } catch {
      // 避免外部进度回调异常影响底层自动化执行
    }
  }
}

function parseSettings(options, hostDryRun) {
  const approveProb = number(options.approveProbability ?? CONSTANTS.DEFAULT_APPROVE_PROBABILITY, 'approveProbability', 0, 1, false);
  const rejectProb = number(options.rejectProbability ?? (1 - approveProb), 'rejectProbability', 0, 1, false);
  if (Math.abs(approveProb + rejectProb - 1) > 1e-9) {
    fail('INVALID_ARGUMENT', 'approveProbability and rejectProbability must sum to 1');
  }

  const requestedCenterFraction = number(options.centerFraction ?? CONSTANTS.DEFAULT_CENTER_FRACTION, 'centerFraction', 0.01, 0.99, false);
  // 操作按钮禁止点击外围区；强制将采样限制在中心 50% 核心区内
  const centerFraction = Math.min(requestedCenterFraction, CONSTANTS.DEFAULT_CENTER_FRACTION);

  const maxDistanceKm = options.maxDistanceKm !== undefined && options.maxDistanceKm !== null
    ? number(options.maxDistanceKm, 'maxDistanceKm', 0.01, 10000, false)
    : null;

  return {
    execute: boolean(options.execute ?? false, 'execute'),
    dryRun: boolean(options.dryRun ?? hostDryRun, 'dryRun'),
    maxApproved: number(options.maxApproved ?? CONSTANTS.DEFAULT_MAX_APPROVED, 'maxApproved', 1, 50),
    maxDistanceKm,
    approveProbability: approveProb,
    rejectProbability: rejectProb,
    cycles: number(options.cycles ?? 1, 'cycles', 1, 100),
    cycleIntervalMinutes: range(options.cycleIntervalMinutes, { min: 7, max: 20 }, 'cycleIntervalMinutes', 1, 1440),
    cardWaitMs: range(options.cardWaitMs, CONSTANTS.DEFAULT_CARD_WAIT_MS, 'cardWaitMs', 100, 10000),
    exitWaitMs: range(options.exitWaitMs, CONSTANTS.DEFAULT_EXIT_WAIT_MS, 'exitWaitMs', 0, 10000),
    settleMs: number(options.settleMs ?? CONSTANTS.DEFAULT_SETTLE_MS, 'settleMs', 50, 5000),
    stepTimeoutMs: number(options.stepTimeoutMs ?? CONSTANTS.DEFAULT_STEP_TIMEOUT_MS, 'stepTimeoutMs', 1000, 60000),
    pollMs: number(options.pollMs ?? CONSTANTS.DEFAULT_POLL_MS, 'pollMs', 100, 2000),
    centerFraction,
    centerProbability: 1,
    insetPx: number(options.insetPx ?? CONSTANTS.DEFAULT_INSET_PX, 'insetPx', 0, 100),
    skipBack: boolean(options.skipBack ?? false, 'skipBack'),
  };
}

function greetingsTimeoutMs(options = {}) {
  const settings = parseSettings(options, false);
  const cycleBudget = Math.max(30000, settings.maxApproved * CONSTANTS.PER_CARD_TIME_BUDGET_MS) +
    settings.stepTimeoutMs * 2 + settings.settleMs * 3 + 10000;
  return number(Math.max(300000, settings.cycles * cycleBudget +
    (settings.cycles - 1) * settings.cycleIntervalMinutes.max * 60000),
  'calculated greetings timeoutMs', 1, MAX_GREETINGS_TIMEOUT_MS);
}

async function processMomoGreetings(host, options, ctx) {
  const settings = parseSettings(options, host.dryRun);

  if (!settings.execute || settings.dryRun) {
    return {
      status: 'planned',
      data: {
        app: 'momo',
        action: 'greetings',
        description: DESCRIPTION,
        execute: false,
        settings,
        steps: [
          'verify_greetings_page',
          'process_cards_with_distance_and_prob',
          'stop_when_target_reached_or_exhausted_or_limited',
          'exit_and_verify_message_list',
        ],
        note: 'Preview only; no real phone touch or model inference executed.',
      },
    };
  }

  host._requireToken();

  const report = {
    app: 'momo',
    action: 'greetings',
    description: DESCRIPTION,
    settings,
    outcome: 'not_started',
    requestedCycles: settings.cycles,
    completedCycles: 0,
    totalApproved: 0,
    approvedCount: 0,
    totalRejected: 0,
    rejectedCount: 0,
    rateLimited: false,
    exitVerified: false,
    cycles: [],
    screenshots: 0,
    lastScreenshot: null,
    lastObservation: null,
    history: [],
  };
  ctx.data = report;

  const record = (stage, extra = {}) => {
    report.history.push({ stage, elapsedMs: Math.round(performance.now() - ctx.started), ...extra });
    if (report.history.length > 500) report.history.shift();
  };

  const pool = host._recognitionPool ?? new SharedRecognitionClient();
  const ownsClient = !host._recognitionPool;
  let control, session;

  function checkControl() {
    ctx.check();
    if (!control?.connected || !control.ready) fail('CONNECTION_LOST', 'Control is no longer ready');
    if (control._generation !== session.generation) fail('CONNECTION_CHANGED', 'Control session changed');
    if (control.screenWidth !== session.width || control.screenHeight !== session.height) {
      fail('SCREEN_CHANGED', 'Control screen dimensions changed during greeting processing');
    }
  }

  async function observe() {
    checkControl();
    ctx.stage = 'momo_greetings_screenshot';
    // 强制获取最新新鲜帧（maxAgeMs=0），防止复用已过期的动作前截图
    const shot = await screenshot(host.device, { source: 'stream', maxSize: 1280, maxAgeMs: 0, attempts: 1 }, ctx);
    report.lastScreenshot = shot;
    report.screenshots++;

    ctx.stage = 'momo_greetings_recognition';
    const request = { signal: ctx.signal, timeoutMs: Math.min(30000, ctx.remaining()) };
    const [pageRes, ocrRes] = await ctx.wait(Promise.all([
      pool.page(shot.image, request),
      pool.ocr(shot.image, request),
    ]));

    ctx.check();
    checkControl();

    const page = recognitionData(pageRes, 'page', shot);
    const ocr = recognitionData(ocrRes, 'ocr', shot);
    const classification = classifyGreetingsScreen(ocr, page);
    report.lastObservation = {
      state: classification.state,
      rateLimited: classification.hasRateLimitToast,
      unreadCount: classification.unreadCount,
      page,
      timings: { page: pageRes.timings, ocr: ocrRes.timings },
    };

    return { shot, classification, page, ocr };
  }

  async function clickBox(box, label) {
    checkControl();
    ctx.stage = 'dispatch';
    record('click_dispatched', { label, box });
    const coordinateSpace = report.lastScreenshot ? { width: report.lastScreenshot.width, height: report.lastScreenshot.height } : undefined;
    return await host._executeGesture(
      control,
      screen => regionClickPlan(box, {
        coordinateSpace,
        centerFraction: settings.centerFraction,
        centerProbability: settings.centerProbability,
        insetPx: settings.insetPx,
      }, screen),
      ctx,
      'click'
    );
  }

  /**
   * 阶段 1：入口状态核验 (Entry State Verification)
   */
  async function verifyEntryState(deadline) {
    const started = performance.now();
    const expires = Math.min(started + settings.stepTimeoutMs, deadline ?? Infinity);
    let nonGreetingsCount = 0;
    let lastObs = null;

    record('entry_verification_started', { timeoutMs: Math.round(expires - started) });

    while (performance.now() < expires) {
      ctx.check();
      lastObs = await observe();
      const cls = lastObs.classification;
      const now = performance.now();

      // 1. 频控
      if (cls.hasRateLimitToast || cls.state === 'rate_limited') {
        record('entry_rate_limited', { toast: cls.rateLimitText });
        return { status: 'rate_limited', obs: lastObs };
      }

      // 2. 有卡片弹窗就绪
      if (cls.state === 'card' && cls.hasCardButtons && cls.approveBox && cls.rejectBox) {
        record('entry_card_ready');
        return { status: 'card', obs: lastObs };
      }

      // 3. 空态或触底列表（无需处理直接完成）
      if (cls.state === 'empty_or_list' && !cls.hasLoadingIndicator) {
        record('entry_already_empty_or_list');
        return { status: 'empty_or_list', obs: lastObs };
      }

      // 4. 加载中状态，稍作等待
      if (cls.hasLoadingIndicator || cls.state === 'loading') {
        record('entry_page_loading');
        await ctx.sleep(settings.pollMs);
        continue;
      }

      // 5. 校验是否完全脱离打招呼上下文（非打招呼页连续出现）
      if (!cls.isGreetingsPage) {
        nonGreetingsCount++;
        if (nonGreetingsCount >= CONSTANTS.INITIAL_NON_GREETING_MIN_FRAMES &&
            (now - started >= CONSTANTS.INITIAL_NON_GREETING_STABLE_MS)) {
          record('entry_not_on_greetings_page', { state: cls.state });
          fail('MOMO_NOT_ON_GREETINGS_PAGE', `当前页面不是打招呼页面 (当前检测状态: ${cls.state})`,
            { state: cls.state });
        }
      } else {
        nonGreetingsCount = 0;
      }

      await ctx.sleep(settings.pollMs);
    }

    // 超时兜底：若最后页面处于无新招呼卡片状态
    if (lastObs?.classification?.state === 'empty_or_list' || (lastObs?.classification?.isGreetingsPage && !lastObs?.classification?.hasCardButtons)) {
      return { status: 'empty_or_list', obs: lastObs };
    }

    fail('MOMO_GREETINGS_PAGE_NOT_READY', 'Greeting page did not finish loading or its controls could not be confirmed',
      { state: lastObs?.classification?.state ?? 'unobserved', timeoutMs: settings.stepTimeoutMs });
  }

  /**
   * 阶段 2：卡片动作下发后等待下一状态 (Post-Mutation State Transition Waiter)
   * 核心状态转移契约：
   * - 转移至新卡片 (card): 继续处理
   * - 转移至卡片耗尽/列表态 (empty_or_list / exhausted): 明确触底，立即以 all_processed 终态返回，决不拖延超时！
   * - 转移至频控 (rate_limited): 熔断终止
   * - 转移至页面脱离 (message_list / other_subpage): 退出循环
   */
  async function waitNextCardOrTerminal(deadline) {
    const started = performance.now();
    const transitionTimeout = Math.min(CONSTANTS.DEFAULT_CARD_TRANSITION_TIMEOUT_MS, Math.max(1000, deadline - started));
    const expires = started + transitionTimeout;

    let emptyFrameCount = 0;
    let lastObs = null;

    record('wait_next_card_started', { timeoutMs: transitionTimeout });

    while (performance.now() < expires) {
      ctx.check();
      lastObs = await observe();
      const cls = lastObs.classification;

      // 1. 频控提示判定
      if (cls.hasRateLimitToast || cls.state === 'rate_limited') {
        record('post_mutation_rate_limited', { toast: cls.rateLimitText });
        return { status: 'rate_limited', obs: lastObs };
      }

      // 2. 新卡片已就绪（具有完整通过与拒绝操作按钮）
      if (cls.state === 'card' && cls.hasCardButtons && cls.approveBox && cls.rejectBox) {
        record('post_mutation_new_card_ready');
        return { status: 'card', obs: lastObs };
      }

      // 3. 卡片已耗尽 (Exhausted / Empty List)
      // 特征：处于打招呼子页面且无卡片操作按钮，且无加载中提示
      const isExhausted = (cls.state === 'empty_or_list' || cls.isGreetingsExhausted || (!cls.hasCardButtons && cls.hasGreetingsSubpageHeader)) && !cls.hasLoadingIndicator;
      if (isExhausted) {
        emptyFrameCount++;
        // 连续 2 帧确认卡片已消失并进入列表/空态，立即判定为全部卡片消费完毕！
        if (emptyFrameCount >= CONSTANTS.EXHAUSTED_CONFIRM_MIN_FRAMES) {
          record('post_mutation_cards_exhausted_confirmed');
          return { status: 'all_processed', obs: lastObs };
        }
      } else {
        emptyFrameCount = 0;
      }

      // 4. 页面跳出至主消息列表或其他页面
      if (cls.state === 'message_list' || cls.state === 'other_subpage') {
        record('post_mutation_navigated_away', { state: cls.state });
        return { status: 'navigated_away', obs: lastObs };
      }

      await ctx.sleep(settings.pollMs);
    }

    // 过渡超时处理：若当前无卡片按钮且不在加载中，按卡片已耗尽成功处理，绝不报失败
    if (lastObs && !lastObs.classification.hasCardButtons && !lastObs.classification.hasLoadingIndicator) {
      record('post_mutation_timeout_as_exhausted');
      return { status: 'all_processed', obs: lastObs };
    }

    record('post_mutation_timeout_unresolved', { state: lastObs?.classification?.state });
    return { status: 'timeout', obs: lastObs };
  }

  /**
   * 阶段 3：双层退出与目标主页确认 (Dual-Layer Exit & Target Verification)
   * 确保执行返回后，界面物理落定在 1级消息列表，绝不带着未知中间态退出
   */
  async function exitAndVerify(maxAttempts = 3) {
    if (settings.skipBack) {
      record('exit_skipped_by_settings');
      report.exitVerified = true;
      return true;
    }

    record('exit_and_verify_started');
    notify(options.onProgress, { type: 'send_back' });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      ctx.check();
      const obs = await observe();
      const cls = obs.classification;

      // 1. 若当前已经回到了 1级消息列表主页，后验达成！
      if (cls.state === 'message_list' || cls.isMessageList) {
        record('exit_verified_on_message_list', { attempt });
        report.exitVerified = true;
        return true;
      }

      // 2. 若仍在打招呼子页面或卡片弹窗，派发返回操作
      record('exit_attempt_dispatched', { attempt, currentState: cls.state });
      if (attempt === 1 && cls.backButtonBox) {
        // 首选：点击视觉识别到的左上角 [<] 返回键
        await clickBox(cls.backButtonBox, 'back_arrow_button');
      } else if (attempt === 2) {
        // 次选：派发系统 BACK 按键
        await host._sendBack(control, ctx);
      } else {
        // 兜底：边缘向右滑动触发手势返回
        const w = cls.width || 720;
        const h = cls.height || 1280;
        await host._executeGesture(
          control,
          () => ({
            type: 'swipe',
            startX: Math.round(w * 0.02),
            startY: Math.round(h * 0.5),
            endX: Math.round(w * 0.45),
            endY: Math.round(h * 0.5),
            durationMs: 300,
          }),
          ctx,
          'gesture_back'
        );
      }

      // 等待页面过渡动画沉降
      await ctx.sleep(Math.max(600, settings.settleMs));
    }

    // 最后再核验一次
    const finalObs = await observe();
    if (finalObs.classification.state === 'message_list' || finalObs.classification.isMessageList) {
      record('exit_verified_final');
      report.exitVerified = true;
      return true;
    }

    record('exit_unconfirmed_warning', { finalState: finalObs.classification.state });
    report.exitVerified = false;
    return false;
  }

  try {
    control = await host._ensureControl(ctx);
    session = { generation: control._generation, width: control.screenWidth, height: control.screenHeight };
    report.outcome = 'running';

    for (let c = 0; c < settings.cycles; c++) {
      ctx.check();
      const cycleNumber = c + 1;
      const cycle = {
        cycle: cycleNumber,
        approved: 0,
        rejected: 0,
        decisions: [],
        outcome: 'in_progress',
        waitedNextCycleMs: 0,
      };
      report.cycles.push(cycle);
      record('cycle_started', { cycle: cycleNumber });

      // 1. 入口状态核验
      ctx.stage = 'momo_greetings_entry_verify';
      const entryResult = await verifyEntryState();
      notify(options.onProgress, { type: 'page_verified', state: entryResult.obs.classification.state });

      if (entryResult.status === 'rate_limited') {
        record('rate_limit_triggered_on_entry', { toast: entryResult.obs.classification.rateLimitText });
        report.rateLimited = true;
        cycle.outcome = 'rate_limited';
        notify(options.onProgress, { type: 'rate_limited', toast: entryResult.obs.classification.rateLimitText });
      } else if (entryResult.status === 'empty_or_list') {
        record('cards_already_empty_on_entry');
        cycle.outcome = 'all_processed';
        notify(options.onProgress, { type: 'empty' });
      } else {
        // 2. 卡片处理有限状态机循环
        let currentCardObs = entryResult.obs;
        const cycleDeadline = performance.now() + Math.max(30000, settings.maxApproved * CONSTANTS.PER_CARD_TIME_BUDGET_MS);

        while (performance.now() < cycleDeadline && cycle.approved < settings.maxApproved) {
          ctx.check();

          // 若当前没有就绪卡片帧，等待下一卡片或终态
          if (!currentCardObs) {
            ctx.stage = 'momo_greetings_wait_next_card';
            const transition = await waitNextCardOrTerminal(cycleDeadline);

            if (transition.status === 'rate_limited') {
              record('rate_limit_triggered', { toast: transition.obs.classification.rateLimitText });
              report.rateLimited = true;
              cycle.outcome = 'rate_limited';
              notify(options.onProgress, { type: 'rate_limited', toast: transition.obs.classification.rateLimitText });
              break;
            }

            if (transition.status === 'all_processed') {
              record('all_cards_processed_clean');
              cycle.outcome = 'all_processed';
              notify(options.onProgress, { type: 'all_processed' });
              break;
            }

            if (transition.status === 'navigated_away') {
              record('navigated_away_from_greetings');
              cycle.outcome = 'navigated_away';
              break;
            }

            if (transition.status === 'timeout') {
              record('card_transition_timeout');
              cycle.outcome = 'timeout';
              break;
            }

            currentCardObs = transition.obs;
          }

          const cls = currentCardObs.classification;

          // 双层确认：确认卡片按钮真实有效
          if (cls.state !== 'card' || !cls.hasCardButtons || !cls.approveBox || !cls.rejectBox) {
            record('card_buttons_invalid_dropping_frame', { state: cls.state });
            currentCardObs = null;
            continue;
          }

          // 距离过滤判定
          const cardDistanceKm = cls.distanceKm;
          const cardDistanceText = cls.distanceText;
          let isApprove = true;
          let rejectReason = null;

          if (settings.maxDistanceKm !== null && cardDistanceKm !== null && cardDistanceKm > settings.maxDistanceKm) {
            isApprove = false;
            rejectReason = 'distance_exceeded';
          } else {
            isApprove = chance(settings.approveProbability);
            if (!isApprove) {
              rejectReason = 'prob_sampling';
            }
          }

          const decision = isApprove ? 'approve' : 'reject';
          const targetBox = isApprove ? cls.approveBox : cls.rejectBox;

          // 拟人阅读卡片等待
          const waitTime = pick(settings.cardWaitMs);
          record('reading_card', { waitMs: waitTime, decision, rejectReason, distanceKm: cardDistanceKm, approvedSoFar: cycle.approved });
          await ctx.sleep(waitTime);

          // TOCTOU 校验：如果阅读耗时较长，重新校验当前状态（避免弹窗被自动关闭或网络闪退）
          if (waitTime > 1500) {
            checkControl();
          }

          // 动作派发
          await clickBox(targetBox, decision === 'approve' ? 'button_approve' : 'button_reject');

          // 更新状态与统计
          if (isApprove) {
            cycle.approved++;
            report.totalApproved++;
            report.approvedCount = report.totalApproved;
          } else {
            cycle.rejected++;
            report.totalRejected++;
            report.rejectedCount = report.totalRejected;
          }

          cycle.decisions.push({
            decision,
            rejectReason,
            distanceKm: cardDistanceKm,
            box: targetBox,
            timestamp: new Date().toISOString(),
          });

          record('card_decision_executed', {
            decision,
            rejectReason,
            distanceKm: cardDistanceKm,
            cycleApproved: cycle.approved,
            totalApproved: report.totalApproved,
          });

          notify(options.onProgress, {
            type: 'card_decision',
            decision,
            rejectReason,
            distanceKm: cardDistanceKm,
            distanceText: cardDistanceText,
            maxDistanceKm: settings.maxDistanceKm,
            approved: cycle.approved,
            rejected: cycle.rejected,
            totalApproved: report.totalApproved,
            totalRejected: report.totalRejected,
            targetApproved: settings.maxApproved,
          });

          // 达到目标通过人数
          if (cycle.approved >= settings.maxApproved) {
            record('target_max_approved_reached', { maxApproved: settings.maxApproved });
            cycle.outcome = 'max_approved_reached';
            notify(options.onProgress, { type: 'target_reached', maxApproved: settings.maxApproved });
            break;
          }

          // 动作后旧证据作废，强制在下一次循环中获取新鲜状态
          currentCardObs = null;
          await ctx.sleep(settings.settleMs);
        }
      }

      if (cycle.outcome === 'in_progress') {
        cycle.outcome = cycle.approved >= settings.maxApproved ? 'max_approved_reached' : 'all_processed';
      }

      // 拟人沉降等待
      if (cycle.approved > 0 || cycle.rejected > 0) {
        const exitDelay = pick(settings.exitWaitMs);
        record('exit_settle_wait', { waitMs: exitDelay });
        await ctx.sleep(exitDelay);
      }

      // 3. 双层退出与主页确认
      ctx.stage = 'momo_greetings_exit_verify';
      await exitAndVerify();

      if (c < settings.cycles - 1) {
        await ctx.sleep(settings.settleMs);
      }

      report.completedCycles++;
      record('cycle_finished', { cycle: cycleNumber, outcome: cycle.outcome });

      // 如果限频则阻断后续轮次
      if (report.rateLimited) break;

      // 多轮次等待
      if (c < settings.cycles - 1 && !report.rateLimited) {
        const intervalMins = pick(settings.cycleIntervalMinutes);
        const waitMs = intervalMins * 60 * 1000;
        cycle.waitedNextCycleMs = waitMs;
        record('cycle_wait_next', { waitMinutes: intervalMins, waitMs });
        await ctx.sleep(waitMs);
      }
    }

    report.outcome = report.rateLimited ? 'rate_limited' : 'completed';
    return { status: 'sent', data: report };
  } catch (error) {
    report.outcome = 'stopped';
    throw error;
  } finally {
    ctx.data = report;
    if (ownsClient) {
      try { await pool.close(); } catch { ctx.cleanupFailed = true; }
    }
  }
}

module.exports = {
  MOMO_GREETINGS_OPTIONS,
  MAX_GREETINGS_TIMEOUT_MS,
  greetingsTimeoutMs,
  processMomoGreetings,
};
