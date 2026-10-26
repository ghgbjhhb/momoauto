'use strict';

// Facade forwarding to v3 by default (or v2 if YUNMOMO_SDK_VERSION=v2)
const version = process.env.YUNMOMO_SDK_VERSION === 'v2' ? 'v2' : 'v3';
const impl = require('./' + version + '/' + "set-vpc-proxy.js");
module.exports = impl;
if (require.main === module) {
  require('../automation/runtime').launchCli(impl.main);
}
