'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const { PROJECT_ROOT, redact } = require('../../src/automation/runtime');
const timing = require('../../src/automation/timing');

const STEPS = [
  { order: 1, name: '导入云盘所有文件v2', entry: '01-导入云盘所有文件.js', source: 'src/workflows/v2/send-cloud-files.js', confirmation: 'YUNMOMO_CONFIRM_SEND', version: 'v2' },
  { order: 2, name: '上传证书v2', entry: '02-上传证书.js', source: 'src/workflows/v2/upload-certificate.js', confirmation: 'YUNMOMO_CONFIRM_CERT_UPLOAD', version: 'v2' },
  { order: 2.1, name: '导入真参v2', entry: '02.1-导入真参.js', source: 'src/workflows/v2/import-real-params.js', confirmation: 'YUNMOMO_CONFIRM_REAL_PARAMS', version: 'v2' },
  { order: 3, name: '设置VPC代理v2', entry: '03-设置VPC代理.js', source: 'src/workflows/v2/set-vpc-proxy.js', confirmation: 'YUNMOMO_CONFIRM_VPC_PROXY', version: 'v2' },
  { order: 4, name: '环境配置v2', entry: '04-环境配置.js', source: 'src/workflows/v2/configure-environment.js', confirmation: 'YUNMOMO_CONFIRM_ENV_CONFIG', version: 'v2' },
  { order: 5, name: '一键生成全部v2', entry: '05-一键生成全部.js', source: 'src/workflows/v2/generate-all.js', confirmation: 'YUNMOMO_CONFIRM_GENERATE_ALL', version: 'v2' },
  { order: 6, name: '定位到ip地v2', entry: '06-定位到ip地.js', source: 'src/workflows/v2/locate-ip.js', confirmation: 'YUNMOMO_CONFIRM_VIRTUAL_LOCATION', version: 'v2' },
  { order: 7, name: '高德初始化v2', entry: '07-高德初始化.js', source: 'src/workflows/v2/initialize-gaode.js', confirmation: 'YUNMOMO_CONFIRM_GAODE_INIT', version: 'v2' },
  { order: 8, name: '丫丫登录v2', entry: '08-丫丫登录.js', source: 'src/workflows/v2/login-yaya.js', confirmation: 'YUNMOMO_CONFIRM_YAYA_LOGIN', version: 'v2' },
];

function formatStepOrder(order) {
  if (typeof order !== 'number') return String(order || '');
  if (Number.isInteger(order)) return String(order).padStart(2, '0');
  return '0' + order;
}

async function runStep(order, { env = process.env, onOutput = text => process.stdout.write(text) } = {}) {
  const step = STEPS.find(item => item.order === order);
  if (!step) throw new Error('未知流程编号：' + order);
  const deviceId = String(env.YUNMOMO_DEVICE_ID || '');
  if (!/^[A-Za-z0-9_-]+$/.test(deviceId)) throw new Error('请用 YUNMOMO_DEVICE_ID 指定目标云机');
  if (!env.YUNMOMO_TOKEN) throw new Error('请通过 YUNMOMO_TOKEN 提供当前登录令牌');

  const runId = env.YUNMOMO_SCRIPT_RUN_ID || ('run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const logsDir = path.join(PROJECT_ROOT, 'logs', 'runs');
  await require('node:fs/promises').mkdir(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `${runId}.log`);
  const logRel = path.relative(PROJECT_ROOT, logFile).replace(/\\/g, '/');

  const startTime = new Date();
  const stepLabel = formatStepOrder(order);
  const header = [
    '================================================================================',
    `[调用唯一ID] ${runId}`,
    `[流程步骤]   步骤 ${stepLabel}：${step.name}`,
    `[目标设备]   ${deviceId}`,
    `[启动时间]   ${startTime.toLocaleString('zh-CN')} (${startTime.toISOString()})`,
    `[执行脚本]   ${step.source}`,
    '================================================================================',
    '',
    '--- 原始标准输出与错误 ---',
    ''
  ].join('\n');
  await require('node:fs/promises').writeFile(logFile, header, 'utf8');

  const childEnv = timing.childEnv({
    ...env,
    YUNMOMO_DEVICE_ID: deviceId,
    YUNMOMO_SDK_VERSION: 'v2',
    [step.confirmation]: 'YES',
    YUNMOMO_VERIFY_ONLY: '0',
    YUNMOMO_SCRIPT_RUN_ID: runId,
  });
  onOutput(`[调用ID: ${runId}]\n开始步骤 ${stepLabel}：${step.name}，目标设备 ${deviceId}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, step.source), '--execute'], {
      cwd: PROJECT_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    const collect = data => {
      const text = redact(data.toString());
      output += text;
      onOutput(text);
      require('node:fs/promises').appendFile(logFile, data.toString()).catch(() => {});
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', error => {
      error.output = output;
      error.runId = runId;
      error.logFile = logRel;
      const footer = [
        '',
        '================================================================================',
        `[异常失败]   ${error.message}`,
        `[结束时间]   ${new Date().toISOString()}`,
        '================================================================================'
      ].join('\n');
      require('node:fs/promises').appendFile(logFile, footer).catch(() => {});
      reject(error);
    });
    child.once('close', (code, signal) => {
      const footer = [
        '',
        '================================================================================',
        `[退出代码]   ${code}`,
        `[结束时间]   ${new Date().toISOString()}`,
        '================================================================================'
      ].join('\n');
      require('node:fs/promises').appendFile(logFile, footer).catch(() => {});
      onOutput(`[原始日志] 已归档至 ${logRel}\n`);
      if (code === 0 && !/"ok"\s*:\s*false/.test(output)) resolve({ output, code, runId, logFile: logRel });
      else {
        const error = new Error(`${step.name}执行失败（退出码 ${code}，信号 ${signal || '无'}）`);
        error.output = output;
        error.runId = runId;
        error.logFile = logRel;
        reject(error);
      }
    });
  });
}

runStep = timing.timed('flow.v2.step', runStep, (order, options) => ({ order, version: 'v2', deviceId: (options?.env || process.env).YUNMOMO_DEVICE_ID }));

function launch(order) {
  if (!process.argv.includes('--execute')) {
    console.error('执行请传入 --execute，并通过 YUNMOMO_DEVICE_ID 指定设备');
    process.exitCode = 1;
    return;
  }
  const env = { ...process.env, YUNMOMO_SDK_VERSION: 'v2' };
  const modeIdx = process.argv.indexOf('--mode');
  if (modeIdx !== -1 && process.argv[modeIdx + 1]) {
    env.YUNMOMO_LOCATION_MODE = process.argv[modeIdx + 1].trim();
  }
  const addrIdx = process.argv.indexOf('--address');
  if (addrIdx !== -1 && process.argv[addrIdx + 1]) {
    env.YUNMOMO_LOCATION_ADDRESS = process.argv[addrIdx + 1].trim();
  }
  runStep(order, { env }).catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
}

module.exports = { STEPS, PROJECT_ROOT, redact, runStep, launch };
