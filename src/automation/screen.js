'use strict';

// Shared screenshot/OCR anchors and desktop navigation; importing never controls a phone.
const fs = require('node:fs/promises');
const path = require('node:path');
const { RapidOcrWorker, shellQuote, toWslPath } = require('./ocr');
const os = require('node:os');
const SCREENSHOT_LEVEL = 2;
const HOME_ANCHORS = [
  ['时钟'],
  ['日历'],
  ['通讯录'],
  ['录音机'],
  ['音乐'],
  ['图库', '图'],
];

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deviceIdOf(record) {
  return String(record?.deviceId ?? record?.id ?? '');
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/[|丨]/g, '')
    .replace(/[，。、“”‘’：:；;]/g, '');
}

function textOf(items) {
  return items.map(item => String(item.text ?? '')).join(' ');
}

function normalizedTextOf(items) {
  return normalizeText(items.map(item => String(item.text ?? '')).join(''));
}

function scoreOf(item) {
  return numberOr(item?.score, 0);
}

function validItems(ocr) {
  const minimum = numberOr(process.env.YUNMOMO_OCR_MIN_SCORE, 0.35);
  return (Array.isArray(ocr?.items) ? ocr.items : [])
    .filter(item => scoreOf(item) >= minimum)
    .map(item => ({
      ...item,
      text: String(item.text ?? ''),
      left: numberOr(item.left, 0),
      top: numberOr(item.top, 0),
      right: numberOr(item.right, item.left),
      bottom: numberOr(item.bottom, item.top),
      centerX: numberOr(item.center_x, (numberOr(item.left, 0) + numberOr(item.right, item.left)) / 2),
      centerY: numberOr(item.center_y, (numberOr(item.top, 0) + numberOr(item.bottom, item.top)) / 2),
    }));
}

function sameLine(left, right) {
  const leftHeight = Math.max(1, left.bottom - left.top);
  const rightHeight = Math.max(1, right.bottom - right.top);
  const tolerance = Math.max(12, Math.max(leftHeight, rightHeight) * 1.25);
  return Math.abs(left.centerY - right.centerY) <= tolerance;
}

function closeHorizontally(left, right) {
  const gap = Math.max(0, right.left - left.right);
  const height = Math.max(1, left.bottom - left.top, right.bottom - right.top);
  return gap <= Math.max(80, height * 8);
}

function mergedBox(items) {
  if (!items.length) return null;
  return {
    left: Math.min(...items.map(item => item.left)),
    top: Math.min(...items.map(item => item.top)),
    right: Math.max(...items.map(item => item.right)),
    bottom: Math.max(...items.map(item => item.bottom)),
  };
}

function findPhrase(items, phrase, options = {}) {
  const target = normalizeText(phrase);
  if (!target) return null;

  const ordered = [...items].sort((a, b) => a.top - b.top || a.left - b.left);
  for (const item of ordered) {
    const text = normalizeText(item.text);
    if (text.includes(target) || target.includes(text) && text.length >= 2) return mergedBox([item]);
  }

  const maxWords = options.maxWords ?? 5;
  for (let start = 0; start < ordered.length; start += 1) {
    const line = [ordered[start]];
    let combined = normalizeText(ordered[start].text);
    for (let end = start + 1; end < Math.min(ordered.length, start + maxWords); end += 1) {
      const previous = ordered[end - 1];
      const current = ordered[end];
      if (!sameLine(previous, current)) break;
      const lineItems = [...line, current].sort((a, b) => a.left - b.left);
      if (!closeHorizontally(lineItems[lineItems.length - 2], lineItems[lineItems.length - 1])) break;
      line.push(current);
      combined = normalizeText(line.map(item => item.text).join(''));
      if (combined.includes(target) || target.includes(combined) && combined.length >= 2) {
        return mergedBox(line);
      }
    }
  }
  return null;
}

// Variant for state labels and buttons where a short OCR fragment must not
// satisfy a longer phrase. For example, the normal page contains “生成” in
// several button labels, but only “正在生成...” is an in-progress state.
function findStrictPhrase(items, phrase, options = {}) {
  const target = normalizeText(phrase);
  if (!target) return null;

  const ordered = [...items].sort((a, b) => a.top - b.top || a.left - b.left);
  for (const item of ordered) {
    if (normalizeText(item.text).includes(target)) return mergedBox([item]);
  }

  const maxWords = options.maxWords ?? 5;
  for (let start = 0; start < ordered.length; start += 1) {
    const line = [ordered[start]];
    for (let end = start + 1; end < Math.min(ordered.length, start + maxWords); end += 1) {
      const previous = ordered[end - 1];
      const current = ordered[end];
      if (!sameLine(previous, current)) break;
      const lineItems = [...line, current].sort((a, b) => a.left - b.left);
      if (!closeHorizontally(lineItems[lineItems.length - 2], lineItems[lineItems.length - 1])) break;
      line.push(current);
      const combined = normalizeText(line.map(item => item.text).join(''));
      if (combined.includes(target)) return mergedBox(line);
    }
  }
  return null;
}

