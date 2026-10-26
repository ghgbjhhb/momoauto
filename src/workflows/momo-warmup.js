'use strict';

/**
 * MOMO 首页养号工作流 (MOMO Home Warmup Workflow)
 * 仅刷新动态列表与帖文滑动浏览，不点赞、不评论、不关注、不发消息。
 */

const { YunmomoClient } = require('../index');
const { redact } = require('../automation/runtime');

const DESCRIPTION = '首页刷新与列表浏览，用于初始化后的基础浏览（初始养号动作）；不点赞、不评论、不发消息';

const HELP_TEXT = `MOMO 首页养号工作流:
  node src/workflows/momo-warmup.js [--device-id ID] [--cycles N] [--mode random|button|pull]

参数说明:
  --device-id <ID>   目标云机后台 ID (亦可通过环境变量 YUNMOMO_DEVICE_ID 传入)
  --cycles <N>       养号循环轮数，默认 1 (1~100)
  --mode <MODE>      刷新方式：random (70%按钮/30%下拉，默认) | button | pull
  --refresh-count    每轮刷新次数区间，默认 2,8
  --scroll-count     每轮下滑浏览次数区间，默认 3,6
  --scroll-interval  下滑停顿间隔毫秒区间，默认 1000,5000 (1~3秒占80%, 4~5秒占20%)`;

function parseRange(str, fallback) {
  if (!str) return fallback;
  const [min, max] = String(str).split(/[,~-]/).map(s => Number(s.trim()));
  return (Number.isInteger(min) && Number.isInteger(max) && min <= max) ? { min, max } : fallback;
}

function parseCliArgs(argv) {
  const opts = {
    showHelp: false,
    deviceId: process.env.YUNMOMO_DEVICE_ID,
    cycles: Number(process.env.YUNMOMO_MOMO_CYCLES || 1),
    mode: process.env.YUNMOMO_MOMO_REFRESH_MODE || 'random',
    refreshCount: { min: 2, max: 8 },
    scrollCount: { min: 3, max: 6 },
    scrollIntervalMs: { min: 1000, max: 5000 }
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') { opts.showHelp = true; return opts; }
    if (a === '--execute') continue; // 兼容历史调用参数

    const eqIdx = a.indexOf('=');
    const key = eqIdx !== -1 ? a.slice(0, eqIdx) : a;
    const val = () => (eqIdx !== -1 ? a.slice(eqIdx + 1) : argv[++i]);

    if (key === '--device-id') {
      const id = val();
      if (!id || id.startsWith('--')) throw new Error('--device-id requires a backend device ID');
      opts.deviceId = id;
    } else if (key === '--cycles') opts.cycles = Number(val());
    else if (key === '--mode') opts.mode = val();
    else if (key === '--refresh-count') opts.refreshCount = parseRange(val(), opts.refreshCount);
    else if (key === '--scroll-count') opts.scrollCount = parseRange(val(), opts.scrollCount);
    else if (key === '--scroll-interval') opts.scrollIntervalMs = parseRange(val(), opts.scrollIntervalMs);
    else throw new Error('未知参数: ' + a + '；可用 --help 查看帮助');
  }
  return opts;
}

function printSummary(result) {
  console.log('\n' + '='.repeat(60));
  if (result.ok) {
    console.log('【执行结果】：成功');
    console.log('【任务名称】：MOMO首页养号');
    console.log('【退出状态码】：0');
    console.log(`【完成统计】：完成 ${result.data?.completedCycles || 0} 轮养号，共刷新动态 ${result.data?.refreshesSent || 0} 次，滑动浏览 ${result.data?.scrollsSent || 0} 篇帖文`);
    if (result.durationMs) {
      console.log(`【执行耗时】：${(result.durationMs / 1000).toFixed(2)} 秒`);
    }
  } else {
    console.log('【执行结果】：失败');
    console.log('【任务名称】：MOMO首页养号');
    console.log('【退出状态码】：1');
    console.log(`【失败原因】：${result.error?.message || '未知错误'}`);
    if (result.error?.code) {
      console.log(`【错误代码】：${result.error.code}`);
    }
  }
  console.log('='.repeat(60) + '\n');
}

async function runMomoWarmup(client, deviceId, options = {}) {
  const cycles = Number(options.cycles ?? process.env.YUNMOMO_MOMO_CYCLES ?? 1);
  const phone = client.device(deviceId);
  const tools = phone.tools();

  try {
    return await tools.browseMomoHome({
      cycles,
      mode: String(options.mode ?? process.env.YUNMOMO_MOMO_REFRESH_MODE ?? 'random').trim().toLowerCase(),
      refreshCount: options.refreshCount ?? { min: 2, max: 8 },
      scrollCount: options.scrollCount ?? { min: 3, max: 6 },
      scrollIntervalMs: options.scrollIntervalMs ?? { min: 1000, max: 5000 },
      timeoutMs: options.timeoutMs ?? Math.max(300000, cycles * 120000),
    });
  } finally {
    await tools.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (parsed.showHelp) { console.log(HELP_TEXT); return; }

  if (!parsed.deviceId) throw new Error('执行需要提供目标云机设备 ID (--device-id 或环境变量 YUNMOMO_DEVICE_ID)');
  if (!process.env.YUNMOMO_TOKEN?.trim()) throw new Error('执行需要当前登录令牌 (环境变量 YUNMOMO_TOKEN)');

  if (!Number.isInteger(parsed.cycles) || parsed.cycles < 1 || parsed.cycles > 100) {
    throw new Error('循环轮数 --cycles 必须为 1 到 100 的整数');
  }

  const client = new YunmomoClient();
  try {
    const result = await runMomoWarmup(client, parsed.deviceId, parsed);
    printSummary(result);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await client.closeScreenshots().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(error => {
    console.log('\n' + '='.repeat(60));
    console.log('【执行结果】：失败');
    console.log('【任务名称】：MOMO首页养号');
    console.log('【退出状态码】：1');
    console.log(`【失败原因】：${redact(error.message)}`);
    console.log('='.repeat(60) + '\n');
    process.exitCode = 1;
  });
}

main = require('../automation/timing').timedScript('script.src.workflows.momo-warmup', main);
module.exports = { main, runMomoWarmup, DESCRIPTION };
