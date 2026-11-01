'use strict';

/**
 * MOMO 调度中枢控制数据库 (Brain Control Store)
 *
 * 遵循中枢执行计划第 14 节与 B4 门禁：
 * 1. 独立调度数据库：.runtime/momo-brain/control.sqlite，仅存调度计划、会话状态与任务引用；聊天内容仍留在各自设备 ReplyStore 中。
 * 2. 任务幂等：使用 idempotencyKey 唯一约束，同周期任务合并，不无限制堆积。
 * 3. 严格短事务：认领最高优先级任务、状态更新与游标修改在事务内原子完成。
 * 4. 崩溃恢复索引：记录未完成任务、配额及冷却状态，重启可恢复追踪。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { BRAIN_DIR } = require('./config');

const DEFAULT_BRAIN_DB_PATH = path.join(BRAIN_DIR, 'control.sqlite');

class BrainStore {
  constructor(dbPath = DEFAULT_BRAIN_DB_PATH, options = {}) {
    this.dbPath = dbPath;
    this.closed = false;

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false });
    if (!options.readOnly) {
      this.initSchema();
    }
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS brain_sessions (
        deviceId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 1,
        mode TEXT NOT NULL DEFAULT 'observe',
        desiredState TEXT NOT NULL DEFAULT 'running', -- running | paused | stopped
        actualState TEXT NOT NULL DEFAULT 'idle',     -- idle | observing | replying | browsing | greetings | recovering | paused_manual | cooldown | needs_review | stopped
        configRevision INTEGER NOT NULL DEFAULT 1,
        stoppedReason TEXT,
        updatedAt TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS brain_schedules (
        id TEXT PRIMARY KEY,
        deviceId TEXT NOT NULL,
        taskType TEXT NOT NULL, -- fast_poll | full_sweep | browse | greetings
        dueAt INTEGER NOT NULL DEFAULT 0,
        cooldownUntil INTEGER NOT NULL DEFAULT 0,
        quotaUsed INTEGER NOT NULL DEFAULT 0,
        quotaLimit INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(deviceId, taskType)
      );

      CREATE TABLE IF NOT EXISTS brain_tasks (
        id TEXT PRIMARY KEY,
        deviceId TEXT NOT NULL,
        idempotencyKey TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,     -- reply | inspect_list | sweep_list | browse | greetings | verify_uncertain
        priority INTEGER NOT NULL DEFAULT 3, -- 0=highest, 6=lowest
        state TEXT NOT NULL DEFAULT 'queued', -- queued | running | completed | failed | cancelled | yielded | needs_review
        attempts INTEGER NOT NULL DEFAULT 0,
        deadline INTEGER,
        checkpointJson TEXT,
        replyJobId TEXT,
        createdAt TEXT DEFAULT (datetime('now', 'localtime')),
        updatedAt TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_brain_tasks_priority ON brain_tasks(deviceId, state, priority, createdAt);

      CREATE TABLE IF NOT EXISTS brain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deviceId TEXT NOT NULL,
        eventType TEXT NOT NULL,
        detailsJson TEXT,
        createdAt TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_brain_events_device ON brain_events(deviceId, id);
    `);
  }

  upsertSession(deviceId, data = {}) {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT * FROM brain_sessions WHERE deviceId = ?').get(deviceId);

    if (existing) {
      this.db.prepare(`
        UPDATE brain_sessions
        SET sessionId = COALESCE(?, sessionId),
            epoch = COALESCE(?, epoch),
            mode = COALESCE(?, mode),
            desiredState = COALESCE(?, desiredState),
            actualState = COALESCE(?, actualState),
            configRevision = COALESCE(?, configRevision),
            stoppedReason = COALESCE(?, stoppedReason),
            updatedAt = ?
        WHERE deviceId = ?
      `).run(
        data.sessionId ?? null,
        data.epoch ?? null,
        data.mode ?? null,
        data.desiredState ?? null,
        data.actualState ?? null,
        data.configRevision ?? null,
        data.stoppedReason ?? null,
        now,
        deviceId
      );
    } else {
      this.db.prepare(`
        INSERT INTO brain_sessions (deviceId, sessionId, epoch, mode, desiredState, actualState, configRevision, stoppedReason, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceId,
        data.sessionId || 'sess_' + randomUUID().replace(/-/g, ''),
        data.epoch || 1,
        data.mode || 'observe',
        data.desiredState || 'running',
        data.actualState || 'idle',
        data.configRevision || 1,
        data.stoppedReason || null,
        now
      );
    }

    return this.getSession(deviceId);
  }

  getSession(deviceId) {
    return this.db.prepare('SELECT * FROM brain_sessions WHERE deviceId = ?').get(deviceId);
  }

  getAllSessions() {
    return this.db.prepare('SELECT * FROM brain_sessions').all();
  }

  /**
   * 压入任务，幂等去重
   */
  enqueueTask(taskData) {
    const id = taskData.id || 'task_' + randomUUID().replace(/-/g, '');
    const now = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM brain_tasks WHERE idempotencyKey = ?').get(taskData.idempotencyKey);
      if (existing) {
        if (['queued', 'running'].includes(existing.state)) {
          this.db.exec('COMMIT');
          return existing;
        }
        // 前序任务已处于终态 (completed, failed, cancelled)
        // 归档旧任务的 idempotencyKey，允许新一轮候选任务入队并重新核验
        this.db.prepare('UPDATE brain_tasks SET idempotencyKey = ? WHERE id = ?')
          .run(`${taskData.idempotencyKey}_archived_${existing.id}`, existing.id);
      }

      this.db.prepare(`
        INSERT INTO brain_tasks (id, deviceId, idempotencyKey, type, priority, state, attempts, deadline, checkpointJson, replyJobId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
      `).run(
        id,
        taskData.deviceId,
        taskData.idempotencyKey,
        taskData.type,
        taskData.priority ?? 3,
        taskData.deadline || null,
        taskData.checkpointJson ? JSON.stringify(taskData.checkpointJson) : null,
        taskData.replyJobId || null,
        now,
        now
      );

      this.db.exec('COMMIT');
      return this.db.prepare('SELECT * FROM brain_tasks WHERE id = ?').get(id);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 原子事务认领最高优先级任务
   */
  claimSpecificTask(taskId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare("SELECT * FROM brain_tasks WHERE id = ? AND state = 'queued'").get(taskId);
      if (!task) {
        this.db.exec('COMMIT');
        return null;
      }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE brain_tasks SET state = 'running', attempts = attempts + 1, updatedAt = ? WHERE id = ?").run(now, taskId);
      this.db.exec('COMMIT');
      return this.db.prepare("SELECT * FROM brain_tasks WHERE id = ?").get(taskId);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  reconcileInterruptedTasks(deviceId) {
    // Observation is repeatable. Other interrupted actions require review, not replay.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const tasks = this.db.prepare("SELECT * FROM brain_tasks WHERE deviceId=? AND state='running'").all(deviceId);
      for (const task of tasks) {
        const state = ['inspect_list', 'sweep_list', 'verify_uncertain'].includes(task.type) ? 'queued' : 'needs_review';
        this.updateTaskState(task.id, 'running', state, { checkpointJson: { reason: 'process_interrupted', previousCheckpoint: task.checkpointJson } });
      }
      this.db.exec('COMMIT');
      return tasks.length;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  claimNextTask(deviceId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 优先级升序 (0 最高，6 最低)，创建时间升序
      const task = this.db.prepare(`
        SELECT * FROM brain_tasks
        WHERE deviceId = ? AND state = 'queued'
        ORDER BY priority ASC, createdAt ASC
        LIMIT 1
      `).get(deviceId);

      if (!task) {
        this.db.exec('COMMIT');
        return null;
      }

      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE brain_tasks
        SET state = 'running',
            attempts = attempts + 1,
            updatedAt = ?
        WHERE id = ? AND state = 'queued'
      `).run(now, task.id);

      this.db.exec('COMMIT');
      return this.db.prepare('SELECT * FROM brain_tasks WHERE id = ?').get(task.id);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  updateTaskState(taskId, expectedState, newState, updates = {}) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE brain_tasks
      SET state = ?,
          checkpointJson = COALESCE(?, checkpointJson),
          replyJobId = COALESCE(?, replyJobId),
          updatedAt = ?
      WHERE id = ? AND state = ?
    `).run(
      newState,
      updates.checkpointJson ? JSON.stringify(updates.checkpointJson) : null,
      updates.replyJobId || null,
      now,
      taskId,
      expectedState
    );

    return result.changes > 0;
  }

  recordEvent(deviceId, eventType, details = {}) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO brain_events (deviceId, eventType, detailsJson, createdAt)
      VALUES (?, ?, ?, ?)
    `).run(deviceId, eventType, JSON.stringify(details), now);
  }

  getLatestEventId(deviceId) {
    return this.db.prepare('SELECT MAX(id) AS id FROM brain_events WHERE deviceId = ?')
      .get(deviceId)?.id || 0;
  }

  getRecentEvents(deviceId, limit = 50, afterId = 0) {
    return this.db.prepare(`
      SELECT * FROM brain_events
      WHERE deviceId = ? AND id > ?
      ORDER BY id DESC
      LIMIT ?
    `).all(deviceId, afterId, limit);
  }

  updateSchedule(deviceId, taskType, data = {}) {
    const existing = this.getSchedule(deviceId, taskType);
    const now = new Date().toISOString();
    const schedId = `sched_${deviceId}_${taskType}`;

    const dueAt = data.dueAt !== undefined ? data.dueAt : (existing?.dueAt ?? 0);
    const cooldownUntil = data.cooldownUntil !== undefined ? data.cooldownUntil : (existing?.cooldownUntil ?? 0);
    const quotaUsed = data.quotaUsed !== undefined ? data.quotaUsed : (existing?.quotaUsed ?? 0);
    const quotaLimit = data.quotaLimit !== undefined ? data.quotaLimit : (existing?.quotaLimit ?? 0);

    this.db.prepare(`
      INSERT INTO brain_schedules (id, deviceId, taskType, dueAt, cooldownUntil, quotaUsed, quotaLimit, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deviceId, taskType) DO UPDATE SET
        dueAt = excluded.dueAt,
        cooldownUntil = excluded.cooldownUntil,
        quotaUsed = excluded.quotaUsed,
        quotaLimit = excluded.quotaLimit,
        updatedAt = excluded.updatedAt
    `).run(
      schedId,
      deviceId,
      taskType,
      dueAt,
      cooldownUntil,
      quotaUsed,
      quotaLimit,
      now
    );

    return this.getSchedule(deviceId, taskType);
  }

  getSchedule(deviceId, taskType) {
    return this.db.prepare(`
      SELECT * FROM brain_schedules
      WHERE deviceId = ? AND taskType = ?
    `).get(deviceId, taskType);
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

module.exports = {
  BrainStore,
  DEFAULT_BRAIN_DB_PATH
};
