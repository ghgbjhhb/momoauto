'use strict';

const crypto = require('node:crypto');
const { getAuthDb } = require('./db');

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// WebSocket 握手及静态媒体资源加载带不了自定义 Authorization 头，允许通过查询参数验证令牌。
const QUERY_TOKEN_PATHS = [
  '/api/control',
  '/api/video',
  '/api/cloud-disk/file',
  '/api/cloud-disk/preview',
  '/api/cloud-disk/download'
];

const SCRYPT_KEYLEN = 64;

// 仅供启动期一次性建号使用：此刻没有并发请求，阻塞可接受。
function hashPasswordSync(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

// 请求路径必须走异步派生：同步 scrypt 单次约数十毫秒纯 CPU，
// 会冻结整台控制台的事件循环（包括正在推流的视频与手动控制通道）。
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (error, derived) => {
      if (error) reject(error);
      else resolve(derived.toString('hex'));
    });
  });
}

async function verifyPassword(password, salt, expectedHash) {
  const actualBuf = Buffer.from(await hashPassword(password, salt), 'hex');
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

class AuthService {
  constructor(db = getAuthDb()) {
    this.db = db;
    this.jwtSecret = this.initSecret();
    this.db.setTokenEncryptionKey(this.jwtSecret);
    this._userOwnedDevices = new Map();
    this.initDefaultAdmin();
  }

  initSecret() {
    let secret = this.db.getConfig('jwt_secret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      this.db.setConfig('jwt_secret', secret);
    }
    return secret;
  }

  initDefaultAdmin() {
    if (this.db.countAdmins() === 0) {
      const email = 'admin@yunmomo.local';
      // 不再使用固定弱口令：这类凭据一旦出现在源码里，就会被前端自动登录、
      // 登录页预填等"便利"逻辑复用，等价于给所有访客发了管理员。
      const password = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(12).toString('base64url');
      const salt = generateSalt();
      const hash = hashPasswordSync(password, salt);
      this.db.createUser({
        id: 'admin_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        email,
        passwordHash: hash,
        passwordSalt: salt,
        role: 'admin',
        status: 'active'
      });
      console.log(`[AuthService] 初始超级管理员已创建: ${email}`);
      console.log(`[AuthService] 一次性初始口令（仅本次启动显示，请登录后立即在后台改密）: ${password}`);
    }
  }

  signToken(payload, expiresInMs = 7 * 24 * 3600 * 1000) {
    const exp = Date.now() + expiresInMs;
    const body = { ...payload, exp };
    const headerStr = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payloadStr = base64UrlEncode(JSON.stringify(body));
    const signature = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(`${headerStr}.${payloadStr}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    return `${headerStr}.${payloadStr}.${signature}`;
  }

  verifyToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerStr, payloadStr, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(`${headerStr}.${payloadStr}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    if (signature !== expectedSig) return null;
    try {
      const payload = JSON.parse(base64UrlDecode(payloadStr));
      if (!payload.exp || Date.now() > payload.exp) return null;
      return payload;
    } catch {
      return null;
    }
  }

  // --- User Operations ---
  async register(email, password) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new Error('请输入有效的电子邮箱格式');
    }
    if (password.length < 6) {
      throw new Error('密码长度至少需要 6 位');
    }

    const existing = this.db.getUserByEmail(email);
    if (existing) {
      throw new Error('该邮箱已注册，请直接登录');
    }

    const salt = generateSalt();
    const hash = await hashPassword(password, salt);
    const userId = 'usr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    const user = this.db.createUser({
      id: userId,
      email,
      passwordHash: hash,
      passwordSalt: salt,
      role: 'user',
      status: 'active'
    });

    const token = this.signToken({ sub: user.id, email: user.email, role: user.role, tv: user.token_version || 0 });
    return {
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      token
    };
  }

  async login(email, password) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');

    const user = this.db.getUserByEmail(email);
    if (!user) {
      throw new Error('邮箱或密码不正确');
    }
    if (user.status === 'banned') {
      throw new Error('该账号已被管理员封禁，无法登录');
    }

    const ok = await verifyPassword(password, user.password_salt, user.password_hash);
    if (!ok) {
      throw new Error('邮箱或密码不正确');
    }

    const token = this.signToken({ sub: user.id, email: user.email, role: user.role, tv: user.token_version || 0 });
    return {
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      token
    };
  }

  async changePassword(userId, currentPassword, newPassword) {
    const user = this.db.getUserById(userId);
    if (!user) throw new Error('用户不存在');
    newPassword = String(newPassword || '');
    if (newPassword.length < 8) throw new Error('新密码长度至少需要 8 位');

    const ok = await verifyPassword(String(currentPassword || ''), user.password_salt, user.password_hash);
    if (!ok) throw new Error('当前密码不正确');

    const salt = generateSalt();
    const hash = await hashPassword(newPassword, salt);
    // 同步提升令牌版本号：改密前签发的所有 token 立即失效，否则被盗用的会话能在改密后继续存活 7 天。
    const tokenVersion = this.db.bumpUserTokenVersion(user.id);
    this.db.updateUserPassword(user.id, hash, salt);
    return { id: user.id, email: user.email, role: user.role, tokenVersion };
  }

  getUserFromRequest(request) {
    let token = '';

    // Check Authorization header
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }

    // Check Cookie: ym_auth_token
    if (!token && request.headers.cookie) {
      const match = request.headers.cookie.match(/(?:^|;\s*)ym_auth_token=([^;]+)/);
      if (match) token = decodeURIComponent(match[1]);
    }

    // Check URL query: ?token=... （仅限 WebSocket 握手，见 WS_TOKEN_PATHS）
    if (!token) {
      try {
        const url = new URL(request.url, 'http://' + (request.headers.host || '127.0.0.1'));
        if (QUERY_TOKEN_PATHS.some(prefix => url.pathname.startsWith(prefix))) {
          token = url.searchParams.get('token') || '';
        }
      } catch {}
    }

    if (!token) return null;

    const payload = this.verifyToken(token);
    if (!payload || !payload.sub) return null;

    const user = this.db.getUserById(payload.sub);
    if (!user || user.status === 'banned') return null;
    // 令牌版本号不一致 => 该 token 早于最近一次改密签发，立即失效
    if ((payload.tv || 0) !== (user.token_version || 0)) return null;

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status
    };
  }

  // --- Card Key Generation ---
  generateCardCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Avoid 0, 1, I, O
    const segment = len => {
      let res = '';
      const bytes = crypto.randomBytes(len);
      for (let i = 0; i < len; i++) {
        res += chars[bytes[i] % chars.length];
      }
      return res;
    };
    return `YM-${segment(4)}-${segment(4)}-${segment(4)}-${segment(4)}`;
  }

  generateCards(options = {}) {
    let {
      count = 1,
      batchTag = '',
      cardTypes,
      cloudConfig,
      zhencanConfig,
      ipConfig,
      durationDays,
      durationHours
    } = options;

    count = Math.min(Math.max(1, parseInt(count, 10) || 1), 500);

    // 标准化 cardTypes 数组
    let types = [];
    if (Array.isArray(cardTypes) && cardTypes.length > 0) {
      types = [...new Set(cardTypes.map(t => String(t).trim().toLowerCase()))];
    } else if (typeof cardTypes === 'string' && cardTypes.trim()) {
      try {
        const parsed = JSON.parse(cardTypes);
        if (Array.isArray(parsed)) types = [...new Set(parsed.map(t => String(t).trim().toLowerCase()))];
      } catch {
        types = [cardTypes.trim().toLowerCase()];
      }
    }

    // 若未传递 cardTypes，则回退为 ['cloud']
    if (types.length === 0) {
      types = ['cloud'];
    }

    const validTypes = types.filter(t => ['cloud', 'zhencan', 'ip'].includes(t));
    if (validTypes.length === 0) {
      throw new Error('请至少选择一个有效的卡密权益类别（云机 / 真参 / IP）');
    }

    const contents = {};
    let legacyDurationDays = 0;
    let legacyDurationHours = 0;

    if (validTypes.includes('cloud')) {
      const cDays = parseInt(cloudConfig?.durationDays ?? durationDays, 10) || 0;
      const cHours = parseInt(cloudConfig?.durationHours ?? durationHours, 10) || 0;
      if (cDays <= 0 && cHours <= 0) {
        throw new Error('已勾选云机卡密，请至少设置大于 0 的云机天数或小时数！');
      }
      contents.cloud = {
        durationDays: Math.max(0, cDays),
        durationHours: Math.max(0, cHours),
        deviceCount: Math.max(1, parseInt(cloudConfig?.deviceCount, 10) || 1)
      };
      legacyDurationDays = contents.cloud.durationDays;
      legacyDurationHours = contents.cloud.durationHours;
    }

    if (validTypes.includes('zhencan')) {
      const zCount = parseInt(zhencanConfig?.count, 10) || 10;
      if (zCount <= 0) {
        throw new Error('已勾选真参卡密，请设置至少 1 套真参数量！');
      }
      contents.zhencan = {
        count: zCount
      };
    }

    if (validTypes.includes('ip')) {
      const ipDays = parseInt(ipConfig?.durationDays, 10) || 30;
      if (ipDays <= 0) {
        throw new Error('已勾选IP卡密，请设置至少 1 天的IP有效时长！');
      }
      contents.ip = {
        durationDays: ipDays
      };
    }

    const cards = [];
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      cards.push({
        id: 'crd_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        cardCode: this.generateCardCode(),
        cardTypes: validTypes,
        cardContents: contents,
        durationDays: legacyDurationDays,
        durationHours: legacyDurationHours,
        status: 'unused',
        batchTag: String(batchTag || '').trim(),
        createdAt: now
      });
    }

    this.db.createCards(cards);
    return cards;
  }

  listCards(options) {
    return this.db.listCards(options);
  }

  revokeCard(cardId) {
    return this.db.revokeCard(cardId);
  }

  // --- Device Allocation & Redemption ---
  // 支持一张卡密兑换多个内容（云机、真参、IP）
  redeemCard({ userId, cardCode, masterDevices = [] }) {
    cardCode = String(cardCode || '').trim().toUpperCase();
    if (!cardCode) throw new Error('请输入有效的卡密');

    // 1. 先回收清理所有过期设备
    this.sweepExpiredAllocations();

    // 卡密核销、设备分配、权益入账和日志必须同事务完成。
    return this.db.transaction(() => {
      // 2. 校验卡密
      const card = this.db.getCardByCode(cardCode);
      if (!card) {
        throw new Error('卡密不存在，请核对后重试');
      }
      if (card.status !== 'unused') {
        throw new Error('该卡密已被使用或已作废');
      }

      // 解析包含的类别
      let types = ['cloud'];
      try {
        if (card.card_types) {
          const parsed = JSON.parse(card.card_types);
          if (Array.isArray(parsed) && parsed.length > 0) types = parsed;
        }
      } catch {}

      let contents = {};
      try {
        if (card.card_contents) {
          contents = JSON.parse(card.card_contents) || {};
        }
      } catch {}

      // 兼容老卡密：若含有 cloud 但 contents.cloud 为空，从 duration_days 构造
      if (types.includes('cloud') && !contents.cloud) {
        contents.cloud = {
          durationDays: card.duration_days || 0,
          durationHours: card.duration_hours || 0,
          deviceCount: 1
        };
      }

      // 3. 若包含云机权益，优先探明并核验空闲云机库存（业务不变量：在分配成功前绝不消耗卡密）
      let availableDevices = [];
      let cloudDurationMs = 0;
      let cloudExpireAt = 0;
      if (types.includes('cloud')) {
        const activeAllocatedIds = new Set(this.db.getActiveAllocatedDeviceIds());
        const count = Math.max(1, Number(contents.cloud?.deviceCount) || 1);
        availableDevices = masterDevices.filter(d => !activeAllocatedIds.has(d.deviceId)).slice(0, count);

        if (availableDevices.length < count) {
          throw new Error('当前系统空闲云机库存不足，卡密未扣除，请联系客服补库后再试！');
        }

        const cDays = contents.cloud?.durationDays ?? card.duration_days ?? 0;
        const cHours = contents.cloud?.durationHours ?? card.duration_hours ?? 0;
        cloudDurationMs = (cDays * 24 * 3600 * 1000) + (cHours * 3600 * 1000);
        cloudExpireAt = Date.now() + cloudDurationMs;
      }

      // 4. 原子核销卡密
      const used = this.db.markCardUsed(card.id, userId);
      if (!used) {
        throw new Error('卡密兑换失败，可能已被并发核销');
      }

      const allocatedAt = Date.now();
      const resultDetails = {};
      const summaryParts = [];

      // 5. 执行各类别权益的入账与发放
      // 5.1 云机权益开通
      if (types.includes('cloud') && availableDevices.length) {
        const allocations = availableDevices.map(device => {
          const id = 'alc_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
          const allocation = this.db.createAllocation({
            id,
            userId,
            deviceId: device.deviceId,
            deviceName: device.name || device.cloudNo || 'SF',
            cardId: card.id,
            allocatedAt,
            expireAt: cloudExpireAt
          });
          return { allocationId: allocation.id, deviceId: device.deviceId,
            deviceName: allocation.device_name, allocatedAt, expireAt: cloudExpireAt };
        });
        resultDetails.cloud = {
          ...allocations[0],
          deviceCount: allocations.length,
          allocations,
          remainingMs: Math.max(0, cloudExpireAt - Date.now())
        };
        const daysText = contents.cloud?.durationDays ? `${contents.cloud.durationDays}天` : '';
        const hoursText = contents.cloud?.durationHours ? `${contents.cloud.durationHours}小时` : '';
        summaryParts.push(allocations.length === 1
          ? `云机 [${allocations[0].deviceName}] (${daysText || hoursText || '已开通'})`
          : `云机 ${allocations.length} 台 (${daysText || hoursText || '已开通'})`);
      }

      // 5.2 真参权益入账
      if (types.includes('zhencan')) {
        const count = parseInt(contents.zhencan?.count, 10) || 10;
        const totalBalance = this.db.addZhencanQuota(userId, count, { cardCode, cardId: card.id });
        resultDetails.zhencan = {
          added: count,
          currentBalance: totalBalance
        };
        summaryParts.push(`真参配额 +${count} 套`);
      }

      // 5.3 IP权益开通/续期
      if (types.includes('ip')) {
        const ipDays = parseInt(contents.ip?.durationDays, 10) || 30;
        const newExpireAt = this.db.addOrExtendIp(userId, ipDays, { cardCode, cardId: card.id });
        resultDetails.ip = {
          addedDays: ipDays,
          expireAt: newExpireAt,
          remainingMs: Math.max(0, newExpireAt - Date.now())
        };
        summaryParts.push(`代理IP ${ipDays}天`);
      }

      const summaryText = summaryParts.join(' + ') || '权益已兑换';

      // 6. 记录兑换明细
      const logId = 'rdm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      this.db.createRedemptionLog({
        id: logId,
        userId,
        cardId: card.id,
        cardCode,
        redeemedTypes: types,
        redeemedSummary: summaryText,
        details: resultDetails
      });

      return {
        success: true,
        cardCode,
        types,
        summary: summaryText,
        details: resultDetails,
        // 向后兼容旧调用方读取的字段
        allocationId: resultDetails.cloud?.allocationId || null,
        deviceId: resultDetails.cloud?.deviceId || null,
        deviceName: resultDetails.cloud?.deviceName || null,
        allocatedAt,
        expireAt: cloudExpireAt || null,
        remainingMs: resultDetails.cloud ? Math.max(0, cloudExpireAt - Date.now()) : 0
      };
    });
  }

  redeemCardForNewDevice(args) {
    return this.redeemCard(args);
  }

  getUserDevices(userId, masterDevices = []) {
    this.sweepExpiredAllocations();
    const allocations = this.db.getActiveAllocationsForUser(userId);
    const masterMap = new Map(masterDevices.map(d => [d.deviceId, d]));

    return allocations.map(alloc => {
      const master = masterMap.get(alloc.device_id);
      const remainingMs = Math.max(0, alloc.expire_at - Date.now());
      return {
        deviceId: alloc.device_id,
        name: alloc.device_name || master?.name || 'SF',
        udid: master?.udid || '',
        status: master?.status ?? null,
        online: master?.online ?? null,
        sdkVersion: master?.sdkVersion ?? null,
        currentIp: master?.currentIp || null,
        proxyAddress: master?.proxyAddress || null,
        allocatedAt: alloc.allocated_at,
        expireAt: alloc.expire_at,
        remainingMs,
        remainingText: formatRemainingTime(remainingMs)
      };
    });
  }

  // --- Per-User Platform Token ---

  setUserPlatformToken(userId, plainToken) {
    this.db.setUserToken(userId, plainToken);
    this._userOwnedDevices?.delete(userId);
  }

  getUserPlatformToken(userId) {
    return this.db.getUserToken(userId);
  }

  setUserOwnedDevices(userId, deviceIds) {
    if (!this._userOwnedDevices) this._userOwnedDevices = new Map();
    this._userOwnedDevices.set(userId, new Set((deviceIds || []).map(String)));
  }

  canAccessDevice(user, deviceId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const devStr = String(deviceId || '');
    // 未核验的设备归属不构成权限，卡密租赁另按有效期判断。
    if (this.getUserPlatformToken(user.id) && this._userOwnedDevices.get(user.id)?.has(devStr)) return true;
    this.sweepExpiredAllocations();
    const allocations = this.db.getActiveAllocationsForUser(user.id);
    return allocations.some(a => String(a.device_id) === devStr && a.expire_at > Date.now());
  }

  async ensureDeviceAccess(user, deviceId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (this.getUserPlatformToken(user.id) && !this._userOwnedDevices.has(user.id)) {
      const { YunmomoClient } = require('../../index');
      try {
        const token = this.getUserPlatformToken(user.id);
        const result = await new YunmomoClient({ token, timeoutMs: 15000 })
          .listDevices({ current: 1, size: 50000 });
        const records = Array.isArray(result?.records) ? result.records : (Array.isArray(result) ? result : []);
        this.setUserOwnedDevices(user.id, records.map(d => String(d.id ?? d.deviceId ?? '')));
      } catch {
        // 查询失败不得视为拥有全部设备，也不缓存空结果，避免网络恢复后仍被拒绝。
      }
    }
    return this.canAccessDevice(user, deviceId);
  }

  getDeviceAccessToken(user, deviceId) {
    const token = this.getUserPlatformToken(user.id);
    if (user.role === 'admin') return token;
    return token && this._userOwnedDevices.get(user.id)?.has(String(deviceId)) ? token : '';
  }

  getUserZhencanBalance(userId) {
    return this.db.getUserZhencanBalance(userId);
  }

  consumeZhencanQuota(user, count = 1, metadata = {}) {
    if (!user) throw new Error('未授权用户，无法扣减真参配额');
    if (user.role === 'admin') {
      // 管理员拥有调试与管理特权，记录操作但免扣除
      return 999999;
    }
    return this.db.consumeZhencanQuota(user.id, count, metadata);
  }

  getZhencanFileRecord(fileName) {
    return this.db.getZhencanFileRecord(fileName);
  }

  getAllZhencanRecords() {
    return this.db.getAllZhencanRecords();
  }

  markZhencanFileUsed(fileName, { userId = '', deviceId = '', deviceName = '' } = {}) {
    return this.db.markZhencanFileUsed(fileName, { userId, deviceId, deviceName });
  }

  setZhencanFileStatus(fileName, status) {
    return this.db.setZhencanFileStatus(fileName, status);
  }

  sweepExpiredAllocations(onExpired) {
    const expired = this.db.expireAndRecycleDevices(Date.now());
    if (expired.length > 0 && typeof onExpired === 'function') {
      for (const item of expired) {
        try {
          onExpired(item.device_id, item.user_id);
        } catch (err) {
          console.error(`[AuthService] 回收通知失败 ${item.device_id}:`, err.message);
        }
      }
    }
    return expired;
  }
}

function formatRemainingTime(ms) {
  if (ms <= 0) return '已到期';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

let sharedService = null;
function getAuthService() {
  return (sharedService ||= new AuthService());
}

module.exports = {
  AuthService,
  getAuthService,
  formatRemainingTime
};
