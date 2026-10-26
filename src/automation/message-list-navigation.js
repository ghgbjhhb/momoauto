'use strict';
const { observePage } = require('./page-service');
const { checkSignal, waitFor, sleep } = require('./cancellation');
const { observedPoint } = require('./coordinates');

function listSignature(obs) {
  return JSON.stringify((obs.evidence.ocrData?.items || [])
    .filter(item => item.top > obs.height * .14 && item.bottom < obs.height * .92)
    .map(item => [item.text, Math.round(item.top / 4), Math.round(item.left / 4)]));
}

function normalizeOcrFeature(text) {
  return String(text ?? '').normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function editDistance(left, right) {
  const a = Array.from(left), b = Array.from(right);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// OCR 容错只作用于这几个已经确定的顶部锚点，不引入新的页面标记。
// 允许：空格/标点差异、一个字符的替换/遗漏，以及识别框附带一个字符。
function ocrFeatureMatches(text, target) {
  const value = normalizeOcrFeature(text);
  const expected = normalizeOcrFeature(target);
  if (!value || !expected) return false;
  const valueChars = Array.from(value);
  const expectedLength = Array.from(expected).length;
  if (value === expected || (value.includes(expected) && valueChars.length - expectedLength <= 1)) return true;
  for (const length of [expectedLength - 1, expectedLength, expectedLength + 1]) {
    if (length < 1 || length > valueChars.length) continue;
    for (let start = 0; start + length <= valueChars.length; start++) {
      const window = valueChars.slice(start, start + length).join('');
      if (editDistance(window, expected) <= 1) return true;
    }
  }
  return false;
}

// 识别首屏顶部 4 个绝对核心特征（用户标定基准）：
// 1. 马上聊 (顶栏左侧)
// 2. 消息 (顶栏标题)
// 3. 语音聊天 (包含 OCR 容错 "音聊天")
// 4. 视频匹配 (右侧卡片)
// 出现这 4 个即 100% 确认滑到消息列表首屏顶部。
function topFeatureEvidence(obs) {
  const items = obs?.evidence?.ocrData?.items || [];
  const height = Number(obs?.height ?? obs?.evidence?.ocrData?.height ?? 1280);
  const inRange = (item, min, max) => item.top >= height * min && item.top <= height * max;

  const hasMaShangLiao = items.some(it => inRange(it, 0.02, 0.20) && /马上聊/.test(it.text));
  const hasXiaoXi = items.some(it => inRange(it, 0.02, 0.20) && it.text === '消息');
  const hasYuYinLiaoTian = items.some(it => inRange(it, 0.08, 0.32) && /(?:语)?音聊天/.test(it.text));
  const hasShiPinPiPei = items.some(it => inRange(it, 0.08, 0.32) && /视频匹配/.test(it.text));

  const matched = [];
  if (hasMaShangLiao) matched.push('马上聊');
  if (hasXiaoXi) matched.push('消息');
  if (hasYuYinLiaoTian) matched.push('语音聊天');
  if (hasShiPinPiPei) matched.push('视频匹配');

  // 出现这 4 个特征即 100% 确认到顶；或者命中 3 个以上且包含“马上聊”或“消息”
  const confirmed = matched.length === 4 ||
    (matched.length >= 3 && (hasMaShangLiao || hasXiaoXi));

  return {
    hasMaShangLiao,
    hasXiaoXi,
    hasYuYinLiaoTian,
    hasShiPinPiPei,
    matched,
    confirmed,
  };
}

function hasTopHeader(obs) {
  return topFeatureEvidence(obs).confirmed;
}

async function returnMessageListTop(session, observation, options = {}) {
  let obs = observation;
  for (let step = 0; step <= (options.maxSteps ?? 8); step++) {
    checkSignal(options.signal); session.assertActive?.();
    const validationFailure = options.validateObservation?.(obs);
    if (validationFailure) {
      return { ok: false, code: validationFailure.code ?? 'LIST_UNCONFIRMED', observation: obs,
        error: validationFailure };
    }
    if (!obs?.ok || obs.page !== 'message_list' || obs.overlay !== 'none') {
      return { ok: false, code: 'LIST_UNCONFIRMED', observation: obs };
    }
    if (hasTopHeader(obs)) return { ok: true, atTop: true, proof: 'top_header', observation: obs, steps: step };
    if (step === (options.maxSteps ?? 8)) break;
    if (typeof session.control?.swipe !== 'function') return { ok: false, code: 'NO_SWIPE_PROVIDER', observation: obs };

    const fromY = Math.round(obs.height * .30);
    const toY = Math.round(obs.height * .78);
    const x = Math.round(obs.width * .5);

    await waitFor(session.control.swipe(observedPoint(session.control, obs, { x, y: fromY }),
      observedPoint(session.control, obs, { x, y: toY }), { durationMs: 400, signal: options.signal }),
    { signal: options.signal, timeoutMs: 5000 });
    if (session.control.flush) await waitFor(session.control.flush(), { signal: options.signal, timeoutMs: 5000 });
    await sleep(options.settleMs ?? 500, options.signal);
    const observer = options.observePage ?? observePage;
    obs = await observer(session, { signal: options.signal, timeoutMs: 10000 });
  }
  return { ok: hasTopHeader(obs), code: hasTopHeader(obs) ? null : 'LIST_TOP_UNCONFIRMED', observation: obs };
}
module.exports = { returnMessageListTop: require('./timing').timed('page.returnMessageListTop', returnMessageListTop,
  session => ({ deviceId: session?.deviceId })), listSignature, topFeatureEvidence, ocrFeatureMatches };
