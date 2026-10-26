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

function launchCli(main) {
  return Promise.resolve().then(timedScript('script.' + path.basename(process.argv[1] || 'cli', '.js'), main)).catch(error => {
    console.error(redact(error.message));
    if (typeof error.data === 'string') console.error(redact(error.data));
    process.exitCode = 1;
  });
}

module.exports = { PROJECT_ROOT, redact, launchCli };
