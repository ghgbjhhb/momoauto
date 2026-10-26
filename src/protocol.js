'use strict';

const CONTROL = Object.freeze({
  KEYCODE: 0,
  TEXT: 1,
  TOUCH: 2,
  SCROLL: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_SCREEN_POWER_MODE: 10,
  ROTATE_DEVICE: 11,
  CHANGE_STREAM_PARAMETERS: 101,
  PUSH_FILE: 102
});

const ACTION = Object.freeze({
  DOWN: 0,
  UP: 1,
  MOVE: 2
});

const META = Object.freeze({
  NONE: 0,
  SHIFT_ON: 1,
  ALT_ON: 2,
  CTRL_ON: 4096,
  META_ON: 65536,
  CAPS_LOCK_ON: 1048576,
  NUM_LOCK_ON: 2097152,
  SCROLL_LOCK_ON: 4194304
});

const KEY_CODES = {
  UNKNOWN: 0,
  SOFT_LEFT: 1,
  SOFT_RIGHT: 2,
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  ALT_LEFT: 57,
  ALT_RIGHT: 58,
  SHIFT_LEFT: 59,
  SHIFT_RIGHT: 60,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  GRAVE: 68,
  MINUS: 69,
  EQUALS: 70,
  LEFT_BRACKET: 71,
  RIGHT_BRACKET: 72,
  BACKSLASH: 73,
  SEMICOLON: 74,
  APOSTROPHE: 75,
  SLASH: 76,
  AT: 77,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_STOP: 86,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  MEDIA_REWIND: 89,
  MEDIA_FAST_FORWARD: 90,
  MUTE: 91,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  CAPS_LOCK: 115,
  META_LEFT: 117,
  META_RIGHT: 118,
  FUNCTION: 119,
  SYSRQ: 120,
  BREAK: 121,
  MOVE_HOME: 122,
  MOVE_END: 123,
  INSERT: 124,
  SETTINGS: 176,
  APP_SWITCH: 187,
  FORWARD: 125,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23
};

for (let digit = 0; digit <= 9; digit += 1) {
  KEY_CODES['DIGIT_' + digit] = 7 + digit;
}

for (let index = 0; index < 26; index += 1) {
  KEY_CODES[String.fromCharCode(65 + index)] = 29 + index;
}

for (let functionKey = 1; functionKey <= 12; functionKey += 1) {
  KEY_CODES['F' + functionKey] = 130 + functionKey;
}

Object.freeze(KEY_CODES);

const INITIAL_MAGIC = Buffer.from('scrcpy_initial', 'utf8');
const MESSAGE_MAGIC = Buffer.from('scrcpy_message', 'utf8');
const FILE_STATE = Object.freeze({ NEW: 0, START: 1, APPEND: 2, FINISH: 3, CANCEL: 4 });

function integer(name, value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return number;
}

function screenSize(options) {
  return {
    width: integer('screenWidth', options.screenWidth, 1, 0xffff),
    height: integer('screenHeight', options.screenHeight, 1, 0xffff)
  };
}

function encodeKey(options) {
  const settings = options || {};
  const action = integer('action', settings.action, 0, 0xff);
  const keycode = integer('keycode', settings.keycode, -0x80000000, 0x7fffffff);
  const repeat = integer('repeat', settings.repeat === undefined ? 0 : settings.repeat, 0, 0x7fffffff);
  const metaState = integer(
    'metaState',
    settings.metaState === undefined ? 0 : settings.metaState,
    -0x80000000,
    0x7fffffff
  );

  const buffer = Buffer.alloc(14);
  let offset = 0;
  buffer.writeUInt8(CONTROL.KEYCODE, offset);
  offset += 1;
  buffer.writeUInt8(action, offset);
  offset += 1;
  buffer.writeInt32BE(keycode, offset);
  offset += 4;
  buffer.writeInt32BE(repeat, offset);
  offset += 4;
  buffer.writeInt32BE(metaState, offset);
  return buffer;
}

function encodeText(text) {
  const data = Buffer.from(String(text), 'utf8');
  const buffer = Buffer.alloc(5 + data.length);
  buffer.writeUInt8(CONTROL.TEXT, 0);
  buffer.writeUInt32BE(data.length, 1);
  data.copy(buffer, 5);
  return buffer;
}

