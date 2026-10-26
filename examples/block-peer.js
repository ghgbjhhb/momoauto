'use strict';

const { parseArgs } = require('node:util');
const { YunmomoClient } = require('../src');

async function main() {
  const { values } = parseArgs({ options: {
    execute: { type: 'boolean', default: false }, 'device-id': { type: 'string' }, help: { type: 'boolean', default: false }
  } });
  if (values.help) { console.log('node examples/block-peer.js [--execute --device-id ID]'); return; }
  const deviceId = values['device-id'] ?? process.env.YUNMOMO_DEVICE_ID;
  if (values.execute && !deviceId) { console.error('真实拉黑需要 --device-id 或 YUNMOMO_DEVICE_ID。'); process.exitCode = 1; return; }
  const client = new YunmomoClient();
  const tools = client.device(deviceId ?? 'local-preview-only').tools();
  const abort = new AbortController(), stop = () => abort.abort();
  process.once('SIGINT', stop);
  try {
    const result = await tools.blockPeer({ execute: values.execute, signal: abort.signal });
    if (result.status === 'planned') console.log(JSON.stringify(result, null, 2));
    else console.log(JSON.stringify({ ok: result.ok, status: result.status, operationId: result.operationId,
      deviceId: result.deviceId, durationMs: result.durationMs, execution: result.execution, outcome: result.data?.outcome,
      confirmationClickAttempted: result.data?.confirmationClickAttempted,
      confirmationClickSent: result.data?.confirmationClickSent, blockedUiConfirmed: result.data?.blockedUiConfirmed,
      history: result.data?.history, error: result.error, warnings: result.warnings }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    try { await tools.close(); } finally { await client.closeScreenshots(); }
  }
}

main = require('../src/automation/timing').timedScript('script.examples.block-peer', main);

if (require.main === module) main().catch(() => {
  console.error('拉黑工具未完成；检查启动参数及结果中的 code / stage。可用 --help 查看调用方式。');
  process.exitCode = 1;
});

module.exports = { main };
