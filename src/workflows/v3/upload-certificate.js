'use strict';

// Upload one .cert/.xml Google certificate to one cloud phone.
// The write path is guarded so a normal run only previews the target.
const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../../index');

const DEFAULT_DEVICE_ID = '2030225672674516993';
const DEFAULT_CERT_PATH = 'C:\\Users\\Administrator\\Documents\\app\\keybox(2)(1) (1).xml';

function deviceIdOf(record) {
  return String(record?.deviceId ?? record?.id ?? '');
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
  const target = listedDevices.records.find(record => deviceIdOf(record) === deviceId);
  if (!target) throw new Error('目标设备不在当前账号设备列表中: ' + deviceId);

  if (reads[1].status === 'rejected') throw reads[1].reason;
  const data = reads[1].value;
  console.log(JSON.stringify({
    targetDeviceId: deviceId,
    targetDeviceName: target.deviceName ?? target.name ?? 'SF',
    fileName,
    bytes: data.length,
  }));

  if (process.env.YUNMOMO_CONFIRM_CERT_UPLOAD !== 'YES') {
    console.log('预览完成；如确认上传证书，请设置 YUNMOMO_CONFIRM_CERT_UPLOAD=YES 后重跑。');
    return;
  }

  const result = await client.device(deviceId).uploadGoogleCertificate(data, {
    fileName,
    timeoutMs: 10 * 60 * 1000,
  });
  const payload = result?.data ?? result;
  if (payload && typeof payload === 'object' && payload.success === false) {
    throw new Error('云端返回 success=false');
  }
  console.log(JSON.stringify({
    ok: true,
    targetDeviceId: deviceId,
    fileName,
    bytes: data.length,
    responseType: typeof payload,
    responseKeys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
  }));
}

main = require('../../automation/timing').timedScript('script.src.workflows.v3.upload-certificate', main);

if (require.main === module) require('../../automation/runtime').launchCli(main);

module.exports = { main };
