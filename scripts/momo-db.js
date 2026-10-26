'use strict';

/**
 * MOMO 本地 SQLite 数据库工具 (MOMO Database CLI Tool)
 *
 * 子命令:
 * 1. inspect : 查看指定设备已入库的联系人与消息历史
 * 2. clean   : 清理历史时间戳、关注横幅杂音数据并自动备份
 */

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { MomoDatabase, getDeviceDatabasePath } = require('../src/tools/momo/db');
const { isTimestampText, isFollowBannerText, isSystemNoticeText } = require('../src/tools/momo/chat-detail-parser');

function inspectDatabase(deviceId) {
  if (!deviceId) throw new Error('Pass a device ID: node scripts/momo-db.js inspect <device-id>');
  const dbPath = getDeviceDatabasePath(deviceId);
  if (!fs.existsSync(dbPath)) throw new Error(`No MOMO database exists for device ${deviceId} at ${dbPath}`);
  const db = new MomoDatabase(dbPath, { readOnly: true });
  try {
    const contacts = db.listContacts(20);
    console.log(`=== CONTACTS IN DB (Device ${deviceId}) ===`);
    for (const c of contacts) {
      console.log(`Contact ID: ${c.id}, Name: "${c.name}", unread: ${c.unreadCount}, lastMsg: "${c.lastMessage}", syncedAt: ${c.syncedAt}`);
    }
    console.log('\n=== DETAILED MESSAGES ===');
    for (const c of contacts) {
      const msgs = db.getMessagesByContact(c.id);
      console.log(`\n========================================`);
      console.log(`Contact: ${c.name} (ID: ${c.id}, Total Messages: ${msgs.length})`);
      console.log(`========================================`);
      if (!msgs.length) {
        console.log('  (No messages ingested)');
        continue;
      }
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        console.log(`  [${String(i + 1).padStart(2, '0')}] [${m.sender.toUpperCase().padEnd(6)}] ${m.text}`);
      }
    }
  } finally {
    db.close();
  }
}

function cleanDatabase(deviceId) {
  if (!deviceId) throw new Error('Pass a device ID: node scripts/momo-db.js clean <device-id>');
  const dbPath = getDeviceDatabasePath(deviceId);
  const bakPath = dbPath + '.' + Date.now() + '.bak';

  if (!fs.existsSync(dbPath)) {
    console.log('DB does not exist at', dbPath);
    return;
  }

  fs.copyFileSync(dbPath, bakPath, fs.constants.COPYFILE_EXCL);
  console.log('Backed up database to', bakPath);

  const db = new DatabaseSync(dbPath);
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY id ASC').all();

  for (const contact of contacts) {
    const rows = db.prepare('SELECT * FROM messages WHERE contactId = ? ORDER BY id ASC').all(contact.id);
    console.log(`\nProcessing Contact: ${contact.name} (id: ${contact.id}, total rows: ${rows.length})`);

    let currentTimestamp = '';
    const rowsToDelete = [];
    const rowsToUpdate = [];

    for (const r of rows) {
      const text = (r.text || '').trim();

      if (isFollowBannerText(text)) {
        rowsToDelete.push(r.id);
        continue;
      }

      if (isTimestampText(text)) {
        currentTimestamp = text;
        rowsToDelete.push(r.id);
        continue;
      }

      if (isSystemNoticeText(text)) {
        rowsToUpdate.push({ id: r.id, sender: 'system', time: currentTimestamp });
        continue;
      }

      rowsToUpdate.push({ id: r.id, sender: r.sender, time: currentTimestamp });
    }

    const delStmt = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of rowsToDelete) {
      delStmt.run(id);
    }

    const upStmt = db.prepare('UPDATE messages SET sender = ?, time = ? WHERE id = ?');
    for (const u of rowsToUpdate) {
      upStmt.run(u.sender, u.time, u.id);
    }

    console.log(`  Deleted ${rowsToDelete.length} timestamp/banner rows, updated ${rowsToUpdate.length} message rows.`);
  }

  console.log('\n--- Cleanup complete! ---');
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  const deviceId = arg || process.env.YUNMOMO_DEVICE_ID;

  if (cmd === 'clean') {
    cleanDatabase(deviceId);
  } else if (cmd === 'inspect' || (!cmd && deviceId)) {
    inspectDatabase(deviceId);
  } else {
    console.log('Usage:');
    console.log('  node scripts/momo-db.js inspect [deviceId]');
    console.log('  node scripts/momo-db.js clean [deviceId]');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { inspectDatabase, cleanDatabase };
