'use strict';

// Upload one .cert/.xml Google certificate to one cloud phone.
// The write path is guarded so a normal run only previews the target.
const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../../index');

const DEFAULT_DEVICE_ID = '1920787385311416321'; // GVIP701808715424 (V2)
const DEFAULT_CERT_PATH = 'C:\\Users\\Administrator\\Documents\\app\\keybox(2)(1) (1).xml';

function deviceIdOf(record) {
  return String(record?.deviceId ?? record?.id ?? '');
}

function matchesDevice(record, identifier) {
  const id = String(identifier || '').trim();
  if (!id) return false;
  if (deviceIdOf(record) === id ||
    String(record?.deviceCode ?? record?.code ?? record?.cloudNumber ?? '').trim() === id) {
    return true;
  }
  if (String(record?.name ?? record?.deviceName ?? '').trim() === id) {
    return String(record?.sdkVersion ?? '').toLowerCase() === 'v2';
  }
  return false;
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }

  const deviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID);
  const filePath = String(process.env.YUNMOMO_CERT_PATH || DEFAULT_CERT_PATH);
  const fileName = path.basename(filePath);
  const client = new YunmomoClient({ timeoutMs: 100000 });
  const reads = await Promise.allSettled([client.listDevices({ size: 50000 }), fs.readFile(filePath)]);
  if (reads[0].status === 'rejected') throw reads[0].reason;
  const listedDevices = reads[0].value;
  const target = listedDevices.records.find(record => matchesDevice(record, deviceId));
  if (!target) throw new Error('目标设备不在当前账号设备列表中: ' + deviceId);
  const actualDeviceId = deviceIdOf(target);

  if (reads[1].status === 'rejected') throw reads[1].reason;
  const data = reads[1].value;
  const sizeKb = (data.length / 1024).toFixed(2);
  const deviceName = target.deviceName ?? target.name ?? 'SF';
  const sdkVer = String(target.sdkVersion || 'V2').toUpperCase();

  console.log(`[准备] 目标云机: ${deviceName} (ID: ${actualDeviceId}, 系统: ${sdkVer})`);
  console.log(`[准备] 证书文件: ${fileName} (${sizeKb} KB)`);

  if (process.env.YUNMOMO_CONFIRM_CERT_UPLOAD !== 'YES' && !process.argv.includes('--execute')) {
    console.log('[提示] 当前为只读预览，未实际写入。确认上传请传入 --execute 或配置执行参数。');
    return;
  }

  console.log(`[执行] 正在上传证书到云机...`);
  const result = await client.device(actualDeviceId).uploadGoogleCertificate(data, {
    fileName,
    timeoutMs: 10 * 60 * 1000,
  });
  const payload = result?.data ?? result;
  if (payload && typeof payload === 'object' && payload.success === false) {
    throw new Error('云端处理失败: ' + (payload.message || JSON.stringify(payload)));
  }
  const replyText = typeof payload === 'string' ? payload : (payload?.message || '上传成功');
  console.log(`[完成] ✅ 证书上传成功！云端确认返回: ${replyText}`);
}

main = require('../../automation/timing').timedScript('script.src.workflows.v2.upload-certificate', main);

if (require.main === module) require('../../automation/runtime').launchCli(main);

module.exports = { main };
