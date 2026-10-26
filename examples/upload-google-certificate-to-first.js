'use strict';

// Fixed-target entry point for the first cloud phone.
const TARGET_DEVICE_ID = '2033060279606353921';
if (process.env.YUNMOMO_DEVICE_ID && process.env.YUNMOMO_DEVICE_ID !== TARGET_DEVICE_ID) {
  throw new Error('第一台证书脚本不接受其他 YUNMOMO_DEVICE_ID: ' + process.env.YUNMOMO_DEVICE_ID);
}
process.env.YUNMOMO_DEVICE_ID = TARGET_DEVICE_ID;
if (require.main === module) require('../src/automation/runtime').launchCli(require('./upload-google-certificate').main);
