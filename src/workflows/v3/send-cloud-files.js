'use strict';

// Transfer every private cloud-disk file to one fixed cloud phone.
// The send path is intentionally guarded by YUNMOMO_CONFIRM_SEND=YES because
// rerunning it creates another transfer batch on the target device.
const { YunmomoClient } = require('../../index');

const DEFAULT_DEVICE_ID = '2030225672674516993';
const DEFAULT_POLL_MS = 3000;
const DEFAULT_WAIT_MS = 15 * 60 * 1000;

function asBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function summarizeStatus(raw) {
  const status = raw?.data ?? raw;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  const details = Array.isArray(status.details) ? status.details : [];
  const detailCounts = details.reduce((counts, item) => {
    const state = String(item?.status ?? '').toLowerCase();
    if (state === 'success') counts.success += 1;
    else if (state === 'fail' || state === 'failed') counts.fail += 1;
    else counts.pending += 1;
    return counts;
  }, { success: 0, fail: 0, pending: 0 });
  const totalCount = numberOr(status.totalCount, details.length);
  const successCount = numberOr(status.successCount, detailCounts.success);
  const failCount = numberOr(status.failCount, detailCounts.fail);
  return {
    finished: asBoolean(status.finished),
    expired: asBoolean(status.expired),
    totalCount,
    successCount,
    failCount,
    pendingCount: Math.max(0, totalCount - successCount - failCount),
  };
}

function deviceIdOf(record) {
  return String(record?.deviceId ?? record?.id ?? '');
}

function matchesDevice(record, identifier) {
  const id = String(identifier || '').trim();
  if (!id) return false;
  return deviceIdOf(record) === id ||
    String(record?.deviceCode ?? record?.code ?? record?.cloudNumber ?? '').trim() === id ||
    String(record?.name ?? record?.deviceName ?? '').trim() === id;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTransfer(disk, totalCount, options = {}) {
  const pollMs = numberOr(options.pollMs, DEFAULT_POLL_MS);
  const waitMs = numberOr(options.waitMs, DEFAULT_WAIT_MS);
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    last = summarizeStatus(await disk.transferStatus());
    if (last && (last.finished || last.expired || last.failCount > 0 ||
      last.successCount + last.failCount >= totalCount)) return last;
    await sleep(pollMs);
  }
  throw new Error('Timed out waiting for cloud-file transfer: ' + JSON.stringify(last));
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }

  const deviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID);
  const fileType = String(process.env.YUNMOMO_FILE_TYPE || 'auto');
  const verifyOnly = process.env.YUNMOMO_VERIFY_ONLY === '1';
  const client = new YunmomoClient({ timeoutMs: 100000 });
  const disk = client.cloudDisk();

  const listedDevices = await client.listDevices({ size: 50000 });
  const target = listedDevices.records.find(record => matchesDevice(record, deviceId));
  if (!target) throw new Error('目标设备不在当前账号设备列表中: ' + deviceId);
  const actualDeviceId = deviceIdOf(target);

  const files = await disk.list({ channel: '1', size: 10000 });
  if (!files.records.length) throw new Error('私有云盘没有可传输文件');

  console.log(JSON.stringify({
    targetDeviceId: actualDeviceId,
    targetDeviceIdentifier: deviceId,
    targetDeviceName: target.deviceName ?? target.name ?? 'SF',
    cloudFileCount: files.records.length,
    cloudFileTotal: files.total,
    fileType,
    verifyOnly,
  }));

  if (verifyOnly) {
    console.log(JSON.stringify({ transferStatus: summarizeStatus(await disk.transferStatus()) }));
    return;
  }

  if (process.env.YUNMOMO_CONFIRM_SEND !== 'YES') {
    console.log('预览完成；如确认向该设备传输全部文件，请设置 YUNMOMO_CONFIRM_SEND=YES 后重跑。');
    return;
  }

  await disk.sendToDevices([actualDeviceId], files.records, {
    fileType,
    timeoutMs: 60 * 60 * 1000,
  });
  const status = await waitForTransfer(disk, files.records.length);
  console.log(JSON.stringify({ transfer: status }));
  if (!status.finished || status.expired || status.failCount !== 0 ||
    status.successCount !== files.records.length) {
    throw new Error('云盘传输未全部成功: ' + JSON.stringify(status));
  }
  console.log('SDK cloud-disk transfer OK');
}

waitForTransfer = require('../../automation/timing').timed('workflow.send-cloud-files.waitForTransfer', waitForTransfer);
main = require('../../automation/timing').timedScript('script.src.workflows.v3.send-cloud-files', main);

if (require.main === module) require('../../automation/runtime').launchCli(main);

module.exports = { main, summarizeStatus, waitForTransfer };
