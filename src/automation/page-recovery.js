'use strict';

/**
 * 统一页面恢复导航器 (Unified Page Recovery & Back Stepper)
 *
 * 遵循中枢执行计划第 1、5、6 节与 B2 门禁：
 * 1. 核心运行逻辑：当前页面若不在任务预设范围，按一次返回键，再重新截图判断；必要时重复，有严格上限。
 * 2. 严禁盲目回桌面重开：只有真实到达 Android 桌面时才允许受控启动一次 MOMO，不循环“桌面->启动->返回”。
 * 3. 严格预算控制：
 *    - maxBackSteps: 默认最多 8 次返回；
 *    - maxNoProgressBacks: 连续 3 次按返回无任何页面进展立即停止；
 *    - recoveryTimeoutMs: 阶段总超时 30000ms；
 *    - maxOpenMomoAttempts: 桌面启动最多 1 次。
 * 4. 安全防护拦截 (Guard)：遇到登录失效、滑块验证码、风控提示或未保存草稿时立即停止，绝不强行确认或丢失现场。
 */

const { performance } = require('node:perf_hooks');
const { observePage } = require('./page-service');
const { observedPoint } = require('./coordinates');

const DEFAULT_RECOVERY_OPTIONS = {
  maxBackSteps: 8,
  maxNoProgressBacks: 3,
  recoveryTimeoutMs: 30000,
  maxOpenMomoAttempts: 1,
  settleMs: 400,
  allowOpenMomo: true
};

function cancellableSleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    const err = new Error('Recovery sleep cancelled');
    err.code = 'CANCELLED';
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      const err = new Error('Recovery sleep cancelled');
      err.code = 'CANCELLED';
      reject(err);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

