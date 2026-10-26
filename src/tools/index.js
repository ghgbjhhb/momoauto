'use strict';

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { CloudPhoneControl, requiredString } = require('../control');
const { OperationContext, ToolFailure, fail, keys, number, boolean, size, snapshot, describeError } = require('./runtime');
const { screenshot } = require('./screenshot');
const { clickPlan, REGION_CLICK_OPTIONS, regionClickPlan, swipePlan, gesture } = require('./touch-gestures');
const { MomoVision, ChatDetailVision, visionOptions, SharedMomoVision } = require('./momo-vision');
const { GpuRecognitionPool, createRecognitionPool, RecognitionError, PooledChatDetailVision } = require('./recognition');
const { MOMO_OPTIONS, openMomo } = require('./momo');
const { CONTACT_OPTIONS, sendContact } = require('./send-contact');
const { SEND_CHAT_OPTIONS, sendChatMessage } = require('./send-chat-message');
const { BLOCK_OPTIONS, blockPeer } = require('./block-peer');
const { REFRESH_HOME_OPTIONS, BROWSE_HOME_OPTIONS, refreshMomoHome, browseMomoHome } = require('./momo/home-feed');
const { MOMO_GREETINGS_OPTIONS, processMomoGreetings, greetingsTimeoutMs, MAX_GREETINGS_TIMEOUT_MS } = require('./momo/greetings');
const { MOMO_SYNC_OPTIONS, syncMomoContacts } = require('./momo/contact-sync');
const { SharedRecognitionClient } = require('../automation/recognition-service');
const { MomoMessageListWatcher, createMessageListWatcher } = require('./momo/message-list-watcher');

class CloudPhoneTools {
  constructor(device, options = {}) {
    if (!device || !device.client || typeof device.screenshot !== 'function') throw new TypeError('A CloudPhoneDevice is required');
    this.deviceId = requiredString('deviceId', device.deviceId);
    keys(options, ['control', 'udid', 'timeoutMs', 'connectTimeoutMs', 'logger', 'dryRun', 'screenSize', 'momoVision', 'recognitionPool'], 'configuration');
    this.device = device;
    this.timeoutMs = number(options.timeoutMs ?? 15000, 'timeoutMs', 1, 300000);
    this.connectTimeoutMs = number(options.connectTimeoutMs ?? 10000, 'connectTimeoutMs', 1, 300000);
    this.dryRun = boolean(options.dryRun ?? false, 'dryRun');
    this.screenSize = options.screenSize === undefined ? undefined : size(options.screenSize, 'screenSize');
    this.udid = options.udid === undefined ? undefined : requiredString('udid', options.udid);
    if (options.logger !== undefined && typeof options.logger !== 'function') throw new TypeError('logger must be a function');
    this.logger = options.logger;
    this._momoTimeoutMs = options.timeoutMs ?? 60000;
    this._contactTimeoutMs = options.timeoutMs ?? 180000;
    this._blockTimeoutMs = options.timeoutMs ?? 90000;
    this._refreshHomeTimeoutMs = options.timeoutMs ?? 60000;
    this._browseHomeTimeoutMs = options.timeoutMs ?? 300000;
    this._greetingsTimeoutMs = options.timeoutMs;
    this._syncTimeoutMs = options.timeoutMs ?? 300000;
    this._momoVisionOptions = visionOptions(options.momoVision);
    if (options.recognitionPool !== undefined && !(options.recognitionPool instanceof GpuRecognitionPool) &&
        !(options.recognitionPool instanceof SharedRecognitionClient)) {
      throw new TypeError('recognitionPool must be a GpuRecognitionPool or SharedRecognitionClient');
    }
    this._recognitionPool = options.recognitionPool ?? (options.momoVision === undefined ? new SharedRecognitionClient() : null);
    this._ownsRecognitionClient = options.recognitionPool === undefined && Boolean(this._recognitionPool);
    this._sharedMomoVision = options.momoVision === undefined;
    this._momoVision = null;
    this._chatDetailVision = null;
    if (options.control !== undefined && (!(options.control instanceof CloudPhoneControl) || options.control.deviceId !== this.deviceId)) {
      throw new TypeError('control must be a CloudPhoneControl for the same deviceId');
    }
    this._control = options.control ?? null;
    this._ownsControl = options.control === undefined;
    this._tail = Promise.resolve();
    this._lifetime = new AbortController();
    this._closed = false;
    this._retiring = null;
  }

