'use strict';
// Backward-compatible shim: consolidated into scripts/momo-db.js
const { inspectDatabase } = require('./momo-db');
const deviceId = process.argv[2] || process.env.YUNMOMO_DEVICE_ID;
inspectDatabase(deviceId);
