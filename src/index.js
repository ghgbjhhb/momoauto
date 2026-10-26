'use strict';

module.exports = { ...require('./client'), protocol: require('./protocol'), ...require('./browser-view'),
  ...require('./management'), ...require('./tools'),
  SharedRecognitionClient: require('./automation/recognition-service').SharedRecognitionClient };
