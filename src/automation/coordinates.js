'use strict';
const { coordinateMapper } = require('../tools/touch-gestures');

// Model coordinates belong to a screenshot, not necessarily the SDK's touch resolution.
function observedPoint(control, observation, point) {
  return coordinateMapper({ coordinateSpace: { width: observation.width, height: observation.height } }, {
    width: control.screenWidth ?? observation.width,
    height: control.screenHeight ?? observation.height
  }).map(point, 'observed point');
}
module.exports = { observedPoint };
