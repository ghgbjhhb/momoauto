'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { assertSafeOutboundUrl, assertSafeOutboundUrlSync } = require('../../automation/url-guard');

const DEFAULT_HOST = 'www.xuanwu.de';
const DEFAULT_PREFIX = '/api/admin/openapi/v1';
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/;

// SSRF 防护策略（玄武这条链路）：
// 玄武接码网关是用户自建服务，部署在本机（http://127.0.0.1:<端口>）是合法用法，
// 因此默认放行回环地址（allowLoopback: true）；其余私网段（10/8、172.16/12、
// 192.168/16、169.254/16、100.64/10、0/8、fc00::/7、fe80::/10 等）默认仍拒绝，
// 仅允许通过环境变量 YUNMOMO_SMS_ALLOW_PRIVATE=1 显式放行（用户自建内网网关场景）。
// 特别地，未显式放行时云元数据地址 169.254.169.254 一律拒绝。
function smsGuardOptions() {
  return {
    allowLoopback: true,
    allowPrivate: String(process.env.YUNMOMO_SMS_ALLOW_PRIVATE || '').trim() === '1'
  };
}

class XuanwuError extends Error {
  constructor(message, code = 'ERROR') {
    super(message);
    this.name = 'XuanwuError';
    this.code = code;
  }
}

function tryLogCall(log) {
  try {
    const { getAuthDb } = require('../auth/db');
    getAuthDb().createSmsCallLog(log);
  } catch {}
}

class XuanwuClient {
  constructor(options = {}) {
    this.apiKey = (options.apiKey || '').trim();
    this.prefix = (options.prefix || DEFAULT_PREFIX).replace(/\/+$/, '');
    this.timeout = options.timeout || 15000;
    this.setHost(options.host || DEFAULT_HOST);
  }

  setHost(host) {
    let raw = (host || DEFAULT_HOST).trim();
    if (!raw) raw = DEFAULT_HOST;

    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      this.baseUrl = raw.replace(/\/+$/, '');
    } else if (IPV4_PATTERN.test(raw)) {
      this.baseUrl = `http://${raw.replace(/\/+$/, '')}`;
    } else {
      this.baseUrl = `https://${raw.replace(/\/+$/, '')}`;
    }

