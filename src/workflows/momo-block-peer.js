'use strict';

/**
 * MOMO 拉黑当前联系人工作流 (MOMO Block Current Peer Workflow)
 *
 * 处理已经打开的 MOMO 聊天详情页（与 13 号入库脚本相同的使用前提）：
 * 1. 核验当前页面确为目标联系人的聊天详情页（顶栏姓名比对，拉黑属破坏性动作，无法确认目标时拒绝执行）；
 * 2. 调用 tools.blockPeer 拉黑执行中枢：点头像 -> 聊天设置点「拉黑」-> 确认弹窗点「拉黑」；
 * 3. 记录拉黑前后现场截图，输出结构化执行摘要。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { YunmomoClient } = require('../index');
const { PROJECT_ROOT, redact } = require('../automation/runtime');
const { sleep, waitFor } = require('../automation/cancellation');
const { defaultArbiter } = require('../server/device-arbiter');
const { observePage } = require('../automation/page-service');
const { extractChatContactName, normalize } = require('../tools/momo/chat-history-sync');

const DESCRIPTION = 'MOMO拉黑当前联系人：核验当前聊天页联系人姓名后执行拉黑（破坏性动作，需双重确认）';

const TIMEOUTS = Object.freeze({
  CONTROL_CONNECT_MS: 10000,
  CLEANUP_MS: 5000,
  BLOCK_MS: 60000,
  MAX_SCREENSHOT_DIM: 1280
});

function getTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logLive(step, message) {
  const prefix = step ? `[${step}] ` : '';
  console.log(`[${getTimestamp()}] ${prefix}${message}`);
}

/**
 * 采集现场截图并存盘（辅助观测，异常不阻断主流程）
 */
