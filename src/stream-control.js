'use strict';

/**
 * 厂商新一代输入通道 (qk /stream JSON 协议)。
 *
 * 2026-10 下旬厂商升级后，旧 proxy-adb scrcpy 隧道仅保留视频与按键注入，
 * 触摸注入被服务端静默丢弃；触摸/按键必须走 /stream 端点的 JSON 控制帧：
 *   {"op":"touch","action":0|1|2,"pointerId":-1,"x":..,"y":..,
 *    "pressure":..,"buttons":..,"screenWidth":<视频宽>,"screenHeight":<视频高>}
 *   {"op":"key","keycode":<Android 键值>,"action":0|1}
 * 坐标按该连接自身的视频尺寸标定（由 meta 帧给出）。
 *
 * master 角色同一设备同时只允许一个：被占用时服务端不报错、静默丢弃控制帧，
 * 因此本类按 deviceId 在进程内共享唯一实例，避免自己跟自己抢 master。
 */

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { ACTION } = require('./protocol');

const PERMANENT_CLOSE_CODES = new Set([4003, 4004]);
const CONFLICT_CLOSE_CODES = new Set([4005]);
const POINTER_ID_MOUSE = -1;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function inputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class StreamInput extends EventEmitter {
  constructor(options = {}) {
    super();
    this.deviceId = String(options.deviceId ?? '');
    this.token = String(options.token ?? '');
    this.origin = options.origin ?? 'https://qk.yunmomo.com';
    this.endpoint = options.endpoint ?? 'wss://qk.yunmomo.com/';
    this.maxSize = Number(options.maxSize ?? 720);
    this.videoWidth = null;
    this.videoHeight = null;
    this.ws = null;
    this._connecting = null;
    // 厂商服务端会丢弃「down→up 两帧无位移」的静止 tap（官方网页端人手点击天然带微移动），
    // 因此 DOWN 后若无 MOVE 帧则在 UP 前补一个 1~2px 的人手抖动。
    this._pendingDown = null;
    // 通道暖连期间的输入请求排队（保持顺序，就绪后按序映射发送），
    // 避免流程首个动作与连接建立竞态导致响亮失败。
    this._pendingRequests = [];
  }

  buildUrl() {
    const base = new URL(this.endpoint);
    const url = new URL('/stream', base.origin);
    url.searchParams.set('role', 'master');
    url.searchParams.set('deviceId', this.deviceId);
    url.searchParams.set('token', this.token);
    url.searchParams.set('maxSize', String(Math.round(this.maxSize)));
    return url.toString();
  }

  get open() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(timeoutMs = 12000) {
    if (this._connecting) return this._connecting;
    if (this.open && this.videoWidth) return Promise.resolve(this);
    const deadline = Date.now() + Math.max(2000, Number(timeoutMs) || 12000);
    this._connecting = this._connectWithRetry(deadline);
    try {
      return await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  async _connectWithRetry(deadline) {
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      try {
        const remaining = Math.max(1000, deadline - Date.now());
        return await this._connectOnce(remaining);
      } catch (error) {
        if (error?.code === 'STREAM_INPUT_REJECTED_PERMANENT') {
          throw error;
        }
        const remaining = deadline - Date.now();
        // 4005 为短暂 master 会话冲突或前序连接释放窗口，在预算充足时执行有限退避重试
        if (error?.code === 'STREAM_INPUT_CONFLICT' && remaining > 1200 && attempt < 3) {
          await sleep(800);
          continue;
        }
        throw error;
      }
    }
    throw inputError('STREAM_INPUT_TIMEOUT', '输入通道连接超时');
  }

  _connectOnce(timeoutMs) {
    const ws = this.ws = new WebSocket(this.buildUrl(), { origin: this.origin });
    ws.on('message', (data, isBinary) => this._handleMessage(data, isBinary));
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          if (this.ws === ws) {
            this.ws = null;
            this.videoWidth = this.videoHeight = null;
          }
          try { ws.terminate(); } catch {}
          reject(error);
        } else {
          resolve(this);
        }
      };
      const timer = setTimeout(() => settle(inputError('STREAM_INPUT_TIMEOUT', '输入通道连接超时')), timeoutMs);
      ws.once('error', () => settle(inputError('STREAM_INPUT_CONNECT_FAILED', '输入通道连接失败')));
      ws.once('close', code => {
        if (PERMANENT_CLOSE_CODES.has(code)) {
          settle(inputError('STREAM_INPUT_REJECTED_PERMANENT', '输入通道被服务端永久拒绝 (' + code + ')'));
        } else if (CONFLICT_CLOSE_CODES.has(code)) {
          settle(inputError('STREAM_INPUT_CONFLICT', '输入通道被服务端拒绝 (4005)'));
        } else {
          settle(inputError('STREAM_INPUT_CONNECT_FAILED', '输入通道在就绪前断开 (' + code + ')'));
        }
      });
      this._settleConnect = settle;
    });
  }

  _handleMessage(data, isBinary) {
    if (isBinary) return; // 视频帧仅用于带宽占用，输入通道不消费
    let frame;
    try { frame = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'meta' && Number.isFinite(frame.width) && Number.isFinite(frame.height)) {
      this.videoWidth = frame.width;
      this.videoHeight = frame.height;
      if (this._settleConnect) {
        const settle = this._settleConnect;
        this._settleConnect = null;
        settle();
      }
      this._drainRequests();
      this.emit('meta', { width: frame.width, height: frame.height });
    } else if (frame.type === 'status') {
      this.emit('status', frame);
    }
  }

  ensureConnected(timeoutMs) {
    if (this.open && this.videoWidth) return Promise.resolve(this);
    if (this._connecting) return this._connecting;
    return this.connect(timeoutMs);
  }

  _requireReady() {
    if (!this.open || !this.videoWidth || !this.videoHeight) {
      throw inputError('INPUT_STREAM_NOT_READY', '输入通道未就绪（可能被其他 master 占用或连接中断），动作未下发');
    }
  }

  _enqueueRequest(request) {
    if (this._pendingRequests.length >= 64) {
      this._pendingRequests = [];
      throw inputError('INPUT_STREAM_NOT_READY', '输入通道排队溢出，动作未下发');
    }
    this._pendingRequests.push(request);
    this.ensureConnected().catch(error => {
      this._pendingRequests = [];
      this._connectError = error;
      this.emit('connect-error', error);
    });
    return this;
  }

  _drainRequests() {
    while (this._pendingRequests.length && this.open && this.videoWidth) {
      const request = this._pendingRequests.shift();
      if (request.kind === 'touch') this.sendTouch(request.action, request.x, request.y, request.options);
      else this.sendKey(request.keycode, request.action);
    }
  }

  sendTouch(action, x, y, options = {}) {
    const sourceWidth = Number(options.screenWidth ?? (this.videoWidth || 720));
    const sourceHeight = Number(options.screenHeight ?? (this.videoHeight || 1280));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > sourceWidth - 1 || y > sourceHeight - 1) {
      throw inputError('COORDINATE_OUT_OF_BOUNDS', '坐标超出源空间');
    }
    if (!this.open || !this.videoWidth) return this._enqueueRequest({ kind: 'touch', action, x, y, options });
    const mappedX = Math.min(this.videoWidth - 1, Math.max(0, Math.round(x * this.videoWidth / sourceWidth)));
    const mappedY = Math.min(this.videoHeight - 1, Math.max(0, Math.round(y * this.videoHeight / sourceHeight)));
    // 字段取值与官方网页查看器一致：move pressure 0.5，up buttons 0
    const pressure = action === ACTION.MOVE ? 0.5 : 1;
    const buttons = action === ACTION.UP ? 0 : 1;
    const send = frame => this.ws.send(JSON.stringify({
      op: 'touch', pointerId: POINTER_ID_MOUSE,
      screenWidth: this.videoWidth, screenHeight: this.videoHeight, ...frame,
    }));
    if (action === ACTION.DOWN) {
      this._pendingDown = { x: mappedX, y: mappedY, moved: false };
    } else if (action === ACTION.MOVE && this._pendingDown) {
      if (mappedX !== this._pendingDown.x || mappedY !== this._pendingDown.y) this._pendingDown.moved = true;
    } else if (action === ACTION.UP && this._pendingDown && !this._pendingDown.moved) {
      const jitterX = Math.min(this.videoWidth - 1, Math.max(0, this._pendingDown.x + (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2))));
      const jitterY = Math.min(this.videoHeight - 1, Math.max(0, this._pendingDown.y + (Math.random() < 0.5 ? -1 : 1)));
      send({ action: ACTION.MOVE, x: jitterX, y: jitterY, pressure: 0.5, buttons: 1 });
    }
    if (action === ACTION.UP) this._pendingDown = null;
    send({ action, x: mappedX, y: mappedY, pressure, buttons });
    return this;
  }

  sendKey(keycode, action) {
    if (!this.open || !this.videoWidth) return this._enqueueRequest({ kind: 'key', keycode, action });
    this.ws.send(JSON.stringify({ op: 'key', keycode, action }));
    return this;
  }

  async flush(timeoutMs = 5000) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 5000);
    // 1. 若通道未完全就绪（未连接、握手中或未收到 meta 帧），等待通道就绪
    while ((!this.open || !this.videoWidth) && Date.now() < deadline) {
      try {
        const remaining = Math.max(200, deadline - Date.now());
        await Promise.race([
          this.ensureConnected(remaining),
          sleep(100)
        ]);
      } catch (error) {
        if (!this._connecting && !this.open) throw error;
      }
    }
    if (!this.open || !this.videoWidth) {
      throw inputError('INPUT_STREAM_NOT_READY', '输入通道未就绪，动作未下发');
    }
    // 2. 排空排队请求
    this._drainRequests();
    while (this._pendingRequests.length && Date.now() < deadline) {
      await sleep(50);
      this._drainRequests();
    }
    if (this._pendingRequests.length) {
      throw inputError('INPUT_STREAM_NOT_READY', '输入通道排队超时，动作未下发');
    }
    // 3. 队列已空，下发 ping 确认底层物理写入完成
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(inputError('STREAM_INPUT_WRITE_FAILED', '输入通道连接已断开'));
      }
      this.ws.ping(Buffer.alloc(0), undefined, error => {
        if (error) reject(inputError('STREAM_INPUT_WRITE_FAILED', '输入通道写入失败'));
        else resolve(this);
      });
    });
  }

  close() {
    const entry = registry.get(this.deviceId);
    if (entry && entry.client === this) {
      registry.delete(this.deviceId);
    }
    const ws = this.ws;
    this.ws = null;
    this._connecting = null;
    this.videoWidth = this.videoHeight = null;
    this._pendingRequests = [];
    this._pendingDown = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { ws.terminate(); resolve(); }, 1000);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      ws.close(1000, 'client close');
    });
  }
}

