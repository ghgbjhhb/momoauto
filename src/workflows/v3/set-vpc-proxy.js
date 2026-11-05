'use strict';

// Set the selected cloud phone to one available VPC line.
// The write path is guarded because this changes the phone's network route.
const { YunmomoClient } = require('../../index');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { parseVpcData } = require('../add-vpc-network');
const { promptVpcProxy } = require('../vpc-dialog');

const DEFAULT_DEVICE_ID = '2033060279606353921';
const DEFAULT_VPC_ID = '';

async function requestedVpcId() {
  const explicit = String(process.env.YUNMOMO_VPC_ID || DEFAULT_VPC_ID).trim();
  if (explicit) return explicit;
  if (!process.env.YUNMOMO_VPC_RESULT_PATH) return '';
  let result;
  try { result = JSON.parse(await fs.readFile(process.env.YUNMOMO_VPC_RESULT_PATH, 'utf8')); }
  catch { throw new Error('无法读取新增VPC结果 JSON；此路径应指向成功结果文件，不是代理数据文件'); }
  if (result.ok !== true || !/^\d+$/.test(String(result.vpcId ?? ''))) {
    throw new Error('新增VPC结果未确认成功或包含多条线路；请显式指定其中一个 YUNMOMO_VPC_ID');
  }
  return String(result.vpcId);
}

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

async function ensureToken() {
  if (process.env.YUNMOMO_TOKEN) return process.env.YUNMOMO_TOKEN;
  try {
    const localEnvPath = path.join(PROJECT_ROOT, '.env.local');
    const content = await fs.readFile(localEnvPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('YUNMOMO_TOKEN=')) {
        const token = trimmed.slice('YUNMOMO_TOKEN='.length).trim();
        if (token) {
          process.env.YUNMOMO_TOKEN = token;
          return token;
        }
      }
    }
  } catch {}
  throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
}

