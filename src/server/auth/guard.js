'use strict';

// 凭据类接口暴力破解防护：按「账号」与「来源 IP」两个维度独立计数，任一维度超限即拒绝。
// 计数保存在内存中，进程重启即清零——目的是抬高撞库成本，而不是持久化封禁，
// 避免因误锁导致管理员无法登录（重启服务即可自救）。

const MINUTE = 60 * 1000;

// realm 隔离不同接口的配额：注册/登录的失败不应连带封掉兑换卡密入口，反之亦然
const REALMS = {
  auth: { maxFails: 5, windowMs: 15 * MINUTE, lockMs: 30 * MINUTE, ipMax: 60, ipWindowMs: 60 * MINUTE },
  redeem: { maxFails: 15, windowMs: 30 * MINUTE, lockMs: 15 * MINUTE, ipMax: 200, ipWindowMs: 60 * MINUTE },
};

const SWEEP_INTERVAL_MS = 5 * MINUTE;
const buckets = new Map(); // realm -> Map(key -> state)
for (const realm of Object.keys(REALMS)) buckets.set(realm, new Map());

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function clientIp(request) {
  const socket = request && request.socket;
  return String((socket && socket.remoteAddress) || 'unknown');
}

function sweep() {
  const now = Date.now();
  for (const [realm, store] of buckets) {
    const config = REALMS[realm];
    for (const [key, state] of store) {
      if (state.kind === 'account') {
        if (state.lockedUntil > now) continue;
        if (now - state.firstAt > config.windowMs) store.delete(key);
      } else if (state.until <= now) {
        store.delete(key);
      }
    }
  }
}

const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
if (typeof sweeper.unref === 'function') sweeper.unref();

// 命中限制返回需等待的秒数，未被限制返回 0
function inspect(email, ip, realm = 'auth') {
  const config = REALMS[realm];
  if (!config) return 0;
  const now = Date.now();
  let waitSeconds = 0;

  const store = buckets.get(realm);
  const accountKey = normalizeEmail(email);
  const account = accountKey ? store.get(accountKey) : null;
  if (account && account.kind === 'account' && account.lockedUntil > now) {
    waitSeconds = Math.max(waitSeconds, Math.ceil((account.lockedUntil - now) / 1000));
  }

  const host = store.get(`ip:${ip}`);
  if (host && host.kind === 'ip' && host.until > now && host.count >= config.ipMax) {
    waitSeconds = Math.max(waitSeconds, Math.ceil((host.until - now) / 1000));
  }

  return waitSeconds;
}

function registerFailure(email, ip, realm = 'auth') {
  const config = REALMS[realm];
  if (!config) return;
  const now = Date.now();
  const store = buckets.get(realm);

  const ipKey = `ip:${ip}`;
  const host = store.get(ipKey);
  if (!host || host.until <= now) {
    store.set(ipKey, { kind: 'ip', count: 1, until: now + config.ipWindowMs });
  } else {
    host.count += 1;
  }

  const accountKey = normalizeEmail(email);
  if (!accountKey) return;
  const account = store.get(accountKey) || { kind: 'account', fails: 0, firstAt: now, lockedUntil: 0 };
  if (account.lockedUntil > now) return;
  if (now - account.firstAt > config.windowMs) {
    account.fails = 0;
    account.firstAt = now;
  }
  account.fails += 1;
  if (account.fails >= config.maxFails) {
    account.lockedUntil = now + config.lockMs;
    account.fails = 0;
  }
  store.set(accountKey, account);
}

function registerSuccess(email, realm = 'auth') {
  const accountKey = normalizeEmail(email);
  if (!accountKey) return;
  const store = buckets.get(realm);
  // 只清账号维度；IP 配额保留，避免用成功请求洗掉撞库计数
  store.delete(accountKey);
}

function redact(url) {
  return String(url || '').replace(/([?&](?:token|password|pwd|passwd|secret|apikey|api_key|code)=)[^&\s]*/gi, '$1***');
}

module.exports = { inspect, registerFailure, registerSuccess, clientIp, normalizeEmail, redact, REALMS };
