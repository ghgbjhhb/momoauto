'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { timedScript } = require('./timing');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

function loadLocalEnv() {
  try {
    const envFile = path.join(PROJECT_ROOT, '.env.local');
    if (!fs.existsSync(envFile)) return;
    const content = fs.readFileSync(envFile, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {}
}

loadLocalEnv();

function redact(value) {
  return String(value).replace(/token=[^&\s]+/gi, 'token=<redacted>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-token>');
}

// 目标云机解析的唯一入口：显式传入优先，其次 YUNMOMO_DEVICE_ID；二者皆缺时明确失败，绝不回退到猜测的设备。
function targetDeviceId(explicitId, env = process.env) {
  const value = String(explicitId ?? '').trim() || String(env.YUNMOMO_DEVICE_ID ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('未指定目标云机：请通过 --device 参数或 YUNMOMO_DEVICE_ID 环境变量提供设备 ID');
  }
  return value;
}

function launchCli(main) {
  return Promise.resolve().then(timedScript('script.' + path.basename(process.argv[1] || 'cli', '.js'), main)).catch(error => {
    console.error(redact(error.message));
    if (typeof error.data === 'string') console.error(redact(error.data));
    process.exitCode = 1;
  });
}

module.exports = { PROJECT_ROOT, redact, launchCli, targetDeviceId };
