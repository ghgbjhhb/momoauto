'use strict';

const { main } = require('../../src/workflows/momo-message-watch');
const { redact } = require('../_common');
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
