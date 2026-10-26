'use strict';

// Pinyin KEYCODE frames -> screenshot -> local OCR -> exact candidate tap.
// This module never uses the clipboard, the host keyboard or the send button.
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { YunmomoClient } = require('../client');
const protocol = require('../protocol');
const { RapidOcrWorker } = require('../automation/ocr');

const { PROJECT_ROOT: ROOT } = require('../automation/runtime');
const BROWSER_NINE_KEY = Object.freeze({
  inputRoi: [0.09, 0.373, 0.81, 0.412],
  candidateRoi: [0, 0.537, 0.89, 0.597],
  focus: [0.43, 0.39],
  emptyLabels: ['', '搜索或输入网址', '搜索或输入网址，'],
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function planText(text, python = path.join(ROOT, '.venv-zhtyping', 'Scripts', 'python.exe'), options = {}) {
  if (path.resolve(python) === path.join(ROOT, '.venv-zhtyping', 'Scripts', 'python.exe')) {
    const plan = await require('../automation/recognition-service').planShared(text, options);
    if (plan?.text !== text || !Array.isArray(plan.units) || plan.units.map(unit => unit.text).join('') !== text) {
      throw new Error('Plan does not reconstruct original text');
    }
    return plan;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-X', 'utf8', path.join(ROOT, 'python_workers', 'typing', 'plan.py')],
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: options.signal });
    let output = '', errors = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Pinyin planner failed (${code}): ${errors}`));
      try {
        const plan = JSON.parse(output);
        if (plan.units.map(unit => unit.text).join('') !== text) throw new Error('Plan does not reconstruct original text');
        resolve(plan);
      } catch (error) { reject(error); }
    });
    child.stdin.end(text, 'utf8');
  });
}

function directKey(char) {
  if (/^[a-z]$/i.test(char)) return [protocol.KEY_CODES[char.toUpperCase()], /[A-Z]/.test(char) ? 1 : 0];
  if (/^\d$/.test(char)) return [protocol.KEY_CODES['DIGIT_' + char], 0];
  const plain = { ',': 55, '.': 56, ' ': 62, '-': 69, '=': 70, '[': 71, ']': 72,
    '\\': 73, ';': 74, "'": 75, '/': 76, '`': 68 };
  if (plain[char] !== undefined) return [plain[char], 0];
  const shifted = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7',
    '*': '8', '(': '9', ')': '0', ':': ';', '"': "'", '?': '/', '+': '=', '_': '-', '<': ',', '>': '.', '~': '`' };
  if (shifted[char]) return [directKey(shifted[char])[0], 1];
  // Enter is intentionally unsupported: a typing module must not submit a chat.
  throw new Error(`Unsupported direct keystroke: ${JSON.stringify(char)}`);
}

function selectExactCandidate(candidates, wanted, minimumScore = 0.8) {
  const available = Array.isArray(candidates) ? candidates : [];
  const matches = available
    .filter(candidate => candidate && candidate.text === wanted && candidate.score >= minimumScore);
  if (matches.length) {
    // Prefer the strongest complete-text match when OCR repeats the same entry.
    return [...matches].sort((a, b) => Number(b.score) - Number(a.score))[0];
  }
  // A substring does not identify a selectable candidate: "我" inside "我们"
  // may belong to one phrase, not a separate entry. Let the existing detector
  // and per-character fallback retry rather than inventing a tap coordinate.
  return null;
}

