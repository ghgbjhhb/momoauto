'use strict';

/**
 * MOMO 联系人及消息自动入库工作流 (MOMO Contact & Message Sync Workflow)
 *
 * 作用描述：
 * 处理已经打开的 MOMO 聊天详情页：
 * 1. 由调用方传入必填联系人姓名，并确认当前页面确实是该聊天。
 * 2. 采集完成后才打开按设备独立的 SQLite 数据库，原子提交联系人和消息。
 * 3. 仅在同帧确认“AI助手快速回复”面板及其右上关闭 X 后关闭浮窗；单独 X 误报不点击。
 * 4. 只用聊天气泡的文字、发送方和移动情况确认翻页与顶部；排除系统卡片及动画，预算耗尽仍未确认则失败。
 * 5. 从当前视口向上解析文字，把更早消息插入历史开头；保留真实重复消息并在顶部确认后入库。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../index');
const { PROJECT_ROOT, redact } = require('../automation/runtime');

const DESCRIPTION = 'MOMO联系人及消息自动入库：必填联系人姓名，从当前聊天画面向上采集文字历史并入库';

async function runMomoContactSync(client, deviceId, options = {}) {
  const contactName = String(options.contactName ?? process.env.YUNMOMO_MOMO_CONTACT_NAME ?? '').trim();
  if (!contactName) {
    throw Object.assign(new Error('MOMO联系人及消息入库必须指定当前聊天联系人姓名'), { code: 'MOMO_CONTACT_NAME_REQUIRED' });
  }

  const phone = client.device(deviceId ?? 'local-preview-only');
  const tools = phone.tools();

  const syncOptions = {
    execute: true,
    dryRun: false,
    boundaryStableCount: options.boundaryStableCount ?? 2,
    dbPath: options.dbPath,
    settleMs: options.settleMs ?? 800,
    scrollSettleMs: options.scrollSettleMs ?? 400,
    swipeDurationMs: options.swipeDurationMs ?? 280,
    signal: options.signal,
    contactName,
    currentChatOnly: true,
    screenshotsDir: options.screenshotsDir,
    timeoutMs: options.timeoutMs ?? 900000,
  };

  try {
    return await tools.syncMomoContacts(syncOptions);
  } finally {
    await tools.close();
  }
}

const STEP_NAMES = {
  confirm_chat_page: '确认当前联系人和聊天页面',
  collect_messages: '向上采集并拼接文字消息',
  momo_database_commit: '联系人与消息入库保存',
  dispatch: '关闭已确认的助手浮层',
  swipe_dispatch: '翻看历史消息',
  momo_screenshot: '截屏采集',
  momo_recognition: '视觉与OCR识别服务',
};

/**
 * 读取调用方注入的本次运行唯一日志 ID（logs/runs/<runId>.log），便于用户直接定位原始日志
 */
function scriptRunId() {
  const runId = String(process.env.YUNMOMO_SCRIPT_RUN_ID ?? '').trim();
  return runId && !/[\r\n\0]/.test(runId) ? runId : '';
}

