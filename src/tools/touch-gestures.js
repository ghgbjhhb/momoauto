'use strict';

/**
 * 统一物理触控与手势交互工具 (Unified Touch Gestures & Motion System)
 *
 * 整合原 coordinates, target-sampling, click, region-click, swipe, gestures
 * 核心不变量：
 * 1. 严格单写互斥 (Single-Writer Guarantee)：基于 control._enqueue 串行队列
 * 2. 坐标映射与防误触采样 (Coordinate Mapping & Safe Inset Sampling)
 * 3. 三态幂等与原子释放 (Tri-State Model & Mandatory Pointer UP on same generation)
 */

const { randomInt } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { ACTION } = require('../protocol');
const { ToolFailure, fail, keys, number, size } = require('./runtime');

// ==========================================
// 1. 概率与采样算法 (Sampling & Probability)
// ==========================================

function chance(probability) {
  return randomInt(0, 1000000) < probability * 1000000;
}

/**
 * 在目标矩形内执行高斯内聚/双环加权随机取点，防止边缘触碰被风控
 */
function sampleWeightedBox(box, options = {}, screenSize) {
  const { width, height } = size(screenSize, 'coordinateSpace');
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) ||
      box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height || box[0] >= box[2] || box[1] >= box[3]) {
    fail('INVALID_ARGUMENT', 'box must be an in-image [left, top, right, bottom] rectangle');
  }
  const fraction = number(options.centerFraction ?? .4, 'centerFraction', .01, .99, false);
  const probability = number(options.centerProbability ?? .7, 'centerProbability', 0, 1, false);
  const inset = number(options.insetPx ?? 1, 'insetPx', 0, 1000);
  const safe = [
    Math.ceil(box[0] + inset),
    Math.ceil(box[1] + inset),
    Math.min(width - 1, Math.ceil(box[2] - inset) - 1),
    Math.min(height - 1, Math.ceil(box[3] - inset) - 1)
  ];
  if (safe[0] > safe[2] || safe[1] > safe[3]) {
    fail('TARGET_REGION_TOO_SMALL', 'Target has no pixels after its safety inset');
  }
  const cx = (safe[0] + safe[2]) / 2, cy = (safe[1] + safe[3]) / 2;
  const halfWidth = Math.max(0, ((safe[2] - safe[0] + 1) * fraction - 1) / 2);
  const halfHeight = Math.max(0, ((safe[3] - safe[1] + 1) * fraction - 1) / 2);
  const inner = [
    Math.round(cx - halfWidth), Math.round(cy - halfHeight),
    Math.round(cx + halfWidth), Math.round(cy + halfHeight)
  ];
  const rectangles = [
    [safe[0], safe[1], safe[2], inner[1] - 1],
    [safe[0], inner[3] + 1, safe[2], safe[3]],
    [safe[0], inner[1], inner[0] - 1, inner[3]],
    [inner[2] + 1, inner[1], safe[2], inner[3]]
  ];
  const outer = rectangles.filter(r => r[0] <= r[2] && r[1] <= r[3]);
  const area = r => (r[2] - r[0] + 1) * (r[3] - r[1] + 1);
  if (!outer.length && probability < 1) {
    fail('TARGET_REGION_TOO_SMALL', 'Target is too small for separate center and outer regions');
  }
  const isCenter = chance(probability);
  let selected = inner;
  if (!isCenter) {
    let ticket = randomInt(0, outer.reduce((sum, r) => sum + area(r), 0));
    for (const rectangle of outer) {
      ticket -= area(rectangle);
      if (ticket < 0) { selected = rectangle; break; }
    }
  }
  return {
    x: randomInt(selected[0], selected[2] + 1),
    y: randomInt(selected[1], selected[3] + 1),
    region: isCenter ? 'center' : 'outer',
    box: [...box],
    safeBox: safe,
    centerBox: inner,
    centerFraction: fraction,
    centerProbability: probability,
    insetPx: inset
  };
}

// ==========================================
// 2. 坐标映射器 (Coordinate Mapper)
// ==========================================

function coordinateMapper(options = {}, screenSize) {
  const target = size(screenSize, 'screenSize');
  const source = options.coordinateSpace === undefined ? target : size(options.coordinateSpace, 'coordinateSpace');
  if (Math.abs((source.width / source.height) / (target.width / target.height) - 1) > 0.05) {
    fail('COORDINATE_SPACE_MISMATCH', 'Source and control aspect ratios differ by more than 5%; check crop/rotation',
      { coordinateSpace: source, screenSize: target });
  }
  const offset = options.offset ?? { x: 0, y: 0 };
  keys(offset, ['x', 'y'], 'offset');
  const dx = number(offset.x ?? 0, 'offset.x', -65535, 65535, false);
  const dy = number(offset.y ?? 0, 'offset.y', -65535, 65535, false);
  const jitter = number(options.jitterPx ?? 0, 'jitterPx', 0, 1000);

  function axis(value, shift, extent, targetExtent, field) {
    const coordinate = number(value, field, -65535, 65535, false);
    if (coordinate < 0 || coordinate > extent - 1) {
      fail('COORDINATE_OUT_OF_BOUNDS', 'Coordinate is outside the source image', { field, coordinate, max: extent - 1 });
    }
    const base = coordinate + shift;
    if (base < 0 || base > extent - 1) {
      fail('COORDINATE_OUT_OF_BOUNDS', 'Offset moves coordinate outside the source image', { field, coordinate: base, max: extent - 1 });
    }
    const delta = randomInt(Math.ceil(Math.max(-jitter, -base)), Math.floor(Math.min(jitter, extent - 1 - base)) + 1);
    return extent === 1 ? 0 : Math.round((base + delta) * (targetExtent - 1) / (extent - 1));
  }

  return {
    source,
    target,
    map(point, field) {
      keys(point, ['x', 'y', 'pauseMs'], field);
      return {
        x: axis(point.x, dx, source.width, target.width, field + '.x'),
        y: axis(point.y, dy, source.height, target.height, field + '.y')
      };
    }
  };
}

