'use strict';

const { performance } = require('node:perf_hooks');
const { fail, number, boolean } = require('./runtime');
const { screenshot } = require('./screenshot');
const { clickPlan, swipePlan } = require('./touch-gestures');

const MOMO_OPTIONS = ['timeoutMs', 'signal', 'dryRun', 'maxPagesPerDirection', 'pollMs', 'homeTimeoutMs',
  'launchTimeoutMs', 'stableObservations', 'confidence', 'iconThreshold', 'anchorThreshold'];

function settingsFor(options, defaultDryRun) {
  return { dryRun: boolean(options.dryRun ?? defaultDryRun, 'dryRun'),
    maxPagesPerDirection: number(options.maxPagesPerDirection ?? 5, 'maxPagesPerDirection', 0, 10),
    pollMs: number(options.pollMs ?? 300, 'pollMs', 100, 3000),
    homeTimeoutMs: number(options.homeTimeoutMs ?? 10000, 'homeTimeoutMs', 500, 60000),
    launchTimeoutMs: number(options.launchTimeoutMs ?? 15000, 'launchTimeoutMs', 500, 120000),
    stableObservations: number(options.stableObservations ?? 2, 'stableObservations', 2, 5),
    confidence: number(options.confidence ?? 0.65, 'confidence', 0.5, 0.99, false),
    iconThreshold: number(options.iconThreshold ?? 0.86, 'iconThreshold', 0.75, 0.99, false),
    anchorThreshold: number(options.anchorThreshold ?? 0.88, 'anchorThreshold', 0.75, 0.99, false) };
}

function similar(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height || a.thumbnail?.length !== 384 || b.thumbnail?.length !== 384) return false;
  const difference = a.thumbnail.reduce((sum, value, index) => sum + Math.abs(value - b.thumbnail[index]), 0) / 384;
  return difference <= 2.5;
}

function fingerprintDistance(a, b) {
  let value = BigInt('0x' + a) ^ BigInt('0x' + b), count = 0;
  while (value) { value &= value - 1n; count++; }
  return count;
}

