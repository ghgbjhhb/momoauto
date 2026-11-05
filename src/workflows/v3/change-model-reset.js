'use strict';

const { randomInt } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../../index');
const { redact, PROJECT_ROOT } = require('../../automation/runtime');

// Match the current web cascader, not every Android version in the raw catalog.
const WEB_ANDROID_VERSIONS = Object.freeze(['10', '14', '16']);

function countryOptions(raw) {
  const data = raw?.data ?? raw;
  let rows;
  if (Array.isArray(data)) rows = data;
  else if (Array.isArray(data?.records)) rows = data.records;
  else if (Array.isArray(data?.list)) rows = data.list;
  else if (Array.isArray(data?.data)) rows = data.data;
  else if (data && typeof data === 'object') {
    rows = Object.entries(data).map(([code, value]) => typeof value === 'string'
      ? { countryCode: code, countryName: value } : { countryCode: code, ...value });
  } else throw new Error('国家列表返回格式无法识别');
  return rows.map(row => typeof row === 'string' ? { code: row, name: row } : {
    code: row?.countryCode ?? row?.code ?? row?.value ?? row?.id,
    name: row?.countryName ?? row?.name ?? row?.label,
  }).filter(row => typeof row.code === 'string' && row.code.trim())
    .map(row => ({ code: row.code, name: String(row.name ?? row.code) }));
}

async function prepareChangeModelReset(client, deviceId, options = {}) {
  if (typeof deviceId !== 'string' || !/^\d+$/.test(deviceId)) {
    throw new Error('请用 YUNMOMO_DEVICE_ID 显式指定设备 ID，不默认选择任何云机');
  }
  const countryCode = String(options.countryCode ?? 'CN').trim().toUpperCase();
  const androidVersion = String(options.androidVersion ?? '16').trim();
  if (androidVersion !== 'all' && !WEB_ANDROID_VERSIONS.includes(androidVersion)) {
    throw new Error('安卓版本必须是 all、10、14 或 16，与当前网页选项一致');
  }
  const { records } = await client.listDevices({ size: 50000 });
  const device = records.find(row => String(row.deviceId ?? row.id) === deviceId);
  if (!device) throw new Error('目标云机不在当前账号设备列表中：' + deviceId);
  const expectedVersion = (
    String(options.sdkVersion ?? '').trim()
    || String(process.env.YUNMOMO_SDK_VERSION ?? '').trim()
    || 'v3'
  ).toLowerCase();
  const actualVersion = String(device.sdkVersion ?? '').trim().toLowerCase();
  if (actualVersion && actualVersion !== expectedVersion) {
    throw new Error(`此脚本对应网页 ${expectedVersion.toUpperCase()} 改机，目标云机当前为 ${actualVersion.toUpperCase()}`);
  }
  const phone = client.device(deviceId);
  const [catalog, rawCountries] = await Promise.all([client.listModels(), phone.countryCodes()]);
  const models = catalog.records.filter(row => WEB_ANDROID_VERSIONS.includes(String(row.androidVersion)) &&
    (androidVersion === 'all' || String(row.androidVersion) === androidVersion) &&
    /^[1-9]\d*$/.test(String(row.id)) && typeof row.name === 'string' && row.name.trim())
    .map(row => ({ id: row.id, name: row.name, androidVersion: String(row.androidVersion) }));
  if (!models.length) throw new Error('所选范围内没有可用机型');
  const countries = countryOptions(rawCountries);
  const country = countries.find(row => row.code.toUpperCase() === countryCode);
  if (!country) throw new Error('该云机不支持国家代码 ' + countryCode + '，请先查看 --list-countries');
  const model = models[randomInt(models.length)];
  return {
    device: { id: deviceId, name: String(device.name ?? ''), sdkVersion: actualVersion || expectedVersion },
    model, country, androidVersionFilter: androidVersion, candidateCount: models.length,
    models, countries,
    payload: { id: deviceId, modelId: model.id, modelName: model.name, resetData: true, countryCode: country.code },
  };
}

function publicPlan(plan) {
  return { name: '改机重置', device: plan.device, model: plan.model, country: plan.country,
    androidVersionFilter: plan.androidVersionFilter, candidateCount: plan.candidateCount,
    resetData: true, resetDelaySecondsAfterModelChange: 30, payload: plan.payload };
}

async function submitChangeModelReset(client, plan) {
  const prepared = plan?.payload;
  if (!prepared || prepared.resetData !== true || !prepared.countryCode ||
    prepared.id !== plan.device?.id || prepared.modelId !== plan.model?.id ||
    prepared.modelName !== plan.model?.name || prepared.countryCode !== plan.country?.code) {
    throw new Error('改机计划不完整，或重置数据/国家参数被修改');
  }
  // One POST, exactly like the web dialog. The backend schedules the reset;
  // do not add a second resetV3 call or retry a destructive request on timeout.
  return client.device(prepared.id).switchModel({ modelId: prepared.modelId, modelName: prepared.modelName,
    resetData: true, countryCode: prepared.countryCode });
}

