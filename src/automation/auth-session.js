'use strict';

/**
 * 微信授权生命周期与 8 分钟超时预算管理模块 (Momo WeChat Auth Session & Lifetime Guard)
 *
 * 核心工程信条（严格依照 GEMINI.md）：
 * 1. 微信授权后在陌陌服务端生成的临时注册/绑定凭据，生命周期严格为 8 分钟（480 秒）；
 * 2. 从点击授权（丫丫一键授权 / 丫丫复扫 / 陌陌微信登录）时刻作为起算原点；
 * 3. 后续资料填写、生日选择、头像上传、手机绑定、验证码获取与打字提交全链路，必须受控于此 8 分钟硬性预算；
 * 4. 严禁超期后盲目提交导致“请重新授权”；
 * 5. 跨脚本、跨会话共享持久化状态与当前剩余可用时长。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { PROJECT_ROOT } = require('./runtime');

const AUTH_BUDGET_MS = 8 * 60 * 1000; // 8 分钟 (480,000 ms)
const AUTH_WARNING_MS = 6.5 * 60 * 1000; // 6.5 分钟紧迫告警线 (390,000 ms)

const AUTH_SESSION_FILE = path.join(PROJECT_ROOT, '.local-output', 'momo-auth-session.json');
const YAYA_HISTORY_FILE = path.join(PROJECT_ROOT, '.local-output', 'yaya-auth-history.json');
const PHONE_BIND_STATE_FILE = path.join(PROJECT_ROOT, '.local-output', 'momo-phone-bind-state.json');

function formatDuration(ms) {
  if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return '0秒';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
  }
  return `${seconds}秒`;
}

/**
 * 记录微信授权启动时间戳
 */
async function recordAuthStart({ deviceId, source = 'yaya', timestamp = Date.now(), extra = {} }) {
  const record = {
    deviceId: String(deviceId || ''),
    source,
    authStartTime: timestamp,
    authStartTimeIso: new Date(timestamp).toISOString(),
    maxBudgetMs: AUTH_BUDGET_MS,
    ...extra,
  };
  try {
    await fs.mkdir(path.dirname(AUTH_SESSION_FILE), { recursive: true });
    await fs.writeFile(AUTH_SESSION_FILE, JSON.stringify(record, null, 2), 'utf8');
  } catch {}
  return record;
}

/**
 * 获取当前设备的微信授权会话信息与剩余时间
 */
async function getAuthSession(deviceId = null) {
  let session = null;
  // 1. 优先读取实时的微信授权会话文件
  try {
    const content = await fs.readFile(AUTH_SESSION_FILE, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && (!deviceId || parsed.deviceId === deviceId)) {
      session = parsed;
    }
  } catch {}

  // 2. 兜底回溯读取丫丫复扫/一键授权历史记录
  if (!session) {
    try {
      const content = await fs.readFile(YAYA_HISTORY_FILE, 'utf8');
      const list = JSON.parse(content);
      if (Array.isArray(list) && list.length > 0) {
        const matched = list.find(it => (!deviceId || it.deviceId === deviceId) && it.clickedAt);
        if (matched) {
          session = {
            deviceId: matched.deviceId,
            source: matched.mode === 'direct' ? 'yaya_direct' : 'yaya_relogin',
            authStartTime: matched.clickedAt,
            authStartTimeIso: matched.clickedAtIso || new Date(matched.clickedAt).toISOString(),
            maxBudgetMs: AUTH_BUDGET_MS,
          };
        }
      }
    } catch {}
  }

  if (!session || !session.authStartTime) {
    return null;
  }

  const now = Date.now();
  const elapsedMs = Math.max(0, now - session.authStartTime);
  const remainingMs = Math.max(0, AUTH_BUDGET_MS - elapsedMs);
  const isExpired = elapsedMs >= AUTH_BUDGET_MS;
  const isUrgent = elapsedMs >= AUTH_WARNING_MS && !isExpired;

  return {
    ...session,
    now,
    elapsedMs,
    remainingMs,
    isExpired,
    isUrgent,
    elapsedFormatted: formatDuration(elapsedMs),
    remainingFormatted: formatDuration(remainingMs),
    budgetFormatted: '8分00秒',
  };
}

