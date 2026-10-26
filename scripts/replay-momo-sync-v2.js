'use strict';
// Explicit offline replay. Uses the real shared recognizers, never touches a phone or production DB.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SharedRecognitionClient } = require('../src/automation/recognition-service');
const { readFrame, mergeOlder } = require('../src/tools/momo/chat-frame');

function verifyArchives(frames) {
  const norm = messages => messages.map(m => [m.sender, m.text.normalize('NFKC')]);
  const greetings = [['peer', '嗨'], ['self', '嗨,小飞哥'], ['peer', '吓我一跳!'], ['peer', '是一个小区的'], ['peer', '?']];
  const verified = [];
  for (const run of ['run-2ttGuK', 'run-cuvyuE', 'run-Ta7OMJ']) {
    const group = frames.filter(f => path.dirname(f.screenshot).endsWith(run));
    if (!group.length) continue;
    const expected = run === 'run-2ttGuK' ? Array.from({ length: 7 }, () => [['peer', '吗'], ['peer', '?']]) :
      run === 'run-cuvyuE' ? [greetings.slice(1), greetings.slice(1), greetings.slice(1), greetings.slice(0, 2),
        [], [], [], greetings.slice(0, 3), greetings.slice(0, 1), greetings.slice(0, 1), greetings.slice(0, 1)] :
      Array.from({ length: 28 }, (_, i) => i < 4 ? [...greetings.slice(1), ['peer', '在干嘛呢']] : i < 6 ? greetings.slice(1) :
        i < 8 ? greetings.slice(0, 4) : i < 10 ? greetings.slice(0, 2) : i < 22 ? greetings.slice(0, 1) : []);
    assert.equal(group.length, expected.length, run);
    group.forEach((frame, index) => {
      assert.deepEqual(norm(frame.messages), expected[index], frame.screenshot);
      assert.equal(frame.pending.length, 0, frame.screenshot);
      if (!expected[index].length) assert.equal(frame.origin, true, frame.screenshot);
    });
    if (run !== 'run-2ttGuK') {
      const history = group[0].messages.slice(); let previous = history.slice();
      for (const index of run === 'run-cuvyuE' ? [3, 8] : [6, 8, 10]) {
        assert.equal(mergeOlder(history, previous, group[index].messages, group[index].height).ok, true, group[index].screenshot);
        previous = group[index].messages;
      }
      assert.deepEqual(norm(history), run === 'run-cuvyuE' ? greetings : [...greetings, ['peer', '在干嘛呢']]);
    }
    verified.push(run);
  }
  return verified;
}

async function main() {
  const sources = process.argv.slice(2);
  if (!sources.length) sources.push('.local-output/momo-sync/run-2ttGuK', '.local-output/momo-sync/run-cuvyuE');
  const root = path.resolve('.local-output/momo-rewrite');
  await fs.mkdir(root, { recursive: true });
  const output = await fs.mkdtemp(path.join(root, 'replay-'));
  const pool = new SharedRecognitionClient(), frames = [];
  let passed = false;
  try {
    for (const source of sources) {
      const names = (await fs.readdir(source)).filter(name => /^\d+-.*\.(png|jpg)$/.test(name)).sort();
      for (const name of names) {
        const file = path.resolve(source, name), image = await fs.readFile(file);
        const [ocr, detail] = await Promise.all([pool.ocr(image), pool.chatDetail(image, { confidence: .30 })]);
        assert.equal(ocr.ok, true, JSON.stringify(ocr.error)); assert.equal(detail.ok, true, JSON.stringify(detail.error));
        const frame = await readFrame(pool, { shot: { image, width: detail.data.width, height: detail.data.height }, ocr: ocr.data, detail: detail.data });
        const summary = { screenshot: file, ...frame.parsed, reread: frame.reread, ocr: frame.ocr, detail: detail.data };
        frames.push(summary);
        console.log(JSON.stringify({ file, messages: summary.messages.map(m => [m.sender, m.text]), pending: summary.pending.length, clipped: summary.clipped.length }));
        if (source.endsWith('run-2ttGuK')) {
          assert.deepEqual(summary.messages.map(m => [m.sender, m.text.normalize('NFKC')]), [['peer', '吗'], ['peer', '?']]);
          assert.equal(summary.pending.length, 0);
        }
      }
    }
    verifyArchives(frames);
    passed = true;
  } finally {
    const result = { output, sources, frames, passed, knownStickerRegressionPassed: passed && sources.some(s => s.endsWith('run-2ttGuK')),
      pendingFrames: frames.filter(f => f.pending.length).length };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ report: path.join(output, 'report.json'), frames: frames.length, pendingFrames: result.pendingFrames, passed }));
    await pool.close();
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verifyArchives };