  screenshot(options = {}) {
    return this._run('screenshot', options, async (ctx, settings) => {
      this._requireToken();
      const data = await screenshot(this.device, settings, ctx);
      ctx.check();
      return { status: 'captured', data };
    });
  }

  click(x, y, options = {}) { return this._gesture('click', options, (screen, settings) => clickPlan(x, y, settings, screen)); }
  clickRegion(box, options = {}) {
    return this._gesture('clickRegion', options, (screen, settings, savedBox) => regionClickPlan(savedBox, settings, screen), box);
  }
  swipe(points, options = {}) {
    return this._gesture('swipe', options, (screen, settings, path) => swipePlan(path, settings, screen), points);
  }

  openMomo(options = {}) { return this._run('openMomo', options, (ctx, settings) => openMomo(this, settings, ctx)); }

  sendChatMessage(text, options = {}) {
    // Runtime objects are operation-private dependencies, never queued public data.
    const { replyStore, assertActive, ...publicOptions } = options;
    return this._run('sendChatMessage', publicOptions, (ctx, settings, savedText) =>
      sendChatMessage(this, savedText, settings, ctx, { replyStore, assertActive }), text);
  }

  sendContact(contact, options = {}) {
    return this._run('sendContact', options, (ctx, settings, savedContact) => sendContact(this, savedContact, settings, ctx), contact);
  }

  blockPeer(options = {}) { return this._run('blockPeer', options, (ctx, settings) => blockPeer(this, settings, ctx)); }

  refreshMomoHome(options = {}) { return this._run('refreshMomoHome', options, (ctx, settings) => refreshMomoHome(this, settings, ctx)); }
  browseMomoHome(options = {}) { return this._run('browseMomoHome', options, (ctx, settings) => browseMomoHome(this, settings, ctx)); }
  processMomoGreetings(options = {}) { return this._run('processMomoGreetings', options, (ctx, settings) => processMomoGreetings(this, settings, ctx)); }
  syncMomoContacts(options = {}) { return this._run('syncMomoContacts', options, (ctx, settings) => syncMomoContacts(this, settings, ctx)); }

  async _ensureChatDetailVision(ctx) {
    ctx.check();
    if (this._chatDetailVision?.closed) { await this._chatDetailVision.close(); ctx.check(); }
    if (!this._chatDetailVision || this._chatDetailVision.closed) this._chatDetailVision = this._recognitionPool ?
      new PooledChatDetailVision(this._recognitionPool) : new ChatDetailVision(this._momoVisionOptions);
    await this._chatDetailVision.start(ctx);
    return this._chatDetailVision;
  }

  async _ensureMomoVision(ctx) {
    ctx.check();
    if (this._momoVision?.closed) { await this._momoVision.close(); ctx.check(); }
    if (!this._momoVision || this._momoVision.closed) this._momoVision = this._sharedMomoVision ?
      new SharedMomoVision() : new MomoVision(this._momoVisionOptions);
    await this._momoVision.start(ctx);
    return this._momoVision;
  }

  async _sendHome(control, ctx) {
    let entered, started = false;
    const admitted = new Promise(resolve => { entered = resolve; });
    const pending = control._enqueue('_gestures', async () => {
      started = true;
      entered();
      ctx.check();
      if (!control.connected || !control.ready) fail('NOT_CONNECTED', 'Control is not ready for HOME');
      ctx.stage = 'dispatch';
      ctx.execution.state = 'partial';
      ctx.execution.localWriteConfirmed = false;
      control.home();
      ctx.execution.framesSent += 2;
      ctx.stage = 'flush';
      await ctx.wait(control.flush());
      ctx.check();
      ctx.execution.state = 'sent';
      ctx.execution.localWriteConfirmed = true;
    });
    pending.catch(() => {});
    try { await ctx.wait(admitted); }
    catch (error) { if (started) await pending.catch(() => {}); throw error; }
    try { return await pending; }
    catch (error) {
      if (this._ownsControl && (ctx.execution.state === 'partial' || ctx.stage === 'flush')) {
        try { await this._retire(control); }
        catch { ctx.cleanupFailed = true; }
      }
      throw error;
    }
  }

