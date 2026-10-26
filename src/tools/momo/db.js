'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { isTimestampText, isFollowBannerText, isChatStatusBannerText, isSystemNoticeText } = require('./chat-detail-parser');
const { sameMessage } = require('./chat-history-sync');

const DEFAULT_DB_DIR = path.join(PROJECT_ROOT, '.runtime', 'momo-data');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'momo.sqlite');

const instances = new Map();

function getDeviceDatabasePath(deviceId) {
  if (typeof deviceId !== 'string' || !deviceId.trim() || /[\r\n\0]/.test(deviceId)) {
    throw new TypeError('A deviceId is required to select a MOMO database');
  }
  const id = deviceId.trim();
  const key = /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : createHash('sha256').update(id).digest('hex');
  return path.join(DEFAULT_DB_DIR, 'devices', 'device-' + key, 'momo.sqlite');
}

/**
 * 基于最长公共子序列 (LCS) 的消息序列拓扑对齐、自愈与幂等合并 (Reconciliation)
 *
 * 遵循《自动化工程核心工作守则》三态幂等性契约：
 * 1. 无论对同一联系人重复执行多少次同步，完全重叠的消息绝对不会重复入库；
 * 2. 向上回溯更早历史消息时，自动作为前置历史（Header Prepend）；
 * 3. 向下增量拉取新消息时，自动作为尾部追加（Tail Append）；
 * 4. 容忍历史数据中途中断或单条漏采（Gap），能够自动拓扑定位并自愈补全；
 * 5. 严格保持消息从最早到最新的时间拓扑单调性。
 */
function reconcileMessageSequences(existing = [], incoming = []) {
  if (!incoming.length) {
    return {
      merged: existing.map(m => ({ ...m })),
      addedCount: 0,
      hasPrependOrGap: false,
    };
  }
  if (!existing.length) {
    return {
      merged: incoming.map(m => ({ ...m })),
      addedCount: incoming.length,
      hasPrependOrGap: false,
    };
  }

  const m = existing.length;
  const n = incoming.length;

  // dp[i][j] 表示 existing[0..i-1] 与 incoming[0..j-1] 的 LCS 长度
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (sameMessage(existing[i - 1], incoming[j - 1]) && existing[i - 1].sender === incoming[j - 1].sender) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯找出匹配对 (eIndex, iIndex)
  const matchedPairs = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (sameMessage(existing[i - 1], incoming[j - 1]) && existing[i - 1].sender === incoming[j - 1].sender) {
      matchedPairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i][j - 1] >= dp[i - 1][j]) {
      // 关键拓扑不变量：当存在等权公共子序列分支时，优先缩减 incoming (j--)，
      // 这保证了在多实例同内容消息场景下，优先匹配与上下文最紧凑、最贴近当前时序的尾部实例（Compact/Recency Preference），
      // 严禁跳跃回溯穿透到远古历史导致新消息时空颠倒倒流！
      j--;
    } else {
      i--;
    }
  }
  matchedPairs.reverse();

  // 若无任何公共子序列重叠，按全新追加处理
  if (matchedPairs.length === 0) {
    return {
      merged: [...existing.map(m => ({ ...m })), ...incoming.map(m => ({ ...m }))],
      addedCount: incoming.length,
      hasPrependOrGap: false,
    };
  }

  const merged = [];
  let addedCount = 0;
  let hasPrependOrGap = false;

  let lastE = 0;
  let lastI = 0;

  for (const [eIdx, iIdx] of matchedPairs) {
    // 1. 处理匹配点之前 incoming 中的新增消息 (前置历史 Header 或中间漏采 Gap)
    while (lastI < iIdx) {
      merged.push({ ...incoming[lastI] });
      addedCount++;
      hasPrependOrGap = true;
      lastI++;
    }

    // 2. 处理匹配点之前 existing 中的已有消息
    while (lastE < eIdx) {
      merged.push({ ...existing[lastE] });
      lastE++;
    }

    // 3. 放入当前匹配的消息 (保留已有的 id / createdAt，补全缺失的 time)
    const existingMsg = existing[eIdx];
    const incomingMsg = incoming[iIdx];
    merged.push({
      ...existingMsg,
      time: existingMsg.time || incomingMsg.time || '',
    });

    lastE = eIdx + 1;
    lastI = iIdx + 1;
  }

  // 处理最后一个匹配点之后的剩余项
  while (lastE < m) {
    merged.push({ ...existing[lastE] });
    lastE++;
  }

  while (lastI < n) {
    merged.push({ ...incoming[lastI] });
    addedCount++;
    lastI++;
  }

  return { merged, addedCount, hasPrependOrGap };
}

