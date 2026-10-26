'use strict';

const { randomInt } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { fail } = require('../runtime');
const { screenshot } = require('../screenshot');
const { regionClickPlan, swipePlan, chance } = require('../touch-gestures');
const { SharedRecognitionClient } = require('../../automation/recognition-service');

const REFRESH_HOME_OPTIONS = ['timeoutMs', 'signal', 'execute', 'dryRun', 'mode'];
const BROWSE_HOME_OPTIONS = [...REFRESH_HOME_OPTIONS, 'cycles', 'refreshCount', 'scrollCount', 'scrollIntervalMs'];
const DESCRIPTION = '首页刷新与列表浏览，用于初始化后的基础浏览（初始养号动作）；不点赞、不评论、不发消息';

// Anti-detection & layout invariants
const BUTTON_PROBABILITY = 0.7;
const CENTER_FRACTION = 0.4;
const CENTER_PROBABILITY = 0.7;
const INSET_PX = 1;
const SETTLE_MS = 700;
const STEP_TIMEOUT_MS = 20000;
const STABLE_OBSERVATIONS = 2;
const SWIPE_DURATION_MS = { min: 450, max: 700 };

function nowTime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg) {
  console.log(`[${nowTime()}] ${msg}`);
}

const pick = r => randomInt(r.min, r.max + 1);
const pickInterval = cfg => (cfg?.weighted !== false
  ? (chance(0.8) ? randomInt(1000, 3001) : randomInt(4000, 5001))
  : pick(cfg ?? { min: 1000, max: 5000 }));

function parseHomeState(page, view) {
  const w = view?.width ?? 720;
  const h = view?.height ?? 1280;
  const keywords = (page?.top_keywords ?? []).join('');
  const tabs = (view?.other_elements ?? []).filter(i => /^tab_(home|live|msg|universe|more)$/.test(i.class) && i.confidence >= 0.45);
  const homeTab = tabs.find(i => i.class === 'tab_home');

  // 1. 判断是否确认为 1 级“首页”动态 Feed 流
  const isHomeFeed = page?.is_momo === true &&
    page?.page_level === '1级页面' &&
    page?.sub_page === '首页' &&
    Boolean(homeTab) &&
    new Set(page?.matched_tabs ?? []).size >= 2 &&
    keywords.includes('动态') &&
    /附近|发动态/.test(keywords);

  // 2. 首页图标坐标与滑动区域
  const defaultHomeBox = [Math.round(w * 0.04), Math.round(h * 0.88), Math.round(w * 0.20), Math.round(h * 0.98)];
  const homeBox = homeTab ? [...homeTab.box] : defaultHomeBox;
  const bottomY = homeTab ? homeTab.box[1] - h * 0.035 : h * 0.88;
  const contentBox = [w * 0.12, h * 0.20, w * 0.88, bottomY];

  // 3. 页面大类状态分类：
  // - 'home_feed': 确认为首页动态 Feed 流
  // - 'level_1_other_tab': 处于 1 级页面的其他 Tab（消息列表、直播、更多等）
  // - 'sub_page': 明确处于 2 级页面（如聊天详情页）
  // - 'deep_or_unknown': 处于 3/4 级深层页面，或手机桌面
  let state = 'deep_or_unknown';
  if (isHomeFeed) {
    state = 'home_feed';
  } else if ((page?.is_momo === true && page?.page_level === '1级页面') || tabs.length >= 2) {
    state = 'level_1_other_tab';
  } else if (page?.page_level === '2级页面' || page?.page_level === '2级消息页') {
    state = 'sub_page';
  }

  return {
    state,
    isHomeFeed,
    home: { box: homeBox, confidence: homeTab?.confidence ?? 0.8 },
    contentBox,
    subPage: page?.sub_page ?? null,
    pageLevel: page?.page_level ?? null
  };
}

function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