async function captureEvidenceScreenshot(tools, dir, filename, desc) {
  if (!dir) return null;
  try {
    const shot = await tools?.screenshot?.({ source: 'stream', maxSize: TIMEOUTS.MAX_SCREENSHOT_DIM }).catch(() => null);
    const imgBuf = shot?.data?.image || (Buffer.isBuffer(shot?.data) ? shot.data : null);
    if (!imgBuf) return null;
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${filename}.png`);
    await fs.writeFile(filePath, imgBuf);
    console.log(`【截图记录】：${desc} -> ${filePath}`);
    return { filename: `${filename}.png`, desc, path: filePath, time: new Date().toISOString() };
  } catch {
    return null;
  }
}

/**
 * 单次执行拉黑当前联系人工作流
 */
async function runMomoBlockPeerOnce(client, deviceId, options = {}) {
  const contactName = (options.contactName || '').trim();
  if (!contactName) {
    throw Object.assign(new Error('拉黑前必须指定联系人姓名以核验当前聊天页'), { code: 'CONTACT_REQUIRED' });
  }
  const signal = options.signal;
  const runId = options.runId || 'block_' + Date.now();
  const screenshotsDir = options.screenshotsDir || path.join(PROJECT_ROOT, '.local-output', 'momo-block-peer', runId);
  const screenshots = [];

  logLive('1/4', `任务启动: 拉黑联系人 [${contactName}] (前提: 云机已停留在该聊天页)`);

  // 1. 获取设备单写互斥锁
  const leaseRes = defaultArbiter.acquireDevice(deviceId, runId, { returnLease: true });
  if (!leaseRes.ok) {
    const err = { code: leaseRes.reason || 'DEVICE_BUSY' };
    logLive('1/4', `获取设备写锁失败: ${err.code}`);
    return { ok: false, contactName, error: err, data: { ok: false, contactName, error: err } };
  }
  const lease = leaseRes.lease;
  logLive('1/4', `成功持有设备 ${deviceId} 互斥控制写锁`);

  let control = null;
  let tools = null;
  let phone = null;

  try {
    phone = client.device(deviceId);
    logLive('2/4', '正在建立云机控制通道...');
    control = await phone.openControl();
    await waitFor(control.connect({ timeoutMs: TIMEOUTS.CONTROL_CONNECT_MS }), {
      signal,
      timeoutMs: TIMEOUTS.CONTROL_CONNECT_MS
    });
    if (!control.connected || !control.ready) {
      throw Object.assign(new Error('Control is not ready'), { code: 'NOT_CONNECTED' });
    }
    tools = phone.tools({ control });
    const pool = tools._recognitionPool;

    // 2. 核验当前聊天页与目标联系人（拉黑不可逆，无法确认目标一律拒绝）
    logLive('2/4', `正在核验当前页面是否为 [${contactName}] 的聊天详情页...`);
    const obs = await observePage({ tools, control, deviceId, pool }, { signal, timeoutMs: 10000 });
    if (!obs?.ok) {
      throw Object.assign(new Error('页面观测失败，无法确认当前处于聊天页'), { code: 'OBSERVE_FAILED' });
    }
    const inChat = obs.page === 'chat_detail' || obs.evidence?.pageRaw?.sub_page === 'chat_detail';
    if (!inChat) {
      throw Object.assign(new Error(`当前不在聊天详情页 (当前页面: ${obs.page || '未知'})，请先手动进入目标聊天页再执行拉黑`),
        { code: 'NOT_IN_CHAT' });
    }
    const topTitle = extractChatContactName(obs.evidence?.ocrData);
    if (!topTitle || normalize(topTitle) !== normalize(contactName)) {
      throw Object.assign(new Error(`顶栏联系人 [${topTitle || '未识别'}] 与目标 [${contactName}] 不一致，拒绝拉黑以防止误操作`),
        { code: 'TARGET_MISMATCH' });
    }
    logLive('2/4', `目标核验通过: 顶栏联系人 [${topTitle}] 与目标一致`);

    const shot1 = await captureEvidenceScreenshot(tools, screenshotsDir, '01-before-block', '拉黑执行前现场');
    if (shot1) screenshots.push(shot1);

    // 3. 调用拉黑执行中枢：点头像 -> 聊天设置「拉黑」-> 确认弹窗「拉黑」
    logLive('3/4', '开始执行拉黑流程 (点头像 -> 聊天设置 -> 确认拉黑)...');
    const result = await tools.blockPeer({
      execute: true,
      timeoutMs: TIMEOUTS.BLOCK_MS,
      signal
    });
    checkResult(result);

    const shot2 = await captureEvidenceScreenshot(tools, screenshotsDir, '02-after-block', '拉黑执行后现场');
    if (shot2) screenshots.push(shot2);

    const outcome = result.data?.outcome || 'confirmation_clicked';
    const alreadyBlocked = outcome === 'already_blocked_ui';
    const confirmed = outcome === 'blocked_confirmed';
    logLive('4/4', alreadyBlocked
      ? '对方已在黑名单中 (聊天设置里已是解除拉黑入口)，无需重复拉黑'
      : confirmed
        ? '拉黑成功 toast 已确认，对方已被加入黑名单'
        : '拉黑确认已点击完成 (toast 未捕获，结果待核验)');

    return {
      ok: true,
      status: 'completed',
      contactName,
      outcome: alreadyBlocked ? 'already_blocked' : confirmed ? 'blocked_confirmed' : 'blocked',
      screenshotsDir,
      screenshots,
      data: { ok: true, contactName, outcome: alreadyBlocked ? 'already_blocked' : confirmed ? 'blocked_confirmed' : 'blocked', blockPeerReport: result.data || null }
    };
  } catch (error) {
    logLive('ERROR', `拉黑工作流异常: [${error?.code || 'ERROR'}] ${error?.message || error}`);
    if (tools) {
      const shotErr = await captureEvidenceScreenshot(tools, screenshotsDir, 'error-scene', '异常发生现场');
      if (shotErr) screenshots.push(shotErr);
    }
    if (signal?.aborted || error.code === 'LEASE_REVOKED') throw error;
    return {
      ok: false,
      status: 'failed',
      contactName,
      screenshotsDir,
      screenshots,
      error: { code: error?.code || 'BLOCK_FAILED', message: error?.message ? redact(error.message) : '拉黑执行失败' },
      data: { ok: false, contactName, error: { code: error?.code || 'BLOCK_FAILED' } }
    };
  } finally {
    logLive('4/4', '正在释放设备锁与通信通道资源...');
    let cleanupFailed = false;
    try { await waitFor(tools?.close?.(), { timeoutMs: TIMEOUTS.CLEANUP_MS }); }
    catch { cleanupFailed = true; }
    try { await waitFor(control?.close?.(), { timeoutMs: TIMEOUTS.CLEANUP_MS }); }
    catch { cleanupFailed = true; }
    if (cleanupFailed) {
      defaultArbiter.quarantineDevice(deviceId, 'Block-peer control cleanup not confirmed');
    } else {
      defaultArbiter.releaseLease(lease);
    }
  }
}

/**
 * 校验 blockPeer 工具返回结果，未成功则抛出结构化错误
 */
function checkResult(result) {
  if (result?.ok) return;
  const err = result?.error || {};
  const message = err.message ? `${err.code || 'BLOCK_FAILED'}: ${err.message}` : 'blockPeer 执行未成功';
  throw Object.assign(new Error(message), { code: err.code || 'BLOCK_FAILED' });
}

/**
 * 打印控制台终端执行总结
 */
function printExecutionSummary(result, { contactName }) {
  console.log('\n' + '='.repeat(60));
  console.log('【任务】：MOMO 拉黑当前联系人');
  console.log(`【目标联系人】：${contactName || '未指定'}`);
  console.log(`【执行结果】：${result.ok ? '成功' : '失败'}`);
  if (result.ok) {
    console.log(`【拉黑状态】：${result.outcome === 'already_blocked' ? '对方已在黑名单中'
      : result.outcome === 'blocked_confirmed' ? '拉黑成功 (toast 已确认)' : '拉黑确认已点击完成'}`);
  }
  if (result.screenshots?.length) {
    console.log(`【截图目录】：${result.screenshotsDir}`);
    for (const shot of result.screenshots) {
      console.log(`  - ${shot.desc}: ${shot.path}`);
    }
  }
  if (!result.ok && result.error) {
    console.log(`【错误信息】：${result.error.code || 'ERROR'} - ${result.error.message || ''}`);
  }
  console.log('='.repeat(60) + '\n');
}

/**
 * 命令行脚本入口
 */
async function main(argv = process.argv.slice(2)) {
  let deviceId = process.env.YUNMOMO_DEVICE_ID;
  let contactName = String(process.env.YUNMOMO_MOMO_CONTACT_NAME || '').trim();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log('MOMO 拉黑当前联系人工作流:');
      console.log('  node flows/momo/18-momo拉黑当前联系人.js [--device-id ID] --contact-name <NAME>');
      console.log('');
      console.log('参数说明:');
      console.log('  --device-id <ID>        目标云机后台 ID (亦可通过环境变量 YUNMOMO_DEVICE_ID 传入)');
      console.log('  --contact-name <NAME>   当前聊天页联系人姓名（必填；执行前必须已打开该聊天页）');
      return;
    } else if (arg === '--device-id') {
      deviceId = argv[++i];
      if (!deviceId || deviceId.startsWith('--')) throw new Error('--device-id 后必须填写云机 ID');
    } else if (arg.startsWith('--device-id=')) {
      deviceId = arg.slice('--device-id='.length);
    } else if (arg === '--contact-name' || arg === '--contact') {
      contactName = argv[++i];
      if (!contactName || contactName.startsWith('--')) throw new Error('--contact-name 后必须填写联系人姓名');
    } else if (arg.startsWith('--contact-name=')) {
      contactName = arg.slice('--contact-name='.length);
    } else if (arg.startsWith('--contact=')) {
      contactName = arg.slice('--contact='.length);
    } else {
      throw new Error('不支持的参数：' + arg + '（请用 --help 查看用法）');
    }
  }

  contactName = contactName.trim();
  if (!contactName) {
    throw Object.assign(new Error('必须通过 --contact-name 指定当前聊天页联系人姓名'), { code: 'CONTACT_REQUIRED' });
  }
  if (!deviceId) {
    throw Object.assign(new Error('执行前必须通过 YUNMOMO_DEVICE_ID 指定目标云机'), { code: 'DEVICE_ID_MISSING' });
  }

  const token = process.env.YUNMOMO_TOKEN?.trim();
  if (!token) {
    throw Object.assign(new Error('执行前必须配置 YUNMOMO_TOKEN 登录凭据'), { code: 'TOKEN_MISSING' });
  }

  const client = new YunmomoClient({ token: token || '' });
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  try {
    const result = await runMomoBlockPeerOnce(client, deviceId, {
      contactName,
      signal: controller.signal
    });
    printExecutionSummary(result, { contactName });
    if (!result.ok) process.exitCode = 1;
    return result;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

module.exports = { DESCRIPTION, runMomoBlockPeerOnce, main };
