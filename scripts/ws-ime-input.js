'use strict';

const typing = require('../src/typing/ws-ime-input');
if (require.main === module) require('../src/automation/runtime').launchCli(typing.main);
module.exports = typing;
