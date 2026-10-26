'use strict';

const crypto = require('node:crypto');
const { getAuthDb } = require('./db');

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  const actualHash = hashPassword(password, salt);
  const actualBuf = Buffer.from(actualHash, 'hex');
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
      const password = process.env.ADMIN_INITIAL_PASSWORD || 'admin123456';
      const salt = generateSalt();
      const hash = hashPassword(password, salt);
      this.db.createUser({
        id: 'admin_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        email,
        passwordHash: hash,
        passwordSalt: salt,
        role: 'admin',
        status: 'active'
      });
      console.log(`[AuthService] 默认超级管理员已初始化: ${email} / ${password}`);
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
  register(email, password) {
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
    const hash = hashPassword(password, salt);
    const userId = 'usr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    const user = this.db.createUser({
      id: userId,
      email,
      passwordHash: hash,
      passwordSalt: salt,
      role: 'user',
      status: 'active'
    });

    const token = this.signToken({ sub: user.id, email: user.email, role: user.role });
    return {
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      token
    };
  }

  login(email, password) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');

    const user = this.db.getUserByEmail(email);
    if (!user) {
      throw new Error('邮箱或密码不正确');
    }
    if (user.status === 'banned') {
      throw new Error('该账号已被管理员封禁，无法登录');
    }

    const ok = verifyPassword(password, user.password_salt, user.password_hash);
    if (!ok) {
      throw new Error('邮箱或密码不正确');
    }

    const token = this.signToken({ sub: user.id, email: user.email, role: user.role });
    return {
      user: { id: user.id, email: user.email, role: user.role, status: user.status },
      token
    };
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

    // Check URL query: ?token=...
    if (!token) {
      try {
        const url = new URL(request.url, 'http://' + (request.headers.host || '127.0.0.1'));
        token = url.searchParams.get('token') || '';
      } catch {}
    }

    if (!token) return null;

    const payload = this.verifyToken(token);
    if (!payload || !payload.sub) return null;

    const user = this.db.getUserById(payload.sub);
    if (!user || user.status === 'banned') return null;

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

  generateCards({ count = 1, durationDays = 0, durationHours = 0, batchTag = '' }) {
    count = Math.min(Math.max(1, parseInt(count, 10) || 1), 500);
    durationDays = Math.max(0, parseInt(durationDays, 10) || 0);
    durationHours = Math.max(0, parseInt(durationHours, 10) || 0);

    if (durationDays === 0 && durationHours === 0) {
      throw new Error('请至少指定天数或小时数');
    }

    const cards = [];
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      cards.push({
        id: 'crd_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        cardCode: this.generateCardCode(),
        durationDays,
        durationHours,
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
  // User confirmed: "不是，是新开" (Always allocate a new cloud phone upon redemption)
  // "到期直接没" (Directly expired/recycled once time expires)
  redeemCardForNewDevice({ userId, cardCode, masterDevices = [] }) {
    cardCode = String(cardCode || '').trim().toUpperCase();
    if (!cardCode) throw new Error('请输入有效的卡密');

    // 1. Purge expired allocations first
    this.sweepExpiredAllocations();

    // 2. Validate card
    const card = this.db.getCardByCode(cardCode);
    if (!card) {
      throw new Error('卡密不存在，请核对后重试');
    }
    if (card.status !== 'unused') {
      throw new Error('该卡密已被使用或已作废');
    }

    // 3. Find available master device
    const activeAllocatedIds = new Set(this.db.getActiveAllocatedDeviceIds());
    const availableDevice = masterDevices.find(d => !activeAllocatedIds.has(d.deviceId));

    if (!availableDevice) {
      throw new Error('当前系统空闲云机库存不足，卡密未扣除，请联系客服补库后再试！');
    }

    // 4. Calculate expiration
    const allocatedAt = Date.now();
    const durationMs = (card.duration_days * 24 * 3600 * 1000) + (card.duration_hours * 3600 * 1000);
    const expireAt = allocatedAt + durationMs;

    // 5. Atomic mark card used and create allocation
    const used = this.db.markCardUsed(card.id, userId);
    if (!used) {
      throw new Error('卡密兑换失败，可能已被并发核销');
    }

    const allocId = 'alc_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const allocation = this.db.createAllocation({
      id: allocId,
      userId,
      deviceId: availableDevice.deviceId,
      deviceName: availableDevice.name || availableDevice.cloudNo || 'SF',
      cardId: card.id,
      allocatedAt,
      expireAt
    });

    return {
      allocationId: allocation.id,
      deviceId: availableDevice.deviceId,
      deviceName: allocation.device_name,
      allocatedAt,
      expireAt,
      remainingMs: Math.max(0, expireAt - Date.now())
    };
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
        allocatedAt: alloc.allocated_at,
        expireAt: alloc.expire_at,
        remainingMs,
        remainingText: formatRemainingTime(remainingMs)
      };
    });
  }

  canAccessDevice(user, deviceId) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    this.sweepExpiredAllocations();
    const allocations = this.db.getActiveAllocationsForUser(user.id);
    return allocations.some(a => a.device_id === deviceId && a.expire_at > Date.now());
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