function hasAllPhrases(items, phrases) {
  return phrases.every(phrase => Boolean(findPhrase(items, phrase)));
}

function homeAnchorMatches(items) {
  const matched = [];
  for (const group of HOME_ANCHORS) {
    const phrase = group.find(candidate => findPhrase(items, candidate));
    if (phrase) matched.push(phrase);
  }
  return matched;
}

function clipboardToastVisible(items) {
  return Boolean(findPhrase(items, '已复制'));
}

function appTargetBox(items) {
  const exact = findPhrase(items, '密钥认证');
  if (exact) return exact;
  const key = findPhrase(items, '密钥');
  const auth = findPhrase(items, '认证');
  if (key && auth && Math.abs(key.top - auth.top) <= 35) return mergedBox([
    { ...key, right: key.right, bottom: key.bottom },
    { ...auth, right: auth.right, bottom: auth.bottom },
  ]);
  return key || auth || null;
}

function pageSignature(items) {
  return items
    .filter(item => item.centerY < 0.94 * 640)
    .map(item => normalizeText(item.text))
    .filter(Boolean)
    .join('|')
    .slice(0, 500);
}

async function createOcrDirectory(prefix) {
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9_-]+-$/.test(prefix)) throw new TypeError('Invalid OCR directory prefix');
  let parent = os.tmpdir();
  if (process.env.YUNMOMO_OCR_PARENT_DIR) {
    const root = path.resolve(__dirname, '../../.local-output/流程执行');
    parent = path.resolve(process.env.YUNMOMO_OCR_PARENT_DIR);
    const relative = path.relative(root, parent);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('OCR 归档目录必须位于独立流程记录目录中');
    await fs.mkdir(parent, { recursive: true });
    const actualRoot = await fs.realpath(root), actualParent = await fs.realpath(parent);
    const actualRelative = path.relative(actualRoot, actualParent);
    if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) throw new Error('OCR 归档目录不能链接到记录目录外部');
  }
  return fs.mkdtemp(path.join(parent, prefix));
}

async function screenshotAndOcr(phone, worker, directory, counter) {
  return require('./timing').measure('screen.screenshotAndOcr', {}, () => screenshotAndOcrMeasured(phone, worker, directory, counter));
}

async function screenshotAndOcrMeasured(phone, worker, directory, counter) {
  const screenshot = await phone.screenshot({ level: SCREENSHOT_LEVEL });
  const imagePath = path.join(directory, `${String(counter).padStart(3, '0')}.jpg`);
  const writing = fs.writeFile(imagePath, screenshot.data);
  const captured = await Promise.allSettled([writing,
    worker instanceof require('./ocr').LegacyRapidOcrWorker ?
      writing.then(() => worker.recognize(imagePath)) : worker.recognize(screenshot.data)]);
  if (captured[0].status === 'rejected') throw captured[0].reason;
  if (captured[1].status === 'rejected') throw captured[1].reason;
  const ocr = captured[1].value;
  const items = validItems(ocr);
  return {
    imagePath,
    width: Number(ocr.width) || 0,
    height: Number(ocr.height) || 0,
    items,
    keyboardSwitches: Array.isArray(ocr.keyboardSwitches) ? ocr.keyboardSwitches : [],
    mapVision: ocr.mapVision || null,
    text: textOf(items),
    normalizedText: normalizedTextOf(items),
    ocrElapsed: ocr.elapsed,
  };
}

async function observeUntil(phone, worker, directory, state, predicate, timeoutMs, pollMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() <= deadline) {
    state.counter += 1;
    last = await screenshotAndOcr(phone, worker, directory, state.counter);
    last.label = label;
    if (predicate(last)) return last;
    await sleep(pollMs);
  }
  return last;
}

async function sendHome(control) {
  control.home();
  await control.flush();
}

