'use strict';

// Script 02.1: 导入真参 (V2)
// 解析后台云盘真机参数文件 (JSON 格式)，自动提取手机品牌、设备型号、安卓版本及设备代号，
// 执行格式校验与卡密额度核验后向云端控制接口下发并应用真机参数配置；
// 导入成功后自动将云盘参数标记为“已使用”与使用日期，默认一参单用（后台可重置启用）。
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { YunmomoClient } = require('../../index');
const { formatDeviceLabel } = require('../../automation/runtime');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { getAuthService } = require('../../server/auth/service');

const CLOUD_DISK_ZHENCAN_DIR = path.resolve(PROJECT_ROOT, 'storage', 'cloud-disk', '真参');

/**
 * 校验目标真参文件是否合法且严格位于系统后台云盘目录内，彻底杜绝任何第三方或外部路径导入
 */
function assertInsideCloudDisk(targetPath) {
  const resolved = path.resolve(targetPath);
  const rel = path.relative(CLOUD_DISK_ZHENCAN_DIR, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('..') || path.dirname(rel) !== '.') {
    throw new Error(`安全规则拦截：真机参数必须且只能从系统后台云盘 (storage/cloud-disk/真参) 获取，严禁使用任何第三方或外部路径导入文件 [${targetPath}]！`);
  }
  return resolved;
}

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

/**
 * 解析待导入的真参文件：
 * 1. 优先读取显式传入路径 (环境变量 YUNMOMO_REAL_PARAMS_FILE 或命令行 --file)；
 * 2. 默认自动从后台云盘 (storage/cloud-disk/真参) 挑选未使用的可用真参文件；
 * 3. 校验文件的使用状态，默认单次导入已使用的文件将被严格拦截。
 */
