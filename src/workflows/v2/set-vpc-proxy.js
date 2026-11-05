'use strict';

// Set the selected cloud phone to one available VPC line (V2 Dedicated Workflow).
// Supports operations:
//   - Set proxy (default, with --execute)
//   - Show current proxy (--show, --status)
//   - Stop proxy (--stop, --close)
const { YunmomoClient } = require('../../index');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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

class Logger {
  constructor(taskId) {
    this.taskId = taskId;
    this.logDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'set-vpc-proxy');
    this.logFile = path.join(this.logDir, `${taskId}.log`);
    this.buffer = [];
  }

  async init() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
      await fs.writeFile(this.logFile, `=== VPC Proxy V2 Task Log [ID: ${this.taskId}] ===\nStarted: ${new Date().toISOString()}\n\n`, 'utf8');
    } catch {}
  }

  file(message, meta) {
    const time = new Date().toISOString();
    let text = `[${time}] ${message}`;
    if (meta !== undefined) {
      text += typeof meta === 'string' ? `\n${meta}` : `\n${JSON.stringify(meta, null, 2)}`;
    }
    this.buffer.push(text);
    fs.appendFile(this.logFile, text + '\n', 'utf8').catch(() => {});
  }

  console(message) {
    console.log(message);
    this.file(`[CONSOLE] ${message}`);
  }

  get relativeLogPath() {
    return path.relative(PROJECT_ROOT, this.logFile).replace(/\\/g, '/');
  }
}