async function main() {
  await ensureToken();

  if (process.argv.includes('--execute')) {
    process.env.YUNMOMO_CONFIRM_VPC_PROXY = 'YES';
  }

  const deviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID);

  const client = new YunmomoClient({ timeoutMs: 100000 });
  const listedDevices = await client.listDevices({ size: 50000 });
  let device = listedDevices.records.find(record => deviceIdOf(record) === deviceId);
  if (!device && listedDevices.records.length > 0 && !process.env.YUNMOMO_DEVICE_ID) {
    device = listedDevices.records[0];
  }
  if (!device) throw new Error('所选设备不在当前账号设备列表中: ' + deviceId);
  const resolvedDeviceId = deviceIdOf(device);
  const phone = client.device(resolvedDeviceId);

  let proxyVersion = String(process.env.YUNMOMO_PROXY_VERSION || 'auto');
  if (!['auto', 'v1', 'legacy'].includes(proxyVersion)) throw new Error('YUNMOMO_PROXY_VERSION 必须是 auto、v1 或 legacy');
  const probeVersion = async () => {
    if (proxyVersion !== 'auto') return proxyVersion;
    try {
      await phone.getProxy('v1');
      proxyVersion = 'v1';
    } catch (error) {
      if (![404, 500].includes(error.status)) throw error;
      await phone.getProxy('legacy');
      proxyVersion = 'legacy';
    }
    return proxyVersion;
  };

  const resolveLine = async () => {
    // 兼容显式指定 YUNMOMO_VPC_ID 且跳过弹窗的情况
    if (!process.env.YUNMOMO_VPC_DATA && process.env.YUNMOMO_SKIP_POPUP === '1' && process.env.YUNMOMO_VPC_ID) {
      const vpcId = process.env.YUNMOMO_VPC_ID.trim();
      const raw = await client.vpc().get(vpcId), line = raw?.data ?? raw;
      if (!line || String(line.id) !== vpcId) throw new Error('未查询到指定 VPC 线路：' + vpcId);
      return selectLine([line], vpcId);
    }

    // 默认弹窗识别 VPC 代理输入（支持 5 种格式）
    const proxyInput = await promptVpcProxy();
    const configs = parseVpcData(proxyInput);
    if (!configs.length) throw new Error('未识别到有效的 VPC 代理线路数据');
    const targetConfig = configs[0];
    console.log(`识别代理：${targetConfig.ip}:${targetConfig.port} (用户: ${targetConfig.username})`);

    // 检查云端是否已有相同线路，有则直接复用，不重复添加
    let existingLine = null;
    try {
      const listRes = await client.vpc().list({ ip: targetConfig.ip, size: 100 });
      const records = listRes.records || [];
      existingLine = records.find(r =>
        String(r.ip || '').trim().toLowerCase() === targetConfig.ip.toLowerCase() &&
        Number(r.port) === Number(targetConfig.port) &&
        (!targetConfig.username || r.username === targetConfig.username)
      );
    } catch {}

    let vpcId;
    if (existingLine) {
      vpcId = String(existingLine.id);
      console.log(`已有相同线路 (ID: ${vpcId})`);
    } else {
      const added = await client.vpc().addAndGetIds([targetConfig]);
      if (!added?.vpcId) throw new Error('添加 VPC 线路失败，未获取到有效线路 ID');
      vpcId = String(added.vpcId);
      console.log(`添加线路成功 (ID: ${vpcId})`);
    }

    // 保存本地最新添加记录
    try {
      const root = path.join(PROJECT_ROOT, '.local-output', 'VPC网络');
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({
        ok: true,
        vpcId,
        networks: [{ ip: targetConfig.ip, port: targetConfig.port, remarks: targetConfig.remarks }],
        addedAt: new Date().toISOString()
      }, null, 2), 'utf8');
    } catch {}

    // 用户通过弹窗或配置提交了有效代理，视为已确认执行
    process.env.YUNMOMO_CONFIRM_VPC_PROXY = 'YES';

    return {
      id: vpcId,
      ip: targetConfig.ip,
      port: targetConfig.port,
      username: targetConfig.username,
      password: targetConfig.password,
      remarks: targetConfig.remarks,
      expTime: targetConfig.expTime
    };
  };

  // 校验探测与线路获取
  const prepared = await Promise.allSettled([probeVersion(), resolveLine()]);
  for (const result of prepared) if (result.status === 'rejected') throw result.reason;
  proxyVersion = prepared[0].value;
  const selected = prepared[1].value;

  // Match each web dialog's defaults: legacy uses server DNS / proxy mode 1.
  const domainMode = proxyVersion === 'legacy' ? '2' : '0';
  const proxyMode = proxyVersion === 'legacy' ? '1' : '2';

  if (process.env.YUNMOMO_CONFIRM_VPC_PROXY !== 'YES') {
    console.log('如确认设置云机代理，请传入执行参数后重试。');
    return;
  }

  console.log(`正在设置为本机代理并验证...`);
  try {
    await phone.setProxy({
      s5ip: selected.ip,
      s5port: selected.port,
      s5user: selected.username,
      s5pwd: selected.password,
      domainMode,
      proxyMode,
      expTime: selected.expTime,
    }, proxyVersion);
  } catch (error) {
    const errText = (error.message || '') + ' ' + (typeof error.data === 'string' ? error.data : JSON.stringify(error.data || ''));
    if (errText.includes('已存在相同的代理配置') || errText.includes('已存在相同')) {
      // 云机已存在相同配置，直接进入读回核验
    } else {
      throw error;
    }
  }

  let verified = false;
  let readback = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    readback = await phone.getProxy(proxyVersion);
    const data = readback?.data ?? readback;
    const config = JSON.stringify(data);
    if (config.includes(String(selected.ip)) && config.includes(String(selected.port)) &&
      (proxyVersion === 'v1' || Number(data.status) === 1)) {
      verified = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!verified) throw new Error('代理设置已提交，但设备读回状态未确认生效');
  console.log(`代理设置成功，已生效 (IP: ${selected.ip}:${selected.port})`);
}

requestedVpcId = require('../../automation/timing').timed('workflow.set-vpc-proxy.requestedVpcId', requestedVpcId);

async function runStep(context = {}) {
  const deviceId = String(context.phone?.deviceId || context.deviceId || process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID).trim();
  const actionParam = String(context.options?.action || '').trim().toLowerCase();
  process.env.YUNMOMO_DEVICE_ID = deviceId;
  process.env.YUNMOMO_CONFIRM_VPC_PROXY = 'YES';
  if (context.options?.vpcData) {
    process.env.YUNMOMO_VPC_DATA = String(context.options.vpcData).trim();
  }
  if (actionParam === 'show' || actionParam === 'status') {
    if (!process.argv.includes('--show')) process.argv.push('--show');
  } else if (actionParam === 'close' || actionParam === 'stop') {
    if (!process.argv.includes('--stop')) process.argv.push('--stop');
  }
  await main();
  return { ok: true };
}

main = require('../../automation/timing').timedScript('script.src.workflows.v3.set-vpc-proxy', main);

if (require.main === module) require('../../automation/runtime').launchCli(main);

module.exports = { main, selectLine, requestedVpcId, runStep };