  async _sendBack(control, ctx) {
    let entered, started = false;
    const admitted = new Promise(resolve => { entered = resolve; });
    const pending = control._enqueue('_gestures', async () => {
      started = true;
      entered();
      ctx.check();
      if (!control.connected || !control.ready) fail('NOT_CONNECTED', 'Control is not ready for BACK');
      ctx.stage = 'dispatch';
      ctx.execution.state = 'partial';
      ctx.execution.localWriteConfirmed = false;
      control.back();
      ctx.execution.framesSent += 2;
      ctx.stage = 'flush';
      await ctx.wait(control.flush());
      ctx.check();
      ctx.execution.state = 'sent';
      ctx.execution.localWriteConfirmed = true;
    });
    pending.catch(() => {});
    try { await ctx.wait(admitted); }
    catch (error) { if (started) await pending.catch(() => {}); throw error; }
    try { return await pending; }
    catch (error) {
      if (this._ownsControl && (ctx.execution.state === 'partial' || ctx.stage === 'flush')) {
        try { await this._retire(control); }
        catch { ctx.cleanupFailed = true; }
      }
      throw error;
    }
  }

  _gesture(operation, options, planner, input) {
    return this._run(operation, options, async (ctx, settings, savedInput) => {
      const dryRun = boolean(settings.dryRun ?? this.dryRun, 'dryRun');
      const build = screen => planner(screen, settings, savedInput);
      if (dryRun) {
        ctx.stage = 'map';
        const screen = this._control?.ready ? { width: this._control.screenWidth, height: this._control.screenHeight } : this.screenSize;
        if (!screen) fail('SCREEN_SIZE_REQUIRED', 'Dry-run requires screenSize or an already-ready control');
        return { status: 'planned', data: build(screen).report };
      }
      // Reject malformed options/path before opening a connection. Actual coordinate
      // mapping is rebuilt inside the control queue with its current dimensions.
      build(settings.coordinateSpace ?? (this._control?.ready ?
        { width: this._control.screenWidth, height: this._control.screenHeight } :
        this.screenSize ?? { width: 65535, height: 65535 }));
      ctx.attempt = 1;
      const control = await this._ensureControl(ctx);
      return { status: 'sent', data: await this._executeGesture(control, build, ctx, operation === 'clickRegion' ? 'click' : operation) };
    }, input);
  }

  async _executeGesture(control, planner, ctx, operation) {
    try { return await gesture(control, planner, ctx, operation); }
    catch (error) {
      // An uncertain release/write leaves the session unsuitable for the next action.
      if (this._ownsControl && (['failed', 'connection_lost'].includes(ctx.execution.release) || ctx.stage === 'flush')) {
        try { await this._retire(control); }
        catch { ctx.cleanupFailed = true; }
      }
      throw error;
    }
  }

  _requireToken() {
    if (typeof this.device.client.token !== 'string' || !this.device.client.token.trim()) {
      fail('AUTH_MISSING', 'Configure YUNMOMO_TOKEN or client.token before real operations');
    }
  }