async function openMomo(host, options, ctx) {
  const settings = settingsFor(options, host.dryRun);
  if (settings.dryRun) return { status: 'planned', data: { app: 'momo', settings,
    steps: ['inspect_current_page', 'confirm_home', 'search_icon_with_paging', 'click_icon_once', 'confirm_momo_page'],
    note: 'Plan only; no screenshots, vision process or phone input' } };
  host._requireToken();
  const report = { app: 'momo', alreadyOpen: false, page: 'unknown', pageConfirmed: false, verifiedBy: null,
    screenshots: 0, homeKeysSent: 0, pagesVisited: 0, iconClickAttempted: false, iconClickSent: false, lastScreenshot: null, lastObservation: null,
    history: [], vision: null };
  ctx.data = report;
  function record(stage, details = {}) {
    report.history.push({ stage, elapsedMs: Math.round(performance.now() - ctx.started), ...details });
    if (report.history.length > 200) report.history.shift();
  }
  ctx.stage = 'vision_start';
  const vision = await host._ensureMomoVision(ctx);
  report.vision = vision.info;
  record('vision_ready', { device: vision.info.device });
  let expectedSize = null, expectedConnection = null;
  function checkSession() {
    if (!expectedConnection) return;
    const control = expectedConnection.control;
    if (!control.connected || !control.ready) fail('CONNECTION_LOST', 'Control connection lost during openMomo');
    if (control._generation !== expectedConnection.generation) fail('CONNECTION_CHANGED', 'Control session changed during openMomo');
    if (control.screenWidth !== expectedConnection.width || control.screenHeight !== expectedConnection.height) {
      fail('SCREEN_CHANGED', 'Control resolution changed during openMomo; capture and locate again');
    }
  }
  async function observe() {
    ctx.check();
    checkSession();
    const shot = await screenshot(host.device, { level: 2, attempts: 1 }, ctx);
    report.lastScreenshot = shot;
    report.screenshots++;
    if (expectedSize && (shot.width !== expectedSize.width || shot.height !== expectedSize.height)) {
      fail('SCREEN_CHANGED', 'Screenshot resolution changed during openMomo');
    }
    expectedSize = { width: shot.width, height: shot.height };
    ctx.stage = 'vision';
    const observation = await vision.inspect(shot.image, settings, ctx);
    if (observation.width !== shot.width || observation.height !== shot.height || !/^[0-9a-f]{64}$/.test(observation.fingerprint ?? '') ||
        !Array.isArray(observation.icons) || !Array.isArray(observation.thumbnail)) {
      fail('VISION_PROTOCOL_ERROR', 'Vision observation does not match the captured image');
    }
    checkSession();
    report.lastObservation = { ...observation, thumbnail: undefined };
    record('observed', { page: observation.scene?.page ?? (observation.launcher ? 'launcher' : 'unknown'),
      homeConfirmed: observation.homeConfirmed, iconCount: observation.icons.length, visionMs: observation.elapsedMs });
    return observation;
  }
  async function stableUntil(predicate, budgetMs, first = null, stability = similar) {
    const deadline = Math.min(ctx.deadline, performance.now() + budgetMs);
    let previous = first, last = first, count = first && predicate(first) ? 1 : 0;
    while (performance.now() < deadline) {
      if (last) await ctx.sleep(settings.pollMs);
      last = await observe();
      count = predicate(last) ? (previous && predicate(previous) && stability(previous, last) ? count + 1 : 1) : 0;
      if (count >= settings.stableObservations) return { matched: true, observation: last };
      previous = last;
    }
    return { matched: false, observation: last };
  }
  function isUpdateBlocked(obs) {
    return obs?.blocked?.role === 'update' ||
      obs?.overlay === 'app_update' ||
      /新版本可升级|版本更新|发现新版本/.test(obs?.blocked?.text || '');
  }
  function blocked(observation) {
    const role = observation?.blocked?.role;
    if (role === 'update') return; // 升级弹窗由专属关闭逻辑处理，避免直接报错阻断
    const codes = { login: 'APP_LOGIN_REQUIRED', permission: 'APP_PERMISSION_REQUIRED', blocked: 'APP_DIALOG_BLOCKED' };
    if (codes[role]) fail(codes[role], 'MOMO needs manual handling; no dialog was confirmed automatically', { templateId: observation.blocked.id });
    if (observation?.modal) fail('APP_DIALOG_BLOCKED', 'A possible modal dialog blocks launch confirmation; inspect lastScreenshot');
  }
  async function ready(first, budgetMs) {
    const result = await stableUntil(observation => {
      blocked(observation);
      return Boolean(observation.scene);
    }, budgetMs, first, (a, b) => {
      if (a.scene?.page !== b.scene?.page || a.width !== b.width || a.height !== b.height) return false;
      return a.scene.anchors.every(anchor => b.scene.anchors.some(other => anchor.class === other.class &&
        Math.abs(anchor.box[0] - other.box[0]) <= a.width * 0.02 && Math.abs(anchor.box[1] - other.box[1]) <= a.height * 0.02));
    });
    if (result.matched) {
      report.page = result.observation.scene.page;
      report.pageConfirmed = true;
      report.verifiedBy = 'yolo_scene_signature';
      record('page_confirmed', { page: report.page, confidence: result.observation.scene.confidence });
    }
    return result;
  }
  const initial = await observe();
  if (initial.scene) {
    const result = await ready(initial, Math.min(settings.launchTimeoutMs, 3000));
    if (result.matched) { report.alreadyOpen = true; return { status: 'opened', data: report }; }
  }
  const control = await host._ensureControl(ctx);
  expectedConnection = { control, generation: control._generation, width: control.screenWidth, height: control.screenHeight };
  if (isUpdateBlocked(initial)) {
    const w = initial.width;
    const h = initial.height;
    const coordinateSpace = { width: w, height: h };
    await action('click', screen => clickPlan(Math.round(w * 0.903), Math.round(h * 0.207), { coordinateSpace, holdMs: 80, jitterPx: 0 }, screen));
    record('app_update_dismissed', { x: Math.round(w * 0.903), y: Math.round(h * 0.207) });
    await ctx.sleep(settings.settleMs ?? 600);
    const afterDismiss = await observe();
    if (afterDismiss.scene) {
      const result = await ready(afterDismiss, Math.min(settings.launchTimeoutMs, 3000));
      if (result.matched) { report.alreadyOpen = true; return { status: 'opened', data: report }; }
    }
  }
  async function goHome() {
    checkSession();
    ctx.stage = 'home';
    await host._sendHome(control, ctx);
    report.homeKeysSent++;
    record('home_sent');
    return stableUntil(observation => observation.homeConfirmed && !observation.modal && !observation.blocked, settings.homeTimeoutMs);
  }
  let home = await goHome();
  if (!home.matched) home = await goHome();
  if (!home.matched) {
    ctx.stage = 'confirm_home';
    fail('HOME_NOT_CONFIRMED', 'HOME did not produce stable system-icon and dock anchors');
  }
  let current = home.observation;
  const visited = [];
  async function action(kind, planner) {
    try {
      checkSession();
      const resolved = await host._executeGesture(control, screen => { checkSession(); return planner(screen); }, ctx, kind);
      record(kind + '_sent', { coordinates: resolved, framesSent: ctx.execution.framesSent });
    } catch (error) {
      record(kind + '_failed', { code: error.code ?? 'DISPATCH_FAILED', framesSent: ctx.execution.framesSent });
      throw error;
    } finally { ctx.data = report; }
  }
  async function tryIcon(observation) {
    ctx.stage = 'find_icon';
    if (observation.icons.length > 1) fail('APP_ICON_AMBIGUOUS', 'Multiple MOMO icon matches; no icon was clicked', { candidates: observation.icons });
    if (!observation.icons.length) return false;
    const [x1, y1, x2, y2] = observation.icons[0].box;
    if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) fail('VISION_PROTOCOL_ERROR', 'Invalid app icon box');
    const coordinateSpace = { width: observation.width, height: observation.height };
    // Recheck a fresh stable frame immediately before the single launch click.
    const fresh = await observe();
    if (!fresh.launcher || !similar(observation, fresh)) fail('LAUNCHER_CHANGED', 'Launcher changed before the app click');
    if (fresh.icons.length !== 1 || Math.hypot(fresh.icons[0].box[0] - x1, fresh.icons[0].box[1] - y1) > Math.max(2, observation.width * 0.01)) {
      fail('APP_ICON_CHANGED', 'MOMO icon moved or became ambiguous before click');
    }
    record('icon_selected', { box: observation.icons[0].box, confidence: observation.icons[0].confidence });
    report.iconClickAttempted = true;
    await action('click', screen => clickPlan((x1 + x2) / 2, (y1 + y2) / 2, { coordinateSpace, holdMs: 80, jitterPx: 0 }, screen));
    report.iconClickSent = true;
    let result = await ready(null, settings.launchTimeoutMs);
    if (!result.matched && isUpdateBlocked(result.observation)) {
      const w = result.observation.width;
      const h = result.observation.height;
      const coordinateSpace = { width: w, height: h };
      await action('click', screen => clickPlan(Math.round(w * 0.903), Math.round(h * 0.207), { coordinateSpace, holdMs: 80, jitterPx: 0 }, screen));
      record('app_update_dismissed', { x: Math.round(w * 0.903), y: Math.round(h * 0.207) });
      await ctx.sleep(settings.settleMs ?? 600);
      result = await ready(null, settings.launchTimeoutMs);
    }
    if (result.matched) return true;
    ctx.stage = 'confirm_app';
    blocked(result.observation);
    if (result.observation?.launcher) fail('APP_OPEN_FAILED', 'MOMO launch was not confirmed; the launcher is still visible');
    fail('APP_LAUNCH_TIMEOUT', 'MOMO did not reach a supported stable page; inspect lastScreenshot for login, splash or an unknown page');
  }
  for (const direction of ['left', 'right']) {
    if (direction === 'right') {
      home = await goHome();
      if (!home.matched) fail('HOME_NOT_CONFIRMED', 'Could not return to the confirmed home page before searching the other direction');
      current = home.observation;
    }
    for (let page = 0; page <= settings.maxPagesPerDirection; page++) {
      ctx.check();
      report.pagesVisited++;
      record('search_page', { direction, index: page, fingerprint: current.fingerprint });
      if (await tryIcon(current)) return { status: 'opened', data: report };
      // Revisited pages are still inspected for the icon, but do not loop through them.
      const repeated = visited.some(value => fingerprintDistance(value, current.fingerprint) <= 6);
      if (page > 0 && repeated) break;
      visited.push(current.fingerprint);
      if (page === settings.maxPagesPerDirection) break;
      const coordinateSpace = { width: current.width, height: current.height };
      const x1 = current.width * (direction === 'left' ? 0.82 : 0.18);
      const x2 = current.width * (direction === 'left' ? 0.18 : 0.82);
      const y = current.height * 0.43;
      await action('swipe', screen => swipePlan([{ x: x1, y }, { x: x2, y }],
        { coordinateSpace, durationMs: 350, startHoldMs: 30, endHoldMs: 30 }, screen));
      const next = await stableUntil(observation => observation.launcher && !observation.modal && !observation.blocked, settings.homeTimeoutMs);
      if (!next.matched) { ctx.stage = 'find_icon'; fail('LAUNCHER_NOT_STABLE', 'Launcher was not stable after paging; no further click was sent'); }
      current = next.observation;
    }
  }
  ctx.stage = 'find_icon';
  fail('APP_ICON_NOT_FOUND', 'No MOMO icon was found within the configured launcher pages; this does not prove it is uninstalled',
    { maxPagesPerDirection: settings.maxPagesPerDirection });
}

module.exports = { MOMO_OPTIONS, openMomo };
