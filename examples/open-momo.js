'use strict';

const fs = require('node:fs/promises');
const { parseArgs } = require('node:util');
const { YunmomoClient } = require('../src');
const { MomoVision } = require('../src/tools/momo-vision');
const { OperationContext } = require('../src/tools/runtime');

async function main() {
  const { values } = parseArgs({ options: { image: { type: 'string' }, execute: { type: 'boolean' },
    'device-id': { type: 'string' }, timeout: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Plan only: node examples/open-momo.js\nOffline image: node examples/open-momo.js --image <SDK image>\nReal launch: node examples/open-momo.js --execute --device-id <ID> [--timeout 60000]');
    return;
  }
  const timeoutMs = values.timeout === undefined ? 60000 : Number(values.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('--timeout must be an integer from 1 to 300000');
  if (values.image && (values.execute || values['device-id'])) throw new Error('--image cannot be combined with device actions');
  if (values.image) {
    const meta = await fs.stat(values.image);
    if (!meta.isFile() || meta.size > 32 * 1024 * 1024) throw new Error('--image requires a file no larger than 32 MiB');
    const image = await fs.readFile(values.image);
    const vision = new MomoVision();
    const ctx = new OperationContext(timeoutMs, undefined, new AbortController().signal);
    try {
      const info = await vision.start(ctx);
      const observation = await vision.inspect(image, { confidence: 0.65, iconThreshold: 0.86, anchorThreshold: 0.88 }, ctx);
      const { thumbnail, ...summary } = observation;
      console.log(JSON.stringify({ mode: 'offline_image_only', device: info.device, gpu: info.gpu, observation: summary }, null, 2));
    } finally { ctx.cleanup(); await vision.close(); }
    return;
  }
  if (values.execute && !values['device-id']) throw new Error('--execute requires an explicit --device-id');
  const phone = new YunmomoClient().device(values['device-id'] ?? 'local-preview-only');
  const tools = phone.tools();
  try {
    const result = await tools.openMomo({ timeoutMs, dryRun: !values.execute });
    const data = result.data && { ...result.data };
    if (data?.lastScreenshot) {
      const { image, ...metadata } = data.lastScreenshot;
      data.lastScreenshot = { ...metadata, note: 'Image bytes retained in API result; omitted from console output' };
    }
    console.log(JSON.stringify({ ...result, data }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally { await tools.close(); }
}

main = require('../src/automation/timing').timedScript('script.examples.open-momo', main);

main().catch(error => { console.error(error.message); process.exitCode = 1; });
