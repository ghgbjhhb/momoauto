'use strict';

/**
 * 陌陌手机号绑定子逻辑已无缝合并至流程 16 (16-momo一键上号.js)
 * 为保持向后兼容性，本脚本直接重定向调用统一全流程主入口
 */
const { main } = require('../../src/workflows/v2/login-momo');
const { redact } = require('../../src/automation/runtime');
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
