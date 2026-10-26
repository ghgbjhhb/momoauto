'use strict';
// Backward-compatible shim: consolidated into scripts/momo-db.js
const { cleanDatabase } = require('./momo-db');
const deviceId = process.argv[2] || process.env.YUNMOMO_DEVICE_ID;
cleanDatabase(deviceId);