async function recoverToAllowedPage(session, allowedPages = ['message_list'], options = {}) {
  const { checkSignal, waitFor } = require('./cancellation');
  const check = () => { checkSignal(options.signal); session.assertActive?.(); };
  const settings = { ...DEFAULT_RECOVERY_OPTIONS, ...options };
  const observer = settings.observePage ?? observePage;
  const startTime = performance.now();
  const deadline = startTime + settings.recoveryTimeoutMs;

  let backSteps = 0;
  let noProgressCount = 0;
  let openMomoAttempts = 0;
  let lastPageSignature = '';
  let tabNavigationAttempts = 0;
  const history = [];

  while (backSteps <= settings.maxBackSteps && performance.now() < deadline) {
    if (options.signal?.aborted) {
      return {
        status: 'cancelled',
        observation: null,
        backSteps,
        history,
        error: { code: 'CANCELLED', message: 'Recovery was cancelled' }
      };
    }

    // 1. 获取当前页面新鲜观测
    const observation = await observer(session, {
      signal: options.signal,
      timeoutMs: Math.min(10000, Math.max(1000, deadline - performance.now()))
    });

    if (!observation.ok) {
      return {
        status: 'dependency_failed',
        observation,
        backSteps,
        history,
        error: observation.error || { code: 'OBSERVATION_FAILED', message: 'Failed to observe current page' }
      };
    }

    const currentSignature = `${observation.app}:${observation.page}:${observation.scene}:${observation.overlay}`;
    history.push({
      step: backSteps,
      signature: currentSignature,
      page: observation.page,
      overlay: observation.overlay,
      elapsedMs: Math.round(performance.now() - startTime)
    });

    // 2. 检查阻断性弹窗与安全守卫 (Guard Blocks)
    if (['login', 'captcha', 'risk', 'permission', 'exit_confirm', 'assistant_unconfirmed'].includes(observation.overlay)) {
      return {
        status: 'blocked_by_guard',
        observation,
        backSteps,
        history,
        guardType: observation.overlay,
        error: {
          code: `GUARD_${observation.overlay.toUpperCase()}`,
          message: `Encountered critical guard overlay: ${observation.overlay}`
        }
      };
    }

    // 3. 仅处理已由面板 + 关闭 X 双重确认的可安全关闭悬浮窗
    if (observation.overlay === 'safe_dismissible' && observation.targets?.assistantCloseX) {
      const [x1, y1, x2, y2] = observation.targets.assistantCloseX;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      if (session.control?.tap) {
        check();
        const point = observedPoint(session.control, observation, { x: cx, y: cy });
        await waitFor(session.control.tap(point.x, point.y, { signal: options.signal }), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
        if (session.control.flush) await waitFor(session.control.flush(), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
        try {
          await cancellableSleep(settings.settleMs, options.signal);
        } catch (err) {
          return { status: 'cancelled', observation: null, backSteps, history, error: { code: 'CANCELLED', message: 'Recovery was cancelled' } };
        }
        continue;
      }
    }

    // 3.1 处理可安全关闭的应用版本升级弹窗 (App Update Dialog)
    if (observation.overlay === 'app_update' && observation.targets?.updateCloseX) {
      const [x1, y1, x2, y2] = observation.targets.updateCloseX;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      if (session.control?.tap) {
        check();
        const point = observedPoint(session.control, observation, { x: cx, y: cy });
        await waitFor(session.control.tap(point.x, point.y, { signal: options.signal }), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
        if (session.control.flush) await waitFor(session.control.flush(), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
        try {
          await cancellableSleep(settings.settleMs * 2, options.signal);
        } catch (err) {
          return { status: 'cancelled', observation: null, backSteps, history, error: { code: 'CANCELLED', message: 'Recovery was cancelled' } };
        }
        continue;
      }
    }

    // 3.2 处理语音聊天红包提现推广弹窗 (Red Packet Promo Dialog)
    if (observation.overlay === 'red_packet_promo' && observation.targets?.redPacketCloseX) {
      const [x1, y1, x2, y2] = observation.targets.redPacketCloseX;
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      if (session.control?.tap) {
        check();
        const point = observedPoint(session.control, observation, { x: cx, y: cy });
        await waitFor(session.control.tap(point.x, point.y, { signal: options.signal }), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
        if (session.control.flush) await waitFor(session.control.flush(), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
        try {
          await cancellableSleep(settings.settleMs * 2, options.signal);
        } catch (err) {
          return { status: 'cancelled', observation: null, backSteps, history, error: { code: 'CANCELLED', message: 'Recovery was cancelled' } };
        }
        continue;
      }
    }

    // 3.3 处理顶层语音/视频来电悬浮窗 (Incoming Call Overlay) - 拒接挂断消除全场景遮挡
    if (observation.overlay === 'incoming_call' && observation.targets?.incomingCallRejectPoint) {
      const point = observedPoint(session.control, observation, observation.targets.incomingCallRejectPoint);
      if (session.control?.tap) {
        check();
        await waitFor(session.control.tap(point.x, point.y, { signal: options.signal }), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
        if (session.control.flush) await waitFor(session.control.flush(), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
        try {
          await cancellableSleep(settings.settleMs * 2, options.signal);
        } catch (err) {
          return { status: 'cancelled', observation: null, backSteps, history, error: { code: 'CANCELLED', message: 'Recovery was cancelled' } };
        }
        continue;
      }
    }

    // 4. 检查是否已达到任务允许的页面白名单
    if (allowedPages.includes(observation.page) && observation.overlay === 'none') {
      return {
        status: 'reached_target',
        observation,
        backSteps,
        history,
        error: null
      };
    }

    // Known home page: navigate by a unique observed bottom Messages tab, never a fallback coordinate.
    if (allowedPages.includes('message_list') && observation.page === 'home_feed' && observation.overlay === 'none') {
      const matches = (observation.evidence.ocrData?.items || []).filter(item => item.text?.trim() === '消息' &&
        item.top > observation.height * .80 && item.bottom < observation.height &&
        item.left > observation.width * .20 && item.right < observation.width * .80);
      if (matches.length !== 1 || !session.control?.tap || tabNavigationAttempts >= 2) {
        return { status: 'no_progress', observation, backSteps, history,
          error: { code: 'MESSAGE_TAB_UNCONFIRMED', message: 'Cannot safely navigate from home to the message list' } };
      }
      const item = matches[0], point = observedPoint(session.control, observation,
        { x: (item.left + item.right) / 2, y: (item.top + item.bottom) / 2 });
      check(); tabNavigationAttempts++;
      await waitFor(session.control.tap(point.x, point.y, { signal: options.signal }), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
      if (session.control.flush) await waitFor(session.control.flush(), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
      await cancellableSleep(settings.settleMs, options.signal);
      continue;
    }

    // 5. 检查是否退到了 Android 桌面 (Launcher)
    if (observation.app === 'android_launcher') {
      // 达到桌面时绝对停止继续按返回键！
      if (settings.allowOpenMomo && openMomoAttempts < settings.maxOpenMomoAttempts) {
        openMomoAttempts++;
        if (session.tools?.openMomo) {
          try {
            check();
            const opened = await session.tools.openMomo({ timeoutMs: Math.max(1, Math.min(15000, deadline - performance.now())), signal: options.signal });
            if (opened?.ok !== true) return { status: 'dependency_failed', observation, backSteps, history, error: opened?.error || { code: 'OPEN_MOMO_FAILED' } };
            try {
              await cancellableSleep(settings.settleMs * 2, options.signal);
            } catch (err) {
              return { status: 'cancelled', observation: null, backSteps, history, error: { code: 'CANCELLED', message: 'Recovery was cancelled' } };
            }
            continue;
          } catch (err) {
            return {
              status: 'launcher_reached',
              observation,
              backSteps,
              history,
              error: { code: 'OPEN_MOMO_FAILED', message: err.message }
            };
          }
        }
      }
      return {
        status: 'launcher_reached',
        observation,
        backSteps,
        history,
        error: null
      };
    }

    // 6. 无进展检查 (No-Progress Detection)
    if (currentSignature === lastPageSignature) {
      noProgressCount++;
      if (noProgressCount >= settings.maxNoProgressBacks) {
        return {
          status: 'no_progress',
          observation,
          backSteps,
          history,
          error: {
            code: 'RECOVERY_NO_PROGRESS',
            message: `No page progress observed after ${settings.maxNoProgressBacks} consecutive Back presses on [${currentSignature}]`
          }
        };
      }
    } else {
      noProgressCount = 0;
      lastPageSignature = currentSignature;
    }

    // 7. 检查动作配额与发送一次返回键 (Single Back Step)
    if (backSteps >= settings.maxBackSteps) {
      return {
        status: 'budget_exhausted',
        observation,
        backSteps,
        history,
        error: {
          code: 'RECOVERY_BUDGET_EXHAUSTED',
          message: `Recovery budget exhausted (backSteps=${backSteps}, max=${settings.maxBackSteps})`
        }
      };
    }

    if (session.control?.back) {
      check();
      await waitFor(session.control.back(), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
      if (session.control.flush) await waitFor(session.control.flush(), { signal: options.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
    } else {
      return {
        status: 'dependency_failed',
        observation,
        backSteps,
        history,
        error: { code: 'NO_BACK_PROVIDER', message: 'No back key dispatch provider available' }
      };
    }

    backSteps++;
    try {
      await cancellableSleep(settings.settleMs, options.signal);
    } catch (err) {
      return {
        status: 'cancelled',
        observation: null,
        backSteps,
        history,
        error: { code: 'CANCELLED', message: 'Recovery was cancelled during settle' }
      };
    }
  }

  return {
    status: 'budget_exhausted',
    observation: null,
    backSteps,
    history,
    error: {
      code: 'RECOVERY_BUDGET_EXHAUSTED',
      message: `Recovery budget exhausted (backSteps=${backSteps}, timeout=${settings.recoveryTimeoutMs}ms)`
    }
  };
}

module.exports = {
  DEFAULT_RECOVERY_OPTIONS,
  recoverToAllowedPage: require('./timing').timed('page.recover', recoverToAllowedPage, session => ({ deviceId: session?.deviceId }))
};
