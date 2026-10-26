'use strict';

const { YunmomoClient } = require('..');

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌不要写入代码或提交到仓库');
  }

  const client = new YunmomoClient();
  const result = await client.listDevices({ current: 1, size: 100 });
  const summary = result.records.map((device) => ({
    id: device.id,
    deviceId: device.deviceId,
    name: device.name,
    udid: device.udid,
    status: device.status,
    online: device.online
  }));
  console.log(JSON.stringify(summary, null, 2));
}

main = require('../src/automation/timing').timedScript('script.examples.basic', main);

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
