'use strict';

const { requiredString } = require('./control');
const { integer } = require('./protocol');
const { mapLimit } = require('./automation/concurrency');
const FILE = '/screen/file/scFile/';
const VPC = '/screen/vpc/scVpc/';
const GROUP = '/screen/vpc/scVpcGroup/';
const TRANSFER = '/screen/file/scFileTransfer/';

// Verified against the live cloud/index and ScVpcList frontend (2026-10-12).
const MANAGEMENT_ACTIONS = Object.freeze(Object.fromEntries(Object.entries({
  cloudList: ['GET', FILE + 'list'], cloudGet: ['GET', FILE + 'queryById'],
  cloudUsage: ['GET', FILE + 'getFileUseDetail'], cloudPublicUsage: ['GET', FILE + 'getPublicFileUseDetail'],
  cloudUpload: ['POST', FILE + 'save'], cloudPublicUpload: ['POST', FILE + 'publicSave'],
  cloudRename: ['POST', FILE + 'rename'], cloudDelete: ['DELETE', FILE + 'delete'],
  cloudPreview: ['GET', '/file/preview'], cloudSend: ['POST', FILE + 'send'],
  cloudSendStatus: ['GET', FILE + 'send/status'],
  cloudSendPairs: ['POST', TRANSFER + 'sendPairs'], cloudPairStatus: ['GET', TRANSFER + 'status'],
  cloudClearPairStatus: ['DELETE', TRANSFER + 'status'],
  cloudImport: ['POST', FILE + 'import'], cloudTemplate: ['GET', FILE + 'import/template'],
  cloudExport: ['GET', FILE + 'export'],
  vpcList: ['GET', VPC + 'list'], vpcGet: ['GET', VPC + 'queryById'],
  vpcSave: ['POST', VPC + 'save'], vpcBatchSave: ['POST', VPC + 'batchSave'],
  vpcDelete: ['DELETE', VPC + 'delete'], vpcTest: ['GET', VPC + 'testById'],
  vpcImport: ['POST', VPC + 'import'], vpcTemplate: ['GET', VPC + 'import/template'],
  vpcExport: ['GET', VPC + 'export'],
  vpcGroupList: ['GET', GROUP + 'list'], vpcGroupGet: ['GET', GROUP + 'queryById'],
  vpcGroupSave: ['POST', GROUP + 'save'], vpcGroupDelete: ['DELETE', GROUP + 'delete']
}).map(([name, [method, path]]) => [name, Object.freeze({ method, path })])));

function call(client, action, payload = {}, options = {}) {
  const spec = MANAGEMENT_ACTIONS[action];
  const queryMethod = spec.method === 'GET' || spec.method === 'DELETE';
  return client.request(spec.path, { ...options, method: spec.method,
    query: queryMethod ? payload : options.query, body: queryMethod ? undefined : payload });
}

function record(value, name = 'record') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name + ' must be an object');
  return value;
}

function idsCsv(ids) {
  const values = Array.isArray(ids) ? ids : requiredString('ids', ids).split(',');
  if (!values.length) throw new TypeError('ids must not be empty');
  return values.map(id => {
    const value = requiredString('id', id).trim();
    if (value.includes(',')) throw new TypeError('Individual id must not contain a comma');
    return value;
  }).join(',');
}

async function pageResult(promise) {
  const raw = await promise;
  const data = raw?.data ?? raw;
  if (!Array.isArray(data?.records)) throw new Error('Unexpected management-list response shape');
  return { records: data.records, total: data.total ?? data.records.length,
    current: data.current, size: data.size, pages: data.pages, raw };
}

function channelValue(channel) {
  if (!['1', '2'].includes(channel)) throw new TypeError('channel must be "1" (private) or "2" (public)');
  return channel;
}

function multipart(data, options) {
  if (!(data instanceof Uint8Array) && !(data instanceof Blob)) throw new TypeError('data must be Uint8Array, Buffer or Blob');
  const form = new FormData();
  form.append('file', data instanceof Blob ? data : new Blob([data]), requiredString('fileName', options.fileName));
  for (const [name, value] of Object.entries(options.fields ?? {})) {
    if (name === 'file') throw new TypeError('fields must not override file');
    if (value !== undefined && value !== null) form.append(name, String(value));
  }
  return form;
}

