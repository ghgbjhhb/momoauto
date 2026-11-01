'use strict';

/**
 * 多设备中枢总控管理器 (Multi-Device Brain Manager)
 *
 * 遵循中枢执行计划第 3、11、13 节与 R1/B4 门禁：
 * 1. 显式装配默认任务注册表 (F01)：默认注入真实业务适配器 (task-adapters.js)，严禁空适配器伪造成功。
 * 2. 管理所有云手机设备会话与其对应的 DeviceActor 实例。
 * 3. 动态配置分发 (F16)：当全局或设备配置更新时，同步通知受管 Actor 应用新配置。
 */

const { BrainStore, DEFAULT_BRAIN_DB_PATH } = require('./store');
const { BrainScheduler } = require('./scheduler');
const { getEffectiveBrainConfig, saveBrainConfig } = require('./config');
const { DeviceActor } = require('./device-actor');
const { defaultArbiter } = require('../server/device-arbiter');
const { YunmomoClient } = require('../index');
const defaultTaskAdapters = require('./task-adapters');

class BrainManager {
  constructor(options = {}) {
    this.dbPath = options.dbPath || DEFAULT_BRAIN_DB_PATH;
    this.store = new BrainStore(this.dbPath);
    this.client = options.client || new YunmomoClient();
    this.actors = new Map(); // deviceId -> DeviceActor
    // 显式装配任务注册表，默认注入真实适配器实现 (F01)
    this.taskAdapters = { ...defaultTaskAdapters, ...(options.taskAdapters || {}) };
  }

  getActor(deviceId) {
    return this.actors.get(String(deviceId)) || null;
  }

  async startDevice(deviceId, options = {}) {
    if (options.mode !== undefined && !['plan','observe','draft','execute'].includes(options.mode)) throw Object.assign(new Error('Invalid mode'), { code: 'INVALID_MODE' });
    const id = String(deviceId);
    let actor = this.actors.get(id);
    if (actor && options.ownerUserId && actor.ownerUserId !== options.ownerUserId) {
      throw Object.assign(new Error('该设备已有其他用户的自动化会话'), { code: 'DEVICE_BUSY' });
    }

    if (!actor) {
      const config = getEffectiveBrainConfig(id);
      const scheduler = new BrainScheduler(this.store, config);
      const actorClient = options.accessToken
        ? new YunmomoClient({ token: options.accessToken }) : this.client;
      actor = new DeviceActor(id, this.store, scheduler, config, actorClient, this.taskAdapters);
      actor.ownerUserId = options.ownerUserId || null;
      this.actors.set(id, actor);
    } else {
      // 动态同步最新生效配置 (F16)
      actor.config = getEffectiveBrainConfig(id);
      actor.scheduler.config = actor.config;
    }

    actor.start(options);
    return this.getStatus(id);
  }

  async pauseDevice(deviceId) {
    const actor = this.getActor(deviceId);
    if (actor) {
      actor.pause();
    } else {
      this.store.upsertSession(deviceId, { desiredState: 'paused' });
    }
    return this.getStatus(deviceId);
  }

  async resumeDevice(deviceId, options = {}) {
    const actor = this.getActor(deviceId);
    if (actor && options.ownerUserId && actor.ownerUserId !== options.ownerUserId) {
      throw Object.assign(new Error('该设备已有其他用户的自动化会话'), { code: 'DEVICE_BUSY' });
    }
    if (actor) {
      // 动态同步最新生效配置 (F16)
      actor.config = getEffectiveBrainConfig(deviceId);
      actor.scheduler.config = actor.config;
      actor.resume();
    } else {
      this.store.updateSchedule(String(deviceId), 'device_guard', { quotaUsed: 0, cooldownUntil: 0 });
      await this.startDevice(deviceId, options);
    }
    return this.getStatus(deviceId);
  }

  async stopDevice(deviceId, reason = 'User requested stop') {
    const actor = this.getActor(deviceId);
    if (actor) {
      await actor.stop(reason);
      if (this.store.getSession(deviceId)?.actualState === 'stopped') this.actors.delete(String(deviceId));
    } else {
      this.store.upsertSession(deviceId, {
        desiredState: 'stopped',
        actualState: 'stopped',
        stoppedReason: reason
      });
    }
    return this.getStatus(deviceId);
  }

  async stopAll(reason = 'Brain shutdown') {
    const promises = Array.from(this.actors.values()).map(actor => actor.stop(reason));
    await Promise.all(promises);
    for (const [id] of this.actors) if (this.store.getSession(id)?.actualState === 'stopped') this.actors.delete(id);
  }

  getStatus(deviceId) {
    const id = String(deviceId);
    const session = this.store.getSession(id);
    const actor = this.getActor(id);
    const busy = defaultArbiter.isDeviceBusy(id);
    const quarantined = defaultArbiter.isDeviceQuarantined(id);
    const quarantineInfo = defaultArbiter.getQuarantineInfo(id);

    return {
      deviceId: id,
      running: Boolean(actor?.running),
      desiredState: session?.desiredState || 'stopped',
      actualState: session?.actualState || 'stopped',
      mode: session?.mode || 'observe',
      currentPhase: actor?.currentPhase || 'idle',
      busy,
      quarantined,
      quarantineInfo,
      updatedAt: session?.updatedAt || null
    };
  }

  getAllStatuses() {
    const sessions = this.store.getAllSessions();
    return sessions.map(sess => this.getStatus(sess.deviceId));
  }

  updateConfigAndNotify(updates = {}, expectedRevision = null, deviceId = null) {
    const saved = saveBrainConfig(updates, expectedRevision);
    if (deviceId) {
      const actor = this.getActor(deviceId);
      if (actor) {
        actor.config = getEffectiveBrainConfig(deviceId);
        actor.scheduler.config = actor.config;
        actor.taskAbort?.abort(new Error('Config updated'));
        this.store.upsertSession(String(deviceId), { configRevision: saved.revision, ...(updates.mode ? { mode: actor.config.mode } : {}) });
      }
    } else {
      for (const [id, actor] of this.actors.entries()) {
        actor.config = getEffectiveBrainConfig(id);
        actor.scheduler.config = actor.config;
        actor.taskAbort?.abort(new Error('Config updated'));
        this.store.upsertSession(id, { configRevision: saved.revision,
          ...((updates.mode || updates.deviceOverrides?.[id]?.mode) ? { mode: actor.config.mode } : {}) });
      }
    }
    return saved;
  }

  async close() {
    await this.stopAll();
    if (this.store.getAllSessions().some(session => session.actualState === 'needs_review' && defaultArbiter.isDeviceBusy(session.deviceId))) {
      throw Object.assign(new Error('Actor stop not acknowledged; preserving control store'), { code: 'SHUTDOWN_INCOMPLETE' });
    }
    this.store.close();
  }
}

let defaultBrainManager;
function getDefaultBrainManager(options = {}) { return defaultBrainManager ||= new BrainManager(options); }
module.exports = { BrainManager, getDefaultBrainManager };
Object.defineProperty(module.exports, 'defaultBrainManager', { get: getDefaultBrainManager });
