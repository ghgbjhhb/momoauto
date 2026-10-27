'use strict';

const { XuanwuClient, DEFAULT_HOST, DEFAULT_PREFIX } = require('./xuanwu-client');
const { getAuthDb } = require('../auth/db');

function maskApiKey(key) {
  if (!key) return '';
  const s = String(key).trim();
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

class SmsService {
  constructor(db = getAuthDb()) {
    this.db = db;
    this._client = null;
  }

  getConfig() {
    const enabled = this.db.getConfig('xuanwu_enabled') !== 'false';
    const host = this.db.getConfig('xuanwu_host') || DEFAULT_HOST;
    const apiKey = this.db.getConfig('xuanwu_api_key') || '';
    const prefix = this.db.getConfig('xuanwu_prefix') || DEFAULT_PREFIX;
    const defaultProjectCode = this.db.getConfig('xuanwu_default_project_code') || '';
    const defaultProjectName = this.db.getConfig('xuanwu_default_project_name') || '';

    return {
      enabled,
      host,
      apiKey,
      maskedApiKey: maskApiKey(apiKey),
      hasApiKey: Boolean(apiKey),
      prefix,
      defaultProjectCode,
      defaultProjectName
    };
  }

  saveConfig(updates = {}) {
    if (updates.enabled !== undefined) {
      this.db.setConfig('xuanwu_enabled', updates.enabled ? 'true' : 'false');
    }
    if (updates.host !== undefined) {
      this.db.setConfig('xuanwu_host', String(updates.host).trim() || DEFAULT_HOST);
    }
    if (updates.prefix !== undefined) {
      this.db.setConfig('xuanwu_prefix', String(updates.prefix).trim() || DEFAULT_PREFIX);
    }
    if (updates.apiKey !== undefined) {
      const raw = String(updates.apiKey).trim();
      // 避免把已经掩码的字符串当作真实 key 存入
      if (raw && !raw.includes('****')) {
        this.db.setConfig('xuanwu_api_key', raw);
      }
    } else if (updates.clearApiKey === true) {
      this.db.setConfig('xuanwu_api_key', '');
    }

    if (updates.defaultProjectCode !== undefined) {
      this.db.setConfig('xuanwu_default_project_code', String(updates.defaultProjectCode).trim());
    }
    if (updates.defaultProjectName !== undefined) {
      this.db.setConfig('xuanwu_default_project_name', String(updates.defaultProjectName).trim());
    }

    this._client = null; // 重置 client 实例
    return this.getConfig();
  }

  getClient(customConfig = null) {
    if (customConfig && (customConfig.host || customConfig.apiKey)) {
      return new XuanwuClient({
        host: customConfig.host || DEFAULT_HOST,
        apiKey: customConfig.apiKey || '',
        prefix: customConfig.prefix || DEFAULT_PREFIX
      });
    }

    if (!this._client) {
      const cfg = this.getConfig();
      this._client = new XuanwuClient({
        host: cfg.host,
        apiKey: cfg.apiKey,
        prefix: cfg.prefix
      });
    }
    return this._client;
  }

  // 连通性测试
  async testConnection(customConfig = null) {
    let client;
    if (customConfig && (customConfig.host || customConfig.apiKey)) {
      const current = this.getConfig();
      const apiKey = (customConfig.apiKey && !customConfig.apiKey.includes('****'))
        ? customConfig.apiKey.trim()
        : current.apiKey;
      client = new XuanwuClient({
        host: customConfig.host || current.host,
        apiKey,
        prefix: customConfig.prefix || current.prefix
      });
    } else {
      client = this.getClient();
    }
    return await client.testConnection();
  }

  // 项目列表
  async listProjects({ page = 1, limit = 50 } = {}) {
    const client = this.getClient();
    return await client.listProjects({ page, limit });
  }

  // 取号
  async grabPhone({ projectCode, projectName = '' } = {}) {
    const cfg = this.getConfig();
    const targetCode = String(projectCode || cfg.defaultProjectCode || '').trim();
    if (!targetCode) {
      throw new Error('未指定取号项目编码 (projectCode)');
    }

    const client = this.getClient();
    const result = await client.getPhone(targetCode);

    if (!result.phoneNumber) {
      throw new Error(result.errorMessage || result.message || '玄武平台未返回有效手机号');
    }

    // 存入本地数据库作为历史记录与追踪
    const record = this.db.createSmsRecord({
      platform: 'xuanwu',
      projectCode: targetCode,
      projectName: projectName || cfg.defaultProjectName || targetCode,
      phoneNumber: result.phoneNumber,
      sessionId: result.sessionId,
      status: 'waiting',
      rawMessage: result.message || ''
    });

    return {
      ok: true,
      record,
      sessionId: result.sessionId,
      phoneNumber: result.phoneNumber,
      latencyMs: result.latencyMs
    };
  }

  // 轮询查码
  async querySmsCode({ recordId, sessionId, phoneNumber } = {}) {
    let rec = null;
    if (recordId) {
      rec = this.db.getSmsRecordById(recordId);
    }
    if (!rec && sessionId) {
      rec = this.db.getSmsRecordBySession(sessionId);
    }

    const sid = sessionId || rec?.session_id;
    const phone = phoneNumber || rec?.phone_number;

    if (!sid || !phone) {
      throw new Error('缺少必要参数 sessionId 或 phoneNumber');
    }

    const client = this.getClient();
    const result = await client.getSms(sid, phone);

    if (result.phoneCode) {
      // 收到验证码，标记成功
      if (rec) {
        this.db.updateSmsRecord(rec.id, {
          smsCode: result.phoneCode,
          status: 'received',
          rawMessage: result.message || '已收到验证码'
        });
      }
      return {
        ok: true,
        success: true,
        code: result.phoneCode,
        status: result.status,
        message: result.message,
        phoneNumber: phone
      };
    }

    return {
      ok: true,
      success: false,
      code: '',
      status: result.status,
      message: result.message || '等待接收短信中…',
      phoneNumber: phone
    };
  }

  // 标记记录状态（例如放弃或超时）
  markRecordStatus(recordId, status, message = '') {
    return this.db.updateSmsRecord(recordId, {
      status,
      errorMessage: message
    });
  }

  listRecords(options) {
    return this.db.listSmsRecords(options);
  }

  clearRecords() {
    return this.db.clearSmsRecords();
  }

  getStats() {
    return this.db.getSmsStats();
  }

  listCallLogs(options) {
    return this.db.listSmsCallLogs(options);
  }

  clearCallLogs() {
    return this.db.clearSmsCallLogs();
  }
}

let sharedSmsService = null;
function getSmsService() {
  return (sharedSmsService ||= new SmsService());
}

module.exports = {
  SmsService,
  getSmsService
};
