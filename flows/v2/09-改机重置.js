'use strict';

// 兼容旧脚本名称，已重命名为“重置数据v2”
process.env.YUNMOMO_SDK_VERSION = 'v2';
const { main } = require('../../src/workflows/v2/reset-data');
const { redact } = require('./_common');
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