function printContactSyncSummary(result) {
  const runId = scriptRunId();
  console.log('\n' + '='.repeat(60));
  console.log(`【执行结果】：${result.ok ? '成功' : '失败'}`);
  console.log('【任务名称】：MOMO联系人及消息自动入库');
  if (result.operationId) console.log(`【任务ID】：${result.operationId}`);
  if (runId) {
    console.log(`【日志ID】：${runId}`);
    console.log(`【原始日志】：logs/runs/${runId}.log`);
  }
  if (result.ok) {
    const inDb = result.data?.totalMessagesInDatabase ?? ((result.data?.totalMessagesAlreadyStored || 0) + (result.data?.totalMessagesIngested || 0));
    console.log(`【处理统计】：处理 ${result.data?.contactsProcessed || 0} 个联系人，本次视口采集 ${result.data?.totalMessagesCollected || 0} 条，本次新增入库 ${result.data?.totalMessagesIngested || 0} 条，库内已有历史 ${result.data?.totalMessagesAlreadyStored || 0} 条（库内当前总计 ${inDb} 条）`);
    if (result.data?.newContactsAdded) console.log(`【新增联系人】：${result.data.newContactsAdded} 人`);
    if (result.data?.screenshotsDirectory) {
      console.log(`【截图归档】：共 ${result.data.savedScreenshots?.length || 0} 张，目录：${result.data.screenshotsDirectory}`);
    }
  } else {
    const failureStage = result.error?.stage || result.data?.history?.slice(-1)[0]?.failureStage || '未知步骤';
    const stepDesc = STEP_NAMES[failureStage] || failureStage;
    console.log(`【失败步骤】：${stepDesc}`);
    console.log(`【失败原因】：${result.error?.message || '未知错误'}`);
    if (result.error?.details?.causeMessage) {
      console.log(`【底层详情】：${result.error.details.causeName}: ${result.error.details.causeMessage}`);
    }
    if (result.data?.currentContact?.name) {
      console.log(`【当前目标】：正在处理条目“${result.data.currentContact.name}”`);
    }
    if (result.data?.lastScreenshot?.imagePath) {
      console.log(`【现场截图】：${result.data.lastScreenshot.imagePath}`);
    }
    if (result.data?.screenshotsDirectory) {
      console.log(`【截图归档】：已保存 ${result.data.savedScreenshots?.length || 0} 张，目录：${result.data.screenshotsDirectory}`);
    }
  }
  if (result.reportPath) {
    console.log(`【详细报告】：${result.reportPath}`);
  }
  console.log('='.repeat(60) + '\n');
}

