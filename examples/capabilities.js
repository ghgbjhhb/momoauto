'use strict';

const { BACKEND_ACTIONS, TOOLBAR_ITEMS, MANAGEMENT_ACTIONS } = require('..');
console.log(JSON.stringify({
  control: ['tap', 'longPress', 'swipe', 'text', 'pressKey', 'back', 'home', 'overview', 'volumeUp', 'volumeDown',
    'expandNotifications', 'expandSettings', 'collapsePanels', 'rotate', 'screenPower', 'getClipboard', 'setClipboard',
    'paste', 'setVideoSettings', 'setStreamSize', 'pushFile', 'setAutoRefresh', 'setAutoCopy', 'refresh', 'close'],
  browserView: ['setPreferences', 'setSize', 'openSidebarAction', 'refresh'],
  toolbar: Object.keys(TOOLBAR_ITEMS),
  backend: BACKEND_ACTIONS,
  cloudDisk: ['list', 'get', 'usage', 'upload', 'rename', 'delete', 'resolveUrl', 'sendToDevices',
    'transferStatus', 'sendPairs', 'pairStatus', 'clearPairStatus', 'importExcel', 'exportExcel', 'exportTemplate'],
  vpc: ['list', 'get', 'save', 'batchSave', 'delete', 'testConnection', 'groups', 'importExcel', 'exportExcel', 'exportTemplate'],
  vpcGroups: ['list', 'get', 'save', 'delete'],
  management: MANAGEMENT_ACTIONS
}, null, 2));
