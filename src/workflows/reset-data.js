'use strict';

// Facade forwarding to v2 reset-data
const impl = require('./v2/reset-data.js');
module.exports = impl;
if (require.main === module) {
  require('../automation/runtime').launchCli(impl.main);
}
