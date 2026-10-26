'use strict';

// Fixed-target entry point for the third cloud phone.
const TARGET_DEVICE_ID = '2030225672674516993';
if (process.env.YUNMOMO_DEVICE_ID && process.env.YUNMOMO_DEVICE_ID !== TARGET_DEVICE_ID) {
  throw new Error('第三台证书脚本不接受其他 YUNMOMO_DEVICE_ID: ' + process.env.YUNMOMO_DEVICE_ID);
}
process.env.YUNMOMO_DEVICE_ID = TARGET_DEVICE_ID;
if (require.main === module) require('../src/automation/runtime').launchCli(require('./upload-google-certificate').main);
