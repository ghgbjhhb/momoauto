'use strict';

const args = process.argv.slice(2);
const actionParam = String(process.env.YUNMOMO_PROXY_ACTION || '').toLowerCase();
const isStandaloneAction = args.some(a => ['--show', '--status', '--info', '--query', '--stop', '--close', '--disable'].includes(a)) ||
  ['show', 'status', 'info', 'query', 'stop', 'close', 'disable'].includes(actionParam);

if (isStandaloneAction) {
  require('../../src/workflows/v2/set-vpc-proxy').main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
} else {
  require('./_common').launch(3);
}