// ==========================================
// 3. 点击与滑动轨迹规划 (Motion Planners)
// ==========================================

const COMMON_GESTURE_OPTIONS = ['timeoutMs', 'signal', 'dryRun', 'coordinateSpace', 'offset', 'jitterPx'];

function clickPlan(pointOrX, optionsOrY = {}, maybeOptions = {}, maybeScreenSize) {
  let point;
  let options;
  let screenSize;

  if (typeof pointOrX === 'number' || typeof optionsOrY === 'number') {
    point = { x: pointOrX, y: optionsOrY };
    options = maybeOptions || {};
    screenSize = maybeScreenSize;
  } else {
    point = pointOrX;
    options = optionsOrY || {};
    screenSize = maybeOptions;
  }

  const mapper = coordinateMapper(options, screenSize);
  const mapped = mapper.map(point, 'point');
  const clicks = number(options.clicks ?? 1, 'clicks', 1, 10);
  const intervalMs = clicks === 1 ? 0 : number(options.intervalMs ?? 80, 'intervalMs', 1, 10000);
  const strokes = [];
  let durationMs = 0;
  for (let index = 0; index < clicks; index++) {
    // 云机注入管线会偶发丢弃超短按压（40~91ms 档实测丢事件），默认对齐人手点击时长。
    const holdMs = options.holdMs === undefined ? randomInt(110, 140) : number(options.holdMs, 'holdMs', 1, 120000);
    strokes.push({ points: [mapped], holdMs });
    durationMs += holdMs + (index < clicks - 1 ? intervalMs : 0);
  }
  return {
    strokes,
    intervalMs,
    report: {
      coordinateSpace: mapper.source,
      screenSize: mapper.target,
      point: mapped,
      clicks,
      durationMs,
      holdMs: options.holdMs ?? null,
      intervalMs
    }
  };
}

function regionClickPlan(box, options = {}, screenSize) {
  const source = options.coordinateSpace === undefined ? screenSize : options.coordinateSpace;
  const sample = sampleWeightedBox(box, options, source);
  const plan = clickPlan({ x: sample.x, y: sample.y }, options, screenSize);
  plan.report.target = sample;
  return plan;
}

function swipePlan(points, options = {}, screenSize) {
  if (!Array.isArray(points) || points.length < 2) fail('INVALID_ARGUMENT', 'points must contain at least two path vertices');
  const mapper = coordinateMapper(options, screenSize);
  const mapped = points.map((p, i) => ({ ...mapper.map(p, 'points[' + i + ']'), pauseMs: number(p.pauseMs ?? 0, 'points[' + i + '].pauseMs', 0, 10000) }));
  const durationMs = number(options.durationMs ?? 300, 'durationMs', 10, 120000);
  const stepMs = number(options.stepMs ?? 8, 'stepMs', 2, 200);
  const startHoldMs = number(options.startHoldMs ?? 0, 'startHoldMs', 0, 10000);
  const endHoldMs = number(options.endHoldMs ?? 0, 'endHoldMs', 0, 10000);
  const easing = options.easing ?? 'easeInOut';
  if (!['linear', 'easeInOut'].includes(easing)) fail('INVALID_ARGUMENT', 'easing must be linear or easeInOut');

  const lengths = [];
  let totalLength = 0;
  for (let i = 0; i < mapped.length - 1; i++) {
    const len = Math.hypot(mapped[i + 1].x - mapped[i].x, mapped[i + 1].y - mapped[i].y);
    lengths.push(len);
    totalLength += len;
  }
  const durations = [];
  let allocated = 0;
  for (let i = 0; i < lengths.length; i++) {
    const share = totalLength === 0 ? Math.round(durationMs / lengths.length) : Math.round(durationMs * lengths[i] / totalLength);
    const duration = i === lengths.length - 1 ? Math.max(1, durationMs - allocated) : Math.max(1, share);
    durations.push(duration);
    allocated += duration;
  }

  const moves = [];
  let atMs = startHoldMs;
  for (let i = 0; i < mapped.length - 1; i++) {
    const from = mapped[i], to = mapped[i + 1];
    const steps = Math.max(1, Math.round(durations[i] / stepMs));
    for (let step = 1; step <= steps; step++) {
      const progress = step / steps;
      const t = easing === 'easeInOut' ? (progress < .5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress) : progress;
      moves.push({ x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t), atMs: Math.round(atMs + durations[i] * progress) });
    }
    atMs += durations[i] + to.pauseMs;
  }
  return {
    strokes: [{ points: mapped, moves, holdMs: durationMs }],
    intervalMs: 0,
    report: {
      coordinateSpace: mapper.source,
      screenSize: mapper.target,
      points: mapped,
      durationMs,
      segmentDurationsMs: durations,
      stepMs,
      startHoldMs,
      endHoldMs,
      easing,
      moveCount: moves.length
    }
  };
}

