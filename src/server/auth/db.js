'use strict';

const path = require('node:path');
const fs = require('node:fs');
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

      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_cards_code ON cards(card_code);
      CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
      CREATE INDEX IF NOT EXISTS idx_allocations_user ON device_allocations(user_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_device ON device_allocations(device_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_status ON device_allocations(status);
    `);
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
      INSERT INTO cards (id, card_code, duration_days, duration_hours, status, batch_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const card of cards) {
      stmt.run(
        card.id,
        card.cardCode,
        card.durationDays || 0,
        card.durationHours || 0,
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

  listCards({ status, batchTag, limit = 100, offset = 0 } = {}) {
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
    sql += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params);
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
