'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { createReadStream } = require('node:fs');

async function summarize(directory, { runId, deviceId, limit = 30 } = {}) {
  const groups = new Map();
  let malformedLines = 0, incompleteSpans = 0;
  const spans = new Set();
  async function walk(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !/^timing-\d+\.jsonl$/.test(entry.name)) continue;
      const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); } catch { malformedLines++; continue; }
        if ((runId && item.runId !== runId) || (deviceId && item.deviceId !== deviceId)) continue;
        if (typeof item.name !== 'string' || !['start', 'end'].includes(item.event) || typeof item.spanId !== 'string') {
          malformedLines++; continue;
        }
        if (item.event === 'start') { spans.add(item.spanId); continue; }
        spans.delete(item.spanId);
        if (!Number.isFinite(item.durationMs) || item.durationMs < 0) { malformedLines++; continue; }
        let group = groups.get(item.name);
        if (!group) { group = { name: item.name, count: 0, failures: 0, totalMs: 0, maxMs: 0, samples: [] }; groups.set(item.name, group); }
        group.count++; group.totalMs += item.durationMs;
        group.maxMs = Math.max(group.maxMs, item.durationMs);
        if (['failed', 'error', 'cancelled', 'aborted', 'timeout', 'blocked', 'needs_review',
          'uncertain', 'needs_baseline', 'rate_limited'].includes(item.status)) group.failures++;
        group.samples.push(item.durationMs);
      }
    }
  }
  await walk(directory);
  incompleteSpans = spans.size;
  const rows = [...groups.values()].map(({ samples, ...group }) => {
    samples.sort((a, b) => a - b);
    return { ...group, totalMs: Math.round(group.totalMs * 100) / 100,
      avgMs: Math.round(group.totalMs / group.count * 100) / 100,
      p95Ms: samples[Math.max(0, Math.ceil(samples.length * .95) - 1)] };
  }).sort((a, b) => b.totalMs - a.totalMs).slice(0, limit);
  return { directory, runId: runId || null, deviceId: deviceId || null, malformedLines, incompleteSpans, rows };
}

async function main(argv = process.argv.slice(2)) {
  const allowed = new Set(['--run-id', '--device-id', '--limit', '--dir', '--json']);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.has(key)) throw new Error('Unknown timing-report option');
    if (key === '--json') { options.json = true; continue; }
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Missing timing-report option value');
    options[key] = argv[++i];
  }
  const limit = Number(options['--limit'] ?? 30);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit must be between 1 and 10000');
  const directory = path.resolve(options['--dir'] || process.env.YUNMOMO_TIMING_DIR || path.join(__dirname, '../.runtime/timings'));
  const result = await summarize(directory, { runId: options['--run-id'], deviceId: options['--device-id'], limit });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.table(result.rows);
    console.log(`未闭合记录：${result.incompleteSpans}；损坏/无效行：${result.malformedLines}`);
    console.log('父子及并行步骤存在重叠，不能把各行总耗时相加当成一次脚本的运行时间。');
  }
}

if (require.main === module) main().catch(error => { console.error(error.code === 'ENOENT' ? '尚无计时日志，请先执行脚本。' : error.message); process.exitCode = 1; });
module.exports = { summarize, main };
