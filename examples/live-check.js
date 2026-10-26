'use strict';

const { YunmomoClient } = require('..');

async function main() {
  const client = new YunmomoClient();
  const { records, total } = await client.listDevices();
  console.log('REST device list OK; total=' + total);
  const deviceId = process.env.YUNMOMO_DEVICE_ID;
  if (!deviceId) {
    console.log('Set YUNMOMO_DEVICE_ID for screenshot/stream checks. No device was selected automatically.');
    return;
  }
  const record = records.find(d => String(d.deviceId ?? d.id) === deviceId);
  if (!record) throw new Error('Configured deviceId is not in the current device list');
  const phone = client.device(deviceId);
  const screenshot = await phone.screenshot();
  console.log('Screenshot OK; bytes=' + screenshot.data.length + '; contentType=' + screenshot.contentType);
  const control = await phone.openControl({ udid: process.env.YUNMOMO_UDID || record.udid });
  try {
    await control.connect();
    console.log('WebSocket initial metadata OK; videoSize=' + control.screenWidth + 'x' + control.screenHeight);
  } finally { await control.close(); }
}

main = require('../src/automation/timing').timedScript('script.examples.live-check', main);

main().catch(error => { console.error(error.message); process.exitCode = 1; });
