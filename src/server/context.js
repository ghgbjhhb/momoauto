'use strict';

const fs = require('node:fs');
const { readFile, writeFile, rename, unlink } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { YunmomoClient } = require('../index');
const { BrainManager } = require('../brain/manager');
const { getAuthService } = require('./auth/service');
const { PROJECT_ROOT } = require('../automation/runtime');

const authService = getAuthService();

const APP_ROOT = path.join(PROJECT_ROOT, 'app');
const CLOUD_DISK_ROOT = path.join(PROJECT_ROOT, 'storage', 'cloud-disk');
try {
  fs.mkdirSync(path.join(CLOUD_DISK_ROOT, '真参'), { recursive: true });
  fs.mkdirSync(path.join(CLOUD_DISK_ROOT, '头像'), { recursive: true });
} catch {}
const LOCAL_ENV_FILE = path.join(PROJECT_ROOT, '.env.local');
const HOST = process.env.YUNMOMO_APP_HOST || '127.0.0.1';
const DEFAULT_PORT = 4318;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 120000;

// Website sessions live in ignored local configuration, never in distributable code.
let runtimeToken = null;
let localEnv = Object.create(null);
const busyDevices = new Set();
const busyAccountScripts = new Set();
const manualBridges = new Set();
const screenshotJobs = new Map();
const activeScriptRuns = new Map();
const pendingScriptStops = new Map();
const completedScriptRuns = new Map();
const SCRIPT_STOP_INTENT_TTL_MS = 30000;
const SCRIPT_STOP_INTENT_MAX = 256;
let deviceCache = null;
let sharedClient = null;
let sharedBrainManager = null;

function brainManager() {
  return sharedBrainManager ||= new BrainManager({ client: client() });
}

// 唯一的会话撤销入口：账号封禁或设备权益失效都从这里收敛。
// 只按租户归属清理系统会话，绝不按设备号盲目终止其他客户的任务。
async function revokeAccess(userId, { deviceId = null, reason = 'Access revoked' } = {}) {
  if (deviceId) {
    const user = authService.db.getUserById(userId);
    if (user?.status === 'active' && authService.canAccessDevice(user, deviceId)) return;
  }

  for (const bridge of manualBridges) {
    if (deviceId) bridge.closeDevice?.(deviceId, 'DEVICE_EXPIRED', userId);
    else bridge.closeUser?.(userId);
  }

  const { stopActiveScript } = require('./script-runner');
  const { revokeAiReplyRuns } = require('./ai-reply-routes');
  const runs = [...activeScriptRuns.values()].filter(run =>
    run.ownerUserId === userId && (!deviceId || run.deviceId === deviceId));
  const actors = [...(sharedBrainManager?.actors.values() || [])].filter(actor =>
    actor.ownerUserId === userId && (!deviceId || actor.deviceId === deviceId));
  const results = await Promise.allSettled([
    ...runs.map(run => stopActiveScript({ scriptRunId: run.scriptRunId }, { role: 'admin' })),
    ...actors.map(actor => sharedBrainManager.stopDevice(actor.deviceId, reason)),
    revokeAiReplyRuns(userId, deviceId)
  ]);
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason),
    '部分设备会话未能正常停止，需人工确认隔离状态');
}

function revokeDeviceAccess(deviceId, userId) {
  return revokeAccess(userId, { deviceId, reason: 'Device access revoked' });
}

function revokeUserAccess(userId) {
  return revokeAccess(userId, { reason: 'Account banned' });
}

// 任意请求触发租期回收时也必须切断会话，不能只依赖后台计时器。
authService.onAllocationExpired = (deviceId, userId) => {
  revokeDeviceAccess(deviceId, userId)
    .catch(error => console.error('[Sweeper Revoke Failed]', error.message));
};
setInterval(() => {
  try {
    authService.sweepExpiredAllocations();
  } catch (err) {
    console.error('[Sweeper Error]', err.message);
  }
}, 10000).unref();

