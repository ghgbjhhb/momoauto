'use strict';

/**
 * 中枢业务任务执行适配器 (Brain Task Execution Adapters)
 *
 * 遵循中枢执行计划第 10、11 节与 B5/B6 门禁：
 * 1. 回复闭环适配 (runReply)：调用已验收的 runMomoAiReplyOnce，映射结构化结果，不另起发送链路。
 * 2. 招呼适配 (runGreetings)：cycles=1，受限配额，检查 rateLimited 阻断并自动设置调度器冷却时间 (cooldownUntil)。
 * 3. 首页浏览适配 (runBrowse)：cycles=1，软时间片限制 (maxIdleOffListMs)，完成后由 PageRecovery 安全切回消息列表。
 * 4. 不确定性核验 (verifyUncertain)：对先前处于 uncertain 状态的回复任务进行只读观察核验，绝不自动重发。
 */

const { runMomoAiReplyOnce } = require('../workflows/momo-ai-reply');
const { processMomoGreetings } = require('../tools/momo/greetings');
const { browseMomoHome } = require('../tools/momo/home-feed');
const { recoverToAllowedPage } = require('../automation/page-recovery');
const { observePage } = require('../automation/page-service');
const { verifyChatScreenAndTarget, newOwnBubble } = require('../tools/momo/chat-detail-parser');

async function runReply(deviceId, task, sessionContext, options = {}) {
  const checkpoint = task.checkpointJson ? (typeof task.checkpointJson === 'string' ? JSON.parse(task.checkpointJson) : task.checkpointJson) : {};
  const contactName = checkpoint.contactName || null;
  const mode = options.mode || 'observe';

  const client = sessionContext.tools?.device?.client || sessionContext.client;
  const result = await runMomoAiReplyOnce(client, deviceId, {
    mode,
    contactName,
    signal: options.signal,
    fetchFn: options.fetchFn,
    leaseToken: sessionContext.leaseToken,
    parentSessionId: sessionContext.sessionId,
    tools: sessionContext.tools,
    control: sessionContext.control,
    assertActive: sessionContext.assertActive
  });

  return {
    ok: result.ok,
    status: result.status,
    outcome: result.data?.outcome || 'unknown',
    data: result.data
  };
}

async function runGreetings(deviceId, task, sessionContext, options = {}) {
  if (options.mode !== 'execute') return { ok: true, status: 'planned', outcome: 'mode_blocked' };
  const tools = sessionContext.tools;
  if (!tools) {
    return { ok: false, error: 'No tools provider available for greetings' };
  }

  const maxApproved = options.maxApproved ?? 2;
  const res = await tools.processMomoGreetings({
    execute: true,
    timeoutMs: options.maxIdleOffListMs ?? 15000,
    cycles: 1,
    maxApproved,
    signal: options.signal
  });

  // 如果遇到风控提示 (rateLimited)，返回冷却标识供调度器更新
  const rateLimited = res.data?.rateLimited === true || res.data?.outcome === 'rate_limited';

  // 无论处理与否，完成后安全恢复回消息列表
  const recovered = rateLimited || !res.ok ? null : await recoverToAllowedPage(sessionContext, ['message_list'], { signal: options.signal });

  return {
    ok: res.ok && (rateLimited || recovered?.status === 'reached_target'),
    rateLimited,
    approvedCount: res.data?.totalApproved || 0,
    rejectedCount: res.data?.totalRejected || 0,
    data: res.data
  };
}

async function runBrowse(deviceId, task, sessionContext, options = {}) {
  if (options.mode !== 'execute') return { ok: true, status: 'planned', outcome: 'mode_blocked' };
  const tools = sessionContext.tools;
  if (!tools) {
    return { ok: false, error: 'No tools provider available for browsing' };
  }

  // 执行单轮首页随机浏览
  const res = await tools.browseMomoHome({
    execute: true,
    timeoutMs: options.maxIdleOffListMs ?? 15000,
    cycles: 1,
    signal: options.signal
  });

  // 浏览完成后，由统一恢复器安全切回消息列表
  const recovered = !res.ok ? null : await recoverToAllowedPage(sessionContext, ['message_list'], { signal: options.signal });

  return {
    ok: res.ok && recovered?.status === 'reached_target',
    data: res.data
  };
}

async function verifyUncertain(deviceId, task, sessionContext, options = {}) {
  const checkpoint = task.checkpointJson ? (typeof task.checkpointJson === 'string' ? JSON.parse(task.checkpointJson) : task.checkpointJson) : {};
  const replyJobId = task.replyJobId || checkpoint.replyJobId;

  if (!replyJobId) {
    return { ok: false, status: 'failed', error: 'MISSING_REPLY_JOB_ID' };
  }

  let replyStore = sessionContext.replyStore;
  let localDb = null;
  if (!replyStore) {
    const { MomoDatabase, getDeviceDatabasePath } = require('../tools/momo/db');
    const { ReplyStore } = require('../tools/momo/reply-store');
    localDb = new MomoDatabase(getDeviceDatabasePath(deviceId));
    replyStore = new ReplyStore(localDb);
  }

  try {
    const job = replyStore.getReplyJob(replyJobId);
    if (!job) {
      return { ok: false, status: 'failed', error: 'REPLY_JOB_NOT_FOUND' };
    }

    const conv = replyStore.db.prepare('SELECT * FROM ai_conversations WHERE id=?').get(job.conversationId);
    if (conv?.deviceId !== String(deviceId)) return { ok: false, status: 'failed', error: 'REPLY_DEVICE_MISMATCH' };
    if (job.state === 'own_bubble_observed') {
      return { ok: true, status: 'own_bubble_observed', alreadyObserved: true };
    }
    if (!['send_attempted', 'uncertain'].includes(job.state)) {
      return { ok: false, status: 'failed', error: 'REPLY_NOT_AWAITING_VERIFICATION' };
    }

    // 只读观察当前聊天画面
    let selfBubble = false;
    try {
      const before = job.sendEvidenceJson ? JSON.parse(job.sendEvidenceJson) : null;
      if (conv?.deviceId === String(deviceId) && before?.deviceId === String(deviceId) && before.expectedPeer === conv.contactName) {
        const obs = await observePage({ ...sessionContext, deviceId: String(deviceId) }, { signal: options.signal });
        if (obs.ok && obs.page === 'chat_detail' && obs.overlay === 'none') {
          verifyChatScreenAndTarget(obs.evidence.ocrData, obs.evidence.detailRaw, conv.contactName);
          selfBubble = newOwnBubble(before.beforeMessages, obs, job.replyText,
            { expandedViewport: before.expandedViewport === true });
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }

    if (selfBubble) {
      const committed = replyStore.updateReplyJobState(job.id, job.state, 'own_bubble_observed', {
        outcome: 'reconciled_observed'
      });
      if (!committed) return { ok: false, status: 'uncertain', reason: 'confirmation_commit_failed', replyJobId: job.id };
      return {
        ok: true,
        status: 'own_bubble_observed',
        replyJobId: job.id
      };
    } else {
      replyStore.updateReplyJobState(job.id, job.state, 'uncertain', {
        outcome: 'unconfirmed_after_recheck'
      });
      return {
        ok: false,
        status: 'uncertain',
        reason: 'own_bubble_not_observed',
        replyJobId: job.id
      };
    }
  } finally {
    if (localDb) {
      try { localDb.close(); } catch {}
    }
  }
}

module.exports = {
  runReply,
  runGreetings,
  runBrowse,
  verifyUncertain
};
