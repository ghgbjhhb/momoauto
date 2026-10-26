'use strict';

// Safe by default: plans actions locally, without network, credentials or phone input.
// Real use: node examples/device-tools.js --live --device-id <backend device ID>
const { writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { YunmomoClient } = require('../src');

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const idAt = args.indexOf('--device-id');
  const deviceId = idAt >= 0 ? args[idAt + 1] : undefined;
  const allowed = new Set(['--live', '--device-id']);
  if (args.some((arg, i) => !(idAt >= 0 && i === idAt + 1) && !allowed.has(arg))) throw new Error('Usage: node examples/device-tools.js [--live --device-id ID]');
  if ((idAt >= 0 && (!deviceId || deviceId.startsWith('--'))) || (live && !deviceId)) throw new Error('--live requires an explicit --device-id');
  const client = new YunmomoClient();
  const tools = client.device(deviceId ?? 'local-preview-only').tools({
    dryRun: !live, screenSize: { width: 400, height: 720 }, logger: entry => console.log(JSON.stringify(entry))
  });
  try {
    let coordinateSpace = { width: 360, height: 640 };
    if (live) {
      const capture = await tools.screenshot();
      if (!capture.ok) { console.error(capture); process.exitCode = 1; return; }
      coordinateSpace = { width: capture.data.width, height: capture.data.height };
      const output = resolve('device-tools-capture.' + capture.data.format);
      await writeFile(output, capture.data.image, { flag: 'wx' });
      console.log('Screenshot:', output, coordinateSpace);
      // A live invocation captures ONLY. Click/swipe destinations depend on the actual UI.
      return;
    }
    console.log(await tools.click(180, 320, { coordinateSpace, jitterPx: 2, holdMs: { min: 65, max: 110 } }));
    console.log(await tools.swipe([
      { x: 180, y: 520 }, { x: 170, y: 350, pauseMs: 40 }, { x: 180, y: 160 }
    ], { coordinateSpace, segmentDurationsMs: [240, 300] }));
  } finally { await tools.close(); }
}

main = require('../src/automation/timing').timedScript('script.examples.device-tools', main);

main().catch(error => { console.error(error.message); process.exitCode = 1; });
