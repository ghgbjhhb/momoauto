'use strict';

const { CloudPhoneControl, requiredString } = require('./control');
const { integer } = require('./protocol');

const DEVICE = '/screen/device/scDevice/';
// Paths/methods verified in the cloud frontend. invoke() takes the original payload.
const BACKEND_ACTIONS = Object.freeze(Object.fromEntries(Object.entries({
  start: ['GET', DEVICE + 'start'], stop: ['GET', DEVICE + 'stop'],
  reboot: ['POST', DEVICE + 'reboot'], rename: ['GET', DEVICE + 'rename'],
  reset: ['GET', DEVICE + 'reset'], resetV3: ['POST', DEVICE + 'v3/reset'],
  setDeviceInfo: ['POST', DEVICE + 'setDeviceInfo'], randomDeviceInfo: ['GET', DEVICE + 'setDeviceRandomInfo'],
  randomFingerprint: ['GET', DEVICE + 'uploadFingerprint'], randomDeviceInfoAsync: ['GET', DEVICE + 'randomDevInfoAsync'],
  setAudio: ['POST', DEVICE + 'setAudio'], setAudioMute: ['POST', DEVICE + 'setAudioMute'],
  setProxyLegacy: ['POST', DEVICE + 's5Set'], stopProxyLegacy: ['GET', DEVICE + 's5Stop'],
  getProxyLegacy: ['GET', DEVICE + 'getS5ByDeviceId'],
  setProxy: ['POST', DEVICE + 's5SetV1'], stopProxy: ['GET', DEVICE + 's5StopV1'], getProxy: ['GET', DEVICE + 's5QueryV1'],
  restartVpc: ['GET', DEVICE + 'restartVpcPlugin'],
  updateResolution: ['POST', DEVICE + 'updateSize'], updateImage: ['POST', DEVICE + 'updateImages'],
  importImage: ['POST', DEVICE + 'importImages'], switchModel: ['POST', DEVICE + 'switchModel'],
  cleanLock: ['POST', '/screen/device/root/cleanLock'], cleanScreenError: ['POST', '/screen/device/root/cleanScreenError'],
  countryCodes: ['GET', DEVICE + 'v3/countryCodes'],
  listFiles: ['POST', DEVICE + 'getFileList'], downloadFile: ['POST', DEVICE + 'download'],
  sendFiles: ['POST', '/screen/file/scFile/send'], sendStatus: ['GET', '/screen/file/scFile/send/status'],
  previewFile: ['GET', '/file/preview'], previewTemporaryFile: ['GET', '/file/previewTmp']
}).map(([name, [method, path]]) => [name, Object.freeze({ method, path })])));

function appendQuery(url, query, prefix = '') {
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? prefix + (Array.isArray(query) ? '[' + key + ']' : '.' + key) : key;
    if (Array.isArray(value)) appendQuery(url, value, name);
    else if (typeof value === 'object') appendQuery(url, value, name);
    else url.searchParams.set(name, String(value));
  }
}

class YunmomoHttpError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'YunmomoHttpError';
    this.status = status;
    Object.defineProperty(this, 'data', { value: data });
  }
}

class YunmomoClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl ?? 'https://cloud.yunmomo.com/backend').replace(/\/+$/, '');
    const url = new URL(this.baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new TypeError('Backend must use HTTPS (HTTP is allowed only on loopback)');
    }
    Object.defineProperty(this, 'token', { value: options.token ?? process.env.YUNMOMO_TOKEN ?? '', writable: true });
    this.timeoutMs = integer('timeoutMs', options.timeoutMs ?? 100000, 1, 0x7fffffff);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new TypeError('Node.js 18+ or a fetchImpl is required');
    this._reads = new Map();
  }

  _readOnce(key, read) {
    // Coalesce only simultaneous metadata reads, never cache state or writes.
    // Token identity is part of the key and is never returned in logs/results.
    const token = this.requireToken();
    const identity = token + ':' + key;
    let pending = this._reads.get(identity);
    if (!pending) {
      pending = Promise.resolve().then(() => {
        if (this.token !== token) throw new Error('Authentication changed before metadata request');
        return read();
      }).finally(() => { if (this._reads.get(identity) === pending) this._reads.delete(identity); });
      this._reads.set(identity, pending);
    }
    return pending.then(value => structuredClone(value));
  }

  requireToken() { return requiredString('YUNMOMO_TOKEN', this.token); }

  async request(path, options = {}) {
    // Only allowlisted endpoint names, never a URL, query, or request body.
    const action = Object.entries(BACKEND_ACTIONS).find(([, spec]) => spec.path === path)?.[0] || 'request';
    return require('./automation/timing').measure('cloud.' + action, {}, () => this._requestMeasured(path, options));
  }

  async _requestMeasured(path, options = {}) {
    const root = new URL(this.baseUrl + '/');
    const value = requiredString('path', path);
    const url = new URL(value.replace(/^\/+/, ''), root);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
      throw new TypeError('Request must stay within the configured backend; token will not be sent elsewhere');
    }
    appendQuery(url, options.query);
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json, */*');
    headers.set('token', this.requireToken());
    const multipart = typeof FormData !== 'undefined' && options.body instanceof FormData;
    let body;
    if (multipart) { body = options.body; headers.delete('Content-Type'); }
    else if (options.body !== undefined) { body = JSON.stringify(options.body); headers.set('Content-Type', 'application/json; charset=utf-8'); }
    const timeoutMs = integer('timeoutMs', options.timeoutMs ?? this.timeoutMs, 1, 0x7fffffff);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await this.fetchImpl(url, { method: options.method ?? 'GET', headers, body,
        signal: controller.signal, redirect: 'error' });
      if (options.responseType === 'buffer') {
        const data = Buffer.from(await response.arrayBuffer());
        if (!response.ok) throw new YunmomoHttpError('Yunmomo HTTP ' + response.status, response.status, data);
        return { data, contentType: response.headers.get('content-type') || '', status: response.status };
      }
      const content = await response.text();
      let data;
      try { data = content ? JSON.parse(content) : null; } catch { data = content; }
      if (!response.ok) throw new YunmomoHttpError('Yunmomo HTTP ' + response.status, response.status, data);
      if (data && typeof data === 'object' && data.success === false) {
        throw new YunmomoHttpError('Yunmomo business request failed', response.status, data);
      }
      return data;
    } catch (error) {
      if (error instanceof YunmomoHttpError) throw error;
      if (controller.signal.aborted) throw new Error('Yunmomo request timed out or was aborted');
      throw new Error('Yunmomo network request failed');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  invoke(action, payload = {}, options = {}) {
    const spec = BACKEND_ACTIONS[action];
    if (!Object.hasOwn(BACKEND_ACTIONS, action)) throw new TypeError('Unknown backend action: ' + action);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('payload must be an object');
    return this.request(spec.path, { ...options, method: spec.method,
      query: spec.method === 'GET' ? payload : options.query,
      body: spec.method === 'GET' ? undefined : payload });
  }

  async listDevices(options = {}) {
    const normalized = new URL('http://localhost/');
    appendQuery(normalized, { ...options.filters,
      current: integer('current', options.current ?? 1, 1, 0x7fffffff), size: integer('size', options.size ?? 100, 1, 50000) });
    const query = Object.fromEntries(normalized.searchParams);
    return this._readOnce('devices:' + normalized.search, async () => {
      const raw = await this.request(DEVICE + 'myDeviceList', { query });
      const payload = raw?.data ?? raw;
      const records = Array.isArray(payload) ? payload : payload?.records;
      if (!Array.isArray(records)) throw new Error('Unexpected device-list response shape');
      return { records, total: payload.total ?? records.length, raw };
    });
  }

  getDevice(id, options = {}) { return this.request(DEVICE + 'queryById', {
    timeoutMs: options.timeoutMs, signal: options.signal, query: { id: requiredString('id', id) } }); }

  async listModels() {
    return this._readOnce('models', async () => {
      const raw = await this.request('/screen/box/mytBox/getModelList');
      const records = raw?.data ?? raw;
      if (!Array.isArray(records)) throw new Error('Unexpected model-list response shape');
      return { records, raw };
    });
  }

  async screenshot(deviceId, options = {}) {
    if (options.source === 'stream') {
      try {
        return await require('./stream-screenshot').captureStream(this, deviceId, options);
      } catch {
        return this.screenshot(deviceId, { ...options, source: 'rest' });
      }
    }
    if (options.source !== undefined && options.source !== 'rest') throw new TypeError('screenshot source must be rest or stream');
    const result = await this.request(DEVICE + 'notifyScreen', { ...options, responseType: 'buffer', query: {
      id: requiredString('deviceId', deviceId), level: integer('level', options.level ?? 2, 1, 2) } });
    const d = result.data;
    const image = /^image\//i.test(result.contentType) ||
      (d.length > 2 && d[0] === 0xff && d[1] === 0xd8) ||
      (d.length >= 8 && d.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    if (!image || !d.length) throw new Error('Screenshot endpoint did not return an image');
    return result;
  }

  closeScreenshots() { return require('./stream-screenshot').closeStreams(this); }

  openControl(options = {}) { return new CloudPhoneControl({ ...options, token: this.requireToken() }); }
  device(deviceId) { return new CloudPhoneDevice(this, requiredString('deviceId', deviceId)); }
  cloudDisk() { return new (require('./management').CloudDisk)(this); }
  vpc() { return new (require('./management').VpcManager)(this); }

  async uploadCloudFile(data, options = {}) {
    const form = new FormData();
    form.append('file', new Blob([data]), requiredString('fileName', options.fileName));
    for (const [name, value] of Object.entries(options.fields ?? {})) form.append(name, String(value));
    return this.request('/screen/file/scFile/save', { method: 'POST', body: form, timeoutMs: options.timeoutMs ?? 3600000 });
  }

  uploadGoogleCertificate(deviceIds, data, options = {}) {
    if (!Array.isArray(deviceIds) || !deviceIds.length) throw new TypeError('deviceIds must be a non-empty array');
    const fileName = requiredString('fileName', options.fileName);
    if (!/\.(cert|xml)$/i.test(fileName)) throw new TypeError('Certificate filename must end in .cert or .xml');
    const form = new FormData();
    form.append('file', new Blob([data]), fileName);
    for (const id of deviceIds) form.append('deviceList', requiredString('deviceId', id));
    return this.request(DEVICE + 'uploadGoogleCert', { method: 'POST', body: form, timeoutMs: options.timeoutMs });
  }

  sendFiles(deviceIds, urls, options = {}) {
    if (!Array.isArray(deviceIds) || !deviceIds.length || !Array.isArray(urls) || !urls.length) {
      throw new TypeError('deviceIds and urls must be non-empty arrays');
    }
    const devices = deviceIds.map(id => requiredString('deviceId', id));
    const sources = urls.map(url => requiredString('url', url));
    const fileType = requiredString('fileType', options.fileType);
    return this.invoke('sendFiles', { devices, urls: sources, fileType });
  }
}

class CloudPhoneDevice {
  constructor(client, deviceId) { this.client = client; this.deviceId = deviceId; }
  getInfo(options) { return this.client.getDevice(this.deviceId, options); }
  screenshot(options) { return this.client.screenshot(this.deviceId, options); }
  tools(options) { return new (require('./tools').CloudPhoneTools)(this, options); }
  invoke(action, fields = {}, options) { return this.client.invoke(action, { ...fields, id: this.deviceId }, options); }
  start() { return this.invoke('start'); }
  stop() { return this.invoke('stop'); }
  reboot(containerId) { return this.invoke('reboot', { containerId: requiredString('containerId', containerId) }); }
  rename(name) { return this.invoke('rename', { name: requiredString('name', name) }); }
  reset() { return this.invoke('reset'); }
  resetV3(countryCode) { return this.invoke('resetV3', { countryCode: requiredString('countryCode', countryCode) }); }
  countryCodes() { return this.invoke('countryCodes'); }
  switchModel(config, options = {}) {
    if (!config || typeof config !== 'object') throw new TypeError('Model config is required');
    const modelId = config.modelId;
    if (!((typeof modelId === 'number' && Number.isSafeInteger(modelId) && modelId > 0) ||
      (typeof modelId === 'string' && /^[1-9]\d*$/.test(modelId)))) {
      throw new TypeError('modelId must be a positive integer or numeric string');
    }
    const resetData = config.resetData ?? false;
    if (typeof resetData !== 'boolean') throw new TypeError('resetData must be a boolean');
    const countryCode = resetData ? requiredString('countryCode', config.countryCode) : (config.countryCode ?? '');
    if (typeof countryCode !== 'string') throw new TypeError('countryCode must be a string');
    return this.invoke('switchModel', { modelId, modelName: requiredString('modelName', config.modelName),
      resetData, countryCode }, options);
  }
  randomDeviceInfo() { return this.invoke('randomDeviceInfo'); }
  randomFingerprint() { return this.invoke('randomFingerprint'); }
  restartVpc() { return this.invoke('restartVpc'); }
  listFiles(path = '/sdcard/') { return this.invoke('listFiles', { path: requiredString('path', path) }); }
  downloadFile(path) { return this.invoke('downloadFile', { path: requiredString('path', path) }, { responseType: 'buffer' }); }
  playAudio(path) { return this._audio('play', path); }
  stopAudio(path) { return this._audio('stop', path); }
  _audio(act, path) {
    if (!/\.mp3$/i.test(requiredString('path', path))) throw new TypeError('Audio path must end in .mp3');
    return this.invoke('setAudio', { act, path });
  }
  getProxy(version = 'v1') { return this.invoke(proxyAction(version, 'get')); }
  stopProxy(version = 'v1') { return this.invoke(proxyAction(version, 'stop')); }
  setProxy(config, version = 'v1') {
    if (!config || typeof config !== 'object') throw new TypeError('Proxy config is required');
    return this.invoke(proxyAction(version, 'set'), { ...config,
      s5ip: requiredString('s5ip', config.s5ip), s5port: integer('s5port', config.s5port, 1, 65535) });
  }
  setDeviceInfo(config) {
    if (!config || config.devinfo === undefined) throw new TypeError('devinfo is required');
    const devinfo = typeof config.devinfo === 'string' ? config.devinfo : JSON.stringify(config.devinfo);
    JSON.parse(devinfo);
    return this.client.invoke('setDeviceInfo', { ...config, devinfo, deviceId: this.deviceId });
  }
  uploadGoogleCertificate(data, options) { return this.client.uploadGoogleCertificate([this.deviceId], data, options); }
  sendFiles(urls, options) { return this.client.sendFiles([this.deviceId], urls, options); }
  async openControl(options = {}) {
    let udid = options.udid;
    if (!udid) { const response = await this.getInfo(); udid = (response?.data ?? response)?.udid; }
    return this.client.openControl({ ...options, udid: requiredString('udid', udid), deviceId: this.deviceId });
  }
}

function proxyAction(version, operation) {
  if (!['legacy', 'v1'].includes(version)) throw new TypeError('Proxy version must be legacy or v1');
  return operation + 'Proxy' + (version === 'legacy' ? 'Legacy' : '');
}

module.exports = { YunmomoClient, CloudPhoneControl, CloudPhoneDevice, YunmomoHttpError, BACKEND_ACTIONS };
