'use strict';

const { YunmomoClient } = require('..');

async function main() {
  if (!process.argv.includes('--demo')) throw new Error('Run with --demo to send HOME/Overview/BACK to the selected device');
  const deviceId = process.env.YUNMOMO_DEVICE_ID;
  if (!deviceId) throw new Error('Set YUNMOMO_DEVICE_ID explicitly');
  const phone = new YunmomoClient().device(deviceId);
  const control = await phone.openControl({ udid: process.env.YUNMOMO_UDID || undefined });
  try {
    await control.connect();
    control.home();
    await new Promise(resolve => setTimeout(resolve, 300));
    control.overview();
    await new Promise(resolve => setTimeout(resolve, 300));
    control.back();
    await control.flush();
    console.log('Navigation frames sent; verify the resulting phone screen.');
  } finally { await control.close(); }
}

main = require('../src/automation/timing').timedScript('script.examples.control', main);

main().catch(error => { console.error(error.message); process.exitCode = 1; });
