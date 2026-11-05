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

/**
 * 跨进程原子排他互斥锁 (Cross-Process Exclusive Mutex)
 * 基于文件系统原子排他创建 (flag: 'wx') 实现。
 * 具备：
 * 1. 毫秒级轮询与排队等待；
 * 2. 陈旧死锁自愈 (Stale Lock Auto-recovery，10分钟未更新自动回收)；
 * 3. 租约释放句柄。
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

      // 检测是否为进程异常中断遗留的陈旧死锁
      try {
        const stat = await fs.stat(lockFile);
        if (Date.now() - stat.mtimeMs > staleMs) {
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

module.exports = { mapLimit, acquireExclusiveLock };
