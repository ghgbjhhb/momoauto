'use strict';

const isDirectRun = require.main === module;

if (isDirectRun) {
  require('../../src/workflows/v2/login-yaya').main().catch(error => {
    process.exitCode = 1;
  });
} else {
  require('./_common').launch(8);
}