async function resolveRealParamsFile(authService, forceReimport = false) {
  const envPath = String(process.env.YUNMOMO_REAL_PARAMS_FILE || '').trim();
  let explicitPath = '';
  if (envPath && envPath.toLowerCase() !== 'todo' && envPath.toLowerCase() !== 'auto') {
    explicitPath = envPath;
  }

  if (!explicitPath) {
    const fileArg = process.argv.find(arg => arg.startsWith('--file='));
    if (fileArg) {
      const val = fileArg.slice('--file='.length).trim();
      if (val && val.toLowerCase() !== 'todo' && val.toLowerCase() !== 'auto') explicitPath = val;
    }
  }

  if (!explicitPath) {
    const fileIdx = process.argv.indexOf('--file');
    if (fileIdx !== -1 && process.argv[fileIdx + 1]) {
      const val = process.argv[fileIdx + 1].trim();
      if (val && val.toLowerCase() !== 'todo' && val.toLowerCase() !== 'auto') explicitPath = val;
    }
  }

  // 1. 若显式指定了具体文件（严格限制只能是后台云盘内的真参文件）
  if (explicitPath) {
    let targetPath;
    if (path.isAbsolute(explicitPath)) {
      targetPath = assertInsideCloudDisk(explicitPath);
    } else {
      targetPath = assertInsideCloudDisk(path.join(CLOUD_DISK_ZHENCAN_DIR, path.basename(explicitPath)));
    }
    const fileName = path.basename(targetPath);
    if (!fsSync.existsSync(targetPath)) {
      throw new Error(`未在后台云盘 (storage/cloud-disk/真参) 中找到真参文件 [${fileName}]！本脚本必须获取后台云盘参数，严禁第三方外部导入。请先在管理后台【资源云盘】上传此文件。`);
    }

    const record = authService.getZhencanFileRecord(fileName);
    if (record && record.status === 'used' && !forceReimport) {
      const dateText = record.used_at ? new Date(record.used_at).toLocaleString('zh-CN') : '此前';
      const devText = record.used_on_device_name || record.used_on_device_id || '其他设备';
      throw new Error(`云盘真参文件 [${fileName}] 已于 ${dateText} 导入过云机 (${devText})！根据单机单参规则，每个参数文件默认只能导入一次。如需再次使用，请在后台【资源云盘】将其状态设置为【启用】。`);
    }
    return { filePath: targetPath, fileName, isAuto: false };
  }

  // 2. 默认行为：自动从后台云盘查找未使用的可用真参文件（绝对禁止第三方外部兜底）
  if (!fsSync.existsSync(CLOUD_DISK_ZHENCAN_DIR)) {
    fsSync.mkdirSync(CLOUD_DISK_ZHENCAN_DIR, { recursive: true });
  }

  const entries = await fs.readdir(CLOUD_DISK_ZHENCAN_DIR);
  const paramFiles = entries.filter(name => {
    const ext = path.extname(name).toLowerCase();
    return ext === '.txt' || ext === '.json';
  });

  if (paramFiles.length === 0) {
    throw new Error('后台云盘 (storage/cloud-disk/真参) 中暂无真参文件！调用本流程必须通过系统后台云盘获取参数，严禁第三方外部导入。请先在管理后台【资源云盘】上传真参。');
  }

  const allRecords = authService.getAllZhencanRecords();
  const availableFiles = [];
  const usedFiles = [];

  for (const name of paramFiles) {
    const rec = allRecords[name];
    if (rec && rec.status === 'used') {
      usedFiles.push(name);
    } else {
      availableFiles.push(name);
    }
  }

  if (availableFiles.length === 0) {
    throw new Error(`后台云盘中所有真参文件均已标记为【已使用】(共 ${paramFiles.length} 套)！根据单次导入安全规则，每个参数文件只能使用一次。请前往后台【资源云盘】上传新真参，或将已有参数重置为【启用】。`);
  }

  // 默认选取第一个可用文件
  const chosenName = availableFiles[0];
  const chosenPath = path.join(CLOUD_DISK_ZHENCAN_DIR, chosenName);
  return {
    filePath: chosenPath,
    fileName: chosenName,
    isAuto: true,
    totalAvailable: availableFiles.length,
    totalUsed: usedFiles.length
  };
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }

  const requestedDeviceId = String(process.env.YUNMOMO_DEVICE_ID || '').trim();
  if (!requestedDeviceId) {
    throw new Error('请通过环境变量 YUNMOMO_DEVICE_ID 指定目标云机（禁止使用默认 ID）');
  }

  const authService = getAuthService();
  const forceReimport = process.argv.includes('--force') || process.env.YUNMOMO_FORCE_REIMPORT === '1';

  // [步骤 1] 智能解析真参文件 (默认读取云盘可用真参，并做单次使用规则拦截)
  const fileTarget = await resolveRealParamsFile(authService, forceReimport);
  const { filePath, fileName, isAuto } = fileTarget;

  // [步骤 2] 核验卡密权益与真参配额
  const userId = String(process.env.YUNMOMO_USER_ID || '').trim();
  const userRole = String(process.env.YUNMOMO_USER_ROLE || 'user').trim();
  const isPrivilegedAdmin = userRole === 'admin';

  let currentBalance = 0;
  if (userId) {
    currentBalance = authService.getUserZhencanBalance(userId);
    if (!isPrivilegedAdmin && currentBalance <= 0) {
      throw new Error(`当前账户真参额度不足（剩余 0 套）！导入真参需要消耗 1 套真参额度。请先点击顶部【兑换卡密】兑换真参权益后再执行导入。`);
    }
  }

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
  const devLabel = (context && context.deviceName) ? context.deviceName : formatDeviceLabel(target);
  const sdkVer = String(target.sdkVersion || 'V2').toUpperCase();

  console.log(`[准备] 目标设备: ${devLabel} (系统: ${sdkVer}) | 流程: 导入真参v2`);
  if (isAuto) {
    console.log(`[分配] 自动从后台云盘选取可用真参: ${fileName} (云盘剩余可用: ${fileTarget.totalAvailable} 套, 已用: ${fileTarget.totalUsed} 套)`);
  } else {
    console.log(`[指定] 使用指定真参配置: ${fileName}`);
  }

  if (userId) {
    console.log(`[权益] 操作用户: ${userId} | 角色: ${userRole} | 当前真参配额: ${isPrivilegedAdmin ? '管理员无限' : currentBalance + ' 套'}`);
  }

  // 读取文件与 JSON 解析校验
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

  // 提取并校验关键设备特征
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

  // 下发并应用真机参数
  console.log('📲 [3/3] 正在下发真机参数...');
  const result = await client.device(actualDeviceId).setDeviceInfo({
    brand: deviceInfo.brand,
    marketName: deviceInfo.marketName,
    model: deviceInfo.model,
    androidVersion: deviceInfo.androidVersion,
    devinfo: fileContent
  });

  const replyText = typeof result === 'string' ? result : (result?.message || result?.data || '设置成功');
  console.log(`✅ 真机参数导入完成: ${replyText}`);

  // [步骤 4] 写入真参状态标记并核销额度
  authService.markZhencanFileUsed(fileName, {
    userId,
    deviceId: actualDeviceId,
    deviceName
  });
  console.log(`📋 真参文件 [${fileName}] 已标记为已使用`);

  if (userId) {
    if (!isPrivilegedAdmin) {
      const remainingBalance = authService.consumeZhencanQuota({ id: userId, role: userRole }, 1, {
        fileName,
        deviceId: actualDeviceId,
        deviceName
      });
      console.log(`[额度] ✅ 已核销 1 套真参配额，当前账户剩余额度: ${remainingBalance} 套`);
    } else {
      console.log(`[额度] 管理员特权免扣除配额`);
    }
  }

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
    userId,
    userRole,
    ok: true
  };
  await fs.writeFile(path.join(outputDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`诊断数据已存入: .local-output/真机参数/latest.json`);
}

async function runStep(context = {}) {
  const targetDeviceId = String(context.deviceId || process.env.YUNMOMO_DEVICE_ID || '').trim();
  process.env.YUNMOMO_DEVICE_ID = targetDeviceId;
  process.env.YUNMOMO_CONFIRM_REAL_PARAMS = 'YES';
  if (context.options?.filePath) {
    process.env.YUNMOMO_REAL_PARAMS_FILE = context.options.filePath;
  }
  await main();
  return { ok: true };
}

main = require('../../automation/timing').timedScript('script.src.workflows.v2.import-real-params', main);

if (require.main === module) require('../../automation/runtime').launchCli(main);

module.exports = { main, runStep, extractDeviceInfo, resolveRealParamsFile };