function findNewMessages(existing = [], incoming = []) {
  const { merged, addedCount } = reconcileMessageSequences(existing, incoming);
  if (addedCount === 0) return [];
  return merged.filter(m => !m.id);
}

class MomoDatabase {
  constructor(dbPath = DEFAULT_DB_PATH, options = {}) {
    this.dbPath = dbPath;
    this.closed = false;
    if (!options.readOnly && dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false });
    try {
      if (!options.readOnly) this.init();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  init() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        deviceId TEXT,
        lastMessage TEXT,
        lastMessageTime TEXT,
        syncedAt TEXT,
        createdAt TEXT DEFAULT (datetime('now', 'localtime')),
        updatedAt TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contactId INTEGER NOT NULL,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        time TEXT DEFAULT '',
        createdAt TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (contactId) REFERENCES contacts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
      CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contactId);
    `);
  }

  getContactByName(name) {
    if (!name || typeof name !== 'string') return null;
    const stmt = this.db.prepare('SELECT * FROM contacts WHERE name = ?');
    return stmt.get(name.trim());
  }

  getContactById(id) {
    if (!id) return null;
    const stmt = this.db.prepare('SELECT * FROM contacts WHERE id = ?');
    return stmt.get(id);
  }

  upsertContact(contact) {
    if (!contact?.name) throw new Error('Contact name is required');
    const name = contact.name.trim();
    const existing = this.getContactByName(name);
    const now = new Date().toISOString();

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE contacts
        SET deviceId = COALESCE(?, deviceId),
            lastMessage = COALESCE(?, lastMessage),
            lastMessageTime = COALESCE(?, lastMessageTime),
            syncedAt = COALESCE(?, syncedAt),
            updatedAt = ?
        WHERE id = ?
      `);
      stmt.run(
        contact.deviceId ?? null,
        contact.lastMessage ?? null,
        contact.lastMessageTime ?? null,
        contact.syncedAt ?? null,
        now,
        existing.id
      );
      return this.getContactByName(name);
    }

    const stmt = this.db.prepare(`
      INSERT INTO contacts (name, deviceId, lastMessage, lastMessageTime, syncedAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      name,
      contact.deviceId ?? null,
      contact.lastMessage ?? null,
      contact.lastMessageTime ?? null,
      contact.syncedAt ?? null,
      now,
      now
    );
    return this.getContactByName(name);
  }

  saveMessages(contactId, contactName, messageList = []) {
    if (!contactId || !Array.isArray(messageList)) return 0;
    return this.transaction(() => this._appendNewMessages(contactId, messageList, true));
  }

  _appendNewMessages(contactId, messageList, verifiedConversation = false) {
    const validMessages = [];
    for (const msg of messageList) {
      if (!msg || !msg.text || !msg.sender) continue;
      const text = String(msg.text).trim();
      if (!text) continue;
      if (msg.isTimestamp || msg.isChatStatusBanner || msg.isPostCard || msg.isSystemNotice) continue;
      if (isFollowBannerText(text) || isChatStatusBannerText(text) || isTimestampText(text) || isSystemNoticeText(text)) continue;
      validMessages.push({
        sender: msg.sender,
        text,
        time: msg.time ?? '',
      });
    }
    if (!validMessages.length) return 0;

    const existing = this.db.prepare('SELECT id, contactId, sender, text, time, createdAt FROM messages WHERE contactId = ? ORDER BY id ASC').all(contactId);
    const { merged, addedCount, hasPrependOrGap } = reconcileMessageSequences(existing, validMessages);
    if (addedCount === 0) return 0;

    const now = new Date().toISOString();
    const insertStmt = this.db.prepare(`
      INSERT INTO messages (contactId, sender, text, time, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `);

    if (hasPrependOrGap) {
      // 存在前置历史补齐或中间漏采自愈：为了保持该联系人消息记录从最早到最新时序严格单调递增，
      // 在原子事务内刷新该联系人的有序消息，保证 ORDER BY id ASC 永远符合真实对话时间线
      this.db.prepare('DELETE FROM messages WHERE contactId = ?').run(contactId);
      for (const m of merged) {
        insertStmt.run(contactId, m.sender, m.text, m.time || '', m.createdAt || now);
      }
    } else {
      // 仅有尾部追加：直接追加新增项，保持既有数据不动
      const tailNew = merged.slice(existing.length);
      for (const m of tailNew) {
        insertStmt.run(contactId, m.sender, m.text, m.time || '', now);
      }
    }

    return addedCount;
  }

  completeContactSync(contact, messages, { verifiedConversation = false } = {}) {
    return this.transaction(() => {
      const existing = this.getContactByName(contact.name);
      const record = this.upsertContact(contact);
      const savedCount = this._appendNewMessages(record.id, messages, verifiedConversation);

      // 必须倒序提取最后一条合法的人类对话消息（严格排除系统提示与非对话文本）
      const validConversationMessages = (messages || []).filter(m =>
        ['peer', 'self'].includes(m.sender) &&
        m.text &&
        !m.isTimestamp && !m.isChatStatusBanner && !m.isPostCard && !m.isSystemNotice &&
        !isTimestampText(m.text) && !isChatStatusBannerText(m.text) && !isFollowBannerText(m.text) && !isSystemNoticeText(m.text)
      );
      const last = validConversationMessages.length ? validConversationMessages[validConversationMessages.length - 1] : null;

      const now = new Date().toISOString();
      const updateData = {
        name: record.name,
        syncedAt: now,
      };
      if (last?.text) {
        updateData.lastMessage = String(last.text).trim();
      }
      const completed = this.upsertContact(updateData);
      return { contact: completed, savedCount, isNew: !existing };
    });
  }

  getMessagesByContact(contactId) {
    if (!contactId) return [];
    const stmt = this.db.prepare('SELECT id, contactId, sender, text, time, createdAt FROM messages WHERE contactId = ? ORDER BY id ASC');
    return stmt.all(contactId);
  }

  getMessagesByContactName(name) {
    if (!name || typeof name !== 'string') return [];
    const contact = this.getContactByName(name);
    if (!contact) return [];
    return this.getMessagesByContact(contact.id);
  }

  listContacts(limit = 100) {
    const stmt = this.db.prepare('SELECT * FROM contacts ORDER BY updatedAt DESC LIMIT ?');
    return stmt.all(limit);
  }

  deleteContact(contactId) {
    if (!contactId) return false;
    const stmt = this.db.prepare('DELETE FROM contacts WHERE id = ?');
    const res = stmt.run(contactId);
    return res.changes > 0;
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
    if (instances.get(this.dbPath) === this) instances.delete(this.dbPath);
  }
}

function getMomoDatabase(dbPath = DEFAULT_DB_PATH) {
  if (!instances.has(dbPath)) instances.set(dbPath, new MomoDatabase(dbPath));
  return instances.get(dbPath);
}

module.exports = {
  MomoDatabase,
  getMomoDatabase,
  DEFAULT_DB_PATH,
  getDeviceDatabasePath,
  findNewMessages,
  reconcileMessageSequences,
};
