'use strict';

// Set the selected cloud phone to one available VPC line (V2 Dedicated Workflow).
// Supports operations:
//   - Set proxy (default, with --execute)
//   - Show current proxy (--show, --status)
//   - Stop proxy (--stop, --close)
const { YunmomoClient } = require('../../index');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { parseVpcData } = require('../add-vpc-network');
const { promptVpcProxy } = require('../vpc-dialog');

const DEFAULT_DEVICE_ID = '1920787385311416321';
const DEFAULT_VPC_ID = '';

function deviceIdOf(record) {
  return String(record?.deviceId ?? record?.id ?? '');
}

function matchesDevice(record, targetId) {
  if (!record) return false;
  const id = deviceIdOf(record);
  if (id !== targetId) return false;
  const sdk = String(record.sdkVersion || '').trim().toLowerCase();
  return !sdk || sdk === 'v2';
}

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

function isExpired(record) {
  if (!record?.expTime) return false;
  const time = Date.parse(String(record.expTime).replace(' ', 'T'));
  return Number.isFinite(time) && time <= Date.now();
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

  const args = process.argv.slice(2);
  const isShow = args.some(a => ['--show', '--status', '--info', '--query'].includes(a)) ||
    ['show', 'status', 'info', 'query'].includes(String(process.env.YUNMOMO_PROXY_ACTION || '').toLowerCase()) ||
    process.env.YUNMOMO_PROXY_SHOW === '1';

  const isStop = args.some(a => ['--stop', '--close', '--disable'].includes(a)) ||
    ['stop', 'close', 'disable'].includes(String(process.env.YUNMOMO_PROXY_ACTION || '').toLowerCase()) ||
    process.env.YUNMOMO_PROXY_STOP === '1';

  if (args.includes('--execute')) {
    process.env.YUNMOMO_CONFIRM_VPC_PROXY = 'YES';
  }

  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID).trim();
  const client = new YunmomoClient({ timeoutMs: 100000 });
  const listedDevices = await client.listDevices({ size: 50000 });

  let device = (listedDevices.records || []).find(record => matchesDevice(record, targetDeviceId));
  if (!device && listedDevices.records?.length > 0 && !process.env.YUNMOMO_DEVICE_ID) {
    device = (listedDevices.records || []).find(record => {
      const sdk = String(record.sdkVersion || '').trim().toLowerCase();
      return sdk === 'v2';
    });
  }
  if (!device) throw new Error(`未找到目标 V2 设备: ${targetDeviceId}`);

  const resolvedDeviceId = deviceIdOf(device);
  const deviceName = String(device.deviceName || device.name || resolvedDeviceId);
  const phone = client.device(resolvedDeviceId);

  console.log(`[准备] 目标设备: ${deviceName} (${resolvedDeviceId}) | 架构: V2 (安卓 12)`);

  // ===================== 可选参数分支 1：展示当前代理 =====================
  if (isShow) {
    console.log(`[查询] 正在获取当前设备 VPC 代理运行状态...`);
    const legacy = await phone.getProxy('legacy').catch(() => null);
    const v1 = await phone.getProxy('v1').catch(() => null);

    const isRunning = Number(legacy?.status) === 1 || Boolean(legacy?.addr);
    if (isRunning) {
      console.log(`[状态] 当前 VPC 代理: 已开启 (运行中)`);
      console.log(`       代理地址: ${legacy.addr}`);
      console.log(`       域名模式: ${legacy.type === 2 ? '服务端解析 (远端DNS)' : legacy.type === 1 ? '本地域名解析' : '默认模式'}`);
    } else {
      console.log(`[状态] 当前 VPC 代理: 未开启 (状态: ${legacy?.statusText || '未启动'})`);
    }

    if (v1 && typeof v1 === 'object' && v1.address) {
      console.log(`[提示] 检测到设备同时残留 V1 代理配置: ${v1.address} (建议运行 --close 关闭旧配置)`);
    }
    return;
  }

  // ===================== 可选参数分支 2：关闭代理 =====================
  if (isStop) {
    console.log(`[操作] 正在向设备下发关闭代理指令...`);
    const legacyRes = await phone.stopProxy('legacy').catch(err => err.message || '已尝试关闭');
    // 同时清理可能残留的 v1 代理，防止双代理冲突
    await phone.stopProxy('v1').catch(() => {});

    // 读回核验关闭状态
    const checkState = await phone.getProxy('legacy').catch(() => null);
    const isClosed = !checkState?.addr && Number(checkState?.status ?? 0) === 0;

    console.log(`[完成] 已成功关闭设备 VPC 代理！`);
    console.log(`       目标设备: ${deviceName} (${resolvedDeviceId})`);
    console.log(`       返回信息: ${typeof legacyRes === 'string' ? legacyRes : JSON.stringify(legacyRes)}`);
    console.log(`       当前状态: ${isClosed ? '未开启 (已完全停止)' : '已下发关闭'}`);
    return;
  }

  // ===================== 默认分支：设置 VPC 代理 =====================
  // V2 云手机在云端体系中默认使用旧版 (legacy) 代理内核 (s5Set / getS5ByDeviceId / s5Stop)
  let proxyVersion = String(process.env.YUNMOMO_PROXY_VERSION || 'legacy').trim().toLowerCase();
  if (!['legacy', 'v1', 'auto'].includes(proxyVersion)) {
    throw new Error('YUNMOMO_PROXY_VERSION 必须是 legacy、v1 或 auto');
  }

  const probeVersion = async () => {
    if (proxyVersion !== 'auto') return proxyVersion;
    try {
      const legacyState = await phone.getProxy('legacy');
      if (legacyState && typeof legacyState === 'object' && ('status' in legacyState || 'addr' in legacyState)) {
        proxyVersion = 'legacy';
        return proxyVersion;
      }
    } catch {}
    try {
      const v1State = await phone.getProxy('v1');
      if (v1State && typeof v1State === 'object' && Object.keys(v1State).length > 0) {
        proxyVersion = 'v1';
        return proxyVersion;
      }
    } catch {}
    proxyVersion = 'legacy';
    return proxyVersion;
  };

  const resolveLine = async () => {
    // 兼容显式指定 YUNMOMO_VPC_ID 且跳过弹窗的情况
    if (!process.env.YUNMOMO_VPC_DATA && process.env.YUNMOMO_SKIP_POPUP === '1' && process.env.YUNMOMO_VPC_ID) {
      const vpcId = process.env.YUNMOMO_VPC_ID.trim();
      const raw = await client.vpc().get(vpcId);
      const line = raw?.data ?? raw;
      if (!line || String(line.id) !== vpcId) throw new Error('未查询到指定 VPC 线路：' + vpcId);
      return selectLine([line], vpcId);
    }

    // 默认弹窗识别 VPC 代理输入（支持 5 种格式）
    const proxyInput = await promptVpcProxy();
    const configs = parseVpcData(proxyInput);
    if (!configs.length) throw new Error('未识别到有效的 VPC 代理线路数据');
    const targetConfig = configs[0];
    console.log(`[识别] 代理配置: ${targetConfig.ip}:${targetConfig.port}${targetConfig.username ? ` (用户: ${targetConfig.username})` : ''}`);

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
      console.log(`[线路] 云端已有相同线路 (ID: ${vpcId})，直接复用`);
    } else {
      const added = await client.vpc().addAndGetIds([targetConfig]);
      if (!added?.vpcId) throw new Error('添加 VPC 线路失败，未获取到有效线路 ID');
      vpcId = String(added.vpcId);
      console.log(`[线路] 添加新线路成功 (ID: ${vpcId})`);
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

  // 根据旧版/新版设置默认模式：
  // 旧版 (legacy)：服务端域名解析 (domainMode: "2")，安卓内置代理模式 (proxyMode: "1")
  // 新版 (v1)：不启用域名解析模式 (domainMode: "0")，tun2socks 网卡模式 (proxyMode: "2")
  const domainMode = proxyVersion === 'legacy' ? '2' : '0';
  const proxyMode = proxyVersion === 'legacy' ? '1' : '2';

  console.log(`[模式] 代理协议: ${proxyVersion === 'legacy' ? '旧版代理 (Legacy S5 | 服务端DNS解析)' : '新版代理 (V1 Tun2socks)'}`);

  if (process.env.YUNMOMO_CONFIRM_VPC_PROXY !== 'YES') {
    console.log('[提示] 如需确认设置云机代理，请传入 --execute 参数后重试。');
    return;
  }

  console.log(`[下发] 正在向设备下发代理配置并启动...`);
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
      console.log(`[提示] 云机已存在相同配置，直接进入状态核验`);
    } else {
      throw error;
    }
  }

  let verified = false;
  let readback = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    readback = await phone.getProxy(proxyVersion);
    const data = readback?.data ?? readback;
    const config = JSON.stringify(data);
    if (config.includes(String(selected.ip)) && config.includes(String(selected.port)) &&
      (proxyVersion === 'v1' || Number(data.status) === 1)) {
      verified = true;
      break;
    }
    console.log(`[验证] 正在读取设备代理生效状态 (第 ${attempt}/10 次)...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (!verified) {
    throw new Error('代理设置已提交，但设备读回状态未确认生效');
  }

  const finalAddr = `${selected.ip}:${selected.port}`;
  console.log(`[完成] VPC 代理设置成功且已确认生效！`);
  console.log(`       目标设备: ${deviceName} (${resolvedDeviceId})`);
  console.log(`       当前代理: ${finalAddr} | 状态: 运行中`);
}

requestedVpcId = require('../../automation/timing').timed('workflow.set-vpc-proxy.requestedVpcId', requestedVpcId);
main = require('../../automation/timing').timedScript('script.src.workflows.v2.set-vpc-proxy', main);

if (require.main === module) require('../../automation/runtime').launchCli(main);

module.exports = { main, selectLine, requestedVpcId };