function importFile(client, action, data, options) {
  if (!/\.(csv|xls|xlsx)$/i.test(requiredString('fileName', options.fileName))) {
    throw new TypeError('Import filename must end in .csv, .xls or .xlsx');
  }
  return call(client, action, multipart(data, options), options);
}

async function spreadsheet(client, action, query, options) {
  const result = await call(client, action, query, { ...options, responseType: 'buffer' });
  if (/json|text\/html/i.test(result.contentType)) throw new Error('Spreadsheet endpoint returned an error document');
  return result;
}

class CloudDisk {
  constructor(client) { this.client = client; }
  list(options = {}, requestOptions = {}) {
    const { page = 1, size = 10000, channel = '1', fileType = '', sort = 'default', orders, ...filters } = options;
    const sorts = { default: [], time: [{ column: 'create_date', asc: false }],
      size: [{ column: 'file_size', asc: false }], name: [{ column: 'name', asc: true }] };
    if (!Object.hasOwn(sorts, sort)) throw new TypeError('Unknown cloud-disk sort');
    return pageResult(call(this.client, 'cloudList', { ...filters,
      page: integer('page', page, 1, 0x7fffffff), size: integer('size', size, 1, 1000000),
      channel: channelValue(channel), fileType, orders: orders ?? sorts[sort] }, requestOptions));
  }
  get(id, options) { return call(this.client, 'cloudGet', { id: requiredString('id', id) }, options); }
  usage(channel = '1', options) {
    return call(this.client, channelValue(channel) === '1' ? 'cloudUsage' : 'cloudPublicUsage', {}, options);
  }
  upload(data, options = {}) {
    if (options.public !== undefined && typeof options.public !== 'boolean') throw new TypeError('public must be boolean');
    return call(this.client, options.public ? 'cloudPublicUpload' : 'cloudUpload', multipart(data, options),
      { ...options, timeoutMs: options.timeoutMs ?? 3600000 });
  }
  rename(id, name, options) {
    return call(this.client, 'cloudRename', { id: requiredString('id', id), name: requiredString('name', name) }, options);
  }
  delete(ids, options) { return call(this.client, 'cloudDelete', { ids: idsCsv(ids) }, options); }
  resolveUrl(file, options) {
    const source = typeof file === 'string' ? file : record(file, 'file').url;
    const url = new URL(requiredString('file.url', source).split(',')[0], this.client.baseUrl + '/');
    return call(this.client, 'cloudPreview', {
      uploadPath: requiredString('uploadPath', url.searchParams.get('uploadPath')),
      name: requiredString('name', url.searchParams.get('name'))
    }, options);
  }
  async sendToDevices(deviceIds, files, options = {}) {
    if (!Array.isArray(deviceIds) || !deviceIds.length) throw new TypeError('deviceIds must be a non-empty array');
    const devices = deviceIds.map(id => requiredString('deviceId', id));
    const fileType = requiredString('fileType', options.fileType);
    if (!Array.isArray(files) || !files.length) throw new TypeError('files must be a non-empty array');
    const urls = await mapLimit(files, 4, async file => {
      const item = typeof file === 'string' ? await this.get(file, options) : record(file, 'file');
      const response = await this.resolveUrl(item?.data ?? item, options);
      return requiredString('resolved url', response?.data ?? response);
    }, options.signal);
    return call(this.client, 'cloudSend', { devices, urls, fileType }, options);
  }
  transferStatus(options) { return call(this.client, 'cloudSendStatus', {}, options); }
  sendPairs(pairs, options = {}) {
    if (!Array.isArray(pairs) || !pairs.length || pairs.length > 50) throw new TypeError('pairs must contain 1-50 entries');
    const fileType = requiredString('fileType', options.fileType ?? 'auto');
    const entries = pairs.map((pair, index) => ({ seq: index + 1,
      deviceId: requiredString('deviceId', record(pair, 'pair').deviceId),
      fileId: requiredString('fileId', pair.fileId), fileName: requiredString('fileName', pair.fileName) }));
    for (const field of ['deviceId', 'fileId']) {
      if (new Set(entries.map(p => p[field])).size !== entries.length) throw new TypeError('One-to-one pairs must have unique ' + field);
    }
    return call(this.client, 'cloudSendPairs', { fileType, pairs: entries }, { ...options, timeoutMs: options.timeoutMs ?? 3600000 });
  }
  pairStatus(options) { return call(this.client, 'cloudPairStatus', {}, options); }
  clearPairStatus(options) { return call(this.client, 'cloudClearPairStatus', {}, options); }
  importExcel(data, options = {}) { return importFile(this.client, 'cloudImport', data, options); }
  exportExcel(query = {}, options) { return spreadsheet(this.client, 'cloudExport', record(query, 'query'), options); }
  exportTemplate(options) { return spreadsheet(this.client, 'cloudTemplate', {}, options); }
}

