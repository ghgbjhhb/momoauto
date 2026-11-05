'use strict';

// Transfer every private cloud-disk file, then transfer designated public-disk files to one cloud phone.
// The send path is intentionally guarded by YUNMOMO_CONFIRM_SEND=YES because
// rerunning it creates another transfer batch on the target device.
const { YunmomoClient } = require('../../index');

const DEFAULT_DEVICE_ID = '1920787385311416321'; // GVIP701808715424
const DEFAULT_POLL_MS = 3000;
const DEFAULT_WAIT_MS = 15 * 60 * 1000;

const DEFAULT_PUBLIC_FILE_TARGETS = Object.freeze([
  { id: '2113105536031281154', label: '抖音', appName: '抖音', packageName: 'com.ss.android.ugc.aweme' },
  { id: '2063926414024982529', label: '美团外卖', appName: '美团外卖', packageName: 'com.sankuai.meituan.takeoutnew' },
  { id: '2063926297389776898', label: '铁路 12306', appName: 'Railway 12306', packageName: 'com.MobileTicket' },
  { id: '2063991577545621505', label: '高德地图', appName: 'Amap', packageName: 'com.autonavi.minimap' },
  { id: '2063913782417113089', label: '支付宝', appName: 'Alipay', packageName: 'com.eg.android.AlipayGphone' },
  { id: '2063915978965729281', label: 'QQ音乐', appName: 'QQ音乐', packageName: 'com.tencent.qqmusic' },
]);

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
    stage: String(status.stage ?? ''),
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

