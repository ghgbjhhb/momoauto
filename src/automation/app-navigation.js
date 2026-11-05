'use strict';

// Entry-page recovery only: never replays a business action or sends HOME.
const {
  sleep, normalizeText, homeAnchorMatches, screenshotAndOcr, observeUntil, findApp, tapBox,
} = require('./screen');

function navigationError(code, message, observation, report) {
  const detail = observation?.text?.slice(0, 700) || '无 OCR 结果';
  return Object.assign(new Error(`[${code}] ${message}；最后页面：${detail}`), {
    code, stage: 'app_entry_recovery',
    details: { app: report?.app, backSteps: report?.backSteps ?? 0, imagePath: observation?.imagePath },
  });
}

function recoverySettings(options) {
  const integer = (value, fallback, name, minimum, maximum) => {
    const parsed = Number(value ?? fallback);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw navigationError('APP_RECOVERY_INVALID_CONFIG', `${name} 必须为 ${minimum}～${maximum} 的整数`);
    }
    return parsed;
  };
  return {
    maxBacks: integer(options.appRecoveryMaxBacks ?? process.env.YUNMOMO_APP_RECOVERY_MAX_BACKS, 8, 'maxBacks', 0, 20),
    timeoutMs: integer(options.appRecoveryTimeoutMs ?? process.env.YUNMOMO_APP_RECOVERY_TIMEOUT_MS, 30000, 'timeoutMs', 1000, 120000),
    settleMs: integer(options.appBackSettleMs ?? process.env.YUNMOMO_APP_BACK_SETTLE_MS ?? process.env.YUNMOMO_APP_CHILD_SETTLE_MS, 600, 'settleMs', 100, 5000),
  };
}

function pageFingerprint(observation) {
  return (observation?.items ?? [])
    .filter(item => item.centerY > observation.height * 0.07 && item.centerY < observation.height * 0.94)
    .map(item => `${normalizeText(item.text)}:${Math.round(item.centerX / 8)}:${Math.round(item.centerY / 8)}`)
    .sort().join('|');
}

function launcherMatches(observation, launcher) {
  if (homeAnchorMatches(observation.items).length >= 2) return true;
  if (!launcher?.width || !launcher.height || !observation.width || !observation.height) return false;
  const matched = new Set();
  for (const item of launcher.items) {
    const text = normalizeText(item.text);
    if (text.length < 2 || item.centerY < launcher.height * 0.10 || item.centerY > launcher.height * 0.90) continue;
    if (observation.items.some(other => normalizeText(other.text) === text &&
        Math.abs(other.centerX / observation.width - item.centerX / launcher.width) < 0.035 &&
        Math.abs(other.centerY / observation.height - item.centerY / launcher.height) < 0.035)) matched.add(text);
  }
  return matched.size >= 3;
}