  async _ensureControl(ctx) {
    ctx.stage = 'connect';
    ctx.check();
    if (this._retiring) await ctx.wait(this._retiring);
    if (this._control?.connected && this._control.ready) return this._control;
    if (!this._ownsControl) fail('NOT_CONNECTED', 'Borrowed control must be connected by its owner');
    this._requireToken();
    if (!this._control) {
      let udid = this.udid;
      if (!udid) {
        ctx.stage = 'device_info';
        const response = await ctx.wait(this.device.getInfo({ signal: ctx.signal, timeoutMs: ctx.remaining() }));
        ctx.check();
        udid = (response?.data ?? response)?.udid;
        if (typeof udid !== 'string' || !udid.trim() || /[\r\n\0]/.test(udid)) {
          fail('INVALID_DEVICE_INFO', 'Device info did not contain a usable udid');
        }
      }
      ctx.check();
      ctx.stage = 'connect';
      this._control = this.device.client.openControl({ deviceId: this.deviceId, udid, autoRefresh: false });
    }
    const control = this._control;
    try {
      await ctx.wait(control.connect({ timeoutMs: Math.min(this.connectTimeoutMs, ctx.remaining()) }));
      ctx.check();
      return control;
    } catch (error) {
      try { await this._retire(control); }
      catch { ctx.cleanupFailed = true; }
      throw error;
    }
  }

  async _retire(control) {
    if (!this._ownsControl) return;
    if (this._control === control) this._control = null;
    const pending = control.close({ timeoutMs: 250 });
    this._retiring = pending;
    try { await pending; }
    finally { if (this._retiring === pending) this._retiring = null; }
  }

  async _run(operation, options, work, input) {
    return require('../automation/timing').measure('tool.' + operation, { deviceId: this.deviceId },
      () => this._runMeasured(operation, options, work, input));
  }