function selectPublicFiles(allPublicFiles, targets = DEFAULT_PUBLIC_FILE_TARGETS) {
  const selected = [];
  for (const target of targets) {
    const match = allPublicFiles.find(file => {
      if (target.id && String(file.id) === String(target.id)) return true;
      if (target.packageName && file.packageName === target.packageName) return true;
      if (target.appName && (file.appName === target.appName || file.name === target.name)) return true;
      return false;
    });
    if (!match) {
      throw new Error(`公共文件库中未找到目标文件: ${target.label || target.appName || target.id}`);
    }
    if (!selected.some(item => String(item.id) === String(match.id))) {
      selected.push({ ...match, displayLabel: target.label || match.appName || match.name });
    }
  }
  return selected;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function renderProgressBar(current, total, length = 20) {
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const filled = Math.min(length, Math.round((percent / 100) * length));
  const bar = '█'.repeat(filled) + '░'.repeat(length - filled);
  return `[${bar}] ${percent}% (${current}/${total})`;
}

async function waitForTransfer(disk, totalCount, stageLabel, options = {}) {
  const pollMs = numberOr(options.pollMs, DEFAULT_POLL_MS);
  const waitMs = numberOr(options.waitMs, DEFAULT_WAIT_MS);
  const deadline = Date.now() + waitMs;
  await sleep(1500);
  let last = null;
  let lastLoggedKey = '';
  while (Date.now() < deadline) {
    last = summarizeStatus(await disk.transferStatus());
    if (last) {
      const processed = last.successCount + last.failCount;
      const progressKey = `${processed}/${totalCount}-${last.finished}`;
      if (progressKey !== lastLoggedKey) {
        lastLoggedKey = progressKey;
        const bar = renderProgressBar(processed, totalCount);
        console.log(`[${stageLabel}] 进度: ${bar} | 成功: ${last.successCount}, 失败: ${last.failCount}, 待处理: ${last.pendingCount}`);
      }
      if (last.finished || last.expired || last.failCount > 0 ||
        (last.totalCount === totalCount && processed >= totalCount)) {
        return last;
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`[${stageLabel}] 传输超时: ` + JSON.stringify(last));
}

async function runStep(context = {}) {
  const deviceId = String(context.deviceId || process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID);
  const fileType = String(context.options?.fileType || process.env.YUNMOMO_FILE_TYPE || 'auto');
  const verifyOnly = context.options?.verifyOnly === true || process.env.YUNMOMO_VERIFY_ONLY === '1';

  let client = context.client || new YunmomoClient({ timeoutMs: 100000 });
  const disk = client.cloudDisk();

  let target = context.target;
  if (!target) {
    const listedDevices = await client.listDevices({ size: 50000 });
    target = listedDevices.records.find(record => matchesDevice(record, deviceId));
    if (!target) throw new Error('目标设备不在当前账号设备列表中: ' + deviceId);
  }
  const actualDeviceId = deviceIdOf(target);

  const privateFiles = await disk.list({ channel: '1', size: 10000 });
  if (!privateFiles.records.length) throw new Error('私有云盘没有可传输文件');

  const publicDiskFiles = await disk.list({ channel: '2', size: 10000 });
  const publicFiles = selectPublicFiles(publicDiskFiles.records);

  console.log(`目标云机: ${context.deviceName ?? target.deviceName ?? target.name ?? 'SF'} (${actualDeviceId})`);
  console.log(`文件清单: 私有云盘 ${privateFiles.records.length} 个，公共应用 ${publicFiles.length} 个`);
  console.log(`公共应用: ${publicFiles.map(f => f.displayLabel || f.appName || f.name).join('、')}`);

  if (verifyOnly) {
    console.log(JSON.stringify({ transferStatus: summarizeStatus(await disk.transferStatus()) }));
    return { ok: true };
  }

  // 第一阶段：向云机传输私有云盘所有文件
  console.log(`\n[Phase 1/2] 开始向云机传输私有云盘文件（共 ${privateFiles.records.length} 个）...`);
  await disk.sendToDevices([actualDeviceId], privateFiles.records, {
    fileType,
    timeoutMs: 60 * 60 * 1000,
  });
  const privateStatus = await waitForTransfer(disk, privateFiles.records.length, '私有云盘');
  if (!privateStatus.finished || privateStatus.expired || privateStatus.failCount !== 0 ||
    privateStatus.successCount !== privateFiles.records.length) {
    throw new Error('私有云盘文件传输未全部成功: ' + JSON.stringify(privateStatus));
  }
  console.log(`[Phase 1/2] 私有云盘文件全部传输完成！\n`);

  // 第二阶段：等待私有传输完成后，向云机传输指定的公共文件
  console.log(`[Phase 2/2] 开始向云机传输公共云盘指定应用（共 ${publicFiles.length} 个）...`);
  await disk.sendToDevices([actualDeviceId], publicFiles, {
    fileType,
    timeoutMs: 60 * 60 * 1000,
  });
  const publicStatus = await waitForTransfer(disk, publicFiles.length, '公共文件');
  if (!publicStatus.finished || publicStatus.expired || publicStatus.failCount !== 0 ||
    publicStatus.successCount !== publicFiles.length) {
    throw new Error('公共云盘指定应用传输未全部成功: ' + JSON.stringify(publicStatus));
  }
  console.log(`[Phase 2/2] 公共云盘指定应用全部传输完成！`);
  console.log('>>> 全部云盘与公共应用传输成功 OK');
  return { ok: true, privateCount: privateFiles.records.length, publicCount: publicFiles.length };
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }

  const deviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID);
  if (process.env.YUNMOMO_CONFIRM_SEND !== 'YES') {
    console.log('预览完成；如确认向该设备传输全部文件，请设置 YUNMOMO_CONFIRM_SEND=YES 后重跑。');
    return;
  }

  return await runStep({ deviceId });
}

waitForTransfer = require('../../automation/timing').timed('workflow.send-cloud-files.waitForTransfer', waitForTransfer);
main = require('../../automation/timing').timedScript('script.src.workflows.v2.send-cloud-files', main);

if (require.main === module) require('../../automation/runtime').launchCli(main);

module.exports = { main, runStep, summarizeStatus, waitForTransfer };
