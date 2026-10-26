'use strict';

/**
 * AI 回复配置与密钥管理模块 (AI Reply Configuration)
 *
 * 遵循计划第 6.1、6.2 节与 P2 门禁：
 * 1. 默认对接 DeepSeek 官方 API (https://api.deepseek.com)。
 * 2. 存储在受控隔离目录 .runtime/ai-reply/settings.json 中。
 * 3. 密钥屏蔽：对外只暴露 hasApiKey 及脱敏掩码 (sk-***abcd)，禁止明文返回 API Key。
 * 4. 版本化增量与并发冲突保护：使用 revision 递增，修改时校验 expectedRevision。
 */

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('../automation/runtime');

const CONFIG_DIR = path.join(PROJECT_ROOT, '.runtime', 'ai-reply');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  revision: 1,
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  systemPrompt: '你是一个友好自然的真人，正在与朋友在社交App上聊天。\n【回复要求】：\n1. 语言简短真实、口语生活化，每次只回复一两句话，严禁出现AI助手或客服腔调。\n2. 务必使用常见高频的日常字词（例如用\"躺着/歇着/呆着/玩呢\"代替低频生僻字，避免使用\"瘫/憩\"等非首屏汉字），便于手机输入法直接输入。\n3. 严禁使用生僻词、文言词、成语或火星文。',
  temperature: 0.7,
  maxTokens: 150,
  timeoutMs: 15000,
  contextMaxMessages: 60,
  deviceOverrides: {}
};

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '********';
  return trimmed.slice(0, 3) + '***' + trimmed.slice(-4);
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadSettings() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    const initial = { ...DEFAULT_SETTINGS, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function getSanitizedSettings(deviceId = null) {
  const settings = loadSettings();
  const effective = getEffectiveConfig(deviceId);

  return {
    revision: settings.revision,
    provider: effective.provider,
    endpoint: effective.endpoint,
    model: effective.model,
    systemPrompt: effective.systemPrompt,
    temperature: effective.temperature,
    maxTokens: effective.maxTokens,
    timeoutMs: effective.timeoutMs,
    contextMaxMessages: effective.contextMaxMessages,
    hasApiKey: Boolean(effective.apiKey && effective.apiKey.trim()),
    apiKeyMasked: maskApiKey(effective.apiKey),
    updatedAt: settings.updatedAt
  };
}

function saveSettings(updates = {}, expectedRevision = null) {
  ensureConfigDir();
  const current = loadSettings();

  if (expectedRevision !== null && expectedRevision !== undefined) {
    if (Number(expectedRevision) !== Number(current.revision)) {
      const err = new Error(`Config revision conflict: current is ${current.revision}, expected ${expectedRevision}`);
      err.code = 'REVISION_CONFLICT';
      throw err;
    }
  }

  const newRevision = (current.revision || 1) + 1;
  const now = new Date().toISOString();

  // 处理 API Key 更新逻辑：如果更新传入了屏蔽字符或空，且已有原 Key，保留原 Key
  let finalApiKey = current.apiKey;
  if (updates.apiKey !== undefined) {
    const rawInput = updates.apiKey.trim();
    if (rawInput && !rawInput.includes('***')) {
      finalApiKey = rawInput;
    } else if (updates.clearApiKey === true) {
      finalApiKey = '';
    }
  }

  const merged = {
    ...current,
    ...updates,
    apiKey: finalApiKey,
    revision: newRevision,
    updatedAt: now
  };
  delete merged.clearApiKey;

  // 写入临时文件后重命名保证原子性
  const tmpFile = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmpFile, CONFIG_FILE);

  return merged;
}

function getEffectiveConfig(deviceId = null) {
  const settings = loadSettings();
  if (deviceId && settings.deviceOverrides && settings.deviceOverrides[deviceId]) {
    return { ...settings, ...settings.deviceOverrides[deviceId] };
  }
  return settings;
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_SETTINGS,
  maskApiKey,
  loadSettings,
  getSanitizedSettings,
  saveSettings,
  getEffectiveConfig
};
