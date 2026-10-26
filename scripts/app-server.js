'use strict';

const server = require('../src/server/app-server');
if (require.main === module) require('../src/automation/runtime').launchCli(server.start);
module.exports = server;