function buildHomeGesturePlan(frame, kind, screen, customBox) {
  const coordinateSpace = { width: frame.shot.width, height: frame.shot.height };
  if (kind === 'click') {
    const box = customBox || frame.layout.home.box;
    return regionClickPlan(box, {
      coordinateSpace, centerFraction: CENTER_FRACTION, centerProbability: CENTER_PROBABILITY, insetPx: INSET_PX
    }, screen);
  }

  const [left, top, right, bottom] = frame.layout.contentBox;
  const w = right - left;
  const h = bottom - top;

  const clampX = val => Math.round(Math.max(left + 15, Math.min(right - 15, val)));
  const clampY = val => Math.round(Math.max(top + 15, Math.min(bottom - 15, val)));

  let startX, startY, midX, midY, endX, endY, durationMs;

  if (kind === 'pull') {
    // 下拉刷新动作：从上方往下拉动约 42%~54% 的内容高度
    startX = clampX(left + w * randomFloat(0.40, 0.60));
    startY = clampY(top + h * randomFloat(0.18, 0.28));
    const pullDist = h * randomFloat(0.42, 0.54);
    endY = clampY(startY + pullDist);
    const arcX = (Math.random() > 0.5 ? 1 : -1) * randomInt(10, 25);
    midX = clampX(startX + arcX);
    midY = Math.round((startY + endY) / 2);
    endX = clampX(startX + randomInt(-10, 10));
    durationMs = randomInt(500, 720);
  } else {
    // 上滑浏览动作：模拟人手大拇指划屏
    // 1. 滑动幅度概率分布：短滑 25% (看短帖/微调)，中滑 60% (正常翻页)，长滑 15% (快速大翻)
    const roll = Math.random();
    const distRatio = roll < 0.25
      ? randomFloat(0.30, 0.42)
      : roll < 0.85
        ? randomFloat(0.46, 0.60)
        : randomFloat(0.65, 0.76);

    // 2. 起始点：多处于屏幕中偏右下方（符合大多数单手大拇指习惯）
    startX = clampX(left + w * randomFloat(0.48, 0.72));
    startY = clampY(bottom - h * randomFloat(0.12, 0.25));

    const scrollDist = h * distRatio;
    endY = clampY(startY - scrollDist);

    // 3. 拟人大拇指贝塞尔微弧度：向上划时，拇指关节自然向内侧（左偏）弯曲 15~35 像素
    const inwardCurve = randomInt(15, 35);
    midX = clampX(startX - inwardCurve);
    midY = Math.round(startY - scrollDist * randomFloat(0.45, 0.55));
    endX = clampX(midX + randomInt(-8, 12));

    // 4. 滑动耗时根据滑行距离动态匹配：短滑更快，长滑稍长
    durationMs = Math.round((scrollDist / h) * 450 + randomInt(250, 380));
  }

  const points = [
    { x: startX, y: startY },
    { x: midX, y: midY },
    { x: endX, y: endY }
  ];

  return swipePlan(points, {
    coordinateSpace,
    durationMs,
    startHoldMs: randomInt(35, 55),
    endHoldMs: randomInt(30, 50),
    easing: 'easeInOut'
  }, screen);
}

