'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../../index');
const { redact, PROJECT_ROOT } = require('../../automation/runtime');

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

async function prepareResetData(client, identifier, options = {}) {
  const targetId = String(identifier || '').trim();
  if (!targetId) {
    throw new Error('请用 YUNMOMO_DEVICE_ID 显式指定设备 ID 或机身码(如 GVIP...)，不默认选择任何云机');
  }
  const { records } = await client.listDevices({ size: 50000 });
  const device = records.find(row => matchesDevice(row, targetId));
  if (!device) throw new Error('目标云机不在当前账号设备列表中：' + targetId);
  const deviceId = deviceIdOf(device);
  const actualVersion = String(device.sdkVersion ?? '').trim().toLowerCase();
  const expectedVersion = String(options.sdkVersion ?? process.env.YUNMOMO_SDK_VERSION ?? 'v2').trim().toLowerCase();
  if (actualVersion && actualVersion !== expectedVersion) {
    throw new Error(`此脚本对应网页 ${expectedVersion.toUpperCase()} 重置数据，目标云机当前为 ${actualVersion.toUpperCase()}`);
  }
  return {
    device: {
      id: deviceId,
      name: String(device.name ?? ''),
      code: String(device.code ?? ''),
      sdkVersion: actualVersion || expectedVersion,
    },
    action: 'reset',
    warning: '即将重置该设备，此操作不可恢复！',
    payload: { id: deviceId },
  };
}

function publicPlan(plan) {
  return {
    name: '重置数据',
    device: plan.device,
    action: plan.action,
    warning: plan.warning,
    payload: plan.payload,
  };
}

async function submitResetData(client, plan) {
  const prepared = plan?.payload;
  if (!prepared || prepared.id !== plan.device?.id) {
    throw new Error('重置计划不完整，或目标设备参数被修改');
  }
  // 对应网页端云机工具栏“...” -> “重置” -> 滑块确认重置
  // 云端异步清空设备数据并恢复出厂设置
  return client.device(prepared.id).reset();
}

function parseArguments(argv) {
  const args = {};
  for (const arg of argv) {
    if (['--execute', '--help', '--v2', '--v3'].includes(arg)) args[arg.slice(2)] = true;
    else if (arg.startsWith('--device=')) args.deviceId = arg.slice('--device='.length);
    else throw new Error('未知参数：' + arg);
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    console.log('重置数据：清空指定云机的所有数据并恢复出厂设置（对应云机网页控制台“重置”操作）。');
    console.log('环境变量：YUNMOMO_TOKEN、YUNMOMO_DEVICE_ID；可选 YUNMOMO_CONFIRM_RESET=YES。');
    console.log('参数：--execute（实际下发重置指令）；--device=<id>；--v2；--help。');
    console.log('无 --execute 且未设置 YUNMOMO_CONFIRM_RESET=YES 时只做只读检查与预览，不下发重置指令。');
    return;
  }
  if (!process.env.YUNMOMO_TOKEN) throw new Error('请通过 YUNMOMO_TOKEN 提供登录令牌，不要写入脚本');
  const client = new YunmomoClient();
  const deviceId = args.deviceId || process.env.YUNMOMO_DEVICE_ID;
  const sdkVersion = args.v2 ? 'v2' : args.v3 ? 'v3' : (process.env.YUNMOMO_SDK_VERSION || 'v2');
  const plan = await prepareResetData(client, deviceId, { sdkVersion });

  const isConfirmed = Boolean(args.execute || process.env.YUNMOMO_CONFIRM_RESET === 'YES');
  if (!isConfirmed) {
    console.log(redact(JSON.stringify({
      status: 'preview',
      ...publicPlan(plan),
      note: '未提交重置指令；传入 --execute 或环境变量 YUNMOMO_CONFIRM_RESET=YES 才会向云端下发重置指令。',
    }, null, 2)));
    return;
  }

  const root = path.join(PROJECT_ROOT, '.local-output', '重置数据');
  await fs.mkdir(root, { recursive: true });
  const outputDir = await fs.mkdtemp(path.join(root, '重置数据-'));
  const reportPath = path.join(outputDir, 'report.json');
  const report = {
    ...publicPlan(plan),
    status: 'submitting',
    startedAt: new Date().toISOString(),
    reportPath,
  };
  const save = () => fs.writeFile(reportPath, redact(JSON.stringify(report, null, 2)), 'utf8');
  await save();

  const devLabel = `${plan.device.name ? plan.device.name + ' (' + plan.device.id + (plan.device.code ? ' / ' + plan.device.code : '') + ')' : plan.device.id}`;
  console.log(`[1/2] 正在向云端下发“重置数据”指令 (目标云机: ${devLabel})...`);
  console.log(`[警告] ${plan.warning}`);

  try {
    const response = await submitResetData(client, plan);
    report.status = 'submitted';
    report.submittedAt = new Date().toISOString();
    report.response = response;
    report.resetCompletionVerified = false;
    report.note = '重置指令已成功下发至云端；云机正在执行清空数据与恢复出厂设置。未验证清数据/重启完成，不能立即进入初始化流程。';
    await save();

    console.log(`[2/2] 重置数据指令已成功下发至云端！`);
    console.log(`>>> 重置数据指令下发成功 OK (设备: ${devLabel})`);
    console.log(`[提示] 云机重置通常需要 30~60 秒恢复出厂设置并重启，请在控制台或画面恢复至桌面后再进行后续初始化流程。`);
    console.log(redact(JSON.stringify(report, null, 2)));
  } catch (error) {
    report.status = 'submission-not-confirmed';
    report.error = redact(error.message);
    if (error.status !== undefined) report.httpStatus = error.status;
    if (error.data !== undefined) report.errorDetail = error.data;
    report.note = '未自动重试；请求异常不代表后台未执行，请先查看云机状态再决定是否再次提交。';
    await save();
    console.error(redact(JSON.stringify(report, null, 2)));
    throw error;
  }
}

async function runStep(context = {}) {
  const client = context.client || new YunmomoClient();
  const deviceId = context.phone?.deviceId || context.deviceId || process.env.YUNMOMO_DEVICE_ID;
  const sdkVersion = context.options?.sdkVersion || process.env.YUNMOMO_SDK_VERSION || 'v2';
  const plan = await prepareResetData(client, deviceId, { sdkVersion });
  console.log(`正在向云端下发“重置数据”指令 (目标云机: ${plan.device.id})...`);
  const response = await submitResetData(client, plan);
  console.log(`重置数据指令下发成功 OK`);
  return { success: true, response, plan };
}

prepareResetData = require('../../automation/timing').timed('workflow.reset-data.prepareResetData', prepareResetData);
submitResetData = require('../../automation/timing').timed('workflow.reset-data.submitResetData', submitResetData);
main = require('../../automation/timing').timedScript('script.src.workflows.v2.reset-data', main);

if (require.main === module) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
module.exports = { prepareResetData, submitResetData, main, runStep };
