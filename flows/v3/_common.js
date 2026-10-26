'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const { PROJECT_ROOT, redact } = require('../../src/automation/runtime');
const timing = require('../../src/automation/timing');

const STEPS = [
  { order: 1, name: '导入云盘所有文件v3', entry: '01-导入云盘所有文件.js', source: 'src/workflows/v3/send-cloud-files.js', confirmation: 'YUNMOMO_CONFIRM_SEND', version: 'v3' },
  { order: 2, name: '上传证书v3', entry: '02-上传证书.js', source: 'src/workflows/v3/upload-certificate.js', confirmation: 'YUNMOMO_CONFIRM_CERT_UPLOAD', version: 'v3' },
  { order: 3, name: '设置VPC代理v3', entry: '03-设置VPC代理.js', source: 'src/workflows/v3/set-vpc-proxy.js', confirmation: 'YUNMOMO_CONFIRM_VPC_PROXY', version: 'v3' },
  { order: 4, name: '环境配置v3', entry: '04-环境配置.js', source: 'src/workflows/v3/configure-environment.js', confirmation: 'YUNMOMO_CONFIRM_ENV_CONFIG', version: 'v3' },
  { order: 5, name: '一键生成全部v3', entry: '05-一键生成全部.js', source: 'src/workflows/v3/generate-all.js', confirmation: 'YUNMOMO_CONFIRM_GENERATE_ALL', version: 'v3' },
  { order: 6, name: '定位到ip地v3', entry: '06-定位到ip地.js', source: 'src/workflows/v3/locate-ip.js', confirmation: 'YUNMOMO_CONFIRM_VIRTUAL_LOCATION', version: 'v3' },
  { order: 7, name: '高德初始化v3', entry: '07-高德初始化.js', source: 'src/workflows/v3/initialize-gaode.js', confirmation: 'YUNMOMO_CONFIRM_GAODE_INIT', version: 'v3' },
  { order: 8, name: '输入法初始化v3', entry: '08-输入法初始化.js', source: 'src/workflows/v3/initialize-input-method.js', confirmation: 'YUNMOMO_CONFIRM_INPUT_INIT', version: 'v3' },
];

async function runStep(order, { env = process.env, onOutput = text => process.stdout.write(text) } = {}) {
  const step = STEPS.find(item => item.order === order);
  if (!step) throw new Error('未知流程编号：' + order);
  const deviceId = String(env.YUNMOMO_DEVICE_ID || '');
  if (!/^[A-Za-z0-9_-]+$/.test(deviceId)) throw new Error('请用 YUNMOMO_DEVICE_ID 指定目标云机');
  if (!env.YUNMOMO_TOKEN) throw new Error('请通过 YUNMOMO_TOKEN 提供当前登录令牌');
  const childEnv = timing.childEnv({
    ...env,
    YUNMOMO_DEVICE_ID: deviceId,
    YUNMOMO_SDK_VERSION: 'v3',
    [step.confirmation]: 'YES',
    YUNMOMO_VERIFY_ONLY: '0',
  });
  onOutput(`开始 ${order}/8：${step.name}，目标设备 ${deviceId}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, step.source), '--execute'], {
      cwd: PROJECT_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    const collect = data => {
      const text = redact(data.toString());
      output += text;
      onOutput(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', error => { error.output = output; reject(error); });
    child.once('close', (code, signal) => {
      if (code === 0 && !/"ok"\s*:\s*false/.test(output)) resolve({ output, code });
      else {
        const error = new Error(`${step.name}执行失败（退出码 ${code}，信号 ${signal || '无'}）`);
        error.output = output;
        reject(error);
      }
    });
  });
}

runStep = timing.timed('flow.v3.step', runStep, (order, options) => ({ order, version: 'v3', deviceId: (options?.env || process.env).YUNMOMO_DEVICE_ID }));

function launch(order) {
  if (!process.argv.includes('--execute')) {
    console.error('执行请传入 --execute，并通过 YUNMOMO_DEVICE_ID 指定设备');
    process.exitCode = 1;
    return;
  }
  runStep(order, { env: { ...process.env, YUNMOMO_SDK_VERSION: 'v3' } }).catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
}

module.exports = { STEPS, PROJECT_ROOT, redact, runStep, launch };
