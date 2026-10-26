'use strict';

const { parseArgs } = require('node:util');
const { YunmomoClient } = require('../src');

async function main() {
  const { values } = parseArgs({ options: {
    contact: { type: 'string' }, 'device-id': { type: 'string' }, execute: { type: 'boolean', default: false },
    'intro-text': { type: 'string' }, help: { type: 'boolean', default: false }
  } });
  if (values.help) {
    console.log('node examples/send-contact.js --contact 123456789 [--execute --device-id ID] [--intro-text TEXT]');
    return;
  }
  const contact = values.contact ?? process.env.YUNMOMO_CONTACT;
  if (!contact) throw new Error('Set --contact or YUNMOMO_CONTACT');
  const deviceId = values['device-id'] ?? process.env.YUNMOMO_DEVICE_ID;
  if (values.execute && !deviceId) throw new Error('--execute requires --device-id or YUNMOMO_DEVICE_ID');
  const client = new YunmomoClient();
  const tools = client.device(deviceId ?? 'local-preview-only').tools();
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  try {
    const result = await tools.sendContact(contact, {
      execute: values.execute, introText: values['intro-text'], signal: abort.signal
    });
    // No image buffers, header thumbnails, tokens or contact texts in live CLI logs.
    if (result.status === 'planned') console.log(JSON.stringify(result, null, 2));
    else console.log(JSON.stringify({ ok: result.ok, status: result.status, operationId: result.operationId,
      deviceId: result.deviceId, durationMs: result.durationMs, execution: result.execution,
      completedMessages: result.data?.completedMessages, uncertainMessageIndex: result.data?.uncertainMessageIndex,
      messages: result.data?.messages?.map(({ index, state }) => ({ index, state })),
      history: result.data?.history, error: result.error, warnings: result.warnings }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    try { await tools.close(); } finally { await client.closeScreenshots(); }
  }
}

main = require('../src/automation/timing').timedScript('script.examples.send-contact', main);

if (require.main === module) main().catch(() => {
  console.error('发送联系方式未完成；检查参数、运行环境，以及结果中的 code / stage。');
  process.exitCode = 1;
});

module.exports = { main };
