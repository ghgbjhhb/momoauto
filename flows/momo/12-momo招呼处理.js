'use strict';

const { main } = require('../../src/workflows/momo-greetings');
const { redact } = require('../../src/automation/runtime');
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
