'use strict';

/**
 * MOMO AI 自动回复工作流
 *
 * 核心执行流程：
 * 1. 参数与权限校验：检查联系人名称与执行模式（execute / draft），获取设备互斥写锁；
 * 2. 界面就绪与截图：建立控制通道，记录起始聊天页面截图 (01-initial.png)；
 * 3. 历史加载：直接从本地 SQLite 数据库读取该联系人的历史对话；
 * 4. AI 生成：调用大模型 API 生成生活化回复文本；
 * 5. 模拟输入：通过拼音输入法键入文本并校验（支持首屏未命中时的剪贴板兜底输入）；
 * 6. 发送与后处理：
 *    - execute 模式：点击发送，按返回键收起软键盘，记录结果截图 (03-after-send.png)，并将消息写入本地数据库；
 *    - draft 模式：只保留输入框草稿，不点击发送，不写入数据库；
 * 7. 资源释放：确保互斥锁与通信连接被安全释放。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { YunmomoClient } = require('../index');
const { PROJECT_ROOT, redact } = require('../automation/runtime');
const { checkSignal, waitFor, sleep } = require('../automation/cancellation');
const { timed, timedScript } = require('../automation/timing');
const { defaultArbiter } = require('../server/device-arbiter');
const { MomoDatabase, getDeviceDatabasePath } = require('../tools/momo/db');
const { getEffectiveConfig } = require('../ai/config');
const { generateReply } = require('../ai/reply-service');

const DESCRIPTION = 'MOMO AI 自动回复：读取本地聊天记录，生成回复并模拟打字发送（含全程截图）';

// 常量配置
const TIMEOUTS = Object.freeze({
  CONTROL_CONNECT_MS: 10000,
  KEYBOARD_SETTLE_MS: 400,
  CLEANUP_MS: 5000,
  MAX_SCREENSHOT_DIM: 1280
});

// 联系方式话术连发：段间隔随机模拟真人节奏，发完自动拉黑
const HANDOFF = Object.freeze({
  MIN_SEGMENT_GAP_MS: 1500,
  MAX_SEGMENT_GAP_MS: 3000,
  BLOCK_TIMEOUT_MS: 60000
});

const MODES = Object.freeze({
  EXECUTE: 'execute',
  DRAFT: 'draft',
  OBSERVE: 'observe',
  PLAN: 'plan'
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
 * 采集关键里程碑截图并存盘
 */