async function runHome(host, options, ctx, browsing) {
  const mode = options.mode ?? 'random';
  if (!['random', 'button', 'pull'].includes(mode)) fail('INVALID_ARGUMENT', 'mode must be random, button or pull');

  const cycles = Math.max(1, Math.min(100, Number(options.cycles ?? 1)));
  const refreshCount = options.refreshCount ?? { min: 2, max: 8 };
  const scrollCount = options.scrollCount ?? { min: 3, max: 6 };
  const scrollIntervalMs = options.scrollIntervalMs ?? { min: 1000, max: 5000, weighted: true };

  host._requireToken();
  log(`连接设备控制通道 (${host.deviceId})`);

  const report = {
    app: 'momo', description: DESCRIPTION, outcome: 'not_started',
    requestedCycles: browsing ? cycles : 0, completedCycles: 0,
    refreshesSent: 0, scrollsSent: 0
  };
  ctx.data = report;

  const pool = host._recognitionPool ?? new SharedRecognitionClient();
  const ownsClient = !host._recognitionPool;
  let control, session, needsTopReset = true;

  function checkControl() {
    ctx.check();
    if (!control?.connected || !control.ready) fail('DEVICE_DISCONNECTED', '云机控制通道已断开，请检查设备状态');
    if (control._generation !== session.generation) fail('DEVICE_DISCONNECTED', '控制会话代次发生变更，操作已中止');
    if (control.screenWidth !== session.width || control.screenHeight !== session.height) {
      fail('DEVICE_DISCONNECTED', '设备屏幕分辨率发生异常变更');
    }
  }

  async function observe() {
    checkControl();
    const shot = await screenshot(host.device, { source: 'stream', maxSize: 1280, maxAgeMs: 0, attempts: 1 }, ctx);
    const observedAt = performance.now();

    ctx.stage = 'momo_home_recognition';
    const req = { signal: ctx.signal, timeoutMs: ctx.remaining() };
    const [page, list] = await ctx.wait(Promise.all([
      pool.page(shot.image, req),
      pool.chatList(shot.image, { ...req, confidence: 0.45 }),
    ]));

    ctx.check();
    checkControl();
    if (!page?.ok || !list?.ok) fail('VISION_ERROR', '图像识别服务调用失败');

    report.lastObservation = { page: page.data, tabs: list.data.other_elements };
    ctx.stage = 'momo_home_confirm';
    const layout = parseHomeState(page.data, list.data);
    return { shot, observedAt, layout, page: page.data };
  }

  async function action(frame, kind, role) {
    if (performance.now() - frame.observedAt > 3000) {
      fail('PAGE_INVALID', '目标观察已过期，重新核验画面');
    }
    return await host._executeGesture(control, screen => buildHomeGesturePlan(frame, kind, screen), ctx, kind === 'click' ? 'click' : 'swipe');
  }

  async function checkIsDesktop(image) {
    try {
      const ocrRes = await pool.ocr(image, { signal: ctx.signal, timeoutMs: 3000 });
      if (!ocrRes?.ok || !Array.isArray(ocrRes.data?.items)) return false;
      const allText = ocrRes.data.items.map(it => it.text.trim()).join(' ');
      const hasDesktopApps = /(^|\s)(陌陌|MOMO|设置|相机|相册|图库|文件管理|应用商城|应用商店|时钟|日历|天气|浏览器|电话|短信)($|\s)/.test(allText);
      const hasMomoContent = /关注|推荐|附近|动态|发动态|小宇宙|互动通知|聊天|打招呼|点赞|粉丝/.test(allText);
      return hasDesktopApps && !hasMomoContent;
    } catch {
      return false;
    }
  }

  async function confirmedHome() {
    ctx.stage = 'momo_home_confirm';
    const deadline = Math.min(ctx.deadline, performance.now() + STEP_TIMEOUT_MS);
    let previous, stable = 0;
    let switchAttempts = 0;
    let backAttempts = 0;

    while (performance.now() < deadline) {
      checkControl();
      const frame = await observe();
      const { state, subPage, home } = frame.layout;

      // 1. 已确认为首页动态 Feed 流
      if (state === 'home_feed') {
        const box = home.box;
        const still = previous && box.every((v, i) => Math.abs(v - previous[i]) < frame.shot.height * 0.012);
        stable = still ? stable + 1 : 1;
        previous = box;
        if (stable >= STABLE_OBSERVATIONS) return frame;
        await ctx.sleep(250);
        continue;
      }

      // 非首页状态，重置连续稳定帧计数
      stable = 0;
      previous = null;

      // 2. 处于 1 级页面的其他 Tab（消息列表、直播、小宇宙、更多等）
      // 绝对禁止在 1 级页面按 Back 键（会直接退出到桌面）！只通过点击底栏“首页”按钮切回
      if (state === 'level_1_other_tab') {
        if (switchAttempts >= 3) {
          fail('PAGE_INVALID', `连续 3 次点击“首页”按钮未能切回首页（当前停留: ${subPage || '其他Tab'}）`);
        }
        switchAttempts++;
        log(`当前处于“${subPage || '其他'}”页面，点击“首页”切换 (${switchAttempts}/3)`);
        await host._executeGesture(control, screen => buildHomeGesturePlan(frame, 'click', screen, home.box), ctx, 'click');
        await ctx.sleep(SETTLE_MS);
        continue;
      }

      // 3. 明确处于 2 级页面（如聊天详情页）
      if (state === 'sub_page') {
        if (backAttempts >= 4) {
          fail('PAGE_INVALID', `连续 ${backAttempts} 次按返回键仍未回到一级页面`);
        }
        backAttempts++;
        log(`当前处于子页面（${subPage || '二级页面'}），按返回键 (${backAttempts}/4)`);
        await host._sendBack(control, ctx);
        await ctx.sleep(SETTLE_MS);
        continue;
      }

      // 4. deep_or_unknown: 可能是 3 级/4 级深层页面，或在手机桌面
      // 先进行桌面特征核验
      const isDesktop = await checkIsDesktop(frame.shot.image);
      if (isDesktop) {
        log('当前处于手机桌面，MOMO 未在前台运行');
        fail('PAGE_INVALID', '当前处于手机桌面，请先打开陌陌应用');
      }

      // 若非桌面，说明处于深层子页面（动态详情/个人主页/设置等），按返回键回退
      if (backAttempts >= 4) {
        fail('PAGE_INVALID', '连续 4 次按返回键仍未识别到陌陌页面，请确认应用状态');
      }
      backAttempts++;
      log(`当前未在一级页面，按返回键 (${backAttempts}/4)`);
      await host._sendBack(control, ctx);
      await ctx.sleep(SETTLE_MS);
      continue;
    }

    fail('PAGE_INVALID', '页面核验超时：未能稳定停留在陌陌首页');
  }

  async function refresh(frame, cycleIndex = 1, refreshIndex = 1, refreshTarget = 1) {
    const refreshMethod = mode === 'random' ? (chance(BUTTON_PROBABILITY) ? 'button' : 'pull') : mode;
    if (refreshMethod === 'pull' && needsTopReset) {
      log(`第 ${cycleIndex} 轮：点击“首页”回到顶部`);
      await action(frame, 'click', 'return_to_top');
      await ctx.sleep(SETTLE_MS);
      frame = await confirmedHome();
    }
    log(`第 ${cycleIndex} 轮：${refreshMethod === 'button' ? '点击按钮刷新' : '下拉刷新'} (${refreshIndex}/${refreshTarget})`);
    await action(frame, refreshMethod === 'button' ? 'click' : 'pull', `refresh_${refreshMethod}`);
    report.refreshesSent++;
    needsTopReset = false;
    await ctx.sleep(SETTLE_MS);
    return { frame: await confirmedHome(), mode: refreshMethod };
  }

  try {
    control = await host._ensureControl(ctx);
    session = { generation: control._generation, width: control.screenWidth, height: control.screenHeight };
    log('检查当前页面状态...');
    let frame = await confirmedHome();
    log('当前已在首页动态列表');
    report.outcome = 'running';

    if (!browsing) {
      const refreshed = await refresh(frame);
      report.outcome = 'refresh_sent_home_reconfirmed';
      return { status: 'sent', data: report };
    }

    log(`开始执行首页养号，共 ${cycles} 轮 (刷新模式: ${mode})`);
    for (let i = 0; i < cycles; i++) {
      ctx.check();
      const refreshTarget = pick(refreshCount);
      const scrollTarget = pick(scrollCount);
      log(`第 ${i + 1}/${cycles} 轮：计划刷新 ${refreshTarget} 次，滑动浏览 ${scrollTarget} 次`);

      for (let s = 0; s < refreshTarget; s++) {
        const refreshed = await refresh(frame, i + 1, s + 1, refreshTarget);
        frame = refreshed.frame;
      }
      for (let s = 0; s < scrollTarget; s++) {
        const wait = pickInterval(scrollIntervalMs);
        ctx.stage = 'momo_home_read_wait';
        log(`第 ${i + 1} 轮：浏览停顿 ${(wait / 1000).toFixed(1)} 秒 (${s + 1}/${scrollTarget})`);
        await ctx.sleep(wait);
        frame = await confirmedHome();
        log(`第 ${i + 1} 轮：上滑翻看下一条 (${s + 1}/${scrollTarget})`);
        await action(frame, 'scroll', 'browse_scroll');
        report.scrollsSent++;
        needsTopReset = true;
        await ctx.sleep(SETTLE_MS);
        frame = await confirmedHome();
      }
      report.completedCycles++;
      log(`第 ${i + 1}/${cycles} 轮执行完成`);
    }

    log('所有养号轮次执行完毕');
    report.outcome = 'cycles_completed_home_reconfirmed';
    return { status: 'sent', data: report };
  } catch (error) {
    report.outcome = 'stopped';
    log(`执行失败: ${error.message}`);
    throw error;
  } finally {
    ctx.data = report;
    if (ownsClient) {
      try { await pool.close(); } catch { ctx.cleanupFailed = true; }
    }
  }
}

function refreshMomoHome(host, options, ctx) { return runHome(host, options, ctx, false); }
function browseMomoHome(host, options, ctx) { return runHome(host, options, ctx, true); }

module.exports = {
  REFRESH_HOME_OPTIONS,
  BROWSE_HOME_OPTIONS,
  refreshMomoHome,
  browseMomoHome,
  buildHomeGesturePlan
};