function parseLocalEnv(source) {
  const values = Object.create(null);
  for (const line of String(source).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function loadLocalEnv() {
  try {
    localEnv = parseLocalEnv(await readFile(LOCAL_ENV_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    localEnv = Object.create(null);
  }
}

function configuredValue(name) {
  return process.env[name] || localEnv[name] || '';
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value ?? ''));
}

async function persistToken(token) {
  const values = { ...localEnv, YUNMOMO_TOKEN: token };
  const source = Object.entries(values)
    .map(([name, value]) => name + '=' + quoteEnvValue(value))
    .join('\n') + '\n';
  const pendingFile = LOCAL_ENV_FILE + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(pendingFile, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(pendingFile, LOCAL_ENV_FILE);
  } finally {
    await unlink(pendingFile).catch(error => {
      if (error.code !== 'ENOENT') console.warn('[Session] 临时配置清理失败:', error.code);
    });
  }
  localEnv = parseLocalEnv(source);
}

function portValue(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('YUNMOMO_APP_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function activeToken() {
  return runtimeToken || configuredValue('YUNMOMO_TOKEN');
}

function client() {
  const token = activeToken() || '';
  if (!sharedClient || sharedClient.token !== token) {
    sharedClient?.closeScreenshots().catch(() => {});
    sharedClient = new YunmomoClient({ token, timeoutMs: 100000 });
  }
  return sharedClient;
}

function deviceIdOf(record) {
  return String(record?.deviceId ?? record?.id ?? '');
}

function deviceNameOf(record) {
  return String(record?.deviceName ?? record?.name ?? record?.cloudNo ?? 'SF');
}

function extractHost(address) {
  if (!address) return null;
  const str = String(address).trim();
  if (!str) return null;
  if (str.startsWith('[')) {
    const end = str.indexOf(']');
    if (end > 0) return str.slice(1, end);
  }
  const host = str.replace(/:\d+$/, '').trim();
  return host || str;
}

async function resolveDeviceProxy(owner, deviceId, useIpFallback = null) {
  try {
    const phone = owner.device(deviceId);
    const v1 = await phone.getProxy('v1').catch(() => null);
    if (v1 && (Number(v1.status) === 1 || v1.status === true) && v1.address) {
      const raw = String(v1.address).trim();
      const host = extractHost(raw);
      if (host) return { host, raw, source: 'v1' };
    }
  } catch {}

  try {
    const phone = owner.device(deviceId);
    const legacy = await phone.getProxy('legacy').catch(() => null);
    const addr = legacy?.addr || legacy?.address || legacy?.data?.addr;
    const status = Number(legacy?.status ?? legacy?.data?.status);
    if ((status === 1 || Boolean(addr)) && addr) {
      const raw = String(addr).trim();
      const host = extractHost(raw);
      if (host) return { host, raw, source: 'legacy' };
    }
  } catch {}

  if (useIpFallback) {
    const raw = String(useIpFallback).trim();
    const host = extractHost(raw);
    if (host) return { host, raw, source: 'useIp' };
  }

  return null;
}

function publicDevice(record) {
  return {
    deviceId: deviceIdOf(record),
    name: deviceNameOf(record),
    udid: String(record?.udid ?? ''),
    status: record?.status ?? null,
    online: record?.online ?? null,
    cloudNo: record?.cloudNo ?? record?.cloudNumber ?? null,
    sdkVersion: record?.sdkVersion ? String(record.sdkVersion).toLowerCase() : null,
    currentIp: record?.currentIp || null,
    proxyAddress: record?.proxyAddress || null
  };
}

let deviceListing = null;
async function listDevices() {
  if (deviceCache && deviceCache.expires > Date.now()) return deviceCache.records;
  const owner = client();
  if (deviceListing?.owner === owner) return deviceListing.pending;
  const listing = { owner };
  listing.pending = (async () => {
    let rawRecords = [];
    try {
      const result = await owner.listDevices({ current: 1, size: 50000 });
      rawRecords = Array.isArray(result?.records) ? result.records : [];
    } catch {}

    if (rawRecords.length === 0) {
      try {
        const allocatedDeviceIds = authService.db.getActiveAllocatedDeviceIds();
        if (Array.isArray(allocatedDeviceIds) && allocatedDeviceIds.length > 0) {
          const fetched = await Promise.all(allocatedDeviceIds.map(async id => {
            try { return await owner.getDevice(id); } catch { return null; }
          }));
          rawRecords = fetched.filter(Boolean);
        }
      } catch {}
    }

    const records = await Promise.all(rawRecords.map(async raw => {
      const base = publicDevice(raw);
      if (!base.deviceId) return null;
      try {
        const proxy = await resolveDeviceProxy(owner, base.deviceId, raw.useIp);
        base.currentIp = proxy?.host || null;
        base.proxyAddress = proxy?.raw || null;
      } catch {
        base.currentIp = null;
        base.proxyAddress = null;
      }
      return base;
    }));
    const validRecords = records.filter(Boolean);
    if (sharedClient === owner) deviceCache = { records: validRecords, expires: Date.now() + 2500 };
    return validRecords;
  })().finally(() => { if (deviceListing === listing) deviceListing = null; });
  deviceListing = listing;
  return listing.pending;
}

async function listDevicesWithToken(token) {
  if (!token) return [];
  const c = new YunmomoClient({ token, timeoutMs: 15000 });
  const result = await c.listDevices({ current: 1, size: 50000 });
  const rawRecords = Array.isArray(result?.records) ? result.records : (Array.isArray(result) ? result : []);
  const records = await Promise.all(rawRecords.map(async raw => {
    const base = publicDevice(raw);
    if (!base.deviceId) return null;
    try {
      const proxy = await resolveDeviceProxy(c, base.deviceId, raw.useIp);
      base.currentIp = proxy?.host || null;
      base.proxyAddress = proxy?.raw || null;
    } catch {
      base.currentIp = null;
      base.proxyAddress = null;
    }
    return base;
  }));
  return records.filter(Boolean);
}

async function selectedDevice(deviceId, tokenOrUser = null) {
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throw new Error('请选择一台云机');
  }
  let token = typeof tokenOrUser === 'string' ? tokenOrUser : null;
  if (!token && tokenOrUser?.id) {
    token = authService.getUserPlatformToken(tokenOrUser.id);
  }

  if (token) {
    const c = new YunmomoClient({ token, timeoutMs: 15000 });
    try {
      const raw = await c.getDevice(deviceId);
      const data = raw?.data ?? raw;
      if (data && (data.id || data.deviceId)) {
        const base = publicDevice(data);
        if (!base.udid) base.udid = String(data?.udid ?? '');
        return base;
      }
    } catch {}
  }

  const records = await listDevices();
  const record = records.find(item => item.deviceId === deviceId);
  if (!record) {
    try {
      const raw = await client().getDevice(deviceId);
      const data = raw?.data ?? raw;
      if (data && (data.id || data.deviceId)) {
        const base = publicDevice(data);
        if (!base.udid) base.udid = String(data?.udid ?? '');
        return base;
      }
    } catch {}
    throw new Error('所选云机不在当前账号设备列表中');
  }
  if (!record.udid) {
    const raw = await client().getDevice(deviceId);
    const data = raw?.data ?? raw;
    record.udid = String(data?.udid ?? '');
  }
  if (!record.udid) throw new Error('所选云机没有可用 UDID');
  return record;
}

module.exports = {
  PROJECT_ROOT,
  APP_ROOT,
  CLOUD_DISK_ROOT,
  LOCAL_ENV_FILE,
  HOST,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  MAX_OUTPUT_BYTES,
  SCRIPT_STOP_INTENT_TTL_MS,
  SCRIPT_STOP_INTENT_MAX,
  getRuntimeToken: () => runtimeToken,
  setRuntimeToken: token => { runtimeToken = token; },
  getLocalEnv: () => localEnv,
  setLocalEnv: env => { localEnv = env; },
  getDeviceCache: () => deviceCache,
  setDeviceCache: cache => { deviceCache = cache; },
  clearDeviceCache: () => { deviceCache = null; },
  busyDevices,
  busyAccountScripts,
  manualBridges,
  screenshotJobs,
  activeScriptRuns,
  pendingScriptStops,
  completedScriptRuns,
  brainManager,
  getSharedBrainManager: () => sharedBrainManager,
  resetSharedBrainManager: async () => {
    await sharedBrainManager?.close();
    sharedBrainManager = null;
  },
  revokeDeviceAccess,
  revokeUserAccess,
  resetSharedClient: async () => {
    await sharedClient?.closeScreenshots();
  },
  parseLocalEnv,
  loadLocalEnv,
  configuredValue,
  quoteEnvValue,
  persistToken,
  portValue,
  activeToken,
  client,
  deviceIdOf,
  deviceNameOf,
  extractHost,
  resolveDeviceProxy,
  publicDevice,
  listDevices,
  listDevicesWithToken,
  selectedDevice
};
