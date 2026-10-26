'use strict';

// Live diagnostic only: types one message into the currently open MOMO chat
// and deliberately does not click Send. This is not a unit test.
const fs = require('node:fs');
const path = require('node:path');
const { YunmomoClient } = require('../../src');

const projectRoot = path.resolve(__dirname, '../..');
const deviceId = process.env.YUNMOMO_DEVICE_ID || '2030225672972312577';
const contactName = process.env.YUNMOMO_CONTACT_NAME || '嘿嘿';
const text = process.argv.slice(2).join(' ') || '你好呀，认识一下';

function readLocalToken() {
  const file = path.join(projectRoot, '.env.local');
  if (!fs.existsSync(file)) return '';
  const line = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .find(value => /^\s*YUNMOMO_TOKEN\s*=/.test(value));
  return line ? line.replace(/^\s*YUNMOMO_TOKEN\s*=\s*/, '').trim().replace(/^['"]|['"]$/g, '') : '';
}

async function main() {
  const client = new YunmomoClient({ token: process.env.YUNMOMO_TOKEN || readLocalToken(), timeoutMs: 100000 });
  const tools = client.device(deviceId).tools();
  try {
    const result = await tools.sendChatMessage(text, {
      expectedPeer: contactName,
      execute: true,
      typeOnly: true,
      verifyChatPage: false,
      signal: new AbortController().signal
    });
    console.log(JSON.stringify({
      ok: result.ok,
      status: result.status,
      deviceId,
      contactName,
      text,
      sendState: result.data?.sendState,
      completion: result.data?.completion,
      history: result.data?.history,
      error: result.error
    }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await tools.close();
    await client.closeScreenshots();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error.code || 'TYPING_CHECK_FAILED', message: error.message }, null, 2));
  process.exitCode = 1;
});

