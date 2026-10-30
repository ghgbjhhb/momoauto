'use strict';

const { main, scriptRunId } = require('../../src/workflows/momo-contact-sync');
const { redact } = require('../../src/automation/runtime');
main().catch(error => {
  const runId = scriptRunId();
  if (runId) console.error(`[日志ID: ${runId}] 原始日志: logs/runs/${runId}.log`);
  console.error(redact(error.message));
  process.exitCode = 1;
});
