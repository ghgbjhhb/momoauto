'use strict';

// Compatibility entry. The implementation lives in src/workflows.
const workflow = require('../src/workflows/set-vpc-proxy');
if (require.main === module) require('../src/automation/runtime').launchCli(workflow.main);
module.exports = workflow;