function vpcRecord(config, batch = false) {
  record(config, 'VPC config');
  const port = String(config.port ?? '').trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new TypeError('port must be an integer from 1 to 65535');
  if (config.id !== undefined && config.id !== '') requiredString('id', config.id);
  if (config.groupId !== undefined && config.groupId !== '') requiredString('groupId', config.groupId);
  return { ...(batch ? { groupId: '', remarks: '' } : { id: '', expTime: '', userId: '', groupId: '', remarks: '' }), ...config,
    ip: requiredString('ip', config.ip).trim(), port,
    username: requiredString('username', config.username), password: requiredString('password', config.password) };
}

async function vpcRowsForHost(manager, ip, requestOptions) {
  const first = await manager.list({ ip, current: 1, size: 1000 }, requestOptions);
  const rows = [...first.records];
  const pages = Number(first.pages ?? Math.ceil(Number(first.total) / Number(first.size ?? 1000)));
  const remaining = Array.from({ length: Math.max(0, pages - 1) || 0 }, (_, index) => index + 2);
  for (const page of await mapLimit(remaining, 4,
    current => manager.list({ ip, current, size: 1000 }, requestOptions), requestOptions?.signal)) rows.push(...page.records);
  return rows;
}

function sameVpcConnection(row, expected) {
  const expiryKey = value => {
    const text = String(value ?? '').replace(/\//g, '-');
    const time = Date.parse(text);
    return Number.isFinite(time) ? time : text;
  };
  return String(row.ip ?? '').trim().toLowerCase() === expected.ip.toLowerCase() &&
    Number(row.port) === Number(expected.port) && row.username === expected.username &&
    row.password === expected.password && String(row.groupId ?? '') === String(expected.groupId ?? '') &&
    String(row.remarks ?? '') === String(expected.remarks ?? '') &&
    (!expected.expTime || expiryKey(row.expTime) === expiryKey(expected.expTime));
}

class VpcManager {
  constructor(client) { this.client = client; }
  list(options = {}, requestOptions = {}) {
    const { current = 1, size = 10, ip = '', remarks = '', groupId = '',
      orders = [{ column: 'create_date', asc: false }, { column: 'id', asc: false }], ...filters } = options;
    return pageResult(call(this.client, 'vpcList', { ...filters, ip, remarks, groupId, orders,
      current: integer('current', current, 1, 0x7fffffff), size: integer('size', size, 1, 1000000) }, requestOptions));
  }
  get(id, options) { return call(this.client, 'vpcGet', { id: requiredString('id', id) }, options); }
  save(config, options) { return call(this.client, 'vpcSave', vpcRecord(config), options); }
  batchSave(configs, options) {
    if (!Array.isArray(configs) || !configs.length) throw new TypeError('configs must be a non-empty array');
    return call(this.client, 'vpcBatchSave', configs.map(config => vpcRecord(config, true)), options);
  }
  async addAndGetIds(configs, options = {}) {
    const input = Array.isArray(configs) ? configs : [configs];
    if (!input.length) throw new TypeError('At least one VPC config is required');
    const payload = input.map(config => {
      if (config?.id !== undefined && config.id !== '') throw new TypeError('New VPC must not contain an existing id');
      return vpcRecord(config, true);
    });
    const identities = payload.map(config => JSON.stringify([config.ip.toLowerCase(), Number(config.port),
      config.username, config.password, config.groupId, config.remarks, config.expTime ?? '']));
    if (new Set(identities).size !== identities.length) throw new TypeError('Duplicate VPC configs in the same request');
    const { lookupAttempts = 10, lookupIntervalMs = 1000, ...requestOptions } = options;
    integer('lookupAttempts', lookupAttempts, 1, 60);
    integer('lookupIntervalMs', lookupIntervalMs, 0, 10000);
    const hosts = [...new Set(payload.map(config => config.ip))];
    const read = async () => (await mapLimit(hosts, 4, ip => vpcRowsForHost(this, ip, requestOptions), requestOptions.signal)).flat();
    const beforeIds = new Set((await read()).map(row => String(row.id)));
    // Exactly one write. Readback failures never cause the batch to be resent.
    await this.batchSave(payload, requestOptions);
    let matched = [], lastReadError;
    for (let attempt = 0; attempt < lookupAttempts; attempt += 1) {
      try {
        const rows = await read();
        matched = payload.map(config => {
          const unique = new Map(rows.filter(row => !beforeIds.has(String(row.id)) && sameVpcConnection(row, config))
            .map(row => [String(row.id), row]));
          return [...unique.values()];
        });
        if (matched.every(rows => rows.length === 1)) {
          const results = await mapLimit(payload, 4, async (config, index) => {
            const id = String(matched[index][0].id);
            const raw = await this.get(id, requestOptions), row = raw?.data ?? raw;
            if (String(row?.id) !== id || !sameVpcConnection(row, payload[index])) {
              throw new Error('New VPC readback did not match submitted config');
            }
            return { vpcId: id, ip: String(row.ip), port: String(row.port), groupId: String(row.groupId ?? ''),
              remarks: String(row.remarks ?? ''), expTime: String(row.expTime ?? '') };
          }, requestOptions.signal);
          return { ids: results.map(row => row.vpcId), results,
            ...(results.length === 1 ? { vpcId: results[0].vpcId } : {}) };
        }
      } catch (error) { lastReadError = error; }
      if (attempt + 1 < lookupAttempts) await new Promise(resolve => setTimeout(resolve, lookupIntervalMs));
    }
    const error = new Error('VPC creation submitted, but new IDs were not uniquely verified; do not automatically add again');
    error.submitted = true;
    error.candidateIds = matched.map(rows => rows.map(row => String(row.id)));
    if (lastReadError) error.cause = lastReadError;
    throw error;
  }
  delete(ids, options) { return call(this.client, 'vpcDelete', { ids: idsCsv(ids) }, options); }
  testConnection(id, options) { return call(this.client, 'vpcTest', { id: requiredString('id', id) }, options); }
  groups() { return new VpcGroupManager(this.client); }
  importExcel(data, options = {}) { return importFile(this.client, 'vpcImport', data, options); }
  exportExcel(query = {}, options) { return spreadsheet(this.client, 'vpcExport', record(query, 'query'), options); }
  exportTemplate(options) { return spreadsheet(this.client, 'vpcTemplate', {}, options); }
}

class VpcGroupManager {
  constructor(client) { this.client = client; }
  list(options = {}, requestOptions = {}) {
    const { current = 1, size = -1, ...filters } = options;
    if (size !== -1) integer('size', size, 1, 1000000);
    return pageResult(call(this.client, 'vpcGroupList', { ...filters,
      current: integer('current', current, 1, 0x7fffffff), size }, requestOptions));
  }
  get(id, options) { return call(this.client, 'vpcGroupGet', { id: requiredString('id', id) }, options); }
  save(config, options) {
    record(config, 'group');
    const payload = { name: requiredString('name', config.name).trim() };
    if (config.id !== undefined) payload.id = requiredString('id', config.id);
    return call(this.client, 'vpcGroupSave', payload, options);
  }
  delete(ids, options = {}) {
    const mode = options.mode ?? 'keep';
    if (!['keep', 'delete'].includes(mode)) throw new TypeError('mode must be keep or delete');
    return call(this.client, 'vpcGroupDelete', { ids: idsCsv(ids), mode }, options);
  }
}

module.exports = { CloudDisk, VpcManager, VpcGroupManager, MANAGEMENT_ACTIONS };
