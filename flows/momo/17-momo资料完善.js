'use strict';

const { main } = require('../../src/workflows/v2/setup-profile');
const { redact } = require('../../src/automation/runtime');
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
