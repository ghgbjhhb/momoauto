'use strict';

/**
 * 调度中枢任务优先级与公平性调度器 (Brain Task Priority Scheduler)
 *
 * 遵循中枢执行计划第 9 节与 R5/B4 门禁：
 * 1. 严格优先级队列 (0 最高，6 最低)：
 *    - 0: 用户停止/人工接管/风控熔断阻断
 *    - 1: 发送/通过不确定性核验任务 (verify_uncertain)
 *    - 2: 已确认新来信自动回复 (reply)
 *    - 3: 到期消息列表快速巡检 (inspect_list)
 *    - 4: 分片全量巡检 (sweep_list)
 *    - 5: 用户启用的收到的招呼 (greetings)
 *    - 6: 用户启用的首页推荐浏览 (browse)
 * 2. 公平调度防饥饿 (T20, F17)：单人持续来信不能永久占满设备；一次只处理一位联系人的一个批次，随后必须让出执行权进行列表巡检。
 * 3. 冷却与配额检查：检查 taskType 是否在 cooldownUntil 冷却期内。
 */

const TASK_PRIORITIES = {
  emergency_stop: 0,
  manual_takeover: 0,
  verify_uncertain: 1,
  reply: 2,
  inspect_list: 3,
  sweep_list: 4,
  greetings: 5,
  browse: 6
};

class BrainScheduler {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.lastServedType = null;
  }

  claimNextFairTask(deviceId) {
    this.store.db.prepare("UPDATE brain_tasks SET state='failed' WHERE deviceId=? AND state='queued' AND deadline IS NOT NULL AND deadline<=?").run(deviceId, Date.now());
    const verification = this.store.db.prepare("SELECT id FROM brain_tasks WHERE deviceId=? AND state='queued' AND priority<=1 ORDER BY priority,createdAt LIMIT 1").get(deviceId);
    if (verification) return this.store.claimSpecificTask(verification.id);
    // 公平调度防饥饿 (T20, F17):
    // 若上一轮执行了回复任务，且当前有已到期的巡检任务，优先执行巡检一次，避免单人消息洪峰占满设备
    if (this.lastServedType === 'reply') {
      const pendingInspection = this.store.db.prepare(`
        SELECT * FROM brain_tasks
        WHERE deviceId = ? AND state = 'queued' AND type IN ('inspect_list', 'sweep_list')
        ORDER BY createdAt ASC LIMIT 1
      `).get(deviceId);

      if (pendingInspection) {
        const claimed = this.store.claimSpecificTask(pendingInspection.id);
        if (claimed) {
          this.lastServedType = claimed.type;
          return claimed;
        }
      }
    }

    const task = this.store.claimNextTask(deviceId);
    if (task) {
      this.lastServedType = task.type;
    }
    return task;
  }

  /**
   * 根据当前时钟与调度表，生成周期性到期任务
   *
   * @param {string} deviceId
   * @param {number} [nowMs=Date.now()]
   * @returns {Array<object>} 压入队列的到期任务列表
   */
  generateDueTasks(deviceId, nowMs = Date.now()) {
    const enqueued = [];
    const cfg = this.config;

    // 1. 检查快速巡检 (inspect_list)
    const fastPollSched = this.store.getSchedule(deviceId, 'fast_poll');
    const fastPollDue = fastPollSched?.dueAt ?? 0;
    if (nowMs >= fastPollDue) {
      const task = this.store.enqueueTask({
        deviceId,
        idempotencyKey: `inspect_list_${deviceId}_${Math.floor(nowMs / cfg.pollIntervalMs)}`,
        type: 'inspect_list',
        priority: TASK_PRIORITIES.inspect_list,
        deadline: nowMs + cfg.pollIntervalMs * 2
      });
      if (task) enqueued.push(task);

      this.store.updateSchedule(deviceId, 'fast_poll', {
        dueAt: nowMs + cfg.pollIntervalMs
      });
    }

    // 2. 检查覆盖巡检 (sweep_list)
    const sweepSched = this.store.getSchedule(deviceId, 'full_sweep');
    const sweepDue = sweepSched?.dueAt ?? 0;
    if (nowMs >= sweepDue) {
      const task = this.store.enqueueTask({
        deviceId,
        idempotencyKey: `sweep_list_${deviceId}_${Math.floor(nowMs / cfg.fullSweepIntervalMs)}`,
        type: 'sweep_list',
        priority: TASK_PRIORITIES.sweep_list,
        deadline: nowMs + cfg.fullSweepIntervalMs
      });
      if (task) enqueued.push(task);

      this.store.updateSchedule(deviceId, 'full_sweep', {
        dueAt: nowMs + cfg.fullSweepIntervalMs
      });
    }

    // 3. 检查空闲任务：收到的招呼 (greetings)
    if (cfg.greetingsEnabled) {
      const greetSched = this.store.getSchedule(deviceId, 'greetings');
      const greetDue = greetSched?.dueAt ?? 0;
      const greetCooldown = greetSched?.cooldownUntil ?? 0;

      if (nowMs >= greetDue && nowMs >= greetCooldown) {
        const task = this.store.enqueueTask({
          deviceId,
          idempotencyKey: `greetings_${deviceId}_${Math.floor(nowMs / cfg.greetingsIntervalMs)}`,
          type: 'greetings',
          priority: TASK_PRIORITIES.greetings,
          deadline: nowMs + cfg.greetingsIntervalMs
        });
        if (task) enqueued.push(task);

        this.store.updateSchedule(deviceId, 'greetings', {
          dueAt: nowMs + cfg.greetingsIntervalMs
        });
      }
    }

    // 4. 检查空闲任务：首页动态浏览 (browse)
    if (cfg.browseEnabled) {
      const browseSched = this.store.getSchedule(deviceId, 'browse');
      const browseDue = browseSched?.dueAt ?? 0;
      const browseCooldown = browseSched?.cooldownUntil ?? 0;

      if (nowMs >= browseDue && nowMs >= browseCooldown) {
        const task = this.store.enqueueTask({
          deviceId,
          idempotencyKey: `browse_${deviceId}_${Math.floor(nowMs / cfg.browseIntervalMs)}`,
          type: 'browse',
          priority: TASK_PRIORITIES.browse,
          deadline: nowMs + cfg.browseIntervalMs
        });
        if (task) enqueued.push(task);

        this.store.updateSchedule(deviceId, 'browse', {
          dueAt: nowMs + cfg.browseIntervalMs
        });
      }
    }

    return enqueued;
  }

  /**
   * 压入待回复联系人任务 (reply)
   */
  enqueueReplyTask(deviceId, contactName, triggerSeq) {
    return this.store.enqueueTask({
      deviceId,
      idempotencyKey: `reply_${JSON.stringify([deviceId, contactName])}`,
      type: 'reply',
      priority: TASK_PRIORITIES.reply,
      checkpointJson: { contactName, triggerSeq }
    });
  }

  /**
   * 压入不确定性核验任务 (verify_uncertain)
   */
  enqueueVerifyTask(deviceId, replyJobId) {
    return this.store.enqueueTask({
      deviceId,
      idempotencyKey: `verify_${deviceId}_${replyJobId}`,
      type: 'verify_uncertain',
      priority: TASK_PRIORITIES.verify_uncertain,
      replyJobId
    });
  }
}

module.exports = {
  TASK_PRIORITIES,
  BrainScheduler
};
