'use strict';

process.env.YUNMOMO_SDK_VERSION = 'v3';
const { main } = require('../../src/workflows/v3/change-model-reset');
const { redact } = require('./_common');
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