    // 同步结构校验：非法 scheme / userinfo / 私网 IP 字面量一律拒绝（不落入 baseUrl）。
    // DNS 指向私网的域名由 _request 发请求前的异步完整校验兜底。
    try {
      assertSafeOutboundUrlSync(this.baseUrl, smsGuardOptions());
    } catch (err) {
      throw new XuanwuError(err.message, 'UNSAFE_HOST');
    }
  }

  setApiKey(apiKey) {
    this.apiKey = (apiKey || '').trim();
  }

  async _request(route, query = {}) {
    if (!this.apiKey) {
      throw new XuanwuError('未配置玄武 API 密钥 (API Key)', 'NO_API_KEY');
    }

    // 发请求前做完整 SSRF 校验（含 DNS 解析），确保不会把 X-API-Key 带向私网/元数据地址。
    try {
      await assertSafeOutboundUrl(this.baseUrl, smsGuardOptions());
    } catch (err) {
      throw new XuanwuError(err.message, 'UNSAFE_HOST');
    }

    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        searchParams.set(k, String(v).trim());
      }
    }

    const queryString = searchParams.toString();
    const urlStr = `${this.baseUrl}${this.prefix}/${route.replace(/^\/+/, '')}${queryString ? `?${queryString}` : ''}`;
    const parsedUrl = new URL(urlStr);

    const transport = parsedUrl.protocol === 'http:' ? http : https;
    const reqOptions = {
      method: 'GET',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'http:' ? 80 : 443),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Accept': 'application/json',
        'X-API-Key': this.apiKey,
        'User-Agent': 'MomoAutomation-XuanwuSDK/1.0'
      },
      timeout: this.timeout
    };

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const req = transport.request(reqOptions, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          const latencyMs = Date.now() - startTime;
          let parsed;
          try {
            parsed = JSON.parse(body || '{}');
          } catch (e) {
            return reject(new XuanwuError(`响应不是合法 JSON: ${body.slice(0, 160)}`, 'BAD_JSON'));
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new XuanwuError(`HTTP ${res.statusCode}: ${parsed.message || body.slice(0, 160)}`, `HTTP_${res.statusCode}`);
            tryLogCall({
              action: route,
              caller: '脚本调用',
              phoneNumber: String(query.phoneNumber || ''),
              sessionId: String(query.sessionId || ''),
              status: 'failed',
              statusCode: String(res.statusCode),
              latencyMs,
              requestUrl: urlStr,
              requestParams: query,
              responseData: parsed,
              errorMessage: err.message
            });
            return reject(err);
          }

          const code = String(parsed.code || '');
          if (code && code !== '0000' && code !== '200') {
            const err = new XuanwuError(parsed.message || `业务异常 [${code}]`, code);
            tryLogCall({
              action: route,
              caller: '脚本调用',
              phoneNumber: String(query.phoneNumber || ''),
              sessionId: String(query.sessionId || ''),
              status: 'failed',
              statusCode: code,
              latencyMs,
              requestUrl: urlStr,
              requestParams: query,
              responseData: parsed,
              errorMessage: err.message
            });
            return reject(err);
          }

          const resData = parsed.data || {};
          const phone = String(resData.phoneNumber || resData.phone || query.phoneNumber || '');
          const sess = String(resData.sessionId || resData.session_id || query.sessionId || '');
          const codeVal = String(resData.phoneCode || resData.code || '');

          tryLogCall({
            action: route,
            caller: '脚本调用',
            phoneNumber: phone,
            sessionId: sess,
            smsCode: codeVal,
            status: 'success',
            statusCode: code || '0000',
            latencyMs,
            requestUrl: urlStr,
            requestParams: query,
            responseData: parsed
          });

          resolve({
            ok: true,
            data: parsed.data || {},
            raw: parsed,
            latencyMs
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const latencyMs = Date.now() - startTime;
        const err = new XuanwuError(`请求玄武平台超时 (${this.timeout}ms)`, 'TIMEOUT');
        tryLogCall({
          action: route,
          caller: '脚本调用',
          phoneNumber: String(query.phoneNumber || ''),
          sessionId: String(query.sessionId || ''),
          status: 'failed',
          statusCode: 'TIMEOUT',
          latencyMs,
          requestUrl: urlStr,
          requestParams: query,
          errorMessage: err.message
        });
        reject(err);
      });

      req.on('error', err => {
        const latencyMs = Date.now() - startTime;
        const netErr = new XuanwuError(`网络连接失败: ${err.message}`, 'NETWORK_ERROR');
        tryLogCall({
          action: route,
          caller: '脚本调用',
          phoneNumber: String(query.phoneNumber || ''),
          sessionId: String(query.sessionId || ''),
          status: 'failed',
          statusCode: 'NETWORK_ERROR',
          latencyMs,
          requestUrl: urlStr,
          requestParams: query,
          errorMessage: netErr.message
        });
        reject(netErr);
      });

      req.end();
    });
  }

  // 1. 获取项目列表
  async listProjects({ page = 1, limit = 50 } = {}) {
    const res = await this._request('project/list', { page, limit });
    const rows = (res.data && Array.isArray(res.data.rows)) ? res.data.rows : (Array.isArray(res.data) ? res.data : []);
    const total = res.data?.total || rows.length;
    return {
      total,
      rows: rows.map(r => ({
        id: r.id || r.code || r.projectCode,
        name: r.name || r.projectName || '未知项目',
        code: String(r.code || r.projectCode || r.id || ''),
        price: r.price !== undefined ? r.price : null,
        raw: r
      })),
      latencyMs: res.latencyMs
    };
  }

  // 2. 取号
  async getPhone(projectCode) {
    if (!projectCode) {
      throw new XuanwuError('请指定项目编码 (projectCode)', 'INVALID_PARAM');
    }
    const res = await this._request('phone/get', { projectCode });
    const d = res.data || {};
    return {
      success: Boolean(d.success !== false && (d.phoneNumber || d.phone)),
      sessionId: String(d.sessionId || d.session_id || ''),
      phoneNumber: String(d.phoneNumber || d.phone || ''),
      batchId: String(d.batchId || ''),
      createTime: d.createTime || new Date().toISOString(),
      message: d.message || res.raw?.message || '',
      errorMessage: d.errorMessage || '',
      latencyMs: res.latencyMs,
      raw: d
    };
  }

  // 3. 获取短信验证码
  async getSms(sessionId, phoneNumber) {
    if (!sessionId || !phoneNumber) {
      throw new XuanwuError('取短信必须提供 sessionId 与 phoneNumber', 'INVALID_PARAM');
    }
    const res = await this._request('sms/get', {
      sessionId: String(sessionId),
      phoneNumber: String(phoneNumber)
    });
    const d = res.data || {};
    const code = String(d.phoneCode || d.code || '').trim();
    return {
      success: Boolean(d.success !== false && code),
      phoneCode: code,
      status: Number(d.status || 0),
      message: d.message || res.raw?.message || '',
      errorMessage: d.errorMessage || '',
      latencyMs: res.latencyMs,
      raw: d
    };
  }

  // 5. 带轮询抢号（对齐网页端机制：每秒请求一次，号池无号 C3007 时持续重试，最长 maxAttempts 次，抢到立即停止）
  async getPhoneWithPolling(projectCode, { maxAttempts = 60, intervalMs = 1000, onRetry = null } = {}) {
    let lastMessage = '未知原因';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this.getPhone(projectCode);
        if (res.success && res.phoneNumber) {
          return { ...res, attempts: attempt };
        }
        lastMessage = res.errorMessage || res.message || '平台未返回可用手机号';
      } catch (err) {
        // 仅「号池无号 C3007」与「频率超限 C40005」可重试；余额不足/项目不存在等立即失败
        if (err.code !== 'C3007' && err.code !== 'C40005') {
          throw err;
        }
        lastMessage = err.message;
      }
      if (attempt < maxAttempts) {
        if (typeof onRetry === 'function') {
          try { onRetry({ attempt, maxAttempts, intervalMs, message: lastMessage }); } catch {}
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    throw new XuanwuError(`连续抢号 ${maxAttempts} 次仍无可用号码 (最后原因: ${lastMessage})`, 'C3007');
  }

  // 6. 带轮询查码（对齐网页端机制：每 5 秒查询一次该号码的验证码，最长 maxAttempts 次）
  //    data.status: 1=已接收 0=未接收；C3054=正在获取(继续等)；C3051/C3055=会话失效(立即抛出，需重新抢号)
  async getSmsWithPolling(sessionId, phoneNumber, { maxAttempts = 60, intervalMs = 5000, onPoll = null } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res = null;
      let pollStatus = null;
      try {
        res = await this.getSms(sessionId, phoneNumber);
        pollStatus = res.status;
      } catch (err) {
        if (err.code === 'C3054' || err.code === 'C40005') {
          pollStatus = 0; // 正在获取验证码/频率超限：视为未收到，等待后重查
        } else {
          throw err; // C3051 会话过期 / C3055 查码失败 → 轮询无意义，直接上抛
        }
      }
      if (res && res.success && res.phoneCode) {
        return { ...res, attempts: attempt };
      }
      if (typeof onPoll === 'function') {
        try { onPoll({ attempt, maxAttempts, status: pollStatus }); } catch {}
      }
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    return { success: false, phoneCode: '', attempts: maxAttempts, timedOut: true };
  }

  // 7. 一键测试连通性
  async testConnection() {
    const startTime = Date.now();
    try {
      const res = await this.listProjects({ page: 1, limit: 1 });
      const latencyMs = Date.now() - startTime;
      return {
        ok: true,
        latencyMs,
        projectCount: res.total,
        message: `连通正常，发现 ${res.total} 个可用项目，耗时 ${latencyMs}ms`
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - startTime,
        error: err.message,
        code: err.code || 'FAIL'
      };
    }
  }
}

module.exports = {
  XuanwuClient,
  XuanwuError,
  DEFAULT_HOST,
  DEFAULT_PREFIX
};