async function captureMilestoneScreenshot(phone, tools, dir, filename, desc) {
  try {
    let imgBuf = null;
    if (typeof tools?.screenshot === 'function') {
      const res = await tools.screenshot({ source: 'stream', maxSize: TIMEOUTS.MAX_SCREENSHOT_DIM }).catch(() => null);
      if (res?.data?.image) imgBuf = res.data.image;
    }
    if (!imgBuf && typeof phone?.screenshot === 'function') {
      const res = await phone.screenshot({ level: 2 }).catch(() => null);
      if (res?.data) imgBuf = res.data;
    }
    if (imgBuf) {
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${filename}.png`);
      await fs.writeFile(filePath, imgBuf);
      console.log(`【截图记录】：${desc} -> ${filePath}`);
      return { filename: `${filename}.png`, desc, path: filePath, time: new Date().toISOString() };
    }
  } catch {
    // 截图属于辅助观测功能，异常不阻断核心业务流程
  }
  return null;
}

/**
 * 获取设备互斥写锁或借用父级租约
 */
function acquireWorkflowLock(deviceId, runId, options = {}) {
  // 仅显式持有父级租约的内部任务允许借用；独立请求必须排他申请。
  const parentToken = options.leaseToken;
  if (parentToken) {
    const borrowRes = defaultArbiter.borrowLease(deviceId, parentToken, runId);
    if (borrowRes.ok) return borrowRes;
  }
  return defaultArbiter.acquireDevice(deviceId, runId, { returnLease: true });
}

/**
 * 发送成功后自动将发出的消息写入本地数据库并更新联系人
 */
function persistSentMessage(momoDb, deviceId, contactName, text) {
  if (!momoDb || !contactName || !text) return false;
  try {
    const contact = momoDb.upsertContact({
      name: contactName,
      deviceId,
      lastMessage: text,
      syncedAt: new Date().toISOString()
    });
    if (contact?.id) {
      momoDb.saveMessages(contact.id, contactName, [{
        sender: 'self',
        text,
        time: ''
      }]);
      return true;
    }
  } catch {}
  return false;
}

/**
 * 安全清理释放会话持有的各项硬件与数据库资源
 */
async function releaseResources({ tools, ownsTools, control, ownsControl, momoDb, deviceId, lease }) {
  let cleanupFailed = false;
  if (ownsTools) {
    try { await waitFor(tools?.close?.(), { timeoutMs: TIMEOUTS.CLEANUP_MS }); }
    catch { cleanupFailed = true; }
  }
  if (ownsControl) {
    try { await waitFor(control?.close?.(), { timeoutMs: TIMEOUTS.CLEANUP_MS }); }
    catch { cleanupFailed = true; }
  }
  if (momoDb) {
    try { momoDb.close(); } catch {}
  }
  if (cleanupFailed) {
    defaultArbiter.quarantineDevice(deviceId, 'Reply control cleanup not confirmed');
  } else if (lease) {
    defaultArbiter.releaseLease(lease);
  }
}

/**
 * 构建规范化成功报告
 */
function buildSuccessReport({ runId, mode, contactName, replyText, sendState, screenshotsDir, screenshots, isDraft, aiMetadata = null, outcome = null, handoff = null }) {
  const reportData = {
    ok: true,
    runId,
    mode,
    contactName,
    replyText,
    sendState,
    screenshotsDir,
    screenshots,
    aiMetadata,
    outcome: outcome || (isDraft ? 'draft_typed' : 'reply_observed'),
    error: null
  };
  if (handoff) reportData.handoff = handoff;
  return {
    ok: true,
    status: 'completed',
    ...reportData,
    data: reportData
  };
}

/**
 * 构建规范化失败报告
 */
function buildFailureReport({ runId, mode, contactName, screenshotsDir, screenshots, error, outcome = 'failed', sendState = 'not_started', aiMetadata = null, handoff = null }) {
  const errCode = error?.code || 'EXECUTION_FAILED';
  const errMsg = error?.message ? redact(error.message) : errCode;
  const reportData = {
    ok: false,
    runId,
    mode,
    contactName,
    sendState,
    screenshotsDir,
    screenshots,
    aiMetadata,
    outcome,
    error: { code: errCode, message: errMsg }
  };
  if (handoff) reportData.handoff = handoff;
  return {
    ok: false,
    status: (outcome === 'needs_review' || outcome === 'handoff_uncertain') ? 'partial' : 'failed',
    ...reportData,
    data: reportData
  };
}

function randomSegmentGapMs() {
  return HANDOFF.MIN_SEGMENT_GAP_MS + Math.floor(Math.random() * (HANDOFF.MAX_SEGMENT_GAP_MS - HANDOFF.MIN_SEGMENT_GAP_MS + 1));
}

/**
 * 联系方式话术连发执行器：逐段打字发送并核验，段间随机等待。
 * 任一段发送状态未知 -> 立即停止，绝不重发，标记 uncertain 待复核。
 */
async function runContactHandoff({ tools, phone, momoDb, deviceId, contactName, segments, screenshotsDir, screenshots, signal, check }) {
  logLive('5/6', `意向判定：触发联系方式话术连发（共 ${segments.length} 段，发完自动拉黑）`);
  let sentSegments = 0;

  for (let i = 0; i < segments.length; i++) {
    const segmentText = segments[i];
    logLive('5/6', `发送话术第 ${i + 1}/${segments.length} 段...`);
    let sent;
    if (typeof tools?.sendChatMessage === 'function') {
      sent = await tools.sendChatMessage(segmentText, {
        expectedPeer: contactName,
        execute: true,
        verifyChatPage: true,
        signal,
        assertActive: check
      });
      check();
    } else {
      throw Object.assign(new Error('聊天发送工具不可用'), { code: 'SEND_TOOL_UNAVAILABLE' });
    }

    const sendState = sent?.data?.sendState || 'not_started';
    if (!(sent.ok && sendState === 'own_bubble_observed')) {
      // 三态中的"未知"：停止后续发送，绝不重发，标记待复核
      const shotErr = await captureMilestoneScreenshot(phone, tools, screenshotsDir, `02-handoff-uncertain-seg${i + 1}`, `话术第 ${i + 1} 段发送未确认现场`);
      if (shotErr) screenshots.push(shotErr);
      try { momoDb.updateHandoffState(contactName, 'uncertain'); } catch {}
      logLive('ERROR', `话术第 ${i + 1} 段发送状态未知 (${sendState})，已停止后续发送并标记待复核，绝不重发`);
      return { ok: false, outcome: 'handoff_uncertain', sentSegments, failedSegment: i + 1, sendState, error: sent?.error || { code: 'SEND_UNCERTAIN' } };
    }

    sentSegments++;
    if (!persistSentMessage(momoDb, deviceId, contactName, segmentText)) {
      try { momoDb.updateHandoffState(contactName, 'uncertain'); } catch {}
      return { ok: false, outcome: 'handoff_uncertain', sentSegments,
        failedSegment: i + 1, sendState: 'own_bubble_observed',
        error: { code: 'PERSIST_FAILED', message: '话术已发送，但本地消息写入失败，需人工复核' } };
    }
    const shotSeg = await captureMilestoneScreenshot(phone, tools, screenshotsDir, `02-handoff-seg${i + 1}`, `话术第 ${i + 1} 段发送成功现场`);
    if (shotSeg) screenshots.push(shotSeg);
    logLive('5/6', `第 ${i + 1} 段已确认上屏`);

    if (i < segments.length - 1) {
      const gapMs = randomSegmentGapMs();
      logLive('5/6', `随机等待 ${gapMs}ms 后连发下一段...`);
      await sleep(gapMs, signal).catch(() => {});
      check();
    }
  }

  try { momoDb.updateHandoffState(contactName, 'sent'); } catch {}
  return { ok: true, outcome: 'handoff_sent', sentSegments };
}

/**
 * 话术全部确认上屏后的自动拉黑：拉黑失败不回滚话术，标记保持 sent 并提示人工处理
 */
async function runAutoBlockAfterHandoff({ tools, momoDb, contactName, signal }) {
  logLive('6/6', '话术发送完毕，开始执行自动拉黑...');
  try {
    const blockRes = typeof tools?.blockPeer === 'function'
      ? await tools.blockPeer({ execute: true, timeoutMs: HANDOFF.BLOCK_TIMEOUT_MS, signal })
      : null;
    const outcome = blockRes?.data?.outcome || null;
    if (blockRes?.ok) {
      try { momoDb.updateHandoffState(contactName, 'blocked'); } catch {}
      logLive('6/6', outcome === 'already_blocked_ui' ? '对方已在黑名单中，无需重复拉黑' : '自动拉黑确认已点击完成');
      return { ok: true, outcome: outcome === 'already_blocked_ui' ? 'already_blocked' : 'blocked' };
    }
    try { momoDb.updateHandoffState(contactName, 'sent'); } catch {}
    logLive('WARN', `自动拉黑未成功 (${blockRes?.error?.code || 'BLOCK_FAILED'})，话术已发送；请手动处理该联系人`);
    return { ok: false, error: { code: blockRes?.error?.code || 'BLOCK_FAILED', message: blockRes?.error?.message || null } };
  } catch (err) {
    try { momoDb.updateHandoffState(contactName, 'sent'); } catch {}
    logLive('WARN', `自动拉黑异常: ${err?.message || err}；请手动处理该联系人`);
    return { ok: false, error: { code: err?.code || 'BLOCK_FAILED', message: err?.message || null } };
  }
}

/**
 * 单次执行 MOMO AI 自动回复工作流
 */
async function runMomoAiReplyOnce(client, deviceId, options = {}) {
  // 1. 参数与模式预检
  const rawMode = options.mode ?? MODES.EXECUTE;
  if (rawMode && !Object.values(MODES).includes(rawMode)) {
    throw Object.assign(new Error(`Invalid mode: ${rawMode}`), { code: 'INVALID_MODE' });
  }
  const mode = rawMode === MODES.DRAFT ? MODES.DRAFT :
               rawMode === MODES.OBSERVE ? MODES.OBSERVE :
               rawMode === MODES.PLAN ? MODES.PLAN : MODES.EXECUTE;
  const contactName = (options.contactName || '').trim();
  if (mode !== MODES.PLAN && !contactName) {
    throw Object.assign(new Error('contactName is required for a targeted reply'), { code: 'CONTACT_REQUIRED' });
  }
  checkSignal(options.signal);

  const modeDesc = mode === MODES.DRAFT ? 'draft（仅打字不发送）' :
                   mode === MODES.OBSERVE ? 'observe（仅同步观测）' : 'execute（正常发送）';
  logLive('1/6', `任务启动: 目标联系人 [${contactName}], 模式: ${modeDesc}`);

  const runId = options.runId || 'run_' + randomUUID();
  const screenshotsDir = options.screenshotsDir || path.join(PROJECT_ROOT, '.local-output', 'momo-ai-reply', runId);
  const screenshots = [];

  // 2. 获取设备单写互斥锁
  const lockRes = acquireWorkflowLock(deviceId, runId, options);
  if (!lockRes.ok) {
    const err = { code: lockRes.reason || 'DEVICE_BUSY' };
    logLive('1/6', `获取设备写锁失败: ${err.code}`);
    return { ok: false, status: 'failed', mode, contactName, error: err,
      data: { ok: false, mode, contactName, error: err } };
  }
  const lease = lockRes.lease;
  logLive('1/6', `成功持有设备 ${deviceId} 互斥控制写锁`);

  // 计划模式：验证锁与参数后立即安全退出
  if (mode === MODES.PLAN) {
    defaultArbiter.releaseLease(lease);
    logLive('1/6', '计划模式就绪，安全退出');
    const planData = { ok: true, status: 'planned', mode, contactName, outcome: 'plan_ready' };
    return { ...planData, data: planData };
  }

  const check = () => {
    checkSignal(options.signal);
    defaultArbiter.assertLease(lease);
    options.assertActive?.();
  };

  let momoDb = null;
  let control = null;
  let tools = null;
  let phone = null;
  let ownsControl = false;
  let ownsTools = false;

  try {
    check();
    phone = client?.device ? client.device(deviceId) : null;
    if (options.control) {
      control = options.control;
      logLive('2/6', '使用外部注入的控制连接');
    } else if (phone?.openControl) {
      logLive('2/6', '正在建立云机控制通道...');
      control = await phone.openControl();
      ownsControl = true;
      await waitFor(control.connect({ timeoutMs: TIMEOUTS.CONTROL_CONNECT_MS }), {
        signal: options.signal,
        timeoutMs: TIMEOUTS.CONTROL_CONNECT_MS
      });
      logLive('2/6', '云机控制通道连接成功');
    }
    check();

    if (control && (!control.connected || !control.ready)) {
      throw Object.assign(new Error('Control is not ready'), { code: 'NOT_CONNECTED' });
    }

    tools = options.tools || phone?.tools?.({ control });
    ownsTools = !options.tools;

    // ── 截图里程碑 ①：起始聊天界面 ──
    logLive('2/6', '正在捕获起始聊天界面...');
    const shot1 = await captureMilestoneScreenshot(phone, tools, screenshotsDir, '01-initial', '起始聊天界面');
    if (shot1) screenshots.push(shot1);

    // 3. 历史对话加载（直接从真实业务数据表 messages 中读取最新抓取的所有历史）
    logLive('3/6', `正在检索 [${contactName}] 的本地历史消息...`);
    momoDb = new MomoDatabase(options.dbPath || getDeviceDatabasePath(deviceId));
    const history = momoDb.getMessagesByContactName(contactName) || [];
    const lastMsg = history.length > 0 ? history[history.length - 1] : null;
    const lastMsgText = lastMsg ? (lastMsg.text || '') : '';
    logLive('3/6', `历史对话加载完成，共 ${history.length} 条记录${lastMsgText ? ` (最新消息: “${lastMsgText}”)` : ''}`);

    // 对话进度：我方累计发送句数 + 固化意向（contactIntent 一经判定为真永久保持，防后续轮次误判回退）
    const selfSentCount = history.filter(m => m.sender === 'self').length;
    const contactRecord = momoDb.getContactByName(contactName);
    const stickyContactIntent = contactRecord?.contactIntent === 1;
    logLive('3/6', `对话进度：我方已发送 ${selfSentCount} 句${stickyContactIntent ? '，对方联系方式意向已确认' : ''}`);

    if (mode === MODES.OBSERVE) {
      logLive('3/6', '观测模式完成：消息已入库，不调用大模型');
      return buildSuccessReport({
        runId,
        mode,
        contactName,
        replyText: '',
        sendState: 'not_started',
        screenshotsDir,
        screenshots,
        isDraft: false,
        outcome: 'observed'
      });
    }

    // 4. 实时调用大模型生成全新回复（每次调用均独立思考，绝不复用旧回复）
    check();
    const configSnapshot = getEffectiveConfig(deviceId, options.userId || process.env.YUNMOMO_USER_ID);
    logLive('4/6', '正在调用大模型生成全新的回复内容...');
    const genStart = Date.now();
    let generated = null;
    let aiMetadata = null;
    let replyText = '';

    if (mode !== MODES.OBSERVE) {
      generated = await generateReply(history, configSnapshot, {
        deviceId,
        signal: options.signal,
        fetchFn: options.fetchFn,
        progress: {
          selfSentCount,
          minSelfMessages: configSnapshot.handoffMinSelfMessages,
          stickyIntent: stickyContactIntent
        }
      });
      replyText = (generated?.text || '').trim();
      if (!replyText) {
        throw Object.assign(new Error('AI generation returned empty reply'), { code: 'EMPTY_REPLY' });
      }
      const genCost = Date.now() - genStart;
      aiMetadata = {
        provider: generated.provider || 'deepseek',
        model: generated.model || 'deepseek-chat',
        requestId: generated.requestId || null,
        usage: generated.usage || null,
        costMs: genCost,
        messageCountUsed: generated.messageCountUsed || 0,
        finishReason: generated.finishReason || null,
        promptMessages: generated.promptMessages || null,
        intent: generated.intent || null
      };

      const usageDetail = aiMetadata.usage
        ? `耗时 ${genCost}ms, Tokens: Prompt=${aiMetadata.usage.prompt_tokens}, Completion=${aiMetadata.usage.completion_tokens}, Total=${aiMetadata.usage.total_tokens}`
        : `耗时 ${genCost}ms`;
      logLive('4/6', `大模型全新回复生成完毕 (${usageDetail}): “${replyText}”`);

      // 意图分析与落库：stage/summary 仅供监控展示，无论是否触发话术都记录
      const intent = generated.intent || { stage: '未知', readyForContactScript: false, summary: '', formatValid: false };
      logLive('4/6', `对方意图 [${intent.stage}]${intent.summary ? `：${intent.summary}` : ''}${intent.formatValid ? '' : '（格式解析失败，已按普通回复降级）'}`);
      try {
        momoDb.updateContactIntent(contactName, {
          lastIntent: intent.summary,
          lastIntentStage: intent.stage,
          contactIntent: intent.readyForContactScript === true ? true : undefined
        });
      } catch {}

      // 归档完整 AI 调用日志 (含真实发送 Prompt 上下文与 Tokens)
      try {
        await fs.mkdir(screenshotsDir, { recursive: true });
        const aiLogPath = path.join(screenshotsDir, '00-ai-call-log.json');
        await fs.writeFile(aiLogPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          runId,
          contactName,
          deviceId,
          ...aiMetadata
        }, null, 2), 'utf8');
        console.log(`【AI日志记录】：调用记录与Prompt已归档 -> ${aiLogPath}`);
      } catch {
        // 辅助观测日志写入异常不阻断核心业务
      }
    }
    check();

    // 4.5 意图分流：意向固化（本轮判定或历史已确认）且我方句数达标 -> 话术连发 + 自动拉黑；否则按普通回复打字发送
    const intent = generated.intent || { stage: '未知', readyForContactScript: false, summary: '', formatValid: false };
    const isDraft = mode === MODES.DRAFT;
    const segments = Array.isArray(configSnapshot.handoffSegments) ? configSnapshot.handoffSegments : [];
    const handoffState = contactRecord?.handoffState || '';
    const effectiveContactIntent = intent.readyForContactScript === true || stickyContactIntent;
    const minSelfMessages = Number(configSnapshot.handoffMinSelfMessages) || 7;

    if (!isDraft && effectiveContactIntent) {
      if (selfSentCount < minSelfMessages) {
        logLive('5/6', `对方有意向，但我方已发送 ${selfSentCount} 句，未达 ${minSelfMessages} 句门槛，按普通升温回复处理`);
      } else if (configSnapshot.handoffEnabled !== true || segments.length === 0) {
        logLive('5/6', '意向已达可发话术阶段，但话术功能未启用或未配置段落，按普通回复处理');
      } else if (handoffState === 'sent' || handoffState === 'blocked') {
        logLive('5/6', `该联系人话术此前已发送 (状态: ${handoffState})，绝不重发，按普通回复处理`);
      } else if (handoffState === 'uncertain') {
        logLive('5/6', '该联系人上次话术发送状态待复核，本次不重发，按普通回复处理');
      } else {
        const handoffRes = await runContactHandoff({
          tools, phone, momoDb, deviceId, contactName,
          segments, screenshotsDir, screenshots,
          signal: options.signal, check
        });
        if (!handoffRes.ok) {
          return buildFailureReport({
            runId,
            mode,
            contactName,
            replyText: segments.slice(0, handoffRes.sentSegments).join(' | '),
            screenshotsDir,
            screenshots,
            error: handoffRes.error,
            outcome: 'handoff_uncertain',
            sendState: handoffRes.sendState,
            aiMetadata,
            handoff: handoffRes
          });
        }
        const blockResult = await runAutoBlockAfterHandoff({ tools, momoDb, contactName, signal: options.signal });
        return buildSuccessReport({
          runId,
          mode,
          contactName,
          replyText: segments.join(' | '),
          sendState: 'own_bubble_observed',
          screenshotsDir,
          screenshots,
          isDraft: false,
          aiMetadata,
          outcome: 'handoff_sent',
          handoff: { segments, sentSegments: handoffRes.sentSegments, block: blockResult }
        });
      }
    }

    // 5. 模拟打字与发送
    logLive('5/6', `开始模拟键盘打字${isDraft ? ' (仅草稿模式)' : '并发送'}...`);
    let sent;
    let shot2Taken = false;
    if (typeof tools?.sendChatMessage === 'function') {
      sent = await tools.sendChatMessage(replyText, {
        expectedPeer: contactName,
        execute: true,
        typeOnly: isDraft,
        verifyChatPage: true,
        signal: options.signal,
        assertActive: check,
        onDraftFrame: async (draftFrame) => {
          if (draftFrame?.shot?.image) {
            try {
              await fs.mkdir(screenshotsDir, { recursive: true });
              const filePath = path.join(screenshotsDir, '02-after-typing.png');
              await fs.writeFile(filePath, draftFrame.shot.image);
              const desc = '输入完成后的画面';
              console.log(`【截图记录】：${desc} -> ${filePath}`);
              screenshots.push({ filename: '02-after-typing.png', desc, path: filePath, time: new Date().toISOString() });
              shot2Taken = true;
            } catch {}
          }
        }
      });
      check();
    } else {
      throw Object.assign(new Error('聊天发送工具不可用'), { code: 'SEND_TOOL_UNAVAILABLE' });
    }

    const sendState = sent.data?.sendState || 'not_started';
    const expectedState = isDraft ? 'draft_verified' : 'own_bubble_observed';
    const isSuccess = Boolean(sent.ok && sendState === expectedState);

    if (isSuccess) {
      logLive('5/6', `输入框内容核验一致 (状态: ${sendState})`);
      // 若之前未在 onDraftReady 中截取，则补录
      if (!shot2Taken) {
        const shot2 = await captureMilestoneScreenshot(phone, tools, screenshotsDir, '02-after-typing', '输入完成后的画面');
        if (shot2) screenshots.push(shot2);
      }

      // execute 模式：智能收起键盘（若已收起则不按），保持留在当前聊天页，绝不退回消息列表
      if (!isDraft) {
        logLive('6/6', '己方消息已确认送达上屏');
        const shot3 = await captureMilestoneScreenshot(phone, tools, screenshotsDir, '03-after-send', '点击发送成功后的结果画面（停留在当前聊天页）');
        if (shot3) screenshots.push(shot3);
        logLive('6/6', '正在将已发出的消息写入本地数据库...');
        if (!persistSentMessage(momoDb, deviceId, contactName, replyText)) {
          return buildFailureReport({
            runId, mode, contactName, screenshotsDir, screenshots,
            error: { code: 'PERSIST_FAILED', message: '消息已发送，但本地历史写入失败，需人工复核' },
            outcome: 'needs_review', sendState: 'own_bubble_observed', aiMetadata
          });
        }
        logLive('6/6', '本地数据库落库完成');
      } else {
        logLive('6/6', '草稿已保留在输入框中 (draft模式未发送、未落库)');
      }

      return buildSuccessReport({
        runId,
        mode,
        contactName,
        replyText,
        sendState,
        screenshotsDir,
        screenshots,
        isDraft,
        aiMetadata
      });
    }

    // ── 失败现场真实截图（绝不伪称“点击发送后结果”） ──
    logLive('5/6', `输入发送未达到预期状态 (预期=${expectedState}, 实际=${sendState})`);
    const shotErr = await captureMilestoneScreenshot(phone, tools, screenshotsDir, '02-failed-scene', `输入发送未完成现场(state=${sendState})`);
    if (shotErr) screenshots.push(shotErr);

    return buildFailureReport({
      runId,
      mode,
      contactName,
      replyText,
      screenshotsDir,
      screenshots,
      error: sent.error || { code: 'SEND_UNCERTAIN' },
      outcome: 'needs_review',
      sendState,
      aiMetadata
    });

  } catch (error) {
    logLive('ERROR', `工作流发生异常: [${error?.code || 'ERROR'}] ${error?.message || error}`);
    const shotErr = await captureMilestoneScreenshot(phone, tools, screenshotsDir, 'error-scene', '异常发生现场');
    if (shotErr) screenshots.push(shotErr);

    if (options.signal?.aborted || error.code === 'LEASE_REVOKED') throw error;
    return buildFailureReport({
      runId,
      mode,
      contactName,
      screenshotsDir,
      screenshots,
      error
    });

  } finally {
    logLive('6/6', '正在释放设备锁与通信通道资源...');
    await releaseResources({ tools, ownsTools, control, ownsControl, momoDb, deviceId, lease });
  }
}

/**
 * 解析 CLI 命令行参数
 */
function parseArgs(argv = process.argv.slice(2)) {
  let mode = MODES.EXECUTE;
  if (argv.includes('--draft') || process.env.YUNMOMO_MOMO_AI_MODE === 'draft') {
    mode = MODES.DRAFT;
  }
  const modeArg = argv.find(a => a.startsWith('--mode='));
  if (modeArg) mode = modeArg.slice('--mode='.length);
  const modeIdx = argv.indexOf('--mode');
  if (modeIdx >= 0 && modeIdx + 1 < argv.length) mode = argv[modeIdx + 1];

  let contactName = null;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--contact' || argv[i] === '--contact-name') && i + 1 < argv.length) {
      contactName = argv[i + 1];
      break;
    }
    if (argv[i].startsWith('--contact=')) {
      contactName = argv[i].slice('--contact='.length);
      break;
    }
    if (argv[i].startsWith('--contact-name=')) {
      contactName = argv[i].slice('--contact-name='.length);
      break;
    }
  }
  if (!contactName && process.env.YUNMOMO_MOMO_CONTACT_NAME?.trim()) {
    contactName = process.env.YUNMOMO_MOMO_CONTACT_NAME.trim();
  }

  return { mode, contactName };
}

/**
 * 格式化并打印控制台终端执行总结
 */
function printExecutionSummary(result, { contactName, mode }) {
  console.log('\n' + '='.repeat(60));
  console.log('【任务】：MOMO AI 自动回复');
  console.log(`【目标联系人】：${contactName || '未指定'}`);
  console.log(`【模式】：${mode === MODES.DRAFT ? 'draft（仅打字不发送）' : 'execute（正常发送）'}`);
  console.log(`【生成回复内容】：${result.replyText || '无'}`);
  if (result.aiMetadata) {
    const meta = result.aiMetadata;
    const usageStr = meta.usage
      ? `Prompt=${meta.usage.prompt_tokens}, Completion=${meta.usage.completion_tokens}, Total=${meta.usage.total_tokens}`
      : '无统计';
    console.log(`【AI 调用审计】：模型: ${meta.model || '未知'}, Tokens: [${usageStr}], RequestID: ${meta.requestId || '无'}`);
  }
  console.log(`【执行结果】：${result.ok ? '成功' : '失败'}`);
  if (result.screenshots?.length) {
    console.log(`【截图目录】：${result.screenshotsDir}`);
    for (const shot of result.screenshots) {
      console.log(`  - ${shot.desc}: ${shot.path}`);
    }
  }
  if (!result.ok && result.error) {
    const errDesc = result.error.message
      ? `${result.error.code || 'ERROR'} - ${result.error.message}`
      : (result.error.code || 'ERROR');
    console.log(`【错误信息】：${errDesc}`);
  }
  console.log('='.repeat(60) + '\n');
}

/**
 * 命令行脚本入口
 */
async function main(argv = process.argv.slice(2)) {
  const { mode, contactName } = parseArgs(argv);

  const deviceId = process.env.YUNMOMO_DEVICE_ID;
  if (!deviceId) {
    console.error(JSON.stringify({
      ok: false,
      error: { code: 'DEVICE_ID_MISSING', message: 'YUNMOMO_DEVICE_ID environment variable is required' }
    }));
    process.exitCode = 1;
    return;
  }

  const client = new YunmomoClient();
  const result = await runMomoAiReplyOnce(client, deviceId, { mode, contactName });

  const outputDir = path.join(PROJECT_ROOT, '.local-output', 'momo-ai-reply');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, `run-${Date.now()}.json`), JSON.stringify(result, null, 2), 'utf8');

  printExecutionSummary(result, { contactName, mode });

  if (!result.ok) process.exitCode = 1;
}

const timedRun = timed('workflow.momoAiReply', runMomoAiReplyOnce,
  (_client, deviceId, options) => ({ deviceId, runId: options?.runId }));
main = require('../automation/timing').timedScript('script.src.workflows.momo-ai-reply', main);
const timedMain = main;

if (require.main === module) {
  timedMain().catch(err => {
    console.error(JSON.stringify({ ok: false, error: { code: err.code ?? 'ERROR', message: redact(err.message) } }));
    process.exitCode = 1;
  });
}

module.exports = { DESCRIPTION, runMomoAiReplyOnce: timedRun, main: timedMain };