function parseArguments(argv) {
  const args = {};
  for (const arg of argv) {
    if (['--execute', '--list-models', '--list-countries', '--help', '--v2', '--v3'].includes(arg)) args[arg.slice(2)] = true;
    else if (arg.startsWith('--country=')) args.countryCode = arg.slice('--country='.length);
    else if (arg.startsWith('--android-version=')) args.androidVersion = arg.slice('--android-version='.length);
    else throw new Error('未知参数：' + arg);
  }
  if (args.execute && (args['list-models'] || args['list-countries'])) {
    throw new Error('查看列表不能同时传 --execute');
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    console.log('改机重置：默认 Android 16 内随机机型、重置数据=true、国家=CN。');
    console.log('环境变量：YUNMOMO_TOKEN、YUNMOMO_DEVICE_ID；可选 YUNMOMO_COUNTRY_CODE、YUNMOMO_ANDROID_VERSION。');
    console.log('参数：--execute（改机并清数据）；--country=US；--android-version=16；--v2 / --v3；--list-models；--list-countries。');
    console.log('无 --execute 时只读取列表并预览，不改机。安卓版本默认 16，机型版本必须与云机系统版本一致。');
    return;
  }
  if (!process.env.YUNMOMO_TOKEN) throw new Error('请通过 YUNMOMO_TOKEN 提供登录令牌，不要写入脚本');
  const client = new YunmomoClient();
  const sdkVersion = args.v2 ? 'v2' : args.v3 ? 'v3' : (process.env.YUNMOMO_SDK_VERSION || 'v3');
  const plan = await prepareChangeModelReset(client, process.env.YUNMOMO_DEVICE_ID, {
    countryCode: args.countryCode ?? process.env.YUNMOMO_COUNTRY_CODE ?? 'CN',
    androidVersion: args.androidVersion ?? process.env.YUNMOMO_ANDROID_VERSION ?? '16',
    sdkVersion,
  });
  if (args['list-models'] || args['list-countries']) {
    console.log(redact(JSON.stringify({ device: plan.device,
      ...(args['list-models'] ? { androidVersionFilter: plan.androidVersionFilter, models: plan.models } : {}),
      ...(args['list-countries'] ? { countries: plan.countries } : {}),
    }, null, 2)));
    return;
  }
  if (!args.execute) {
    console.log(redact(JSON.stringify({ status: 'preview', ...publicPlan(plan),
      note: '未提交改机；加 --execute 才会改机并清除数据。实际执行时会重新读取列表并随机选机型。' }, null, 2)));
    return;
  }
  const root = path.join(PROJECT_ROOT, '.local-output', '改机重置');
  await fs.mkdir(root, { recursive: true });
  const outputDir = await fs.mkdtemp(path.join(root, '改机重置-'));
  const reportPath = path.join(outputDir, 'report.json');
  const report = { ...publicPlan(plan), status: 'submitting', startedAt: new Date().toISOString(), reportPath };
  const save = () => fs.writeFile(reportPath, redact(JSON.stringify(report, null, 2)), 'utf8');
  await save();
  console.log(redact(JSON.stringify(report, null, 2)));
  try {
    const response = await submitChangeModelReset(client, plan);
    report.status = 'submitted';
    report.submittedAt = new Date().toISOString();
    report.response = response;
    report.resetCompletionVerified = false;
    report.note = '接口已返回；按网页说明改机成功 30 秒后自动重置。未验证清数据/重启完成，不能立即进入初始化流程。';
    await save();
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

prepareChangeModelReset = require('../../automation/timing').timed('workflow.change-model-reset.prepareChangeModelReset', prepareChangeModelReset);
submitChangeModelReset = require('../../automation/timing').timed('workflow.change-model-reset.submitChangeModelReset', submitChangeModelReset);
main = require('../../automation/timing').timedScript('script.src.workflows.v3.change-model-reset', main);

if (require.main === module) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
async function runStep(context = {}) {
  const client = context.client || new YunmomoClient();
  const deviceId = context.phone?.deviceId || context.deviceId || process.env.YUNMOMO_DEVICE_ID;
  const sdkVersion = context.options?.sdkVersion || process.env.YUNMOMO_SDK_VERSION || 'v3';
  const countryCode = context.options?.countryCode || process.env.YUNMOMO_COUNTRY_CODE || 'CN';
  const androidVersion = context.options?.androidVersion || process.env.YUNMOMO_ANDROID_VERSION || '16';
  const plan = await prepareChangeModelReset(client, deviceId, { countryCode, androidVersion, sdkVersion });
  console.log(`正在向云端下发“改机重置”指令 (目标云机: ${plan.device.id}, 机型: ${plan.model.name})...`);
  const response = await submitChangeModelReset(client, plan);
  console.log(`改机重置指令下发成功 OK`);
  return { success: true, response, plan };
}

module.exports = { WEB_ANDROID_VERSIONS, countryOptions, prepareChangeModelReset, submitChangeModelReset, main, runStep };
