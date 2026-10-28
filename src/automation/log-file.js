'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const writeQueues = new Map();

async function rotateIfNeeded(filePath, maxBytes) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  let size = 0;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (size < maxBytes) return;
  await fs.promises.rm(`${filePath}.1`, { force: true });
  await fs.promises.rename(filePath, `${filePath}.1`);
}

// 同一文件串行写入，避免并发 rename/append 交错；超过 maxBytes 轮转为单个 .1 备份。
function appendLogLine(filePath, line, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const previous = writeQueues.get(filePath) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => rotateIfNeeded(filePath, maxBytes))
    .then(() => fs.promises.appendFile(filePath, line, 'utf8'))
    .catch(error => {
      console.error(`[log] 写入 ${path.basename(filePath)} 失败: ${error.message}`);
    })
    .finally(() => {
      if (writeQueues.get(filePath) === current) writeQueues.delete(filePath);
    });
  writeQueues.set(filePath, current);
  return current;
}

module.exports = { appendLogLine };
