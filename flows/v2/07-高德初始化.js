'use strict';

const isDirectRun = require.main === module;

if (isDirectRun) {
  require('../../src/workflows/v2/initialize-gaode').main().catch(error => {
    process.exitCode = 1;
  });
} else {
  require('./_common').launch(7);
}
