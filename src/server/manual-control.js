'use strict';

// Loopback-only browser input bridge. Cloud credentials never leave Node.
const { WebSocketServer, WebSocket } = require('ws');
const { protocol } = require('../index');
const { createVideoStreams } = require('./video-stream');
const { defaultArbiter } = require('./device-arbiter');
const { getAuthService } = require('./auth/service');

function attachManualControl(server, { allowedRequest, selectedDevice, client, busyDevices, redact, authService }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const manualDevices = new Map();
  const sessions = new Set();
  const auth = authService || getAuthService();
  const videos = createVideoStreams({ client });

  // 唯一授权入口：每条 WebSocket 在建立、输入派发和存活期间均使用同一套规则。
  function hasAccess(lease) {
    const current = auth.getUserFromRequest(lease.request);
    return Boolean(current && current.id === lease.user.id &&
      auth.canAccessDevice(current, lease.deviceId));
  }
  function revokeSessions(predicate, code) {
    for (const lease of [...sessions]) {
      if (!predicate(lease)) continue;
      lease.authorized = false;
      send(lease.ws, { type: 'error', code, message: '设备使用权限已失效' });
      lease.ws.terminate();
      lease.close?.().catch(() => {});
    }
  }
  const accessMonitor = setInterval(() => {
    revokeSessions(lease => !lease.closed && !hasAccess(lease), 'DEVICE_ACCESS_REVOKED');
  }, 2000);
  accessMonitor.unref();
  server.once('close', () => clearInterval(accessMonitor));
  const send = (ws, value) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://' + request.headers.host); } catch { socket.destroy(); return; }
    if (!['/api/control', '/api/control-input', '/api/video'].includes(url.pathname) ||
        !request.headers.origin || !allowedRequest(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, request, url));
  });
  sockets.on('connection', async (ws, request, url) => {
    const user = auth.getUserFromRequest(request);
    if (!user) {
      console.warn(`[WS REJECT] ${url.pathname} UNAUTHORIZED`);
      send(ws, { type: 'error', code: 'UNAUTHORIZED', message: '请先登录控制台' });
      ws.close(1008); return;
    }
    const deviceId = url.searchParams.get('deviceId');
    if (!deviceId || deviceId.length > 128 || !await auth.ensureDeviceAccess(user, deviceId).catch(() => false)) {
      console.warn(`[WS REJECT] ${url.pathname} DEVICE_FORBIDDEN deviceId=${deviceId} user=${user.email}`);
      send(ws, { type: 'error', code: 'DEVICE_FORBIDDEN', message: '无权操作此设备或该设备租期已到期' });
      ws.close(1008); return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const interactive = url.pathname === '/api/control' || url.pathname === '/api/control-input';
    const inputOnly = url.pathname === '/api/control-input';
    const streamMode = url.searchParams.get('mode') || 'single';
    const pageId = /^[A-Za-z0-9_-]{8,128}$/.test(url.searchParams.get('pageId') || '')
      ? url.searchParams.get('pageId') : '';
    let deviceSession = interactive ? manualDevices.get(deviceId) : null;
    if (deviceSession && deviceSession.ownerUserId !== user.id) {
      send(ws, { type: 'error', code: 'DEVICE_BUSY', message: '该设备正在被其他账号操作' });
      ws.close(1008); return;
    }
    if (!deviceId || deviceId.length > 128 || (interactive && (busyDevices.has(deviceId) ||
        (!deviceSession && defaultArbiter.isDeviceBusy(deviceId))))) {
      console.warn(`[WS REJECT] ${url.pathname} DEVICE_BUSY deviceId=${deviceId}`);
      send(ws, { type: 'error', code: 'DEVICE_BUSY', message: '该设备正在执行脚本，暂时无法手动操作' });
      ws.close(1008); return;
    }
    console.log(`[WS CONNECT] ${url.pathname} deviceId=${deviceId} user=${user.email}`);
    if (interactive && !deviceSession) {
      const acquired = defaultArbiter.acquireDevice(deviceId, 'manual_' + deviceId,
        { type: 'manual_control', returnLease: true });
      if (!acquired.ok) {
        send(ws, { type: 'error', code: 'DEVICE_BUSY', message: '该设备正在执行脚本，暂时无法手动操作' });
        ws.close(1008); return;
      }
      deviceSession = { leases: new Set(), ownerUserId: user.id, arbiterLease: acquired.lease, touchOwner: null,
        keyOwners: new Map(), inputQueue: Promise.resolve(), queuedInputs: 0,
        lastInputPageId: '', lastInputAt: 0 };
      manualDevices.set(deviceId, deviceSession);
    }
    const lease = { ws, control: null, videoLease: null, point: null, keys: new Set(), closed: false,
      generation: null, deviceSession, pageId, deviceId, user, request, authorized: true,
      idleTimer: null, heartbeatTimer: null, pongAt: Date.now() };
    if (interactive) deviceSession.leases.add(lease);
    sessions.add(lease);
    if (inputOnly) {
      lease.onPong = () => { lease.pongAt = Date.now(); };
      ws.on('pong', lease.onPong);
      lease.heartbeatTimer = setInterval(() => {
        if (lease.closed || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lease.pongAt > 10000) { ws.terminate(); return; }
        ws.ping(undefined, undefined, error => { if (error) ws.terminate(); });
        send(ws, { type: 'heartbeat' });
      }, 2000);
      lease.heartbeatTimer.unref();
    }
    let lastSecond = Date.now(), rate = 0;
    function clearIdle() { clearTimeout(lease.idleTimer); lease.idleTimer = null; }
    function canSendInput(owner) {
      const control = owner.control;
      return Boolean(control?.ready && control.connected && control._generation === owner.generation);
    }
    function resetInput() {
      const control = lease.control;
      const input = lease.deviceSession;
      try {
        if (canSendInput(lease)) {
          if (input?.touchOwner === lease && lease.point) {
            control.touch(protocol.ACTION.UP, lease.point.x, lease.point.y, { pressure: 0, buttons: 0 });
          }
          for (const code of lease.keys) {
            if (input?.keyOwners.get(code) === lease) control.keyUp(code);
          }
        }
      } finally {
        if (input?.touchOwner === lease) input.touchOwner = null;
        for (const code of lease.keys) if (input?.keyOwners.get(code) === lease) input.keyOwners.delete(code);
        lease.point = null; lease.keys.clear(); clearIdle();
      }
    }
    function armRelease() {
      clearIdle();
      lease.idleTimer = setTimeout(() => {
        queueInput({ type: 'release' }).then(() => {
          send(ws, { type: 'input_reset', message: '输入长时间无事件，已松开按键和触点' });
        });
      }, 10000);
    }
    lease.clearIdle = clearIdle;
    lease.armRelease = armRelease;
    function resetDeviceInput() {
      for (const owner of deviceSession.leases) owner.resetInput();
    }
    lease.resetInput = resetInput;
    function processInput(message) {
      if (!message || typeof message !== 'object') throw new Error('输入格式无效');
      if (message.type === 'release') { resetInput(); return; }
      if (!lease.authorized) throw new Error('设备使用权限已失效');
      const control = lease.control;
      if (!canSendInput(lease)) throw new Error('控制连接尚未就绪或已经断开');
      if (message.type === 'touch') {
        if (!['down', 'move', 'up'].includes(message.action) ||
            ![message.x, message.y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) {
          throw new Error('触控坐标或动作无效');
        }
        const point = { x: Math.round(message.x * (control.screenWidth - 1)),
          y: Math.round(message.y * (control.screenHeight - 1)) };
        const input = deviceSession;
        if (message.action === 'down') {
          if (input.touchOwner === lease && lease.point) {
            try {
              if (canSendInput(lease)) {
                control.touch(protocol.ACTION.UP, lease.point.x, lease.point.y, { pressure: 0, buttons: 0 });
              }
            } catch {}
            lease.point = null;
            input.touchOwner = null;
          }
          const previous = input.touchOwner;
          if (previous) {
            try {
              if (canSendInput(previous) && previous.point) {
                previous.control.touch(protocol.ACTION.UP, previous.point.x, previous.point.y, { pressure: 0, buttons: 0 });
              }
            } finally {
              previous.point = null;
              if (input.touchOwner === previous) input.touchOwner = null;
              if (!previous.keys.size) previous.clearIdle();
              send(previous.ws, { type: 'input_reset', message: '触控已由另一个网页接管' });
            }
          }
          control.touch(protocol.ACTION.DOWN, point.x, point.y, { pressure: 1, buttons: 1 });
          lease.point = point; input.touchOwner = lease;
        } else {
          if (input.touchOwner !== lease || !lease.point) return;
          const action = message.action === 'move' ? protocol.ACTION.MOVE : protocol.ACTION.UP;
          control.touch(action, point.x, point.y, { pressure: action === protocol.ACTION.UP ? 0 : 1,
            buttons: action === protocol.ACTION.UP ? 0 : 1 });
          if (action === protocol.ACTION.UP) { lease.point = null; input.touchOwner = null; }
          else lease.point = point;
        }
      } else if (message.type === 'scroll') {
        if (![message.x, message.y].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) ||
            !Number.isInteger(message.dy) || Math.abs(message.dy) > 5) throw new Error('滚动参数无效');
        control.scroll(Math.round(message.x * (control.screenWidth - 1)), Math.round(message.y * (control.screenHeight - 1)), { vScroll: message.dy, hScroll: 0 });
      } else if (message.type === 'nav') {
        if (!['back', 'home', 'overview'].includes(message.key)) throw new Error('导航键无效');
        console.log(`[MANUAL NAV] ${deviceId} key=${message.key}`);
        resetDeviceInput(); control[message.key]();
      } else if (message.type === 'key') {
        const code = protocol.KEY_CODES[message.key];
        if (!Number.isInteger(code) || !/^(?:[A-Z]|DIGIT_[0-9]|SPACE|ENTER|DEL|FORWARD_DEL|TAB|DPAD_(?:UP|DOWN|LEFT|RIGHT)|MOVE_HOME|MOVE_END|MINUS|EQUALS|LEFT_BRACKET|RIGHT_BRACKET|BACKSLASH|SEMICOLON|APOSTROPHE|SLASH|GRAVE)$/.test(message.key) ||
            !['down', 'up'].includes(message.action) || typeof message.shift !== 'boolean') throw new Error('键盘参数无效');
        const input = deviceSession;
        if (message.action === 'down') {
          const previous = input.keyOwners.get(code);
          if (previous && previous !== lease) {
            try { if (canSendInput(previous)) previous.control.keyUp(code); }
            finally {
              previous.keys.delete(code);
              if (input.keyOwners.get(code) === previous) input.keyOwners.delete(code);
              if (!previous.keys.size && !previous.point) previous.clearIdle();
            }
          }
          control.keyDown(code, { metaState: message.shift ? protocol.META.SHIFT_ON : 0 });
          input.keyOwners.set(code, lease); lease.keys.add(code);
        } else {
          if (input.keyOwners.get(code) !== lease) return;
          control.keyUp(code); input.keyOwners.delete(code); lease.keys.delete(code);
        }
      } else throw new Error('不支持的手动操作');
      deviceSession.lastInputPageId = lease.pageId;
      deviceSession.lastInputAt = Date.now();
      if (lease.point || lease.keys.size) armRelease(); else clearIdle();
    }
    function queueInput(message, allowClosed = false) {
      if (deviceSession.queuedInputs >= 512 && !allowClosed) {
        send(ws, { type: 'error', code: 'INPUT_BACKPRESSURE', message: '操作太频繁，请稍后重试' });
        ws.close(1013, 'input queue full');
        return Promise.resolve();
      }
      // Serialize input from every page using the order the server received it.
      deviceSession.queuedInputs++;
      const task = deviceSession.inputQueue.then(() => {
        if (lease.closed && !allowClosed) return;
        try { processInput(message); }
        catch (error) {
          try { resetInput(); } catch { /* Preserve original input failure. */ }
          console.warn(`[MANUAL INPUT ERROR] ${deviceId}: ${error.message}`);
          send(ws, { type: 'error', code: 'INPUT_FAILED', message: redact(error.message) });
        }
      }).finally(() => { deviceSession.queuedInputs--; });
      deviceSession.inputQueue = task.catch(() => {});
      return task;
    }
    async function close() {
      if (lease.closed) return;
      lease.closed = true;
      clearInterval(lease.heartbeatTimer);
      if (interactive) await queueInput({ type: 'release' }, true);
      if (lease.onPong) ws.removeListener('pong', lease.onPong);
      lease.videoLease?.release();
      sessions.delete(lease);
      if (interactive) {
        deviceSession.leases.delete(lease);
        if (!deviceSession.leases.size) {
          if (manualDevices.get(deviceId) === deviceSession) manualDevices.delete(deviceId);
          defaultArbiter.releaseLease(deviceSession.arbiterLease);
        }
      }
    }
    lease.close = close;
    ws.on('close', (code, reason) => {
      console.log(`[WS CLOSE] ${url.pathname} deviceId=${deviceId} code=${code}`);
      close().catch(() => {});
    });
    ws.on('error', err => {
      console.error(`[WS ERROR] ${url.pathname} deviceId=${deviceId}: ${err?.message || err}`);
      close().catch(() => {});
    });
    ws.on('message', (raw, binary) => {
      try {
        if (lease.closed) return;
        if (binary || raw.length > 4096) throw new Error('输入格式无效');
        const now = Date.now();
        if (now - lastSecond > 1000) { lastSecond = now; rate = 0; }
        if (++rate > 200) throw new Error('输入事件过于频繁');
        const message = JSON.parse(raw.toString('utf8'));
        if (!message || typeof message !== 'object') throw new Error('输入格式无效');
        if (message.type === 'refresh') { lease.videoLease?.refresh(); return; }
        if (!interactive) throw new Error('预览连接不允许操作设备');
        queueInput(message);
      } catch (error) {
        const reply = () => send(ws, { type: 'error', code: 'INPUT_FAILED', message: redact(error.message) });
        if (interactive) queueInput({ type: 'release' }).then(reply);
        else reply();
      }
    });
    (async () => {
      const userToken = auth.getDeviceAccessToken(user, deviceId);
      const device = await selectedDevice(deviceId, userToken);
      if (lease.closed) return;
      if (interactive && busyDevices.has(deviceId)) throw new Error('该设备正在执行脚本');
      const callbacks = {
        onSize(control) {
          if (lease.generation !== null && lease.generation !== control._generation) { ws.close(1011); return; }
          if (lease.point || lease.keys.size) queueInput({ type: 'release' });
          send(ws, { type: 'size', width: control.screenWidth, height: control.screenHeight });
        },
        onError(code, message) { send(ws, { type: 'error', code, message }); },
        onClose() { if (!lease.closed) { close().catch(() => {}); ws.close(1011); } }
      };
      const videoLease = lease.videoLease = inputOnly
        ? videos.hold(device, callbacks, userToken)
        : videos.subscribe(device, ws, callbacks, userToken, streamMode);
      const control = lease.control = await videoLease.ready;
      if (lease.closed) { videoLease.release(); return; }
      lease.generation = control._generation;
      const settings = videos.getSettings(control);
      send(ws, { type: 'ready', deviceId, width: control.screenWidth, height: control.screenHeight,
        interactive, codec: 'h264-annexb', maxFps: settings.maxFps,
        bitrate: settings.bitrate, bounds: settings.bounds });
    })().catch(async error => {
      send(ws, { type: 'error', code: error.code || 'CONNECT_FAILED', message: redact(error.message) });
      ws.close(1011); await close().catch(() => {});
    });
  });
  return {
    videos,
    captureScreenshot: (device, options, token) => videos.captureScreenshot(device, options, token),
    isBusy: deviceId => manualDevices.has(deviceId),
    closeDevice(deviceId, reason = 'DEVICE_EXPIRED', userId = null) {
      revokeSessions(lease => lease.deviceId === deviceId && (!userId || lease.user.id === userId), reason);
    },
    closeUser(userId) {
      revokeSessions(lease => lease.user.id === userId, 'ACCOUNT_BANNED');
    },
    getState(pageId) {
      return [...manualDevices].map(([deviceId, session]) => ({
        deviceId,
        windows: session.leases.size,
        lastInputAt: session.lastInputAt,
        lastInputFromCurrentPage: Boolean(pageId && session.lastInputPageId && session.lastInputPageId === pageId)
      }));
    },
    async closeAll() {
      await Promise.all([...sessions].map(async lease => { lease.ws.close(1001, 'console session closed'); await lease.close().catch(() => {}); }));
      await videos.closeAll();
    }
  };
}

module.exports = { attachManualControl };
