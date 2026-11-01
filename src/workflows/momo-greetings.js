'use strict';

/**
 * MOMO 打招呼页面自动处理工作流 (MOMO Greetings Processing Workflow)
 * 业务流程：
 * 1. 识别当前页面是否为打招呼页面（双层确认：页面类型 + 卡片控件）
 * 2. 依次点击“通过”或“拒绝”以完成次数（距离过滤、防封随机采样与拟人停顿）
 * 3. 卡片触底或达标后，执行返回并核验主消息列表
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../index');
const { imageExtension } = require('../automation/image-format');
const { PROJECT_ROOT, redact } = require('../automation/runtime');

function formatLogTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}

function createLogger(enabled = true, logFile = null) {
  return (msg) => {
    if (enabled) {
      const line = `${formatLogTime()} ${msg}`;
      console.log(line);
      if (logFile) {
        fs.appendFile(logFile, line + '\n', 'utf8').catch(() => {});
      }
    }
  };
}

async function captureStepScreenshot(phone, dir, filename, desc, log = null) {
  if (!phone || typeof phone.screenshot !== 'function' || !dir) return null;
  try {
    const shot = await phone.screenshot({ level: 2 }).catch(() => null);
    if (!shot?.data) return null;
    const extension = imageExtension(shot.data);
    if (!extension) { if (log) log(`【截图保存失败】: ${desc} (未知图片格式)`); return null; }
    await fs.mkdir(dir, { recursive: true });
    const targetPath = path.join(dir, `${filename}${extension}`);
    await fs.writeFile(targetPath, shot.data);
    const rel = path.relative(PROJECT_ROOT, targetPath);
    if (log) log(`【保存截图】: ${desc} -> ${rel}`);
    return targetPath;
  } catch (err) {
    if (log) log(`【截图保存失败】: ${desc} (${err.message})`);
    return null;
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const envDist = process.env.YUNMOMO_MOMO_MAX_DISTANCE?.trim();
  const options = {
    execute: argv.includes('--execute'),
    json: argv.includes('--json'),
    deviceId: process.env.YUNMOMO_DEVICE_ID,
    maxApproved: Number(process.env.YUNMOMO_MOMO_MAX_APPROVED || 6),
    approveProbability: Number(process.env.YUNMOMO_MOMO_APPROVE_PROBABILITY || 0.9),
    maxDistanceKm: (envDist && envDist !== 'none' && !Number.isNaN(Number(envDist))) ? Number(envDist) : null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--device-id') options.deviceId = argv[++i];
    else if (arg.startsWith('--device-id=')) options.deviceId = arg.slice(12);
    else if (arg === '--max-approved') options.maxApproved = Number(argv[++i]);
    else if (arg.startsWith('--max-approved=')) options.maxApproved = Number(arg.slice(15));
    else if (arg === '--approve-prob') options.approveProbability = Number(argv[++i]);
    else if (arg.startsWith('--approve-prob=')) options.approveProbability = Number(arg.slice(15));
    else if (arg === '--max-distance' || arg === '--distance') options.maxDistanceKm = Number(argv[++i]);
    else if (arg.startsWith('--max-distance=')) options.maxDistanceKm = Number(arg.slice(15));
    else if (arg.startsWith('--distance=')) options.maxDistanceKm = Number(arg.slice(11));
    else if (arg === '--help') {
      console.log('MOMO 打招呼页面处理:');
      console.log('  node flows/12-momo招呼处理.js [--execute] [--device-id ID] [--max-approved 6] [--max-distance 5] [--approve-prob 0.9] [--json]');
      console.log('\n参数说明:');
      console.log('  --execute          真正操作手机（缺省为只读预览）');
      console.log('  --device-id <ID>   目标云机后台 ID (亦可用环境变量 YUNMOMO_DEVICE_ID)');
      console.log('  --max-approved <N> 目标通过人数，默认 6');
      console.log('  --max-distance <N> 距离筛选（公里）：仅通过 <= N 公里内的卡片，超出则拒绝');
      console.log('  --approve-prob <P> 通过概率，默认 0.9 (90%通过，10%拒绝)');
      console.log('  --json             以原始 JSON 格式输出');
      process.exit(0);
    }
  }
  if (!Number.isInteger(options.maxApproved) || options.maxApproved < 1 || options.maxApproved > 50) {
    options.maxApproved = 6;
  }
  if (Number.isNaN(options.approveProbability) || options.approveProbability < 0 || options.approveProbability > 1) {
    options.approveProbability = 0.9;
  }
  if (options.maxDistanceKm !== null && (Number.isNaN(options.maxDistanceKm) || options.maxDistanceKm <= 0)) {
    options.maxDistanceKm = null;
  }
  return options;
}

function createProgressHandler(log, phone = null, runDir = null) {
  let cardIndex = 0;
  return async function onProgress(event) {
    switch (event.type) {
      case 'page_verified':
        log('确认处于打招呼页面');
        if (runDir && phone) await captureStepScreenshot(phone, runDir, '01-initial', '打招呼页面初始现场', null);
        break;
      case 'empty':
        log('当前暂无新招呼卡片');
        if (runDir && phone) await captureStepScreenshot(phone, runDir, '03-empty-finished', '暂无新卡片现场', null);
        break;
      case 'rate_limited':
        log('触发平台“发送过于频繁”，熔断停止');
        if (runDir && phone) await captureStepScreenshot(phone, runDir, 'error-rate-limited', '平台频控拦截现场', null);
        break;
      case 'card_decision': {
        cardIndex++;
        const distText = event.distanceKm !== null ? `距离 ${event.distanceKm}km` : null;
        if (event.decision === 'approve') {
          const info = distText ? ` (${distText}，累计通过 ${event.approved} 人)` : ` (累计通过 ${event.approved} 人)`;
          log(`卡片处理：通过${info}`);
        } else {
          if (event.rejectReason === 'distance_exceeded') {
            log(`卡片处理：拒绝 (${distText} 超出限制 ${event.maxDistanceKm}km)`);
          } else {
            const info = distText ? ` (${distText}，累计拒绝 ${event.rejected} 人)` : ` (累计拒绝 ${event.rejected} 人)`;
            log(`卡片处理：拒绝${info}`);
          }
        }
        if (runDir && phone) {
          const action = event.decision === 'approve' ? 'pass' : 'reject';
          await captureStepScreenshot(phone, runDir, `02-card-${String(cardIndex).padStart(2, '0')}-${action}`, `第${cardIndex}张卡片处理现场(${action})`, null);
        }
        break;
      }
      case 'target_reached':
        log(`已达到目标通过人数 (${event.maxApproved} 人)`);
        if (runDir && phone) await captureStepScreenshot(phone, runDir, '03-target-reached', '达到目标人数现场', null);
        break;
      case 'all_processed':
        log('招呼卡片已全部处理完毕');
        if (runDir && phone) await captureStepScreenshot(phone, runDir, '03-all-processed', '全部卡片处理完毕现场', null);
        break;
      case 'send_back':
        log('退出打招呼页面并核验返回消息列表...');
        break;
    }
  };
}

async function runMomoGreetings(client, deviceId, options = {}) {
  const phone = client.device(deviceId || 'local-preview-only');
  const tools = phone.tools();
  try {
    return await tools.processMomoGreetings({
      execute: Boolean(options.execute),
      dryRun: !options.execute,
      maxApproved: options.maxApproved ?? 6,
      maxDistanceKm: options.maxDistanceKm ?? null,
      approveProbability: options.approveProbability ?? 0.9,
      rejectProbability: 1 - (options.approveProbability ?? 0.9),
      cycles: 1,
      timeoutMs: options.timeoutMs ?? (options.execute ? undefined : 15000),
      signal: options.signal,
      onProgress: options.onProgress,
    });
  } finally {
    await tools.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (!args.execute) {
    const log = createLogger(!args.json);
    if (args.json) {
      console.log(JSON.stringify({ ok: true, preview: true, settings: args }, null, 2));
    } else {
      log('MOMO打招呼处理 (预览模式)');
      log(`目标通过: ${args.maxApproved} 人，通过概率: ${Math.round(args.approveProbability * 100)}%`);
      if (args.maxDistanceKm !== null) {
        log(`距离筛选: 仅通过 <= ${args.maxDistanceKm} 公里 (超出自动拒绝)`);
      } else {
        log(`距离筛选: 未启用 (不限制距离)`);
      }
      log('提示: 传入 --execute 参数才会真正操作手机');
    }
    return { ok: true, preview: true };
  }

  if (!args.deviceId) throw new Error('--execute 需要指定 --device-id 或环境变量 YUNMOMO_DEVICE_ID');

  const token = process.env.YUNMOMO_TOKEN?.trim() || '';
  if (!token) throw new Error('执行操作需要环境变量 YUNMOMO_TOKEN');

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  const runDir = path.join(PROJECT_ROOT, '.local-output', 'momo-greetings', `run_${timestamp}_${randomSuffix}`);
  await fs.mkdir(runDir, { recursive: true }).catch(() => {});
  const logFile = path.join(runDir, 'greetings.log');
  const log = createLogger(!args.json, logFile);

  // 立即将输出与截图位置呈现给用户
  log(`【过程日志】：${path.relative(PROJECT_ROOT, logFile)}`);
  log(`【过程截图】：${path.relative(PROJECT_ROOT, runDir)}`);

  const client = new YunmomoClient({ token, timeoutMs: 300000 });
  const phone = client.device(args.deviceId);
  const controller = new AbortController();
  const onSigint = () => {
    log('收到中断信号，正在终止...');
    controller.abort();
  };
  process.once('SIGINT', onSigint);

  const onProgress = createProgressHandler(log, phone, runDir);

  try {
    const result = await runMomoGreetings(client, args.deviceId, {
      ...args,
      signal: controller.signal,
      onProgress,
    });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      const approved = result.data?.totalApproved || 0;
      const rejected = result.data?.totalRejected || 0;
      const outcome = result.data?.cycles?.[0]?.outcome;
      const isRateLimited = Boolean(result.data?.rateLimited);
      const exitVerified = Boolean(result.data?.exitVerified);

      if (isRateLimited) {
        log(`处理终止：因平台频控退出 (共通过 ${approved} 人，拒绝 ${rejected} 人)`);
      } else if (approved === 0 && outcome === 'all_processed') {
        log('处理完成：无新卡片需要处理');
      } else {
        log(`处理完成：通过 ${approved} 人，拒绝 ${rejected} 人${exitVerified ? ' (已核验返回消息列表)' : ''}`);
      }

      // 保存最终现场截图与运行摘要
      await captureStepScreenshot(phone, runDir, '04-final-exit', '执行结束最终现场', null);
      const summary = {
        ok: true,
        totalApproved: approved,
        totalRejected: rejected,
        outcome,
        rateLimited: isRateLimited,
        exitVerified,
        decisions: result.data?.cycles?.[0]?.decisions || [],
        finishedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8').catch(() => {});

      log(`【执行摘要】：通过 ${approved} 人，拒绝 ${rejected} 人，状态: ${outcome}`);
    } else {
      const msg = result.error?.message || '未知错误';
      log(`处理失败：${msg}`);
      await captureStepScreenshot(phone, runDir, 'error-failed', '处理失败现场', null);
      const summary = {
        ok: false,
        error: msg,
        code: result.error?.code || 'UNKNOWN_ERROR',
        finishedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8').catch(() => {});
      if (result.error?.code === 'MOMO_NOT_ON_GREETINGS_PAGE') {
        log('提示：请先将手机打开到打招呼页面，再运行此脚本');
      }
    }

    if (!result.ok) process.exitCode = 1;
    return result;
  } catch (err) {
    log(`执行异常：${err.message}`);
    await captureStepScreenshot(phone, runDir, 'error-failed', '异常崩溃现场', null);
    const summary = {
      ok: false,
      error: err.message,
      stack: err.stack,
      finishedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8').catch(() => {});
    throw err;
  } finally {
    process.removeListener('SIGINT', onSigint);
    await client.closeScreenshots().catch(() => {});
  }
}

module.exports = { runMomoGreetings, main };
