'use strict';
const { randomUUID } = require('node:crypto');
class DeviceArbiter {
  constructor() { this.locks = new Map(); this.quarantined = new Map(); this.epochs = new Map(); }
  isDeviceBusy(id) { return this.locks.has(String(id)); }
  isDeviceQuarantined(id) { return this.quarantined.has(String(id)); }
  getQuarantineInfo(id) { return this.quarantined.get(String(id)) || null; }
  getLockInfo(id) { return this.locks.get(String(id)) || null; }
  quarantineDevice(id, reason = 'Unconfirmed cancellation') {
    id = String(id);
    this.quarantined.set(id, { reason, quarantinedAt: new Date().toISOString() });
    const record = this.locks.get(id);
    if (record) record.revoked = true;
  }
  unquarantineDevice(id) {
    id = String(id);
    if (this.locks.has(id)) return false;
    return this.quarantined.delete(id);
  }
  _handle(record, ownerId, borrowed = false) {
    const handle = { deviceId: record.deviceId, ownerId: String(ownerId), leaseToken: record.leaseToken,
      epoch: record.epoch, referenceId: randomUUID(), borrowed };
    Object.defineProperty(handle, 'refCount', { enumerable: true, get: () => record.refs.size });
    record.refs.set(handle.referenceId, handle);
    return handle;
  }
  acquireDevice(id, ownerId, metadata = {}) {
    if (!id) throw new TypeError('deviceId is required');
    id = String(id);
    ownerId = String(ownerId || randomUUID());
    const fail = reason => metadata.returnLease ? { ok: false, reason } : false;
    if (this.quarantined.has(id)) return fail('DEVICE_QUARANTINED');
    let record = this.locks.get(id);
    if (record && (record.ownerId !== ownerId || record.revoked)) return fail('DEVICE_BUSY');
    if (!record) {
      const epoch = (this.epochs.get(id) || 0) + 1;
      this.epochs.set(id, epoch);
      record = { deviceId: id, ownerId, leaseToken: 'lease_' + randomUUID(), epoch, refs: new Map(), metadata, revoked: false };
      Object.defineProperty(record, 'refCount', { enumerable: true, get: () => record.refs.size });
      this.locks.set(id, record);
    }
    let handle = [...record.refs.values()].find(ref => !ref.borrowed && ref.ownerId === ownerId);
    if (!handle || metadata.nested) handle = this._handle(record, ownerId);
    return metadata.returnLease ? { ok: true, lease: handle } : true;
  }
  borrowLease(id, token, ownerId) {
    const record = this.locks.get(String(id));
    if (!record || record.leaseToken !== token || record.revoked || this.isDeviceQuarantined(id)) return { ok: false, reason: 'INVALID_PARENT_LEASE' };
    const lease = this._handle(record, ownerId || randomUUID(), true);
    return { ok: true, lease, handle: lease.referenceId };
  }
  assertLease(lease) {
    const record = this.locks.get(String(lease?.deviceId));
    if (!record || record.revoked || this.isDeviceQuarantined(lease?.deviceId) || record.leaseToken !== lease?.leaseToken ||
        (lease.referenceId && !record.refs.has(lease.referenceId))) {
      throw Object.assign(new Error('Device lease is no longer active'), { code: 'LEASE_REVOKED' });
    }
    return true;
  }
  releaseLease(lease) {
    const record = this.locks.get(String(lease?.deviceId));
    if (!record || record.leaseToken !== lease?.leaseToken || !lease.referenceId) return false;
    const removed = record.refs.delete(lease.referenceId);
    if (!record.refs.size) this.locks.delete(record.deviceId);
    return removed;
  }
  releaseDevice(id, ownerOrToken) {
    const record = this.locks.get(String(id));
    if (!record) return false;
    const refs = [...record.refs.values()];
    const handle = refs.find(ref => ref.referenceId === ownerOrToken) || refs.find(ref => ref.ownerId === String(ownerOrToken)) ||
      (record.leaseToken === ownerOrToken ? refs.find(ref => !ref.borrowed) : null);
    return handle ? this.releaseLease(handle) : false;
  }
}
const defaultArbiter = new DeviceArbiter();
module.exports = { DeviceArbiter, defaultArbiter };
