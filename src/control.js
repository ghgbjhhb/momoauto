'use strict';

const { EventEmitter } = require('node:events');
const { readFile, stat } = require('node:fs/promises');
const { basename } = require('node:path');
const { inspect } = require('node:util');
const WebSocket = require('ws');
const p = require('./protocol');
const { sharedStreamInput } = require('./stream-control');

function requiredString(name, value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(name + ' must be a non-empty string');
  if (/[\r\n\0]/.test(value)) throw new TypeError(name + ' must not contain control characters');
  return value;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(new Error('Operation aborted'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    function abort() { clearTimeout(timer); cleanup(); reject(new Error('Operation aborted')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

class CloudPhoneControl extends EventEmitter {
  constructor(options = {}) {
    super();
    Object.defineProperty(this, 'token', { value: requiredString('token', options.token), writable: true });
    this.udid = requiredString('udid', options.udid);
    this.deviceId = requiredString('deviceId', options.deviceId);
    this.origin = options.origin ?? 'https://qk.yunmomo.com';
    this.endpoint = options.endpoint ?? 'wss://qk.yunmomo.com/';
    this.screenWidth = p.integer('screenWidth', options.screenWidth ?? 720, 1, 65535);
    this.screenHeight = p.integer('screenHeight', options.screenHeight ?? 1280, 1, 65535);
    // 触摸/按键走厂商 /stream JSON 协议（旧隧道触摸注入已被服务端下线）。
    // 截图/转发等纯视频连接点必须显式传 false，避免与流程输入互抢 master。
    this.inputOverStream = options.inputOverStream !== false;
    this._streamInput = null;
    this._streamError = null;
    this.displayId = p.integer('displayId', options.displayId ?? 0, 0, 0x7fffffff);
    this.videoSettings = { bitrate: 524288, maxFps: options.maxFps ?? 60, iFrameInterval: 15,
      bounds: { width: 720, height: 720 }, lockedVideoOrientation: -1, sendFrameMeta: false,
      ...options.videoSettings, displayId: this.displayId };
    p.encodeVideoSettings(this.videoSettings);
    this.socket = null;
    this.connected = false;
    this.ready = false;
    this.info = null;
    this.initialFrame = null;
    this.autoRefresh = false;
    this.retryDelays = [500, 2000, 5000, 10000, 30000];
    this._retryIndex = 0;
    this._desired = false;
    this._generation = 0;
    this._gestures = Promise.resolve();
    this._clipboardQueue = Promise.resolve();
    this._uploads = Promise.resolve();
    if (options.autoRefresh) this.setAutoRefresh(true);
    if (options.autoCopy) this.setAutoCopy(options.autoCopy);
  }

  buildWebSocketUrl() {
    const url = new URL(this.endpoint);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new TypeError('WebSocket endpoint must use wss (ws is allowed only on loopback)');
    }
    url.searchParams.set('action', 'proxy-adb');
    url.searchParams.set('remote', 'tcp:8886');
    url.searchParams.set('udid', this.udid);
    url.searchParams.set('token', this.token);
    url.searchParams.set('deviceId', this.deviceId);
    return url.toString();
  }

  redactedWebSocketUrl() {
    const url = new URL(this.buildWebSocketUrl());
    url.searchParams.set('token', '<redacted>');
    return url.toString();
  }

  toJSON() {
    return { deviceId: this.deviceId, udid: this.udid, connected: this.connected, ready: this.ready,
      screenWidth: this.screenWidth, screenHeight: this.screenHeight };
  }

  [inspect.custom]() { return this.toJSON(); }

  connect(options = {}) {
    if (this._connecting) return this._connecting;
    if (this.ready || (options.waitForInitial === false && this.connected)) return Promise.resolve(this);
    const timeoutMs = p.integer('timeoutMs', options.timeoutMs ?? 15000, 1, 0x7fffffff);
    const address = this.buildWebSocketUrl();
    this._desired = true;
    clearTimeout(this._retryTimer);
    const generation = ++this._generation;
    const previous = this.socket;
    if (previous) previous.terminate();
    this.ready = this.connected = false;
    this.info = this.initialFrame = null;
    const socket = this.socket = new WebSocket(address, { origin: this.origin });
    let finish;
    const pending = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error('Cloud phone connection/initialization timed out'));
        socket.terminate();
      }, timeoutMs);
      finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(this);
      };
      socket.on('open', () => {
        if (generation !== this._generation) return;
        this.connected = true;
        this.emit('open');
        if (options.waitForInitial === false) finish();
      });
      socket.on('message', (data, isBinary) => {
        if (generation !== this._generation) return;
        try {
          this.handleMessage(isBinary ? data : data.toString('utf8'));
          if (this.ready) finish();
        } catch {
          const error = new Error('Invalid cloud phone protocol frame');
          this.emit('protocol-error', error);
          finish(error);
          socket.terminate();
        }
      });
      socket.on('error', () => {
        if (generation !== this._generation) return;
        const error = new Error('Cloud phone WebSocket error (check token, device and network)');
        finish(error);
        this.emit('connection-error', error);
        if (this.listenerCount('error')) this.emit('error', error);
      });
      socket.on('close', code => {
        if (generation !== this._generation) return;
        finish(new Error('Cloud phone connection closed before initialization'));
        this.connected = this.ready = false;
        this.socket = null;
        // Remote close reasons may contain credentials; do not forward them into logs.
        this.emit('close', { code });
        this._scheduleReconnect();
      });
    });
    this._connecting = pending;
    const clear = () => { if (this._connecting === pending) this._connecting = null; };
    pending.then(clear, clear);
    return pending;
  }

  handleMessage(data) {
    if (typeof data === 'string') { this.emit('text-message', data); return; }
    const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (frame.subarray(0, p.INITIAL_MAGIC.length).equals(p.INITIAL_MAGIC)) {
      const info = p.decodeInitial(frame);
      const display = info.displays.find(d => d.displayId === this.displayId);
      if (!display) throw new Error('Requested display is not available');
      const size = display.screenInfo?.videoSize ?? display;
      const width = p.integer('screen width', size.width, 1, 65535);
      const height = p.integer('screen height', size.height, 1, 65535);
      this.screenWidth = width;
      this.screenHeight = height;
      this.info = info;
      this.initialFrame = frame;
      const firstReady = !this.ready;
      this.ready = true;
      this._retryIndex = 0;
      this.emit('initial', frame);
      this.emit('screen-info', { width, height, displayId: this.displayId, info });
      if (firstReady) {
        this.send(p.encodeVideoSettings(this.videoSettings));
        this.emit('ready', info);
        this._warmStreamInput();
      }
      return;
    }
    const message = p.decodeDeviceMessage(frame);
    if (message) {
      this.emit('device-message', message);
      if (message.type === 'clipboard') {
        this.emit('clipboard', message.text);
        if (this._copyHandler) Promise.resolve().then(() => this._copyHandler?.(message.text))
          .catch(() => this.emit('copy-error', new Error('Clipboard handler failed')));
      } else if (message.type === 'file-response') this.emit('file-response', message);
      return;
    }
    this.emit('video', frame);
  }

  send(frame) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Cloud phone is not connected');
    this.socket.send(Buffer.from(frame));
    return this;
  }

  _ensureStreamInput() {
    if (!this.inputOverStream) return null;
    if (!this._streamInput) {
      this._streamInput = sharedStreamInput({ deviceId: this.deviceId, token: this.token,
        origin: this.origin, endpoint: this.endpoint });
    }
    return this._streamInput;
  }

  _warmStreamInput() {
    const stream = this._ensureStreamInput();
    if (!stream || stream.open) return;
    this._streamError = null;
    stream.ensureConnected().catch(error => { this._streamError = error; });
  }

  _streamSend(operation) {
    const stream = this._ensureStreamInput();
    if (!stream) return false;
    try {
      operation(stream);
      this._streamError = null;
      return true;
    } catch (error) {
      if (error && error.code === 'INPUT_STREAM_NOT_READY') {
        this._warmStreamInput();
        if (this._streamError) error.cause = this._streamError;
      }
      throw error;
    }
  }

  flush() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Cloud phone is not connected'));
    // ws preserves frame order. Callback confirms local write, not Android execution.
    const legacy = new Promise((resolve, reject) => this.socket.ping(Buffer.alloc(0), undefined,
      error => error ? reject(new Error('Cloud phone write failed')) : resolve(this)));
    if (!this._streamInput) return legacy;
    // 输入帧走独立通道，两条都确认写入才算 flush 完成。
    return Promise.all([legacy, this._streamInput.flush()]).then(() => this);
  }

  async close(options = {}) {
    this._desired = false;
    clearTimeout(this._retryTimer);
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    const timeoutMs = p.integer('close timeoutMs', options.timeoutMs ?? 2000, 1, 0x7fffffff);
    await new Promise(resolve => {
      const timer = setTimeout(() => socket.terminate(), timeoutMs);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, 'client close');
    });
    if (this._connecting) await this._connecting.catch(() => {});
  }

  async refresh(options) {
    await this.close();
    return this.connect(options);
  }

  setAutoRefresh(enabled, options = {}) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    if (options.delays) {
      if (!Array.isArray(options.delays) || !options.delays.length) throw new TypeError('delays must be a non-empty array');
      this.retryDelays = options.delays.map(value => p.integer('retry delay', value, 1, 0x7fffffff));
    }
    this.autoRefresh = enabled;
    if (!enabled) clearTimeout(this._retryTimer);
    else if (this._desired && !this.connected && !this._connecting) this._scheduleReconnect();
    return this;
  }

  _scheduleReconnect() {
    if (!this._desired || !this.autoRefresh) return;
    if (this._retryIndex >= this.retryDelays.length) { this.emit('reconnect-exhausted'); return; }
    const delayMs = this.retryDelays[this._retryIndex++];
    clearTimeout(this._retryTimer);
    this.emit('reconnect-scheduled', { attempt: this._retryIndex, delayMs });
    this._retryTimer = setTimeout(() => {
      if (this._desired && this.autoRefresh) this.connect().catch(() => {});
    }, delayMs);
  }

  setAutoCopy(handler) {
    if (handler !== false && typeof handler !== 'function') throw new TypeError('Pass a clipboard callback or false');
    this._copyHandler = handler || null;
    return this;
  }

  _enqueue(name, operation) {
    const pending = this[name].then(operation);
    this[name] = pending.catch(() => {});
    return pending;
  }

  touch(action, x, y, options = {}) {
    if (this._streamSend(stream => stream.sendTouch(action, x, y, options))) return this;
    return this.send(p.encodeTouch({ ...options, action, x, y,
      screenWidth: options.screenWidth ?? this.screenWidth, screenHeight: options.screenHeight ?? this.screenHeight,
      pressure: options.pressure ?? (action === p.ACTION.UP ? 0 : 1),
      buttons: options.buttons ?? (action === p.ACTION.UP ? 0 : 1) }));
  }

  keyDown(keycode, options = {}) {
    if (this._streamSend(stream => stream.sendKey(keycode, 0))) return this;
    return this.send(p.encodeKey({ ...options, action: 0, keycode }));
  }

  keyUp(keycode, options = {}) {
    if (this._streamSend(stream => stream.sendKey(keycode, 1))) return this;
    return this.send(p.encodeKey({ ...options, action: 1, keycode }));
  }

  tap(x, y, options = {}) {
    return this.swipe({ x, y }, { x, y }, { ...options, durationMs: options.durationMs ?? 50, steps: 1 });
  }

  longPress(x, y, options = {}) {
    return this.tap(x, y, { ...options, durationMs: options.durationMs ?? 800 });
  }

  swipe(from, to, options = {}) {
    const duration = p.integer('durationMs', options.durationMs ?? 300, 0, 60000);
    const steps = p.integer('steps', options.steps ?? 10, 1, 1000);
    const clamp = (val, max) => Math.min(max - 1, Math.max(0, Math.round(Number(val))));
    const clampedFrom = {
      x: clamp(from.x, this.screenWidth),
      y: clamp(from.y, this.screenHeight)
    };
    const clampedTo = {
      x: clamp(to.x, this.screenWidth),
      y: clamp(to.y, this.screenHeight)
    };
    // Validate both ends before emitting a DOWN, avoiding stuck touches on bad input.
    for (const point of [clampedFrom, clampedTo]) p.encodeTouch({ ...options, action: 0, ...point,
      screenWidth: this.screenWidth, screenHeight: this.screenHeight });
    return this._enqueue('_gestures', async () => {
      if (options.signal?.aborted) throw new Error('Operation aborted');
      const generation = this._generation;
      let current = { ...clampedFrom };
      this.touch(p.ACTION.DOWN, clampedFrom.x, clampedFrom.y, options);
      try {
        for (let i = 1; i <= steps; i++) {
          await delay(duration / steps, options.signal);
          if (generation !== this._generation) throw new Error('Connection changed during gesture');
          current = {
            x: clamp(clampedFrom.x + (clampedTo.x - clampedFrom.x) * i / steps, this.screenWidth),
            y: clamp(clampedFrom.y + (clampedTo.y - clampedFrom.y) * i / steps, this.screenHeight)
          };
          if (clampedFrom.x !== clampedTo.x || clampedFrom.y !== clampedTo.y) this.touch(p.ACTION.MOVE, current.x, current.y, options);
        }
      } finally {
        if (generation === this._generation && this.connected) {
          const upX = clamp(current.x, this.screenWidth);
          const upY = clamp(current.y, this.screenHeight);
          this.touch(p.ACTION.UP, upX, upY, { ...options, pressure: 0, buttons: 0 });
        }
      }
      return this;
    });
  }

  text(value) { return this.send(p.encodeText(value)); }
  key(keycode, options) { this.keyDown(keycode, options); return this.keyUp(keycode, options); }
  pressKey(name, options) {
    const code = typeof name === 'number' ? name : p.KEY_CODES[String(name).trim().toUpperCase().replace(/[- ]/g, '_')];
    if (code === undefined) throw new TypeError('Unknown Android key: ' + name);
    return this.key(code, options);
  }
  back(options) { return this.key(p.KEY_CODES.BACK, options); }
  home(options) { return this.key(p.KEY_CODES.HOME, options); }
  overview(options) { return this.key(p.KEY_CODES.APP_SWITCH, options); }
  volumeUp(options) { return this.key(p.KEY_CODES.VOLUME_UP, options); }
  volumeDown(options) { return this.key(p.KEY_CODES.VOLUME_DOWN, options); }
  scroll(x, y, options = {}) {
    return this.send(p.encodeScroll({ ...options, x, y,
      screenWidth: options.screenWidth ?? this.screenWidth, screenHeight: options.screenHeight ?? this.screenHeight }));
  }
  command(type) { return this.send(p.encodeCommand(type)); }
  backOrScreenOn() { return this.command(p.CONTROL.BACK_OR_SCREEN_ON); }
  expandNotifications() { return this.command(p.CONTROL.EXPAND_NOTIFICATION_PANEL); }
  expandSettings() { return this.command(p.CONTROL.EXPAND_SETTINGS_PANEL); }
  collapsePanels() { return this.command(p.CONTROL.COLLAPSE_PANELS); }
  rotate() { return this.command(p.CONTROL.ROTATE_DEVICE); }
  screenPower(on) { return this.send(p.encodeScreenPower(on)); }
  setClipboard(value, options) { return this.send(p.encodeSetClipboard(value, options)); }
  paste(value) { return this.setClipboard(value, { paste: true }); }

  _requestReply(event, filter, send, options = {}) {
    const timeoutMs = p.integer('reply timeoutMs', options.timeoutMs ?? 10000, 1, 0x7fffffff);
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer); this.off(event, receive); this.off('close', closed);
        options.signal?.removeEventListener('abort', aborted);
      };
      const fail = error => { cleanup(); reject(error); };
      const receive = value => { if (filter(value)) { cleanup(); resolve(value); } };
      const closed = () => fail(new Error('Connection closed while waiting for ' + event));
      const aborted = () => fail(new Error('Operation aborted'));
      this.on(event, receive); this.on('close', closed);
      options.signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => fail(new Error('Timed out waiting for ' + event)), timeoutMs);
      try { if (options.signal?.aborted) aborted(); else send(); } catch (error) { fail(error); }
    });
  }

  getClipboard(options) {
    return this._enqueue('_clipboardQueue', () => this._requestReply('clipboard', () => true,
      () => this.command(p.CONTROL.GET_CLIPBOARD), options));
  }

  setVideoSettings(options) {
    const settings = { ...this.videoSettings, ...options, displayId: this.displayId };
    const frame = p.encodeVideoSettings(settings);
    this.send(frame);
    this.videoSettings = settings;
    return this;
  }

  setStreamSize(size) {
    const aligned = p.integer('size', size, 16, 32767) & ~15;
    return this.setVideoSettings({ bounds: { width: aligned, height: aligned }, bitrate: 524288,
      maxFps: 60, iFrameInterval: 15, lockedVideoOrientation: -1, sendFrameMeta: false });
  }

  pushFile(source, options = {}) {
    return this._enqueue('_uploads', async () => {
      let data, fileName = options.fileName;
      if (typeof source === 'string') {
        const metadata = await stat(source);
        if (!metadata.isFile() || metadata.size > 300 * 1024 * 1024) throw new RangeError('File must be at most 300 MiB');
        data = await readFile(source); fileName ??= basename(source);
      } else if (Buffer.isBuffer(source) || source instanceof Uint8Array) data = Buffer.from(source);
      else throw new TypeError('source must be a local path or binary data');
      if (data.length > 300 * 1024 * 1024) throw new RangeError('File must be at most 300 MiB');
      if (!fileName || !/\.apk$/i.test(fileName)) throw new TypeError('qk stream upload only supports APK; use REST file APIs for other files');
      const chunkSize = p.integer('chunkSize', options.chunkSize ?? 65536, 1, 1024 * 1024);
      // Validate filename before allocating a server transfer id.
      p.encodePushFile({ id: 1, state: p.FILE_STATE.START, fileName, fileSize: data.length });
      const request = (id, state, extra = {}) => this._requestReply('file-response',
        m => state === p.FILE_STATE.NEW ? m.code === 1 || m.id === 0 : m.id === id,
        () => this.send(p.encodePushFile({ id, state, ...extra })), options);
      const allocated = await request(0, p.FILE_STATE.NEW);
      if (allocated.code !== 1 || allocated.id <= 0) throw new Error('File transfer id allocation failed: ' + allocated.code);
      const id = allocated.id;
      const check = reply => { if (reply.code !== 0) throw new Error('File transfer failed with code ' + reply.code); };
      try {
        check(await request(id, p.FILE_STATE.START, { fileName, fileSize: data.length }));
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          const chunk = data.subarray(offset, offset + chunkSize);
          check(await request(id, p.FILE_STATE.APPEND, { chunk }));
          this.emit('file-progress', { id, fileName, sent: offset + chunk.length, total: data.length });
        }
        check(await request(id, p.FILE_STATE.FINISH));
        return { id, fileName, bytes: data.length, acknowledged: true };
      } catch (error) {
        if (this.connected) this.send(p.encodePushFile({ id, state: p.FILE_STATE.CANCEL }));
        throw error;
      }
    });
  }
}

// Do not wrap connect/close: their exact shared Promise identity is public API.
for (const name of ['tap', 'longPress', 'swipe', 'flush', 'getClipboard', 'pushFile']) {
  CloudPhoneControl.prototype[name] = require('./automation/timing').timed('control.' + name,
    CloudPhoneControl.prototype[name], function () { return { deviceId: this.deviceId }; });
}
module.exports = { CloudPhoneControl, requiredString };
