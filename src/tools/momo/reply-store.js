'use strict';

/**
 * MOMO AI 专用增量回复数据仓储 (AI Reply Store)
 *
 * 遵循计划第 8.2 节与 P1 门禁：
 * 1. 在每台设备独立数据库 (momo.sqlite) 中创建专用 AI 表，不修改 legacy 旧表结构与唯一约束。
 * 2. 区分旧归档历史导入与 live 新增增量，按递增 seq 保证消息严格有序。
 * 3. 严格短事务：增量保存、状态更新、游标推进和 Job 状态机流转均在原子事务内执行。
 * 4. 防串扰：隔离 deviceId、accountScope、conversationId。
 */

const { randomUUID, createHash } = require('node:crypto');
const { MomoDatabase } = require('./db');
const { isConversationMessage } = require('./chat-detail-parser');

class ReplyStore {
  /**
   * @param {MomoDatabase|object} momoDb - MomoDatabase 实例或包含 .db 的包装器
   */
  constructor(momoDb) {
    if (!momoDb || !momoDb.db) {
      throw new TypeError('A valid MomoDatabase instance with an active .db is required');
    }
    this.momoDb = momoDb;
    this.db = momoDb.db;
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_schema_migrations (
        version INTEGER PRIMARY KEY,
        appliedAt TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS ai_conversations (
        id TEXT PRIMARY KEY,
        deviceId TEXT NOT NULL,
        accountScope TEXT NOT NULL DEFAULT 'default',
        contactId INTEGER,
        contactName TEXT NOT NULL,
        baselineState TEXT NOT NULL DEFAULT 'uninitialized',
        legacyWatermark INTEGER DEFAULT 0,
        contextVersion INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT DEFAULT (datetime('now', 'localtime')),
        updatedAt TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(deviceId, accountScope, contactName)
      );
      CREATE INDEX IF NOT EXISTS idx_ai_conversations_lookup ON ai_conversations(deviceId, contactName);

      CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        sender TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        rawText TEXT NOT NULL,
        time TEXT DEFAULT '',
        source TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        createdAt TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(conversationId, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_ai_messages_conv_seq ON ai_messages(conversationId, seq);

      CREATE TABLE IF NOT EXISTS ai_conversation_state (
        conversationId TEXT PRIMARY KEY,
        lastObservedSeq INTEGER NOT NULL DEFAULT 0,
        handledThroughSeq INTEGER NOT NULL DEFAULT 0,
        pendingBatchJson TEXT,
        updatedAt TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS ai_reply_jobs (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        triggerStartSeq INTEGER NOT NULL,
        triggerEndSeq INTEGER NOT NULL,
        inputDigest TEXT,
        contextVersion INTEGER NOT NULL,
        configRevision INTEGER NOT NULL DEFAULT 1,
        replyText TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        sendAttempts INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        error TEXT,
        createdAt TEXT DEFAULT (datetime('now', 'localtime')),
        updatedAt TEXT DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_ai_jobs_conv ON ai_reply_jobs(conversationId);

      INSERT OR IGNORE INTO ai_schema_migrations (version) VALUES (1);
    `);
    if (!this.db.prepare('PRAGMA table_info(ai_reply_jobs)').all().some(row => row.name === 'sendEvidenceJson')) {
      this.db.exec('ALTER TABLE ai_reply_jobs ADD COLUMN sendEvidenceJson TEXT');
    }
  }

  getOrCreateConversation(deviceId, contactName, options = {}) {
    if (!deviceId || typeof deviceId !== 'string') throw new TypeError('deviceId is required');
    if (!contactName || typeof contactName !== 'string') throw new TypeError('contactName is required');

    const accountScope = options.accountScope || 'default';
    const trimmedName = contactName.trim();

    const existing = this.db.prepare(`
      SELECT * FROM ai_conversations
      WHERE deviceId = ? AND accountScope = ? AND contactName = ?
    `).get(deviceId, accountScope, trimmedName);

    if (existing) return existing;

    const legacyContact = this.momoDb.getContactByName ? this.momoDb.getContactByName(trimmedName) : null;
    const convId = 'conv_' + randomUUID().replace(/-/g, '');
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO ai_conversations (id, deviceId, accountScope, contactId, contactName, baselineState, contextVersion, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, 'uninitialized', 1, ?, ?)
    `).run(convId, deviceId, accountScope, legacyContact?.id ?? null, trimmedName, now, now);

    this.db.prepare(`
      INSERT OR IGNORE INTO ai_conversation_state (conversationId, lastObservedSeq, handledThroughSeq, updatedAt)
      VALUES (?, 0, 0, ?)
    `).run(convId, now);

    return this.db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(convId);
  }

  importLegacyBaseline(conversationId) {
    const conv = this.db.prepare('SELECT * FROM ai_conversations WHERE id = ?').get(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    if (conv.baselineState === 'baseline_ready') {
      const messages = this.db.prepare('SELECT sender, rawText FROM ai_messages WHERE conversationId = ?').all(conversationId);
      return { importedCount: messages.filter(isConversationMessage).length, alreadyInitialized: true };
    }

    let legacyMsgs = [];
    if (conv.contactId && this.momoDb.getMessagesByContact) {
      legacyMsgs = this.momoDb.getMessagesByContact(conv.contactId) || [];
    } else if (this.momoDb.getMessagesByContactName) {
      legacyMsgs = this.momoDb.getMessagesByContactName(conv.contactName) || [];
    }
    legacyMsgs = legacyMsgs.filter(isConversationMessage);

    let importedCount = 0;
    const now = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      let seq = 1;
      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO ai_messages (id, conversationId, seq, sender, type, rawText, time, source, confidence, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'legacy_import', 1.0, ?)
      `);

      for (const msg of legacyMsgs) {
        const msgId = 'msg_' + randomUUID().replace(/-/g, '');
        insertStmt.run(
          msgId,
          conversationId,
          seq,
          msg.sender || 'peer',
          msg.type || 'text',
          msg.text || '',
          msg.time || '',
          now
        );
        seq++;
        importedCount++;
      }

      const lastSeq = seq - 1;
      this.db.prepare(`
        UPDATE ai_conversations
        SET baselineState = 'baseline_ready',
            legacyWatermark = ?,
            updatedAt = ?
        WHERE id = ?
      `).run(importedCount, now, conversationId);

      // The imported messages are context, not an instruction to skip the
      // current reply.  Keep the observation cursor for diagnostics, but do
      // not advance the reply cursor during initialization.  The one-shot
      // reply workflow decides from the current last message on every call.
      this.db.prepare(`
        UPDATE ai_conversation_state
        SET lastObservedSeq = ?,
            updatedAt = ?
        WHERE conversationId = ?
      `).run(lastSeq, now, conversationId);

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { importedCount, alreadyInitialized: false };
  }

  getConversationMessages(conversationId, options = {}) {
    const limit = options.limit ? Math.min(options.limit, 1000) : 1000;
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM ai_messages
        WHERE conversationId = ?
        ORDER BY seq DESC
        LIMIT ?
      ) sub
      ORDER BY seq ASC
    `).all(conversationId, limit).filter(isConversationMessage);
  }

  getConversationState(conversationId) {
    return this.db.prepare('SELECT * FROM ai_conversation_state WHERE conversationId = ?').get(conversationId);
  }

  appendNewMessages(conversationId, newMessages = [], options = {}) {
    if (!Array.isArray(newMessages) || newMessages.length === 0) {
      return { addedCount: 0, lastSeq: 0 };
    }
    newMessages = newMessages.filter(isConversationMessage);
    if (!newMessages.length) return { addedCount: 0, lastSeq: 0 };

    const source = options.source || 'live_observed';
    const now = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const maxRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM ai_messages WHERE conversationId = ?').get(conversationId);
      let currentSeq = maxRow.maxSeq;

      const insertStmt = this.db.prepare(`
        INSERT INTO ai_messages (id, conversationId, seq, sender, type, rawText, time, source, confidence, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const msg of newMessages) {
        currentSeq++;
        const msgId = 'msg_' + randomUUID().replace(/-/g, '');
        insertStmt.run(
          msgId,
          conversationId,
          currentSeq,
          msg.sender || 'peer',
          msg.type || 'text',
          msg.rawText || msg.text || '',
          msg.time || '',
          source,
          msg.confidence ?? 1.0,
          now
        );
      }

      this.db.prepare(`
        UPDATE ai_conversations
        SET contextVersion = contextVersion + 1,
            updatedAt = ?
        WHERE id = ?
      `).run(now, conversationId);

      this.db.prepare(`
        UPDATE ai_conversation_state
        SET lastObservedSeq = ?,
            updatedAt = ?
        WHERE conversationId = ?
      `).run(currentSeq, now, conversationId);

      this.db.exec('COMMIT');
      return { addedCount: newMessages.length, lastSeq: currentSeq };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  createReplyJob(conversationId, {
    triggerStartSeq,
    triggerEndSeq,
    inputDigest,
    contextVersion,
    configRevision,
    forceNew = false,
  }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const existing = forceNew ? null : this.db.prepare(`SELECT * FROM ai_reply_jobs WHERE conversationId=? AND triggerStartSeq=? AND triggerEndSeq=?
      AND COALESCE(inputDigest,'')=? ORDER BY CASE WHEN state IN ('send_attempted','uncertain','own_bubble_observed') THEN 0 ELSE 1 END, createdAt LIMIT 1`)
      .get(conversationId, triggerStartSeq, triggerEndSeq, inputDigest || '');
    if (existing) { this.db.exec('COMMIT'); return existing; }
    const jobId = forceNew
      ? 'job_' + randomUUID().replace(/-/g, '')
      : 'job_' + createHash('sha256').update(JSON.stringify([conversationId, triggerStartSeq, triggerEndSeq, inputDigest || ''])).digest('hex');
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO ai_reply_jobs (id, conversationId, triggerStartSeq, triggerEndSeq, inputDigest, contextVersion, configRevision, state, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      jobId,
      conversationId,
      triggerStartSeq,
      triggerEndSeq,
      inputDigest || null,
      contextVersion || 1,
      configRevision || 1,
      now,
      now
    );

    this.db.prepare('UPDATE ai_conversation_state SET pendingBatchJson=? WHERE conversationId=?')
      .run(JSON.stringify({ jobId, triggerStartSeq, triggerEndSeq }), conversationId);
    this.db.exec('COMMIT');
    return this.getReplyJob(jobId);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getReplyJob(jobId) {
    return this.db.prepare('SELECT * FROM ai_reply_jobs WHERE id = ?').get(jobId);
  }

  updateReplyJobState(jobId, expectedState, newState, updates = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE ai_reply_jobs
      SET state = ?,
          replyText = COALESCE(?, replyText),
          outcome = COALESCE(?, outcome),
          sendEvidenceJson = COALESCE(?, sendEvidenceJson),
          error = COALESCE(?, error),
          sendAttempts = sendAttempts + (CASE WHEN ? = 'send_attempted' THEN 1 ELSE 0 END),
          updatedAt = ?
      WHERE id = ? AND state = ?
    `).run(
      newState,
      updates.replyText || null,
      updates.outcome || null,
      updates.sendEvidence ? JSON.stringify(updates.sendEvidence) : null,
      updates.error || null,
      newState,
      now,
      jobId,
      expectedState
    );

    if (result.changes > 0 && newState === 'own_bubble_observed') {
      const job = this.getReplyJob(jobId);
      this.db.prepare(`UPDATE ai_conversation_state SET handledThroughSeq=MAX(handledThroughSeq,?), pendingBatchJson=NULL, updatedAt=? WHERE conversationId=?`)
        .run(job.triggerEndSeq, now, job.conversationId);
    }
    this.db.exec('COMMIT');
    return result.changes > 0;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

module.exports = { ReplyStore };