function encodeTouch(options) {
  const settings = options || {};
  const size = screenSize(settings);
  const point = {
    x: integer('x', settings.x, 0, size.width - 1),
    y: integer('y', settings.y, 0, size.height - 1)
  };
  const action = integer('action', settings.action, 0, 2);
  const pointerId = integer('pointerId', settings.pointerId === undefined ? 0 : settings.pointerId, 0, 0xffffffff);
  const pressure = settings.pressure === undefined ? 1 : Number(settings.pressure);
  const buttons = integer('buttons', settings.buttons === undefined ? 1 : settings.buttons, 0, 0xffffffff);

  if (!Number.isFinite(pressure) || pressure < 0 || pressure > 1) {
    throw new RangeError('pressure must be a number between 0 and 1');
  }

  // This is the exact frame size emitted by the qk stream bundle:
  // PAYLOAD_LENGTH is 28 and the type byte is added separately.
  const buffer = Buffer.alloc(29);
  let offset = 0;
  buffer.writeUInt8(CONTROL.TOUCH, offset);
  offset += 1;
  buffer.writeUInt8(action, offset);
  offset += 1;
  buffer.writeUInt32BE(0, offset);
  offset += 4;
  buffer.writeUInt32BE(pointerId, offset);
  offset += 4;
  buffer.writeUInt32BE(point.x, offset);
  offset += 4;
  buffer.writeUInt32BE(point.y, offset);
  offset += 4;
  buffer.writeUInt16BE(size.width, offset);
  offset += 2;
  buffer.writeUInt16BE(size.height, offset);
  offset += 2;
  buffer.writeUInt16BE(Math.round(pressure * 0xffff), offset);
  offset += 2;
  buffer.writeUInt32BE(buttons, offset);
  return buffer;
}

function encodeScroll(options) {
  const settings = options || {};
  const size = screenSize(settings);
  const point = {
    x: integer('x', settings.x, 0, size.width - 1),
    y: integer('y', settings.y, 0, size.height - 1)
  };
  const hScroll = integer('hScroll', settings.hScroll === undefined ? 0 : settings.hScroll, -0x80000000, 0x7fffffff);
  const vScroll = integer('vScroll', settings.vScroll === undefined ? 0 : settings.vScroll, -0x80000000, 0x7fffffff);

  const buffer = Buffer.alloc(21);
  let offset = 0;
  buffer.writeUInt8(CONTROL.SCROLL, offset);
  offset += 1;
  buffer.writeUInt32BE(point.x, offset);
  offset += 4;
  buffer.writeUInt32BE(point.y, offset);
  offset += 4;
  buffer.writeUInt16BE(size.width, offset);
  offset += 2;
  buffer.writeUInt16BE(size.height, offset);
  offset += 2;
  buffer.writeInt32BE(hScroll, offset);
  offset += 4;
  buffer.writeInt32BE(vScroll, offset);
  return buffer;
}

function encodeSetClipboard(text, options) {
  const settings = options || {};
  const data = Buffer.from(String(text === undefined || text === null ? '' : text), 'utf8');
  const buffer = Buffer.alloc(6 + data.length);
  buffer.writeUInt8(CONTROL.SET_CLIPBOARD, 0);
  buffer.writeUInt8(settings.paste ? 1 : 0, 1);
  buffer.writeUInt32BE(data.length, 2);
  data.copy(buffer, 6);
  return buffer;
}

function encodeScreenPower(on) {
  if (typeof on !== 'boolean') throw new TypeError('on must be a boolean');
  const buffer = Buffer.alloc(2);
  buffer.writeUInt8(CONTROL.SET_SCREEN_POWER_MODE, 0);
  buffer.writeUInt8(on ? 1 : 0, 1);
  return buffer;
}

function encodeCommand(type) {
  const command = integer('type', type, 0, 0xff);
  const buffer = Buffer.alloc(1);
  buffer.writeUInt8(command, 0);
  return buffer;
}

// qk module 362: 35-byte fixed header, followed by two optional UTF-8 strings.
function encodeVideoSettings(options = {}) {
  const codec = Buffer.from(options.codecOptions || '', 'utf8');
  const encoder = Buffer.from(options.encoderName || '', 'utf8');
  const buffer = Buffer.alloc(36 + codec.length + encoder.length);
  buffer[0] = CONTROL.CHANGE_STREAM_PARAMETERS;
  let offset = 1;
  offset = buffer.writeInt32BE(integer('bitrate', options.bitrate ?? 524288, 0, 0x7fffffff), offset);
  offset = buffer.writeInt32BE(integer('maxFps', options.maxFps ?? 60, 0, 240), offset);
  offset = buffer.writeInt8(integer('iFrameInterval', options.iFrameInterval ?? 15, -1, 127), offset);
  for (const [name, value] of Object.entries({
    width: options.bounds?.width ?? 0, height: options.bounds?.height ?? 0,
    left: options.crop?.left ?? 0, top: options.crop?.top ?? 0,
    right: options.crop?.right ?? 0, bottom: options.crop?.bottom ?? 0
  })) offset = buffer.writeInt16BE(integer(name, value, 0, 0x7fff), offset);
  offset = buffer.writeUInt8(options.sendFrameMeta ? 1 : 0, offset);
  offset = buffer.writeInt8(integer('lockedVideoOrientation', options.lockedVideoOrientation ?? -1, -1, 3), offset);
  offset = buffer.writeInt32BE(integer('displayId', options.displayId ?? 0, 0, 0x7fffffff), offset);
  offset = buffer.writeInt32BE(codec.length, offset);
  offset += codec.copy(buffer, offset);
  offset = buffer.writeInt32BE(encoder.length, offset);
  encoder.copy(buffer, offset);
  return buffer;
}

