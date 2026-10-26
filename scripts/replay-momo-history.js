'use strict';

// Offline, read-only phone replay. Run explicitly; not part of node --test discovery.
// Recognition requests are bounded by the
// existing shared service; screenshots and the production database are not changed.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SharedRecognitionClient } = require('../src/automation/recognition-service');
const { completeChatBubbleOcr } = require('../src/tools/momo/chat-bubble-ocr');
const { visibleMessages, prependChatPage } = require('../src/tools/momo/chat-history');

async function main() {
  const source = path.resolve(process.argv[2] ?? '.local-output/momo-sync/run-cuvyuE');
  const outputRoot = path.resolve('.local-output/momo-history-replay');
  await fs.mkdir(outputRoot, { recursive: true });
  const output = await fs.mkdtemp(path.join(outputRoot, 'run-'));
  const pool = new SharedRecognitionClient();
  const frames = [];
  try {
    const names = (await fs.readdir(source)).filter(name => /^\d+-observe_screen\.png$/.test(name)).sort();
    for (const name of names) {
      const image = await fs.readFile(path.join(source, name));
      const [ocrResult, detailResult] = await Promise.all([pool.ocr(image), pool.chatDetail(image, { confidence: .30 })]);
      assert.equal(ocrResult.ok, true, JSON.stringify(ocrResult.error));
      assert.equal(detailResult.ok, true, JSON.stringify(detailResult.error));
      const detail = detailResult.data;
      const obs = await completeChatBubbleOcr(pool, {
        shot: { image, width: detail.width, height: detail.height },
        ocr: ocrResult.data, detail,
      });
      const messages = visibleMessages(obs.parsed);
      const frame = { screenshot: path.join(source, name), messages, excludedCards: obs.parsed.excludedCards,
        originNotice: obs.parsed.isTopReachedByKeyword, bubbleOcr: obs.bubbleOcr, unresolved: obs.unresolvedBubbleRegions,
        ocr: obs.ocr, detail };
      frames.push(frame);
      console.log(JSON.stringify({ frame: name, messages: messages.map(m => ({ sender: m.sender, text: m.text })),
        excludedCards: frame.excludedCards.length, unresolved: frame.unresolved.length }));
    }
    const report = { source, output, frames, recognitionCompleted: true, visualExpectationsChecked: false };
    if (source.endsWith('run-cuvyuE')) {
      assert.equal(frames.length, 11);
      for (const n of [0, 1, 2]) assert.deepEqual(frames[n].messages.map(m => m.text), ['嗨，小飞哥', '吓我一跳！', '是一个小区的', '?']);
      assert.deepEqual(frames[3].messages.map(m => m.text), ['嗨', '嗨，小飞哥']);
      for (const n of [4, 5, 6]) { assert.deepEqual(frames[n].messages, []); assert.equal(frames[n].originNotice, true); }
      assert.deepEqual(frames[7].messages.map(m => m.text), ['嗨', '嗨，小飞哥', '吓我一跳！']);
      for (const n of [8, 9, 10]) assert.deepEqual(frames[n].messages.map(m => m.text), ['嗨']);
      assert.ok(frames.every(frame => frame.unresolved.length === 0));
      const history = frames[0].messages.map(m => ({ ...m }));
      let previous = frames[0].messages;
      for (const n of [3, 8]) previous = prependChatPage(history, previous, frames[n].messages, 1280);
      report.reconstructed = history.map(({ sender, text }) => ({ sender, text }));
      assert.deepEqual(report.reconstructed, [
        { sender: 'peer', text: '嗨' }, { sender: 'self', text: '嗨，小飞哥' },
        { sender: 'peer', text: '吓我一跳！' }, { sender: 'peer', text: '是一个小区的' },
        { sender: 'peer', text: '?' },
      ]);
      report.visualExpectationsChecked = true;
    }
    if (report.visualExpectationsChecked) report.passed = true;
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ recognitionCompleted: true, visualExpectationsChecked: report.visualExpectationsChecked,
      passed: report.passed, frames: frames.length, report: path.join(output, 'report.json'), messages: report.reconstructed }));
  } finally { await pool.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
