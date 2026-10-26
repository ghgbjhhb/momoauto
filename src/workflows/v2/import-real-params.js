'use strict';

// Script 02.1: 导入真参 (V2)
// 解析指定真机参数文件 (JSON 格式)，自动提取手机品牌、设备型号、安卓版本及设备代号，
// 执行格式校验后向云端控制接口下发并应用真机参数配置。
const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../../index');
const { PROJECT_ROOT } = require('../../automation/runtime');

const DEFAULT_REAL_PARAMS_PATH = 'C:\\Users\\Administrator\\Downloads\\22101316UCP_batch_05.txt';

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

function extractDeviceInfo(parsed) {
  const info = { brand: '', marketName: '', model: '', androidVersion: '' };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.env)) return info;

  for (const item of parsed.env) {
    if (item && item.name === 'PropRw' && item.description && item.value) {
      switch (item.description) {
        case 'ro.product.brand':
          info.brand = String(item.value).trim();
          break;
        case 'ro.vivo.market.name':
          info.marketName = String(item.value).trim();
          break;
        case 'ro.product.model':
          info.model = String(item.value).trim();
          break;
        case 'ro.build.version.release':
          info.androidVersion = String(item.value).trim();
          break;
      }
    }
  }

  if (!info.marketName) {
    const devItem = parsed.env.find(item => item && item.description === 'ro.product.device');
    if (devItem && devItem.value) {
      info.marketName = String(devItem.value).trim();
    }
  }

  return info;
}

function resolveFilePath() {
  const envPath = String(process.env.YUNMOMO_REAL_PARAMS_FILE || '').trim();
  if (envPath && envPath.toLowerCase() !== 'todo') return envPath;

  const fileArg = process.argv.find(arg => arg.startsWith('--file='));
  if (fileArg) {
    const val = fileArg.slice('--file='.length).trim();
    if (val && val.toLowerCase() !== 'todo') return val;
  }

  const fileIdx = process.argv.indexOf('--file');
  if (fileIdx !== -1 && process.argv[fileIdx + 1]) {
    const val = process.argv[fileIdx + 1].trim();
    if (val && val.toLowerCase() !== 'todo') return val;
  }

  // 默认写死路径，待后续动态配置
  return DEFAULT_REAL_PARAMS_PATH;
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }

  const requestedDeviceId = String(process.env.YUNMOMO_DEVICE_ID || '').trim();
  if (!requestedDeviceId) {
    throw new Error('请通过环境变量 YUNMOMO_DEVICE_ID 指定目标云机（禁止使用默认 ID）');
  }

  const filePath = resolveFilePath();
  const fileName = path.basename(filePath);

  const client = new YunmomoClient({ timeoutMs: 100000 });
  const reads = await Promise.allSettled([
    client.listDevices({ size: 50000 }),
    fs.readFile(filePath, 'utf8')
  ]);

  if (reads[0].status === 'rejected') throw reads[0].reason;
  const listedDevices = reads[0].value;
  const target = listedDevices.records.find(record => matchesDevice(record, requestedDeviceId));
  if (!target) throw new Error('目标设备不在当前账号设备列表中: ' + requestedDeviceId);
  const actualDeviceId = deviceIdOf(target);
  const deviceName = target.deviceName ?? target.name ?? 'SF';
  const sdkVer = String(target.sdkVersion || 'V2').toUpperCase();

  console.log(`[准备] 目标设备: ${deviceName} (${actualDeviceId}, 系统: ${sdkVer}) | 流程: 导入真参v2`);

  // [1/3] 读取文件与 JSON 解析校验
  if (reads[1].status === 'rejected') {
    throw new Error(`无法读取真参文件 [${filePath}]: ${reads[1].reason.message}`);
  }
  const fileContent = reads[1].value;
  const sizeKb = (Buffer.byteLength(fileContent, 'utf8') / 1024).toFixed(1);
  console.log(`[1/3] 正在读取真参文件并进行 JSON 语法验证...`);
  console.log(`      文件: ${fileName} (${sizeKb} KB)`);

  let parsedJson;
  try {
    parsedJson = JSON.parse(fileContent);
  } catch (err) {
    throw new Error(`真参文件 JSON 语法校验失败: ${err.message}`);
  }

  // [2/3] 提取并校验关键设备特征
  console.log(`[2/3] 正在解析并提取真机特征属性...`);
  const deviceInfo = extractDeviceInfo(parsedJson);
  if (!deviceInfo.brand || !deviceInfo.model) {
    throw new Error(`真参解析未提取到有效品牌或型号: 品牌=${deviceInfo.brand || '空'}, 型号=${deviceInfo.model || '空'}`);
  }

  console.log(`      - 手机品牌: ${deviceInfo.brand}`);
  console.log(`      - 设备型号: ${deviceInfo.model}`);
  console.log(`      - 安卓版本: ${deviceInfo.androidVersion || '未知'}`);
  console.log(`      - 设备代号: ${deviceInfo.marketName || '无'}`);

  if (process.env.YUNMOMO_CONFIRM_REAL_PARAMS !== 'YES' && !process.argv.includes('--execute')) {
    console.log('[提示] 当前为只读预览，未实际写入。确认导入真参请传入 --execute 或配置执行参数。');
    return;
  }

  // [3/3] 下发并应用真机参数
  console.log(`[3/3] 正在向云端控制流下发并配置真机参数...`);
  const result = await client.device(actualDeviceId).setDeviceInfo({
    brand: deviceInfo.brand,
    marketName: deviceInfo.marketName,
    model: deviceInfo.model,
    androidVersion: deviceInfo.androidVersion,
    devinfo: fileContent
  });

  const replyText = typeof result === 'string' ? result : (result?.message || result?.data || '设置成功');
  console.log(`[完成] ✅ 真机参数导入成功！云端返回: ${replyText}`);

  // 诊断报告保存至 .local-output/真机参数/latest.json
  const outputDir = path.join(PROJECT_ROOT, '.local-output', '真机参数');
  await fs.mkdir(outputDir, { recursive: true });
  const runId = String(process.env.YUNMOMO_SCRIPT_RUN_ID || ('run-' + Date.now()));
  const report = {
    runId,
    timestamp: new Date().toISOString(),
    deviceId: actualDeviceId,
    deviceName,
    sdkVersion: sdkVer,
    filePath,
    fileName,
    fileSizeKb: Number(sizeKb),
    deviceInfo,
    cloudResult: replyText,
    ok: true
  };
  await fs.writeFile(path.join(outputDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`诊断数据已存入: .local-output/真机参数/latest.json`);
}

main = require('../../automation/timing').timedScript('script.src.workflows.v2.import-real-params', main);

if (require.main === module) require('../../automation/runtime').launchCli(main);

module.exports = { main, extractDeviceInfo };
