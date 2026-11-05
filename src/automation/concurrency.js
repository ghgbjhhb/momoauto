'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { PROJECT_ROOT } = require('./runtime');

// Bounded independent reads; preserve order, stop admitting work on failure,
// and settle already-running reads before the caller can perform a write.
async function mapLimit(values, limit, read, signal) {
  const results = new Array(values.length);
  let cursor = 0, failed = false, firstError;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (!failed && cursor < values.length) {
      const index = cursor++;
      try {
        if (signal?.aborted) throw signal.reason ?? new Error('Read cancelled');
        results[index] = await read(values[index], index);
      } catch (error) { if (!failed) firstError = error; failed = true; }
    }
  }));
  if (failed) throw firstError;
  if (signal?.aborted) throw signal.reason ?? new Error('Read cancelled');
  return results;
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 清理由于异常中断残留在磁盘上的孤儿锁 (Orphan Locks)
 */
async function cleanStaleLocks() {
  const locksDir = path.join(PROJECT_ROOT, 'storage', 'locks');
  try {
    const files = await fs.readdir(locksDir);
    for (const file of files) {
      if (!file.endsWith('.lock')) continue;
      const fullPath = path.join(locksDir, file);
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const data = JSON.parse(raw);
        if (data.pid && !isPidAlive(data.pid)) {
          await fs.unlink(fullPath);
        }
      } catch {
        await fs.unlink(fullPath).catch(() => {});
      }
    }
  } catch {}
}

/**
 * 跨进程原子排他互斥锁 (Cross-Process Exclusive Mutex)
 * 基于文件系统原子排他创建 (flag: 'wx') 实现。
 * 具备：
 * 1. 毫秒级轮询与排队等待；
 * 2. 进程活性自愈 (PID Liveness Check，持有进程退出时自动秒级回收)；
 * 3. 超时保护 (10分钟超时双保险)；
 * 4. 租约释放句柄。
 */
async function acquireExclusiveLock(lockName, options = {}) {
  const timeoutMs = options.timeoutMs ?? (15 * 60 * 1000);
  const staleMs = options.staleMs ?? (10 * 60 * 1000);
  const pollMs = options.pollMs ?? 1500;
  const onWaiting = typeof options.onWaiting === 'function' ? options.onWaiting : null;

  const safeName = String(lockName || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  const locksDir = path.join(PROJECT_ROOT, 'storage', 'locks');
  await fs.mkdir(locksDir, { recursive: true });
  const lockFile = path.join(locksDir, `${safeName}.lock`);

  const startTime = Date.now();
  let waitCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const handle = await fs.open(lockFile, 'wx');
      const payload = JSON.stringify({ pid: process.pid, at: Date.now(), deviceId: options.deviceId || '' });
      await handle.writeFile(payload, 'utf8');

      let released = false;
      return {
        lockName: safeName,
        lockFile,
        async release() {
          if (released) return;
          released = true;
          try { await handle.close(); } catch {}
          try { await fs.unlink(lockFile); } catch {}
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // 检测是否为进程异常中断遗留的死锁（PID 已死亡或超过最大时限）
      try {
        const raw = await fs.readFile(lockFile, 'utf8').catch(() => null);
        let isStale = false;
        if (raw) {
          try {
            const data = JSON.parse(raw);
            if (data.pid && !isPidAlive(data.pid)) {
              isStale = true;
            }
          } catch {
            isStale = true;
          }
        }
        if (!isStale) {
          const stat = await fs.stat(lockFile);
          if (Date.now() - stat.mtimeMs > staleMs) {
            isStale = true;
          }
        }
        if (isStale) {
          await fs.unlink(lockFile).catch(() => {});
          continue;
        }
      } catch {}

      waitCount++;
      if (onWaiting) {
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        onWaiting(elapsedSec);
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }

  throw new Error(`获取全局排他锁 [${safeName}] 超时 (${Math.round(timeoutMs / 1000)}s)，前序任务可能占用过久`);
}

module.exports = { mapLimit, acquireExclusiveLock, cleanStaleLocks };