/**
 * 输出带有标准格式的微信授权计时状态
 */
async function logAuthBudget(logger, deviceId, stepDesc = '') {
  const session = await getAuthSession(deviceId);
  const logFn = typeof logger?.console === 'function' ? logger.console : console.log;
  const fileFn = typeof logger?.file === 'function' ? logger.file : () => {};

  const stepTag = stepDesc ? ` [阶段: ${stepDesc}]` : '';

  if (!session) {
    logFn(`[微信授权计时] 未检索到前序微信授权记录，当前处于独立运行模式${stepTag}`);
    return null;
  }

  if (session.isExpired) {
    logFn(`[微信授权计时 ⚠️ 严重超时] 距离微信授权已过去 ${session.elapsedFormatted}（已超过 8分00秒 有效期上限）！陌陌服务端临时凭据已失效，若提交极可能提示“请重新授权”！${stepTag}`);
    await fileFn('WeChat auth session expired', { session, stepDesc });
  } else if (session.isUrgent) {
    logFn(`[微信授权计时 ⚠️ 紧迫预警] 距离微信授权已过去 ${session.elapsedFormatted} / 8分00秒 (仅剩 ${session.remainingFormatted})！请尽快完成验证码提交！${stepTag}`);
    await fileFn('WeChat auth session urgent warning', { session, stepDesc });
  } else {
    logFn(`[微信授权计时 ⏱️] 距离微信授权已过去 ${session.elapsedFormatted} / 8分00秒 (剩余可用时间: ${session.remainingFormatted})${stepTag}`);
    await fileFn('WeChat auth session check', { session, stepDesc });
  }

  return session;
}

/**
 * 记录手机验证码请求状态（用于防重复获取验证码）
 */
async function recordPhoneCodeRequested({ deviceId, phoneNumber, sessionId = null, timestamp = Date.now() }) {
  const record = {
    deviceId: String(deviceId || ''),
    phoneNumber: String(phoneNumber || '').trim(),
    sessionId: sessionId || null,
    codeRequestedAt: timestamp,
    codeRequestedAtIso: new Date(timestamp).toISOString(),
    hasRequestedCode: true,
  };
  try {
    await fs.mkdir(path.dirname(PHONE_BIND_STATE_FILE), { recursive: true });
    await fs.writeFile(PHONE_BIND_STATE_FILE, JSON.stringify(record, null, 2), 'utf8');
  } catch {}
  return record;
}

/**
 * 读取手机验证码请求状态
 */
async function getPhoneBindState(deviceId = null, phoneNumber = null) {
  try {
    const content = await fs.readFile(PHONE_BIND_STATE_FILE, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || !parsed.codeRequestedAt) return null;

    if (deviceId && parsed.deviceId && parsed.deviceId !== deviceId) return null;
    if (phoneNumber) {
      const cleanTarget = String(phoneNumber).replace(/\s+/g, '');
      const cleanStored = String(parsed.phoneNumber || '').replace(/\s+/g, '');
      if (cleanTarget && cleanStored && cleanTarget !== cleanStored) return null;
    }

    const now = Date.now();
    const elapsedSinceCodeRequestMs = Math.max(0, now - parsed.codeRequestedAt);
    // 10 分钟内视为近期已请求过验证码
    const isRecentRequest = elapsedSinceCodeRequestMs < 10 * 60 * 1000;

    return {
      ...parsed,
      elapsedSinceCodeRequestMs,
      isRecentRequest,
      elapsedFormatted: formatDuration(elapsedSinceCodeRequestMs),
    };
  } catch {
    return null;
  }
}

/**
 * 清除微信授权与手机绑定状态缓存
 */
async function clearAuthSession() {
  try {
    await fs.unlink(AUTH_SESSION_FILE);
  } catch {}
}

async function clearPhoneBindState() {
  try {
    await fs.unlink(PHONE_BIND_STATE_FILE);
  } catch {}
}

module.exports = {
  AUTH_BUDGET_MS,
  AUTH_WARNING_MS,
  formatDuration,
  recordAuthStart,
  getAuthSession,
  logAuthBudget,
  recordPhoneCodeRequested,
  getPhoneBindState,
  clearAuthSession,
  clearPhoneBindState,
};