async function recoverAppPage(phone, control, worker, directory, state, initial, options, config) {
  const settings = recoverySettings(options);
  const budget = config.budget ?? { used: 0 };
  const report = { app: config.appName, target: config.targetName ?? config.appName, backSteps: 0, outcome: 'checking' };
  (state.appNavigationRecoveries ??= []).push(report);
  let current = initial;
  let unchanged = 0;
  const isLauncher = observation => Boolean(config.isLauncher?.(observation)) || launcherMatches(observation, config.launcherObservation);
  const stop = (code, message) => {
    report.outcome = code;
    throw navigationError(code, `${config.appName}：${message}`, current, report);
  };
  while (true) {
    if (!current) {
      state.counter += 1;
      current = await screenshotAndOcr(phone, worker, directory, state.counter);
    }
    if (config.prepare) current = await config.prepare(current);
    if (!current) stop('APP_RECOVERY_NO_OBSERVATION', '页面处理后没有可用截图');
    const blocked = config.blockedReason?.(current);
    if (blocked) stop('APP_RECOVERY_BUSY', blocked);
    if (config.isTarget(current)) {
      report.outcome = 'target';
      return { observation: current, reachedTarget: true, report };
    }
    if (isLauncher(current)) {
      report.outcome = 'launcher';
      return { observation: current, reachedTarget: false, report };
    }
    if (unchanged >= 2 && config.allowHomeOnStuck !== false) {
      // 弹窗死锁解救（Modal Trap Escape）：
      // 当应用非取消型弹窗（如用户隐私协议、强更提示、死锁页面）拦截 BACK 物理按键时，
      // 派发系统级 HOME 键打破死锁，安全回退至桌面重新寻找入口。
      try {
        console.log(`[恢复] 检测到连续 2 次返回键未产生页面变化，可能遭遇非取消型弹窗拦截，发送 HOME 键解救回桌面...`);
        const { sendHome } = require('./screen');
        await sendHome(control);
        await sleep(500);
        state.counter += 1;
        current = await screenshotAndOcr(phone, worker, directory, state.counter);
        if (isLauncher(current)) {
          report.outcome = 'launcher';
          return { observation: current, reachedTarget: false, report };
        }
      } catch (err) {
        console.warn(`[恢复] 发送 HOME 键解救失败：${err.message}`);
      }
    }
    if (unchanged >= 3) stop('APP_RECOVERY_NO_PROGRESS', '连续三次返回后页面未变化');
    budget.deadline ??= Date.now() + settings.timeoutMs;
    if (Date.now() >= budget.deadline) stop('APP_RECOVERY_TIMEOUT', '逐级返回目标界面超时');
    if (budget.used >= settings.maxBacks) stop('APP_RECOVERY_BACK_LIMIT', `已达到 ${settings.maxBacks} 次返回上限，仍未到达目标界面`);
    const before = pageFingerprint(current);
    try {
      await control.back();
      await control.flush();
    } catch (error) {
      report.outcome = 'APP_RECOVERY_BACK_FAILED';
      const failure = navigationError('APP_RECOVERY_BACK_FAILED', `${config.appName}返回键发送失败：${error.message}`, current, report);
      failure.details.controlCode = error.code;
      throw Object.assign(failure, { cause: error });
    }
    budget.used += 1;
    report.backSteps += 1;
    await sleep(Math.min(settings.settleMs, Math.max(0, budget.deadline - Date.now())));
    let previous = '';
    current = await observeUntil(
      phone, worker, directory, state,
      observation => {
        if (config.isTarget(observation) || isLauncher(observation) || config.launchEvidence?.(observation) ||
            config.blockedReason?.(observation)) return true;
        const fingerprint = pageFingerprint(observation);
        const stable = fingerprint && fingerprint === previous;
        previous = fingerprint;
        return Boolean(stable);
      },
      Math.max(1, Math.min(2500, budget.deadline - Date.now())), options.pollMs,
      `${config.label ?? 'app-entry'}-back-${budget.used}`,
    );
    if (!current) stop('APP_RECOVERY_NO_OBSERVATION', '返回后没有可用截图');
    const after = pageFingerprint(current);
    unchanged = before && before === after ? unchanged + 1 : 0;
  }
}

async function openAppWithRecovery(phone, control, worker, directory, state, found, options, config) {
  recoverySettings(options); // Validate before the first tap.
  const budget = { used: 0 };
  const offsets = config.offsets ?? [{ y: -55 }, { y: 0 }, { y: -80 }];
  let located = found;
  let relaunched = false;
  for (let index = 0; index < offsets.length; index += 1) {
    const raw = tapBox(control, located.box, located.observation, offsets[index].y ?? 0);
    const point = {
      x: Math.min(control.screenWidth - 1, Math.max(0, raw.x + Math.round(control.screenWidth * (offsets[index].xRatio ?? 0)))),
      y: Math.min(control.screenHeight - 1, Math.max(0, raw.y)),
    };
    await control.tap(point.x, point.y);
    await control.flush();
    const initial = await observeUntil(
      phone, worker, directory, state,
      observation => config.isTarget(observation) || config.launchEvidence?.(observation) || config.blockedReason?.(observation),
      config.launchTimeoutMs ?? options.appTimeoutMs, options.pollMs, `${config.label ?? 'app-entry'}-open-${index + 1}`,
    );
    const recovered = await recoverAppPage(phone, control, worker, directory, state, initial, options, {
      ...config, budget, allowHomeOnStuck: true, isLauncher: observation => launcherMatches(observation, located.observation) || Boolean(config.isLauncher?.(observation)),
    });
    if (recovered.reachedTarget) return { opened: recovered.observation, point, retried: index > 0 };
    // Only a freshly confirmed launcher permits another icon click. App exits
    // allow one relaunch; missed launcher hitboxes keep their existing limit.
    if (recovered.report.backSteps > 0) {
      if (relaunched) throw navigationError('APP_RECOVERY_RELAUNCH_LIMIT', `${config.appName}返回桌面后已重新打开一次，停止循环`, recovered.observation, recovered.report);
      relaunched = true;
    }
    if (index + 1 >= offsets.length) {
      throw navigationError('APP_OPEN_FAILED', `未能进入${config.appName}目标界面`, recovered.observation, recovered.report);
    }
    located = await findApp(phone, control, worker, directory, state, recovered.observation, options, config.targetBox, config.appName);
  }
}

module.exports = { openAppWithRecovery, recoverAppPage };
