'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { PROJECT_ROOT } = require('../../automation/runtime');

const AUTH_DB_DIR = path.join(PROJECT_ROOT, '.runtime', 'auth-system');
const AUTH_DB_PATH = path.join(AUTH_DB_DIR, 'management.sqlite');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

class AuthDatabase {
  constructor(dbPath = AUTH_DB_PATH) {
    ensureDir(path.dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        card_code TEXT UNIQUE NOT NULL,
        duration_days INTEGER NOT NULL DEFAULT 0,
        duration_hours INTEGER NOT NULL DEFAULT 0,
        card_types TEXT NOT NULL DEFAULT '["cloud"]',
        card_contents TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'unused',
        batch_tag TEXT DEFAULT '',
        created_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by_user_id TEXT,
        FOREIGN KEY(used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS device_allocations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT,
        card_id TEXT,
        allocated_at INTEGER NOT NULL,
        expire_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS user_entitlements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        expire_at INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS redemption_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        card_code TEXT NOT NULL,
        redeemed_types TEXT NOT NULL,
        redeemed_summary TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}',
        redeemed_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sms_records (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'xuanwu',
        project_code TEXT,
        project_name TEXT,
        phone_number TEXT NOT NULL,
        session_id TEXT NOT NULL,
        sms_code TEXT,
        status TEXT NOT NULL DEFAULT 'waiting',
        raw_message TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sms_call_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        caller TEXT DEFAULT '脚本调用',
        phone_number TEXT DEFAULT '',
        session_id TEXT DEFAULT '',
        sms_code TEXT DEFAULT '',
        status TEXT NOT NULL,
        status_code TEXT DEFAULT '',
        latency_ms INTEGER DEFAULT 0,
        request_url TEXT DEFAULT '',
        request_params TEXT DEFAULT '{}',
        response_data TEXT DEFAULT '{}',
        error_message TEXT DEFAULT '',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_cards_code ON cards(card_code);
      CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
      CREATE INDEX IF NOT EXISTS idx_allocations_user ON device_allocations(user_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_device ON device_allocations(device_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_status ON device_allocations(status);
      CREATE INDEX IF NOT EXISTS idx_entitlements_user_type ON user_entitlements(user_id, type);
      CREATE INDEX IF NOT EXISTS idx_redemption_user ON redemption_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_sms_created ON sms_records(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_records(phone_number);
      CREATE INDEX IF NOT EXISTS idx_sms_session ON sms_records(session_id);
      CREATE INDEX IF NOT EXISTS idx_sms_logs_created ON sms_call_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sms_logs_phone ON sms_call_logs(phone_number);
    `);

    // 平滑升级已有 cards 表字段
    try {
      const cardCols = this.db.prepare('PRAGMA table_info(cards)').all().map(c => c.name);
      if (!cardCols.includes('card_types')) {
        this.db.exec(`ALTER TABLE cards ADD COLUMN card_types TEXT NOT NULL DEFAULT '["cloud"]'`);
      }
      if (!cardCols.includes('card_contents')) {
        this.db.exec(`ALTER TABLE cards ADD COLUMN card_contents TEXT NOT NULL DEFAULT '{}'`);
      }
    } catch {}
  }

  // --- System Config ---
  getConfig(key) {
    const stmt = this.db.prepare('SELECT value FROM system_config WHERE key = ?');
    const row = stmt.get(key);
    return row ? row.value : null;
  }

  setConfig(key, value) {
    const stmt = this.db.prepare(`
      INSERT INTO system_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, String(value));
  }

  // --- Users ---
  getUserByEmail(email) {
    const stmt = this.db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
    return stmt.get(email);
  }

  getUserById(id) {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id);
  }

  createUser({ id, email, passwordHash, passwordSalt, role = 'user', status = 'active' }) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, email, passwordHash, passwordSalt, role, status, now, now);
    return this.getUserById(id);
  }

  listUsers() {
    const stmt = this.db.prepare(`
      SELECT u.id, u.email, u.role, u.status, u.created_at, u.updated_at,
        (SELECT COUNT(1) FROM device_allocations a WHERE a.user_id = u.id AND a.status = 'active') AS active_devices
      FROM users u
      ORDER BY u.created_at DESC
    `);
    return stmt.all();
  }

  updateUserStatus(id, status) {
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?');
    stmt.run(status, now, id);
    return this.getUserById(id);
  }

  countAdmins() {
    const stmt = this.db.prepare("SELECT COUNT(1) AS cnt FROM users WHERE role = 'admin'");
    const row = stmt.get();
    return row ? row.cnt : 0;
  }

  // --- Cards ---
  createCards(cards) {
    const stmt = this.db.prepare(`
      INSERT INTO cards (id, card_code, duration_days, duration_hours, card_types, card_contents, status, batch_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const card of cards) {
      stmt.run(
        card.id,
        card.cardCode,
        card.durationDays || 0,
        card.durationHours || 0,
        typeof card.cardTypes === 'string' ? card.cardTypes : JSON.stringify(card.cardTypes || ['cloud']),
        typeof card.cardContents === 'string' ? card.cardContents : JSON.stringify(card.cardContents || {}),
        card.status || 'unused',
        card.batchTag || '',
        card.createdAt || now
      );
    }
  }

  getCardByCode(code) {
    const stmt = this.db.prepare('SELECT * FROM cards WHERE card_code = ?');
    return stmt.get(code);
  }

  getCardById(id) {
    const stmt = this.db.prepare('SELECT * FROM cards WHERE id = ?');
    return stmt.get(id);
  }

  markCardUsed(id, userId) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE cards SET status = 'used', used_at = ?, used_by_user_id = ?
      WHERE id = ? AND status = 'unused'
    `);
    const result = stmt.run(now, userId, id);
    return result.changes > 0;
  }

  revokeCard(id) {
    const stmt = this.db.prepare("UPDATE cards SET status = 'revoked' WHERE id = ? AND status = 'unused'");
    const result = stmt.run(id);
    return result.changes > 0;
  }

  listCards({ status, batchTag, type, limit = 200, offset = 0 } = {}) {
    let sql = `
      SELECT c.*, u.email as used_by_email
      FROM cards c
      LEFT JOIN users u ON c.used_by_user_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (status) {
      sql += ' AND c.status = ?';
      params.push(status);
    }
    if (batchTag) {
      sql += ' AND c.batch_tag = ?';
      params.push(batchTag);
    }
    if (type) {
      sql += ' AND c.card_types LIKE ?';
      params.push(`%"${type}"%`);
    }
    sql += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params);
  }

  // --- User Entitlements (真参、IP等权益) ---
  addZhencanQuota(userId, count, metadata = {}) {
    const now = Date.now();
    const num = Math.max(0, parseInt(count, 10) || 0);
    const existing = this.db.prepare("SELECT * FROM user_entitlements WHERE user_id = ? AND type = 'zhencan'").get(userId);
    if (existing) {
      const newAmount = Math.max(0, (existing.amount || 0) + num);
      this.db.prepare(`
        UPDATE user_entitlements SET amount = ?, updated_at = ?
        WHERE id = ?
      `).run(newAmount, now, existing.id);
      return newAmount;
    } else {
      const id = 'ent_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      this.db.prepare(`
        INSERT INTO user_entitlements (id, user_id, type, amount, expire_at, metadata, created_at, updated_at)
        VALUES (?, ?, 'zhencan', ?, 0, ?, ?, ?)
      `).run(id, userId, num, JSON.stringify(metadata), now, now);
      return num;
    }
  }

  getUserZhencanBalance(userId) {
    const row = this.db.prepare("SELECT amount FROM user_entitlements WHERE user_id = ? AND type = 'zhencan'").get(userId);
    return row ? (row.amount || 0) : 0;
  }

  addOrExtendIp(userId, durationDays, metadata = {}) {
    const now = Date.now();
    const days = Math.max(0, parseInt(durationDays, 10) || 0);
    const durationMs = days * 24 * 3600 * 1000;
    const existing = this.db.prepare("SELECT * FROM user_entitlements WHERE user_id = ? AND type = 'ip'").get(userId);

    let newExpireAt;
    if (existing && existing.expire_at > now) {
      // 在原到期时间上顺延
      newExpireAt = existing.expire_at + durationMs;
    } else {
      newExpireAt = now + durationMs;
    }

    if (existing) {
      this.db.prepare(`
        UPDATE user_entitlements SET expire_at = ?, updated_at = ?
        WHERE id = ?
      `).run(newExpireAt, now, existing.id);
    } else {
      const id = 'ent_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      this.db.prepare(`
        INSERT INTO user_entitlements (id, user_id, type, amount, expire_at, metadata, created_at, updated_at)
        VALUES (?, ?, 'ip', 1, ?, ?, ?, ?)
      `).run(id, userId, newExpireAt, JSON.stringify(metadata), now, now);
    }
    return newExpireAt;
  }

  getUserIpStatus(userId) {
    const now = Date.now();
    const row = this.db.prepare("SELECT expire_at FROM user_entitlements WHERE user_id = ? AND type = 'ip'").get(userId);
    if (!row || !row.expire_at || row.expire_at <= now) {
      return { active: false, expireAt: row?.expire_at || 0, remainingMs: 0 };
    }
    return {
      active: true,
      expireAt: row.expire_at,
      remainingMs: Math.max(0, row.expire_at - now)
    };
  }

  createRedemptionLog({ id, userId, cardId, cardCode, redeemedTypes, redeemedSummary, details = {} }) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO redemption_logs (id, user_id, card_id, card_code, redeemed_types, redeemed_summary, details, redeemed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      userId,
      cardId,
      cardCode,
      typeof redeemedTypes === 'string' ? redeemedTypes : JSON.stringify(redeemedTypes),
      redeemedSummary,
      typeof details === 'string' ? details : JSON.stringify(details),
      now
    );
  }

  getUserAssets(userId) {
    const zhencanBalance = this.getUserZhencanBalance(userId);
    const ipStatus = this.getUserIpStatus(userId);
    const activeAllocations = this.getActiveAllocationsForUser(userId);
    return {
      userId,
      zhencan: {
        count: zhencanBalance
      },
      ip: {
        active: ipStatus.active,
        expireAt: ipStatus.expireAt,
        remainingMs: ipStatus.remainingMs
      },
      activeDeviceCount: activeAllocations.length
    };
  }

  // --- Device Allocations ---
  createAllocation({ id, userId, deviceId, deviceName, cardId, allocatedAt, expireAt }) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO device_allocations (id, user_id, device_id, device_name, card_id, allocated_at, expire_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
    `);
    stmt.run(id, userId, deviceId, deviceName || '', cardId || null, allocatedAt || now, expireAt, now);
    return this.getAllocationById(id);
  }

