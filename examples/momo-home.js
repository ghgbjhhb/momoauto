'use strict';

// Preview by default. Never guesses a device from browser order or the name SF.
const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../src');

async function main() {
  const args = process.argv.slice(2);
  let execute = false, refreshOnly = false, deviceId = process.env.YUNMOMO_DEVICE_ID, cycles = 1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') execute = true;
    else if (arg === '--refresh-only') refreshOnly = true;
    else if (arg === '--device-id') {
      deviceId = args[++i];
      if (!deviceId || deviceId.startsWith('--')) throw new Error('--device-id requires a backend device ID');
    } else if (arg === '--cycles') {
      cycles = Number(args[++i]);
      if (!Number.isInteger(cycles) || cycles < 1 || cycles > 100) throw new Error('--cycles must be an integer from 1 to 100');
    } else throw new Error('Usage: node examples/momo-home.js [--refresh-only] [--cycles N] [--execute --device-id ID]');
  }
  if (execute && !deviceId) throw new Error('--execute requires --device-id or YUNMOMO_DEVICE_ID; no phone is selected automatically');
  if (execute && !process.env.YUNMOMO_TOKEN?.trim()) throw new Error('Set YUNMOMO_TOKEN before real execution');
  const tools = new YunmomoClient().device(deviceId ?? 'local-preview-only').tools();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    const result = refreshOnly ? await tools.refreshMomoHome({ execute, signal: controller.signal }) :
      await tools.browseMomoHome({ execute, cycles, signal: controller.signal });
    let output = result;
    if (execute) {
      const parent = path.resolve(__dirname, '../.local-output/momo-home');
      await fs.mkdir(parent, { recursive: true });
      const directory = await fs.mkdtemp(path.join(parent, 'run-'));
      const shot = result.data?.lastScreenshot;
      let lastScreenshot = null;
      if (shot) {
        const imagePath = path.join(directory, 'last.' + (shot.format === 'png' ? 'png' : 'jpg'));
        await fs.writeFile(imagePath, shot.image, { flag: 'wx' });
        const { image, ...metadata } = shot;
        lastScreenshot = { ...metadata, imagePath };
      }
      output = { ...result, data: result.data ? { ...result.data, lastScreenshot } : null, reportPath: path.join(directory, 'report.json') };
      await fs.writeFile(output.reportPath, JSON.stringify(output, null, 2), { flag: 'wx' });
    }
    console.log(JSON.stringify(output, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    await tools.close();
  }
}

main = require('../src/automation/timing').timedScript('script.examples.momo-home', main);

main().catch(error => { console.error(error.code ?? 'CLI_FAILED', error.message); process.exitCode = 1; });