async function runWsImeInput(options) {
  const { client, deviceId, udid, text } = options;
  if (!client || !deviceId || !udid || !text) throw new Error('client, deviceId, udid and text are required');
  const plan = await planText(text, options.python);
  if (!options.live) return { mode: 'dry-run', deviceId, plan };
  const profile = options.profile || BROWSER_NINE_KEY;
  const interval = options.keyIntervalMs ?? 55;
  const settle = options.settleMs ?? 250;
  const log = options.log || (value => console.log(JSON.stringify(value)));
  const directory = options.outputDir || await fs.mkdtemp(path.join(ROOT, '.local-output', 'auto-ime-'));
  await fs.mkdir(directory, { recursive: true });
  const phone = client.device(String(deviceId));
  const worker = options.worker || new RapidOcrWorker({ workerPath: path.join(ROOT, 'python_workers', 'ocr', 'ime_ocr_worker.py') });
  let control, frameNumber = 0, prefix = '';
  const started = Date.now();
  const report = { deviceId: String(deviceId), udid, text, tokens: plan.tokens, steps: [],
    autonomous: true, sent: false, outputDir: directory, ok: false };
  const regions = { input_roi: profile.inputRoi, candidate_roi: profile.candidateRoi };
  async function capture(label, fullField = false) {
    const tick = Date.now();
    const screenshot = await phone.screenshot({ level: 2 });
    const file = path.join(directory, `${String(frameNumber++).padStart(2, '0')}-${label}.jpg`);
    const writing = fs.writeFile(file, screenshot.data);
    const tasks = await Promise.allSettled([writing, worker instanceof require('../automation/ocr').LegacyRapidOcrWorker ?
      writing.then(() => worker.recognize(file, { ...regions, full_field: fullField })) :
      worker.recognize(screenshot.data, { ...regions, full_field: fullField })]);
    for (const task of tasks) if (task.status === 'rejected') throw task.reason;
    return { ...tasks[1].value, file, image: screenshot.data, capture_ms: Date.now() - tick };
  }
  async function key(code, meta = 0) {
    control.keyDown(code, { metaState: meta });
    await sleep(25);
    control.keyUp(code, { metaState: meta });
    await control.flush();
    await sleep(interval);
  }
  async function tapNormalized(x, y) {
    await control.tap(Math.round(x * control.screenWidth), Math.round(y * control.screenHeight));
    await control.flush();
  }
  async function verify(expected, label, empty = false) {
    let observed;
    for (let attempt = 0; attempt < 4; attempt++) {
      observed = await capture(label + '-' + attempt);
      if (observed.input_text === expected || (empty && profile.emptyLabels.includes(observed.input_text))) return observed;
      const detected = await worker.recognize(observed.image, { ...regions, full_field: true });
      if (detected.input_text === expected || (empty && profile.emptyLabels.includes(detected.input_text))) {
        return { ...observed, ...detected, inputSource: 'detector-fallback' };
      }
      await sleep(250);
    }
    throw new Error(`Input OCR mismatch: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(observed.input_text)}`);
  }
  try {
    // Verify this field before touching it. Replacement is not implied by live.
    const before = await capture('before', true);
    const expectedExisting = options.expectedExisting ?? '';
    if (before.input_text !== expectedExisting && !(expectedExisting === '' && profile.emptyLabels.includes(before.input_text))) {
      throw new Error(`Wrong input field/content: expected ${JSON.stringify(expectedExisting)}, saw ${JSON.stringify(before.input_text)}`);
    }
    control = await phone.openControl({ udid });
    await control.connect();
    const countdown = options.countdownSeconds ?? 5;
    log({ stage: 'starting', deviceId, text, countdownSeconds: countdown, candidateSelection: 'local-ocr-exact-match' });
    await sleep(countdown * 1000);
    await tapNormalized(...profile.focus);
    await sleep(settle);
    if (expectedExisting) {
      if (!options.replaceExisting) throw new Error('Existing draft found; explicit replaceExisting is required');
      await key(protocol.KEY_CODES.A, protocol.META.CTRL_ON);
      await key(protocol.KEY_CODES.DEL);
      await sleep(settle);
      await verify('', 'cleared', true);
    }
    const queue = [...plan.units];
    for (let index = 0; index < queue.length; index++) {
      const unit = queue[index], tick = Date.now();
      let selected = null, view = null;
      if (unit.kind === 'pinyin') {
        if (!/^[a-z]+$/.test(unit.pinyin)) throw new Error(`Unsupported pinyin: ${unit.pinyin}`);
        for (const char of unit.pinyin) await key(protocol.KEY_CODES[char.toUpperCase()]);
        await sleep(settle);
        for (let attempt = 0; attempt < (unit.text.length > 1 ? 2 : 4); attempt++) {
          view = await capture(`candidate-${index}-${attempt}`);
          selected = selectExactCandidate(view.candidates, unit.text, options.minimumScore ?? 0.8);
          if (!selected) {
            const detected = await worker.recognize(view.image, { ...regions, detected_candidates: true });
            const match = selectExactCandidate(detected.candidates, unit.text, options.minimumScore ?? 0.8);
            if (match) { view = { ...view, ...detected }; selected = match; }
          }
          if (selected) break;
          await sleep(250);
        }
        if (!selected && unit.text.length > 1 && unit.syllables?.length === unit.text.length) {
          // IME dictionaries may not contain a whole jieba phrase. Cancel its
          // uncommitted composition, verify the draft and split automatically.
          for (const char of unit.pinyin) await key(protocol.KEY_CODES.DEL);
          await sleep(settle);
          await verify(prefix, `fallback-${index}`, prefix === '');
          const cut = Math.ceil(unit.text.length / 2);
          const split = [[0, cut], [cut, unit.text.length]].map(([left, right]) => ({
            ...unit, text: unit.text.slice(left, right), syllables: unit.syllables.slice(left, right),
            pinyin: unit.syllables.slice(left, right).join(''), source: 'automatic-candidate-fallback',
          }));
          queue.splice(index, 1, ...split);
          log({ stage: 'automatic-split', text: unit.text, parts: split.map(part => part.text) });
          index--;
          continue;
        }
        if (!selected) throw new Error(`No confident exact candidate for ${unit.text}: ${view.candidates.map(c => c.text).join('|')}`);
        await tapNormalized(selected.center_x / view.width, selected.center_y / view.height);
      } else {
        for (const action of unit.actions) {
          if (action.action === 'press') {
            if (action.key !== 'space') throw new Error('Only space may be pressed by this draft-only module');
            await key(protocol.KEY_CODES.SPACE);
          } else await key(...directKey(action.key));
        }
      }
      prefix += unit.text;
      await sleep(settle);
      const verified = await verify(prefix, `verified-${index}`);
      const step = { text: unit.text, pinyin: unit.pinyin || null,
        candidates: view?.candidates.map(c => ({ text: c.text, score: c.score })) || [],
        selected: selected ? { text: selected.text, score: selected.score, x: selected.center_x, y: selected.center_y } : null,
        verifiedText: verified.input_text, ocrMs: view?.elapsed_ms ?? verified.elapsed_ms,
        stepMs: Date.now() - tick, screenshot: verified.file };
      report.steps.push(step);
      log({ stage: 'verified', ...step });
    }
    report.ok = true;
    report.finalText = prefix;
    report.finalScreenshot = report.steps.at(-1).screenshot;
    return report;
  } catch (error) {
    report.error = error.message;
    log({ stage: 'stopped', error: error.message, completedText: prefix, outputDir: directory });
    throw error;
  } finally {
    report.elapsedMs = Date.now() - started;
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    if (control) await control.close();
    if (!options.worker) await worker.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const deviceId = value('--device-id');
  const text = value('--text');
  if (!deviceId || !text) throw new Error('Usage: node scripts/ws-ime-input.js --device-id ID --text TEXT [--live]');
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ mode: 'dry-run', deviceId, plan: await planText(text) }, null, 2));
    return;
  }
  const client = new YunmomoClient({ token: process.env.YUNMOMO_TOKEN });
  const listing = await client.listDevices({ size: 50000 });
  const records = Array.isArray(listing) ? listing : (listing.records || listing.data?.records || listing.data || []);
  const device = records.find(record => String(record.deviceId ?? record.id) === String(deviceId));
  if (!device?.udid) throw new Error('Exact deviceId/UDID not found; will not use list order');
  const report = await runWsImeInput({ client, deviceId, udid: device.udid, text, live: true,
    expectedExisting: value('--expected-existing'), replaceExisting: args.includes('--replace-existing') });
  console.log(JSON.stringify({ stage: 'finished', ok: report.ok, text: report.finalText,
    elapsedMs: report.elapsedMs, outputDir: report.outputDir, sent: false }));
}

runWsImeInput = require('../automation/timing').timed('typing.run', runWsImeInput, options => ({ deviceId: options?.deviceId }));
planText = require('../automation/timing').timed('typing.plan', planText);
main = require('../automation/timing').timedScript('script.src.typing.ws-ime-input', main);

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, BROWSER_NINE_KEY, planText, directKey, selectExactCandidate, runWsImeInput };