async function main() {
  const taskId = process.env.YUNMOMO_TIMING_RUN_ID || process.env.RUN_ID || randomUUID();
  const logger = new Logger(taskId);
  await logger.init();

  const args = process.argv.slice(2);
  const actionParam = String(process.env.YUNMOMO_PROXY_ACTION || '').toLowerCase();
  const isShow = args.some(a => ['--show', '--status', '--info', '--query'].includes(a)) ||
    ['show', 'status', 'info', 'query'].includes(actionParam) ||
    process.env.YUNMOMO_PROXY_SHOW === '1';

  const isStop = args.some(a => ['--stop', '--close', '--disable'].includes(a)) ||
    ['stop', 'close', 'disable'].includes(actionParam) ||
    process.env.YUNMOMO_PROXY_STOP === '1';

  if (args.includes('--execute')) {
    process.env.YUNMOMO_CONFIRM_VPC_PROXY = 'YES';
  }

  const currentOp = isShow ? '展示当前代理' : isStop ? '关闭设备代理' : '设置设备代理';

  logger.file('Task initialized', {
    taskId,
    args,
    actionParam,
    operation: currentOp,
    envDeviceId: process.env.YUNMOMO_DEVICE_ID
  });

  logger.console(`[任务ID] ${taskId}`);

  try {
    await ensureToken();

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

    logger.file('Resolved device info', { deviceName, resolvedDeviceId, sdkVersion: device.sdkVersion });
    logger.console(`[目标设备] ${deviceName} (${resolvedDeviceId}) | V2 (安卓 12)`);
    logger.console(`[执行操作] ${currentOp}`);

    // ===================== 可选参数分支 1：展示当前代理 =====================
    if (isShow) {
      logger.file('Querying proxy status via legacy and v1 APIs...');
      const [legacy, v1] = await Promise.all([
        phone.getProxy('legacy').catch(err => { logger.file('getProxy(legacy) error', err.message); return null; }),
        phone.getProxy('v1').catch(err => { logger.file('getProxy(v1) error', err.message); return null; })
      ]);

      logger.file('Query results', { legacy, v1 });

      const isRunning = Number(legacy?.status) === 1 || Boolean(legacy?.addr);
      if (isRunning) {
        logger.console(`[代理状态] 运行中 (${legacy.addr})`);
      } else {
        logger.console(`[代理状态] 未开启 (状态: ${legacy?.statusText || '未启动'})`);
      }

      if (v1 && typeof v1 === 'object' && v1.address) {
        logger.console(`[提示] 检测到设备存在 V1 代理配置: ${v1.address}`);
      }

      logger.console(`[执行结果] 成功`);
      logger.console(`[完整日志] ${logger.relativeLogPath}`);
      return;
    }

    // ===================== 可选参数分支 2：关闭代理 =====================
    if (isStop) {
      logger.file('Executing stopProxy(legacy) and stopProxy(v1)...');
      const legacyRes = await phone.stopProxy('legacy').catch(err => {
        logger.file('stopProxy(legacy) error', err.message);
        return err.message || '已尝试关闭';
      });
      await phone.stopProxy('v1').catch(() => {});

      logger.file('Stop API response', { legacyRes });

      const checkState = await phone.getProxy('legacy').catch(() => null);
      logger.file('Readback after stop', { checkState });
      const isClosed = !checkState?.addr && Number(checkState?.status ?? 0) === 0;

      logger.console(`[下发结果] ${typeof legacyRes === 'string' ? legacyRes : '关闭成功'}`);
      logger.console(`[代理状态] ${isClosed ? '未开启 (已完全停止)' : '已下发关闭'}`);
      logger.console(`[执行结果] 成功`);
      logger.console(`[完整日志] ${logger.relativeLogPath}`);
      return;
    }

    // ===================== 默认分支：设置 VPC 代理 =====================
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
      if (!process.env.YUNMOMO_VPC_DATA && process.env.YUNMOMO_SKIP_POPUP === '1' && process.env.YUNMOMO_VPC_ID) {
        const vpcId = process.env.YUNMOMO_VPC_ID.trim();
        const raw = await client.vpc().get(vpcId);
        const line = raw?.data ?? raw;
        if (!line || String(line.id) !== vpcId) throw new Error('未查询到指定 VPC 线路：' + vpcId);
        return selectLine([line], vpcId);
      }

      const proxyInput = await promptVpcProxy();
      logger.file('Raw proxy input received', { length: proxyInput?.length });
      const configs = parseVpcData(proxyInput);
      if (!configs.length) throw new Error('未识别到有效的 VPC 代理线路数据');
      const targetConfig = configs[0];
      logger.console(`[识别线路] ${targetConfig.ip}:${targetConfig.port}${targetConfig.username ? ` (用户: ${targetConfig.username})` : ''}`);

      let existingLine = null;
      try {
        const listRes = await client.vpc().list({ ip: targetConfig.ip, size: 100 });
        const records = listRes.records || [];
        existingLine = records.find(r =>
          String(r.ip || '').trim().toLowerCase() === targetConfig.ip.toLowerCase() &&
          Number(r.port) === Number(targetConfig.port) &&
          (!targetConfig.username || r.username === targetConfig.username)
        );
      } catch (err) {
        logger.file('Check existing line error', err.message);
      }

      let vpcId;
      if (existingLine) {
        vpcId = String(existingLine.id);
        logger.console(`[线路状态] 复用已有线路 (ID: ${vpcId})`);
      } else {
        const added = await client.vpc().addAndGetIds([targetConfig]);
        if (!added?.vpcId) throw new Error('添加 VPC 线路失败，未获取到有效线路 ID');
        vpcId = String(added.vpcId);
        logger.console(`[线路状态] 新增线路成功 (ID: ${vpcId})`);
      }

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

    const prepared = await Promise.allSettled([probeVersion(), resolveLine()]);
    for (const result of prepared) if (result.status === 'rejected') throw result.reason;
    proxyVersion = prepared[0].value;
    const selected = prepared[1].value;

    const domainMode = proxyVersion === 'legacy' ? '2' : '0';
    const proxyMode = proxyVersion === 'legacy' ? '1' : '2';

    logger.file('Proxy configuration chosen', { proxyVersion, domainMode, proxyMode, targetIp: selected.ip, port: selected.port });
    logger.console(`[下发协议] ${proxyVersion === 'legacy' ? '旧版代理 (Legacy S5 | 远端DNS)' : '新版代理 (V1 Tun2socks)'}`);

    if (process.env.YUNMOMO_CONFIRM_VPC_PROXY !== 'YES') {
      logger.console('[提示] 如需确认设置云机代理，请传入 --execute 参数后重试。');
      logger.console(`[完整日志] ${logger.relativeLogPath}`);
      return;
    }

    try {
      const setRes = await phone.setProxy({
        s5ip: selected.ip,
        s5port: selected.port,
        s5user: selected.username,
        s5pwd: selected.password,
        domainMode,
        proxyMode,
        expTime: selected.expTime,
      }, proxyVersion);
      logger.file('phone.setProxy response', setRes);
    } catch (error) {
      const errText = (error.message || '') + ' ' + (typeof error.data === 'string' ? error.data : JSON.stringify(error.data || ''));
      logger.file('phone.setProxy threw error', { errText, errorData: error.data });
      if (errText.includes('已存在相同的代理配置') || errText.includes('已存在相同')) {
        logger.file('Proxy configuration already exists on device, proceeding to verify');
      } else {
        throw error;
      }
    }

    let verified = false;
    let readback = null;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      readback = await phone.getProxy(proxyVersion);
      const data = readback?.data ?? readback;
      logger.file(`Readback attempt #${attempt}`, data);
      const config = JSON.stringify(data);
      if (config.includes(String(selected.ip)) && config.includes(String(selected.port)) &&
        (proxyVersion === 'v1' || Number(data.status) === 1)) {
        verified = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!verified) {
      throw new Error('代理设置已提交，但设备读回状态未确认生效');
    }

    const finalAddr = `${selected.ip}:${selected.port}`;
    logger.console(`[代理状态] 运行中 (${finalAddr})`);
    logger.console(`[执行结果] 成功且已确认生效`);
    logger.console(`[完整日志] ${logger.relativeLogPath}`);
  } catch (err) {
    logger.file('TASK EXCEPTION', { message: err.message, stack: err.stack, data: err.data });
    logger.console(`[执行结果] 失败: ${err.message}`);
    logger.console(`[完整日志] ${logger.relativeLogPath}`);
    throw err;
  }
}

async function runStep(context = {}) {
  const deviceId = String(context.deviceId || process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID).trim();
  const actionParam = String(context.options?.action || '').trim().toLowerCase();
  process.env.YUNMOMO_DEVICE_ID = deviceId;
  process.env.YUNMOMO_CONFIRM_VPC_PROXY = 'YES';
  if (actionParam === 'show' || actionParam === 'status') {
    if (!process.argv.includes('--show')) process.argv.push('--show');
  } else if (actionParam === 'close' || actionParam === 'stop') {
    if (!process.argv.includes('--stop')) process.argv.push('--stop');
  }
  await main();
  return { ok: true };
}

requestedVpcId = require('../../automation/timing').timed('workflow.set-vpc-proxy.requestedVpcId', requestedVpcId);
main = require('../../automation/timing').timedScript('script.src.workflows.v2.set-vpc-proxy', main);

if (require.main === module) require('../../automation/runtime').launchCli(main);

module.exports = { main, selectLine, requestedVpcId, runStep };