async function main(argv = process.argv.slice(2)) {
  let deviceId = process.env.YUNMOMO_DEVICE_ID;
  let contactName = String(process.env.YUNMOMO_MOMO_CONTACT_NAME || '').trim();
  let dbPath;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log('MOMO 联系人及消息自动入库工作流:');
      console.log('  node flows/13-momo联系人及消息入库.js [--device-id ID] --contact-name <NAME>');
      console.log('');
      console.log('参数说明:');
      console.log('  --device-id <ID>       目标云机后台 ID (亦可通过环境变量 YUNMOMO_DEVICE_ID 传入)');
      console.log('  --contact-name <NAME> 当前聊天页联系人姓名（必填；执行前必须已打开该聊天页）');
      console.log('  --db-path <PATH>       显式覆盖数据库路径；默认按云机独立保存');
      return;
    } else if (arg === '--device-id') {
      deviceId = argv[++i];
      if (!deviceId || deviceId.startsWith('--')) throw new Error('--device-id 后必须填写云机 ID');
    } else if (arg.startsWith('--device-id=')) {
      deviceId = arg.slice(12);
    } else if (arg === '--db-path') {
      dbPath = argv[++i];
      if (!dbPath || dbPath.startsWith('--')) throw new Error('--db-path 后必须填写数据库路径');
    } else if (arg === '--contact-name') {
      contactName = argv[++i];
      if (!contactName || contactName.startsWith('--')) throw new Error('--contact-name 后必须填写联系人姓名');
    } else if (arg.startsWith('--contact-name=')) {
      contactName = arg.slice('--contact-name='.length);
      if (!contactName) throw new Error('--contact-name 后必须填写联系人姓名');
    } else {
      throw new Error('不支持的参数：' + arg + '（请用 --help 查看用法）');
    }
  }

  contactName = contactName.trim();
  if (!contactName) throw Object.assign(new Error('必须通过 --contact-name 指定联系人姓名'), { code: 'MOMO_CONTACT_NAME_REQUIRED' });

  if (!deviceId) {
    throw new Error('执行前必须通过 --device-id 或 YUNMOMO_DEVICE_ID 指定云机');
  }

  const token = process.env.YUNMOMO_TOKEN?.trim();
  if (!token) {
    throw new Error('执行前必须配置 YUNMOMO_TOKEN 登录凭据');
  }

  const client = new YunmomoClient({ token: token || '', timeoutMs: 300000 });
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  let outputDir = null;
  let runDir = null;
  try {
    outputDir = path.join(PROJECT_ROOT, '.local-output', 'momo-sync');
    await fs.mkdir(outputDir, { recursive: true });
    runDir = await fs.mkdtemp(path.join(outputDir, 'run-'));

    const result = await runMomoContactSync(client, deviceId, {
      contactName,
      dbPath,
      signal: controller.signal,
      screenshotsDir: runDir,
    });

    let output = result;
    let lastScreenshot = null;
    const shot = result.data?.lastScreenshot;
    const lastSaved = result.data?.savedScreenshots?.find(item => item.index === result.data.screenshots);
    if (shot?.image && lastSaved?.imagePath) {
      const { image, ...meta } = shot;
      lastScreenshot = { ...meta, imagePath: lastSaved.imagePath };
    } else if (shot?.image) {
      const ext = shot.format === 'png' ? 'png' : 'jpg';
      const imagePath = path.join(runDir, 'last.' + ext);
      await fs.writeFile(imagePath, shot.image, { flag: 'wx' });
      const { image, ...meta } = shot;
      lastScreenshot = { ...meta, imagePath };
    }

    // 关键帧现场留存：保存跳过的非联系人页面截图
    const skippedSnapshots = [];
    if (Array.isArray(result.data?.skippedSnapshots)) {
      for (let i = 0; i < result.data.skippedSnapshots.length; i++) {
        const item = result.data.skippedSnapshots[i];
        const archived = result.data.savedScreenshots?.find(saved => saved.index === item.screenshotIndex);
        if (archived?.imagePath) {
          skippedSnapshots.push({
            name: item.name,
            reason: item.reason,
            pageLevel: item.pageLevel,
            imagePath: archived.imagePath,
          });
          continue;
        }
        if (item.shot?.image) {
          const ext = item.shot.format === 'png' ? 'png' : 'jpg';
          const safeName = String(item.name || 'unknown').replace(/[^a-zA-Z0-9一-龥_-]/g, '_');
          const snapPath = path.join(runDir, `skipped-${i + 1}-${safeName}.${ext}`);
          await fs.writeFile(snapPath, item.shot.image, { flag: 'wx' });
          skippedSnapshots.push({ name: item.name, reason: item.reason, pageLevel: item.pageLevel, imagePath: snapPath });
        }
      }
    }

    output = {
      ...result,
      data: result.data ? { ...result.data, lastScreenshot, skippedSnapshots } : null,
      reportPath: path.join(runDir, 'report.json'),
      latestPath: path.join(outputDir, 'latest.json'),
    };

    const serialized = JSON.stringify(output, null, 2);
    await fs.writeFile(output.reportPath, serialized, 'utf8');
    await fs.writeFile(output.latestPath, serialized, 'utf8');

    // 全量 frames/history/截图清单只落盘 report.json，不再打印到用户侧
    printContactSyncSummary(output);
    if (!result.ok) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
    await client.closeScreenshots().catch(() => {});
  }
}

runMomoContactSync = require('../automation/timing').timed('workflow.momo-contact-sync.runMomoContactSync', runMomoContactSync);
main = require('../automation/timing').timedScript('script.src.workflows.momo-contact-sync', main);

if (require.main === module) {
  main().catch(err => {
    const runId = scriptRunId();
    if (runId) console.error(`[日志ID: ${runId}] 原始日志: logs/runs/${runId}.log`);
    console.error(JSON.stringify({ ok: false, error: { code: err.code ?? 'ERROR', message: redact(err.message) } }));
    process.exitCode = 1;
  });
}

module.exports = {
  runMomoContactSync,
  main,
  scriptRunId,
};