async function confirmHome(phone, control, worker, directory, state, options) {
  const confirmation = options.homeConfirmation || null;
  const startedAt = Date.now();
  const pollMs = numberOr(confirmation?.pollMs, options.pollMs);
  const isConfirmedHome = observation => homeAnchorMatches(observation?.items || []).length >= 2 &&
    (confirmation?.allowClipboardToast === true || !clipboardToastVisible(observation?.items || []));
  const reportConfirmation = (observation, attempts) => confirmation ? {
    ...observation,
    homeConfirmation: {
      attempts,
      elapsedMs: Math.round((Date.now() - startedAt) * 100) / 100,
    },
  } : observation;

  await sendHome(control);
  if (numberOr(confirmation?.settleMs, 0) > 0) {
    await sleep(numberOr(confirmation?.settleMs, 0));
  }
  let home = await observeUntil(
    phone,
    worker,
    directory,
    state,
    isConfirmedHome,
    numberOr(confirmation?.firstAttemptTimeoutMs, options.homeTimeoutMs),
    pollMs,
    'home',
  );
  if (isConfirmedHome(home)) return reportConfirmation(home, 1);

  // HOME is idempotent. A second key helps if the first frame landed while a
  // transient clipboard toast or another browser-side overlay was visible.
  await sleep(numberOr(confirmation?.retryDelayMs, 500));
  await sendHome(control);
  home = await observeUntil(
    phone,
    worker,
    directory,
    state,
    isConfirmedHome,
    numberOr(confirmation?.retryTimeoutMs, options.homeTimeoutMs),
    pollMs,
    'home-retry',
  );
  if (!isConfirmedHome(home)) {
    throw new Error('返回主页后未识别到足够的桌面锚点（至少需要两个：时钟/日历/通讯录/录音机/音乐/图库）');
  }
  return reportConfirmation(home, 2);
}

async function swipeHomePage(control, direction) {
  const width = control.screenWidth;
  const height = control.screenHeight;
  const y = Math.round(height * 0.43);
  const fromX = direction === 'left' ? Math.round(width * 0.82) : Math.round(width * 0.18);
  const toX = direction === 'left' ? Math.round(width * 0.18) : Math.round(width * 0.82);
  await control.swipe(
    { x: fromX, y },
    { x: toX, y },
    { durationMs: 500, steps: 12 },
  );
  await control.flush();
}

async function findApp(phone, control, worker, directory, state, home, options,
  targetBoxFinder = appTargetBox, targetName = '密钥认证') {
  let current = home;
  const directions = ['left', 'right'];
  const visited = new Set();

  for (const direction of directions) {
    for (let page = 0; page <= options.maxPagesPerDirection; page += 1) {
      const box = targetBoxFinder(current.items);
      if (box && !clipboardToastVisible(current.items)) {
        return { observation: current, box, direction, page };
      }

      const signature = pageSignature(current.items);
      if (signature) visited.add(signature);
      if (page === options.maxPagesPerDirection) break;

      await swipeHomePage(control, direction);
      // A frame during the launcher animation has moving labels/hitboxes.
      // Wait for the gesture and page animation before locating the next icon.
      await sleep(800);
      let previousFrame = '';
      current = await observeUntil(
        phone,
        worker,
        directory,
        state,
        observation => {
          // Only the initial HOME needs the system-app anchors. Later pages
          // may contain only downloaded apps; require two stationary frames.
          const frame = observation.items
            .filter(item => item.centerY > observation.height * 0.06 && item.centerY < observation.height * 0.9)
            .map(item => `${normalizeText(item.text)}:${Math.round(item.centerX / 8)}:${Math.round(item.centerY / 8)}`)
            .join('|');
          const stable = frame.length > 0 && frame === previousFrame && !clipboardToastVisible(observation.items);
          previousFrame = frame;
          return stable;
        },
        options.homeTimeoutMs,
        options.pollMs,
        `home-page-${direction}-${page + 1}`,
      );
      if (!current) continue;
      const nextSignature = pageSignature(current.items);
      if (nextSignature && visited.has(nextSignature)) break;
    }
  }
  throw new Error(`已确认在桌面，但在左右翻页范围内未识别到“${targetName}”应用`);
}

function tapBox(control, box, observation, yOffset = 0) {
  const scaleX = control.screenWidth / Math.max(1, observation.width);
  const scaleY = control.screenHeight / Math.max(1, observation.height);
  const x = Math.round(((box.left + box.right) / 2) * scaleX);
  const y = Math.round(((box.top + box.bottom) / 2) * scaleY + yOffset * scaleY);
  return { x, y };
}

module.exports = {
  numberOr,
  sleep: require('./timing').timed('screen.wait', sleep),
  deviceIdOf,
  normalizeText,
  textOf,
  normalizedTextOf,
  validItems,
  findPhrase,
  findStrictPhrase,
  homeAnchorMatches,
  clipboardToastVisible,
  appTargetBox,
  shellQuote,
  toWslPath,
  RapidOcrWorker,
  screenshotAndOcr,
  observeUntil: require('./timing').timed('screen.observeUntil', observeUntil),
  sendHome: require('./timing').timed('screen.sendHome', sendHome),
  confirmHome: require('./timing').timed('screen.confirmHome', confirmHome),
  swipeHomePage: require('./timing').timed('screen.swipeHomePage', swipeHomePage),
  findApp: require('./timing').timed('screen.findApp', findApp),
  tapBox,
  createOcrDirectory,
};