  async _runMeasured(operation, options, work, input) {
    const started = performance.now(), startedAt = new Date().toISOString();
    const operationId = randomUUID();
    let ctx, unlock, data = null, status = 'failed', error = null;
    try {
      keys(options, operation === 'syncMomoContacts' ? MOMO_SYNC_OPTIONS : operation === 'processMomoGreetings' ? MOMO_GREETINGS_OPTIONS : operation === 'refreshMomoHome' ? REFRESH_HOME_OPTIONS : operation === 'browseMomoHome' ? BROWSE_HOME_OPTIONS :
        operation === 'clickRegion' ? REGION_CLICK_OPTIONS : operation === 'blockPeer' ? BLOCK_OPTIONS : operation === 'sendChatMessage' ? SEND_CHAT_OPTIONS : operation === 'sendContact' ? CONTACT_OPTIONS : operation === 'openMomo' ? MOMO_OPTIONS : operation === 'screenshot' ? ['timeoutMs', 'signal', 'level', 'attempts', 'retryDelayMs', 'maxBytes', 'source', 'maxSize', 'bitrate', 'maxAgeMs'] :
        operation === 'click' ? ['timeoutMs', 'signal', 'dryRun', 'coordinateSpace', 'offset', 'jitterPx', 'button', 'count', 'holdMs', 'intervalMs'] :
          ['timeoutMs', 'signal', 'dryRun', 'coordinateSpace', 'offset', 'jitterPx', 'durationMs', 'segmentDurationsMs', 'stepMs', 'startHoldMs', 'endHoldMs', 'easing']);
      const settings = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, key === 'signal' ? value : snapshot(value)]));
      const savedInput = snapshot(input);
      const maxAllowedTimeout = operation === 'processMomoGreetings' ? MAX_GREETINGS_TIMEOUT_MS :
        operation === 'syncMomoContacts' ? 1800000 : 300000;
      ctx = new OperationContext(number(settings.timeoutMs ?? (operation === 'syncMomoContacts' ? this._syncTimeoutMs :
        operation === 'processMomoGreetings' ? (this._greetingsTimeoutMs ?? greetingsTimeoutMs(settings)) :
        operation === 'refreshMomoHome' ? this._refreshHomeTimeoutMs :
        operation === 'browseMomoHome' ? this._browseHomeTimeoutMs : operation === 'blockPeer' ? this._blockTimeoutMs : operation === 'sendChatMessage' ? (this._contactTimeoutMs ?? 60000) : operation === 'sendContact' ? this._contactTimeoutMs : operation === 'openMomo' ? this._momoTimeoutMs : this.timeoutMs),
        'timeoutMs', 1, maxAllowedTimeout), settings.signal, this._lifetime.signal);
      if (this._closed) fail('TOOLS_CLOSED', 'This tool session is closed');
      // Reserve a queue slot. An aborted waiter resolves its slot without ever running late.
      const previous = this._tail;
      const slot = new Promise(resolve => { unlock = resolve; });
      this._tail = previous.then(() => slot);
      await ctx.wait(previous);
      ctx.check();
      ctx.stage = 'validate';
      const value = await work(ctx, settings, savedInput);
      status = value.status;
      data = value.data;
    } catch (cause) {
      // Prefer our explicit timeout/abort reason over the SDK's generic network exception.
      if (ctx?.signal.aborted && !(cause instanceof ToolFailure)) cause = new ToolFailure(ctx.reason, 'Operation cancelled or deadline exceeded');
      const detail = describeError(cause, ctx ?? { stage: 'validate' });
      const retrySafe = operation === 'screenshot' || !ctx || ctx.execution.state === 'not_started';
      error = { ...detail, stage: ctx?.stage ?? 'validate', retrySafe,
        retryable: retrySafe && ['NETWORK_ERROR', 'BACKEND_UNAVAILABLE', 'RATE_LIMITED', 'CONNECT_FAILED', 'CONNECT_TIMEOUT'].includes(detail.code) };
      data = ctx?.data ?? null;
      if (['openMomo', 'sendContact', 'blockPeer', 'refreshMomoHome', 'browseMomoHome', 'processMomoGreetings', 'syncMomoContacts'].includes(operation) && data?.history) {
        data.history.push({ stage: 'failed', elapsedMs: Math.round(performance.now() - started), code: error.code, failureStage: error.stage });
        if (['refreshMomoHome', 'browseMomoHome', 'processMomoGreetings', 'syncMomoContacts'].includes(operation) && data.history.length > 400) data.history.shift();
      }
    } finally {
      ctx?.cleanup(error);
      unlock?.();
    }
    const result = { ok: error === null, status, operation, operationId, deviceId: this.deviceId, startedAt,
      durationMs: Math.round((performance.now() - started) * 100) / 100, attempts: ctx?.attempt ?? 0,
      execution: ctx?.execution ?? { state: 'not_started', framesSent: 0, completedClicks: 0, release: 'not_needed', localWriteConfirmed: false, deviceConfirmed: false },
      data, error };
    if (ctx?.cleanupFailed) result.warnings = ['CONTROL_CLEANUP_FAILED'];
    if (this.logger) {
      // Deliberately omit data (image buffers / path arrays) from the default journal.
      const entry = { operationId, deviceId: this.deviceId, operation, status, ok: result.ok,
        startedAt, durationMs: result.durationMs, attempts: result.attempts, execution: { ...result.execution },
        error: error ? { code: error.code, stage: error.stage, retrySafe: error.retrySafe, retryable: error.retryable } : null };
      try {
        const pending = this.logger(entry);
        if (pending && typeof pending.then === 'function') {
          // Journaling must not hold an input operation open indefinitely.
          Promise.resolve(pending).catch(() => {});
          result.warnings = [...(result.warnings ?? []), 'ASYNC_LOGGER_UNSUPPORTED'];
        }
      } catch { result.warnings = [...(result.warnings ?? []), 'LOGGER_FAILED']; }
    }
    return result;
  }

  close() {
    if (this._closing) return this._closing;
    this._closed = true;
    this._lifetime.abort();
    this._closing = (async () => {
      await this._tail;
      try {
        if (this._control && this._ownsControl) await this._retire(this._control);
        if (this._retiring) await this._retiring;
      } finally {
        await Promise.all([this._momoVision?.close(), this._chatDetailVision?.close()]);
        if (this._ownsRecognitionClient) await this._recognitionPool.close();
      }
    })();
    return this._closing;
  }
}

function createDeviceTools(device, options) { return new CloudPhoneTools(device, options); }

module.exports = { CloudPhoneTools, createDeviceTools, GpuRecognitionPool, createRecognitionPool, RecognitionError,
  MomoMessageListWatcher, createMessageListWatcher,
  MOMO_GREETINGS_OPTIONS, processMomoGreetings, MOMO_SYNC_OPTIONS, syncMomoContacts, SEND_CHAT_OPTIONS, sendChatMessage };
