'use strict';

process.env.YUNMOMO_SDK_VERSION = 'v2';
const { main } = require('../../src/workflows/v2/reset-data');
const { redact } = require('./_common');
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
