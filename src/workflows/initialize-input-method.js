'use strict';

// V2 架构无需初始化输入法；V3 走 v3 真实工作流
if (process.env.YUNMOMO_SDK_VERSION === 'v2') {
  const main = async () => {
    console.log('[输入法初始化] V2 架构无需执行输入法初始化，已自动跳过。');
    return { ok: true, skipped: true, reason: 'V2无需输入法初始化' };
  };
  module.exports = { main };
  if (require.main === module) {
    require('../automation/runtime').launchCli(main);
  }
} else {
  const impl = require('./v3/initialize-input-method.js');
  module.exports = impl;
  if (require.main === module) {
    require('../automation/runtime').launchCli(impl.main);
  }
}