function encodePushFile({ id = 0, state, fileName, fileSize, chunk } = {}) {
  integer('id', id, 0, 0x7fff);
  integer('state', state, 0, 4);
  let buffer;
  if (state === FILE_STATE.START) {
    if (typeof fileName !== 'string' || !fileName || /[\\/\0]/.test(fileName)) {
      throw new TypeError('fileName must be a filename without path separators');
    }
    const name = Buffer.from(fileName, 'utf8');
    integer('filename byte length', name.length, 1, 0xffff);
    buffer = Buffer.alloc(10 + name.length);
    buffer.writeUInt32BE(integer('fileSize', fileSize, 0, 0xffffffff), 4);
    buffer.writeUInt16BE(name.length, 8);
    name.copy(buffer, 10);
  } else if (state === FILE_STATE.APPEND) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new TypeError('chunk must be binary data');
    const data = Buffer.from(chunk);
    buffer = Buffer.alloc(8 + data.length);
    buffer.writeUInt32BE(data.length, 4);
    data.copy(buffer, 8);
  } else buffer = Buffer.alloc(4);
  buffer[0] = CONTROL.PUSH_FILE;
  buffer.writeInt16BE(id, 1);
  buffer.writeInt8(state, 3);
  return buffer;
}

function binaryReader(data, offset = 0) {
  const buffer = Buffer.from(data);
  return {
    take(length) {
      if (!Number.isInteger(length) || length < 0 || offset + length > buffer.length) {
        throw new RangeError('Truncated or invalid cloud-phone frame');
      }
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      return value;
    },
    int32() { return this.take(4).readInt32BE(); },
    get remaining() { return buffer.length - offset; }
  };
}

function decodeVideoSettings(data) {
  const r = binaryReader(data);
  const bitrate = r.int32(), maxFps = r.int32(), iFrameInterval = r.take(1).readInt8();
  const rect = Array.from({ length: 6 }, () => r.take(2).readInt16BE());
  const sendFrameMeta = !!r.take(1)[0], lockedVideoOrientation = r.take(1).readInt8(), displayId = r.int32();
  const codecOptions = r.take(r.int32()).toString('utf8');
  const encoderName = r.take(r.int32()).toString('utf8');
  return { bitrate, maxFps, iFrameInterval, bounds: { width: rect[0], height: rect[1] },
    crop: { left: rect[2], top: rect[3], right: rect[4], bottom: rect[5] },
    sendFrameMeta, lockedVideoOrientation, displayId, codecOptions, encoderName };
}

function decodeInitial(data) {
  const buffer = Buffer.from(data);
  if (!buffer.subarray(0, INITIAL_MAGIC.length).equals(INITIAL_MAGIC)) throw new TypeError('Not an initial frame');
  const r = binaryReader(buffer, INITIAL_MAGIC.length);
  const deviceName = r.take(64).toString('utf8').replace(/\0+$/, '');
  const count = integer('display count', r.int32(), 0, 128);
  const displays = [];
  for (let index = 0; index < count; index++) {
    const d = { displayId: r.int32(), width: r.int32(), height: r.int32(), rotation: r.int32(),
      layerStack: r.int32(), flags: r.int32(), connections: r.int32() };
    const screen = r.take(r.int32());
    if (screen.length) {
      const s = binaryReader(screen);
      d.screenInfo = { contentRect: { left: s.int32(), top: s.int32(), right: s.int32(), bottom: s.int32() },
        videoSize: { width: s.int32(), height: s.int32() }, deviceRotation: s.take(1)[0] };
    }
    const settings = r.take(r.int32());
    if (settings.length) d.videoSettings = decodeVideoSettings(settings);
    displays.push(d);
  }
  const encoderCount = integer('encoder count', r.int32(), 0, 1024);
  const encoders = Array.from({ length: encoderCount }, () => r.take(r.int32()).toString('utf8'));
  return { deviceName, displays, encoders, clientId: r.int32() };
}

function decodeDeviceMessage(data) {
  const buffer = Buffer.from(data);
  if (!buffer.subarray(0, MESSAGE_MAGIC.length).equals(MESSAGE_MAGIC)) return null;
  const r = binaryReader(buffer, MESSAGE_MAGIC.length);
  const type = r.take(1)[0];
  if (type === 0) return { type: 'clipboard', text: r.take(r.int32()).toString('utf8') };
  if (type === 101) return { type: 'file-response', id: r.take(2).readInt16BE(), code: r.take(1).readInt8() };
  return { type: 'unknown', messageType: type, data: r.take(r.remaining) };
}

module.exports = {
  ACTION,
  CONTROL,
  INITIAL_MAGIC,
  MESSAGE_MAGIC,
  FILE_STATE,
  KEY_CODES,
  META,
  encodeCommand,
  encodeKey,
  encodeScreenPower,
  encodeScroll,
  encodeSetClipboard,
  encodeText,
  encodeTouch,
  encodeVideoSettings,
  encodePushFile,
  decodeVideoSettings,
  decodeInitial,
  decodeDeviceMessage,
  integer
};