  getAllocationById(id) {
    const stmt = this.db.prepare('SELECT * FROM device_allocations WHERE id = ?');
    return stmt.get(id);
  }

  getActiveAllocationsForUser(userId) {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT * FROM device_allocations
      WHERE user_id = ? AND status = 'active' AND expire_at > ?
      ORDER BY allocated_at DESC
    `);
    return stmt.all(userId, now);
  }

  getAllActiveAllocations() {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT a.*, u.email as user_email
      FROM device_allocations a
      JOIN users u ON a.user_id = u.id
      WHERE a.status = 'active' AND a.expire_at > ?
      ORDER BY a.allocated_at DESC
    `);
    return stmt.all(now);
  }

  getActiveAllocatedDeviceIds() {
    const now = Date.now();
    const stmt = this.db.prepare(`
      SELECT DISTINCT device_id FROM device_allocations
      WHERE status = 'active' AND expire_at > ?
    `);
    return stmt.all(now).map(row => row.device_id);
  }

  expireAndRecycleDevices(now = Date.now()) {
    // Find all that have expired
    const findStmt = this.db.prepare(`
      SELECT id, device_id, user_id FROM device_allocations
      WHERE status = 'active' AND expire_at <= ?
    `);
    const expired = findStmt.all(now);
    if (expired.length > 0) {
      const updateStmt = this.db.prepare(`
        UPDATE device_allocations SET status = 'recycled'
        WHERE status = 'active' AND expire_at <= ?
      `);
      updateStmt.run(now);
    }
    return expired;
  }

  recycleAllocationManually(allocationId) {
    const stmt = this.db.prepare("UPDATE device_allocations SET status = 'recycled' WHERE id = ?");
    const result = stmt.run(allocationId);
    return result.changes > 0;
  }

  // --- SMS Records (接码平台历史记录) ---
  createSmsRecord({
    id,
    platform = 'xuanwu',
    projectCode = '',
    projectName = '',
    phoneNumber,
    sessionId,
    smsCode = '',
    status = 'waiting',
    rawMessage = '',
    errorMessage = ''
  }) {
    const now = Date.now();
    const recordId = id || `sms_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const stmt = this.db.prepare(`
      INSERT INTO sms_records (
        id, platform, project_code, project_name, phone_number, session_id,
        sms_code, status, raw_message, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      recordId,
      platform,
      projectCode,
      projectName,
      phoneNumber,
      sessionId,
      smsCode,
      status,
      rawMessage,
      errorMessage,
      now,
      now
    );
    return this.getSmsRecordById(recordId);
  }

  updateSmsRecord(id, updates = {}) {
    const now = Date.now();
    const fields = [];
    const values = [];

    if (updates.smsCode !== undefined) {
      fields.push('sms_code = ?');
      values.push(updates.smsCode);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.rawMessage !== undefined) {
      fields.push('raw_message = ?');
      values.push(updates.rawMessage);
    }
    if (updates.errorMessage !== undefined) {
      fields.push('error_message = ?');
      values.push(updates.errorMessage);
    }

    if (fields.length === 0) return this.getSmsRecordById(id);

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const stmt = this.db.prepare(`UPDATE sms_records SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    return this.getSmsRecordById(id);
  }

  getSmsRecordById(id) {
    const stmt = this.db.prepare('SELECT * FROM sms_records WHERE id = ?');
    return stmt.get(id);
  }

  getSmsRecordBySession(sessionId) {
    const stmt = this.db.prepare('SELECT * FROM sms_records WHERE session_id = ? ORDER BY created_at DESC LIMIT 1');
    return stmt.get(sessionId);
  }

  listSmsRecords({ limit = 50, offset = 0, status = '', search = '' } = {}) {
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (search) {
      conditions.push('(phone_number LIKE ? OR project_name LIKE ? OR project_code LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = this.db.prepare(`SELECT COUNT(1) AS total FROM sms_records ${whereClause}`);
    const total = countStmt.get(...params).total;

    const listStmt = this.db.prepare(`
      SELECT * FROM sms_records ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const records = listStmt.all(...params, limit, offset);

    return { total, records };
  }

  clearSmsRecords() {
    return this.db.prepare('DELETE FROM sms_records').run();
  }

  getSmsStats() {
    const totalStmt = this.db.prepare('SELECT COUNT(1) AS total FROM sms_records');
    const total = totalStmt.get().total;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();

    const todayStmt = this.db.prepare('SELECT COUNT(1) AS cnt FROM sms_records WHERE created_at >= ?');
    const todayTotal = todayStmt.get(todayTs).cnt;

    const successStmt = this.db.prepare("SELECT COUNT(1) AS cnt FROM sms_records WHERE status = 'received'");
    const successTotal = successStmt.get().cnt;

    const waitingStmt = this.db.prepare("SELECT COUNT(1) AS cnt FROM sms_records WHERE status = 'waiting'");
    const waitingTotal = waitingStmt.get().cnt;

    return { total, todayTotal, successTotal, waitingTotal };
  }

  // --- SMS Call Logs (供脚本调用的完整日志与详情) ---
  createSmsCallLog({
    id,
    action,
    caller = '脚本调用',
    phoneNumber = '',
    sessionId = '',
    smsCode = '',
    status = 'success',
    statusCode = '',
    latencyMs = 0,
    requestUrl = '',
    requestParams = {},
    responseData = {},
    errorMessage = ''
  }) {
    const now = Date.now();
    const logId = id || `log_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const reqStr = typeof requestParams === 'string' ? requestParams : JSON.stringify(requestParams || {});
    const respStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});

    const stmt = this.db.prepare(`
      INSERT INTO sms_call_logs (
        id, action, caller, phone_number, session_id, sms_code,
        status, status_code, latency_ms, request_url, request_params,
        response_data, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      logId,
      action,
      caller,
      phoneNumber,
      sessionId,
      smsCode,
      status,
      statusCode,
      latencyMs,
      requestUrl,
      reqStr,
      respStr,
      errorMessage,
      now
    );
    return this.getSmsCallLogById(logId);
  }

  getSmsCallLogById(id) {
    const stmt = this.db.prepare('SELECT * FROM sms_call_logs WHERE id = ?');
    return stmt.get(id);
  }

  listSmsCallLogs({ limit = 50, offset = 0, status = '', search = '' } = {}) {
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (search) {
      conditions.push('(phone_number LIKE ? OR action LIKE ? OR caller LIKE ? OR session_id LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = this.db.prepare(`SELECT COUNT(1) AS total FROM sms_call_logs ${whereClause}`);
    const total = countStmt.get(...params).total;

    const listStmt = this.db.prepare(`
      SELECT * FROM sms_call_logs ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const logs = listStmt.all(...params, limit, offset);

    return { total, logs };
  }

  clearSmsCallLogs() {
    return this.db.prepare('DELETE FROM sms_call_logs').run();
  }

  // --- Script Visibility & Custom Bundles ---
  getScriptVisibility() {
    const raw = this.getConfig('script_visibility_config');
    if (!raw) {
      return {
        groups: { v2: true, v3: true, momo: true, custom: true },
        scripts: {}
      };
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        groups: { v2: true, v3: true, momo: true, custom: true, ...(parsed.groups || {}) },
        scripts: parsed.scripts || {}
      };
    } catch {
      return {
        groups: { v2: true, v3: true, momo: true, custom: true },
        scripts: {}
      };
    }
  }

  setScriptVisibility(config = {}) {
    const current = this.getScriptVisibility();
    const updated = {
      groups: { ...current.groups, ...(config.groups || {}) },
      scripts: { ...current.scripts, ...(config.scripts || {}) }
    };
    this.setConfig('script_visibility_config', JSON.stringify(updated));
    return updated;
  }

  getScriptBundles() {
    const raw = this.getConfig('script_bundles');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  saveScriptBundle(bundle = {}) {
    const bundles = this.getScriptBundles();
    const now = Date.now();
    const id = bundle.id || `bundle_${now}_${Math.random().toString(36).slice(2, 6)}`;
    const stepIds = Array.isArray(bundle.stepIds) ? bundle.stepIds : [];

    const existingIndex = bundles.findIndex(b => b.id === id);
    const bundleData = {
      id,
      name: String(bundle.name || '未命名组合').trim(),
      description: String(bundle.description || '').trim(),
      enabled: bundle.enabled !== false,
      stepIds,
      createdAt: existingIndex >= 0 ? bundles[existingIndex].createdAt : now,
      updatedAt: now
    };

    if (existingIndex >= 0) {
      bundles[existingIndex] = bundleData;
    } else {
      bundles.push(bundleData);
    }

    this.setConfig('script_bundles', JSON.stringify(bundles));
    return bundleData;
  }

  deleteScriptBundle(bundleId) {
    const bundles = this.getScriptBundles();
    const filtered = bundles.filter(b => b.id !== bundleId);
    this.setConfig('script_bundles', JSON.stringify(filtered));
    return true;
  }
}

let sharedDb = null;
function getAuthDb() {
  return (sharedDb ||= new AuthDatabase());
}

module.exports = {
  AuthDatabase,
  getAuthDb,
  AUTH_DB_PATH
};
