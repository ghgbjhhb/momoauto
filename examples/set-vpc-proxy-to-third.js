'use strict';

// Set the third cloud phone to one available VPC line.
// The target is fixed so this entry point cannot accidentally modify another phone.
const { YunmomoClient } = require('..');

const DEVICE_ID = '2030225672674516993';
const DEFAULT_VPC_ID = '';

function deviceIdOf(record) {
  return String(record?.deviceId ?? record?.id ?? '');
}

function isExpired(record) {
  if (!record?.expTime) return false;
  const time = Date.parse(String(record.expTime).replace(' ', 'T'));
  return Number.isFinite(time) && time <= Date.now();
}

function safeShape(raw) {
  const value = raw?.data ?? raw;
  if (value === null || value === undefined) return { type: String(value) };
  if (typeof value !== 'object') return { type: typeof value, length: String(value).length };
  return { type: Array.isArray(value) ? 'array' : 'object', keys: Object.keys(value) };
}

function selectLine(records, requestedId) {
  const available = records.filter(record => !isExpired(record));
  if (requestedId) {
    const selected = available.find(record => String(record.id) === requestedId);
    if (!selected) throw new Error('指定 VPC 线路不存在或已过期: ' + requestedId);
    return selected;
  }
  if (!available.length) throw new Error('当前账号没有未过期的 VPC 线路');
  return available[0];
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }
  if (process.env.YUNMOMO_DEVICE_ID && process.env.YUNMOMO_DEVICE_ID !== DEVICE_ID) {
    throw new Error('第三台 VPC 脚本不接受其他 YUNMOMO_DEVICE_ID: ' + process.env.YUNMOMO_DEVICE_ID);
  }

  const client = new YunmomoClient({ timeoutMs: 100000 });
  const listedDevices = await client.listDevices({ size: 50000 });
  const device = listedDevices.records.find(record => deviceIdOf(record) === DEVICE_ID);
  if (!device) throw new Error('第三台设备不在当前账号设备列表中: ' + DEVICE_ID);

  const lines = (await client.vpc().list({ size: 100 })).records;
  const selected = selectLine(lines, String(process.env.YUNMOMO_VPC_ID || DEFAULT_VPC_ID));
  console.log(JSON.stringify({
    deviceId: DEVICE_ID,
    deviceName: device.deviceName ?? device.name ?? 'SF',
    vpcId: selected.id,
    ip: selected.ip,
    port: selected.port,
    remarks: selected.remarks,
    domainMode: '0',
    proxyMode: 'tun2socks',
  }));

  if (process.env.YUNMOMO_CONFIRM_VPC_PROXY !== 'YES') {
    console.log('预览完成；如确认设置第三台云机代理，请设置 YUNMOMO_CONFIRM_VPC_PROXY=YES 后重跑。');
    return;
  }

  const result = await client.device(DEVICE_ID).setProxy({
    s5ip: selected.ip,
    s5port: selected.port,
    s5user: selected.username,
    s5pwd: selected.password,
    domainMode: '0',
    proxyMode: '2',
    expTime: selected.expTime,
  }, 'v1');
  const readback = await client.device(DEVICE_ID).getProxy('v1');
  console.log(JSON.stringify({
    ok: true,
    deviceId: DEVICE_ID,
    vpcId: selected.id,
    ip: selected.ip,
    port: selected.port,
    setResponse: safeShape(result),
    readback: safeShape(readback),
  }));
}

main = require('../src/automation/timing').timedScript('script.examples.set-vpc-proxy-to-third', main);

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