// ==========================================
// 4. 单写物理派发器 (Gesture Dispatcher)
// ==========================================

function checkControl(control, snapshot) {
  if (!control.connected || !control.ready) fail('CONNECTION_LOST', 'Control connection is not ready');
  if (control._generation !== snapshot.generation) fail('CONNECTION_CHANGED', 'Control connection changed; action will not be replayed');
  if (control.screenWidth !== snapshot.width || control.screenHeight !== snapshot.height) {
    fail('SCREEN_CHANGED', 'Control resolution changed during the operation; obtain a fresh screenshot');
  }
}

async function dispatch(control, plan, ctx, operation) {
  const snapshot = { generation: control._generation, width: control.screenWidth, height: control.screenHeight };
  const touchOptions = { screenWidth: snapshot.width, screenHeight: snapshot.height, pointerId: 0, pressure: 1, buttons: 1 };
  const send = (action, point, options = touchOptions) => {
    control.touch(action, point.x, point.y, options);
    ctx.execution.framesSent++;
  };
  for (let index = 0; index < plan.strokes.length; index++) {
    ctx.stage = 'dispatch';
    ctx.check();
    checkControl(control, snapshot);
    const stroke = plan.strokes[index];
    let current = stroke.points[0], primaryError;
    const start = performance.now();
    ctx.execution.state = 'partial';
    ctx.execution.localWriteConfirmed = false;
    ctx.execution.release = 'pending';
    try {
      send(ACTION.DOWN, current);
      for (const move of stroke.moves ?? []) {
        await ctx.sleep(Math.max(0, start + move.atMs - performance.now()));
        ctx.check();
        checkControl(control, snapshot);
        send(ACTION.MOVE, move);
        current = move;
      }
      await ctx.sleep(Math.max(0, start + stroke.holdMs - performance.now()));
      ctx.check();
      checkControl(control, snapshot);
    } catch (error) {
      primaryError = error;
    } finally {
      if (control._generation === snapshot.generation && control.connected) {
        try {
          send(ACTION.UP, current, { ...touchOptions, pressure: 0, buttons: 0 });
          ctx.execution.release = 'sent';
        } catch {
          ctx.execution.release = 'failed';
          if (!primaryError) {
            ctx.stage = 'release';
            primaryError = new ToolFailure('RELEASE_FAILED', 'Could not send pointer UP; do not blindly retry');
          }
        }
      } else {
        ctx.execution.release = 'connection_lost';
        if (!primaryError) {
          primaryError = new ToolFailure('CONNECTION_LOST', 'Connection lost before pointer UP');
        }
      }
    }
    if (primaryError) throw primaryError;
    if (operation === 'click') ctx.execution.completedClicks++;
    if (index < plan.strokes.length - 1) await ctx.sleep(plan.intervalMs);
  }
  ctx.stage = 'flush';
  ctx.check();
  checkControl(control, snapshot);
  await ctx.wait(control.flush());
  ctx.check();
  checkControl(control, snapshot);
  ctx.execution.localWriteConfirmed = true;
  ctx.execution.state = 'sent';
  return plan.report;
}

async function gesture(control, planner, ctx, operation) {
  let entered, started = false;
  const admitted = new Promise(resolve => { entered = resolve; });
  ctx.stage = 'gesture_queue';
  const pending = control._enqueue('_gestures', async () => {
    started = true;
    entered();
    ctx.check();
    ctx.stage = 'map';
    if (!control.ready || !control.connected) fail('NOT_CONNECTED', 'Control is not ready');
    const plan = planner({ width: control.screenWidth, height: control.screenHeight });
    ctx.data = plan.report;
    if (plan.report.durationMs + 25 >= ctx.remaining()) {
      fail('INSUFFICIENT_TIME', 'Gesture duration exceeds the remaining deadline; increase timeoutMs',
        { plannedDurationMs: plan.report.durationMs, remainingMs: ctx.remaining() });
    }
    return dispatch(control, plan, ctx, operation);
  });
  pending.catch(() => {});
  try { await ctx.wait(admitted); }
  catch (error) {
    if (started) await pending.catch(() => {});
    throw error;
  }
  return pending;
}

module.exports = {
  chance,
  sampleWeightedBox,
  coordinateMapper,
  clickPlan,
  regionClickPlan,
  swipePlan,
  dispatch,
  checkControl,
  gesture,
  COMMON: COMMON_GESTURE_OPTIONS,
  COMMON_GESTURE_OPTIONS
};