// 同设备同进程仅保留一条输入流：防止流程控制连接与工具层控制连接互抢 master。
const registry = new Map();

function sharedStreamInput(options) {
  const deviceId = String(options.deviceId ?? '');
  const token = String(options.token ?? '');
  let entry = registry.get(deviceId);
  if (entry && entry.token !== token) {
    entry.client.close();
    entry = undefined;
  }
  if (!entry) {
    entry = { token, client: new StreamInput(options) };
    registry.set(deviceId, entry);
  }
  return entry.client;
}

function closeStreamInput(deviceId) {
  const entry = registry.get(String(deviceId ?? ''));
  return entry ? entry.client.close() : Promise.resolve();
}

function closeAllStreamInputs() {
  const pending = [];
  for (const entry of registry.values()) pending.push(entry.client.close());
  registry.clear();
  return Promise.allSettled(pending);
}

module.exports = { StreamInput, sharedStreamInput, closeStreamInput, closeAllStreamInputs, INPUT_ERROR_CODES: Object.freeze({
  NOT_READY: 'INPUT_STREAM_NOT_READY',
  REJECTED: 'STREAM_INPUT_REJECTED',
  REJECTED_PERMANENT: 'STREAM_INPUT_REJECTED_PERMANENT',
  CONFLICT: 'STREAM_INPUT_CONFLICT',
}) };
