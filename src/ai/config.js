'use strict';

/**
 * AI 回复配置与多供应商管理模块 (AI Multi-Provider Configuration)
 *
 * 1. 支持管理多个 AI 供应商（如 DeepSeek 官方、硅基流动、OpenAI、通用自定义等）。
 * 2. 支持设置默认启用供应商（activeProviderId），业务调用与调度统一使用默认供应商。
 * 3. 密钥屏蔽：对外只暴露 hasApiKey 及脱敏掩码 (sk-***abcd)，禁止明文返回 API Key。
 * 4. 版本化增量与并发冲突保护：使用 revision 递增。
 */

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('../automation/runtime');

const CONFIG_DIR = path.join(PROJECT_ROOT, '.runtime', 'ai-reply');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  revision: 1,
  activeProviderId: 'prov_default',
  providers: null,
  provider: 'deepseek',
  endpoint: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  systemPrompt: '你是一个友好自然的真人，正在与朋友在社交App上聊天。\n【回复要求】：\n1. 语言简短真实、口语生活化，每次只回复一两句话，严禁出现AI助手或客服腔调。\n2. 务必使用常见高频的日常字词（例如用"躺着/歇着/呆着/玩呢"代替低频生僻字，避免使用"瘫/憩"等非首屏汉字），便于手机输入法直接输入。\n3. 严禁使用生僻词、文言词、成语或火星文。',
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

function normalizeSettings(parsed) {
  const settings = { ...DEFAULT_SETTINGS, ...(parsed || {}) };
  const rawProviders = Array.isArray(parsed?.providers) ? parsed.providers : null;
  if (!rawProviders || rawProviders.length === 0) {
    const defaultProvider = {
      id: 'prov_default',
      name: settings.provider === 'deepseek' ? 'DeepSeek 官方' : (settings.provider === 'openai' ? 'OpenAI 兼容' : '默认供应商'),
      provider: settings.provider || 'deepseek',
      endpoint: settings.endpoint || 'https://api.deepseek.com',
      apiKey: settings.apiKey || '',
      model: settings.model || 'deepseek-chat',
      temperature: Number(settings.temperature ?? 0.7),
      maxTokens: Number(settings.maxTokens ?? 150),
      timeoutMs: Number(settings.timeoutMs ?? 15000),
      createdAt: settings.createdAt || new Date().toISOString(),
      updatedAt: settings.updatedAt || new Date().toISOString()
    };
    settings.providers = [defaultProvider];
    settings.activeProviderId = 'prov_default';
  } else {
    settings.providers = settings.providers.map((p, idx) => ({
      id: p.id || `prov_${idx + 1}`,
      name: p.name || `供应商 ${idx + 1}`,
      provider: p.provider || 'openai',
      endpoint: p.endpoint || 'https://api.deepseek.com',
      apiKey: p.apiKey || '',
      model: p.model || 'deepseek-chat',
      temperature: Number(p.temperature ?? 0.7),
      maxTokens: Number(p.maxTokens ?? 150),
      timeoutMs: Number(p.timeoutMs ?? 15000),
      createdAt: p.createdAt || new Date().toISOString(),
      updatedAt: p.updatedAt || new Date().toISOString()
    }));
  }

  const hasActive = settings.providers.some(p => p.id === settings.activeProviderId);
  if (!hasActive && settings.providers.length > 0) {
    settings.activeProviderId = settings.providers[0].id;
  }

  const active = settings.providers.find(p => p.id === settings.activeProviderId) || settings.providers[0];
  if (active) {
    settings.provider = active.provider;
    settings.endpoint = active.endpoint;
    settings.apiKey = active.apiKey;
    settings.model = active.model;
    settings.temperature = active.temperature;
    settings.maxTokens = active.maxTokens;
    settings.timeoutMs = active.timeoutMs;
  }

  return settings;
}

function loadSettings() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    const initial = normalizeSettings({ createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch {
    return normalizeSettings({});
  }
}

function listProviders() {
  const settings = loadSettings();
  return (settings.providers || []).map(p => ({
    id: p.id,
    name: p.name,
    provider: p.provider,
    endpoint: p.endpoint,
    model: p.model,
    apiKeyMasked: maskApiKey(p.apiKey),
    hasApiKey: Boolean(p.apiKey && p.apiKey.trim()),
    temperature: p.temperature ?? 0.7,
    maxTokens: p.maxTokens ?? 150,
    timeoutMs: p.timeoutMs ?? 15000,
    isDefault: p.id === settings.activeProviderId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  }));
}

function getSanitizedSettings(deviceId = null) {
  const settings = loadSettings();
  const effective = getEffectiveConfig(deviceId);

  return {
    revision: settings.revision,
    activeProviderId: settings.activeProviderId,
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

  let finalApiKey = current.apiKey;
  if (updates.apiKey !== undefined) {
    const rawInput = String(updates.apiKey).trim();
    if (rawInput && !rawInput.includes('***')) {
      finalApiKey = rawInput;
    } else if (updates.clearApiKey === true) {
      finalApiKey = '';
    }
  }

  const merged = normalizeSettings({
    ...current,
    ...updates,
    apiKey: finalApiKey,
    revision: newRevision,
    updatedAt: now
  });
  delete merged.clearApiKey;

  const tmpFile = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmpFile, CONFIG_FILE);

  return merged;
}

function saveProvider(providerData = {}) {
  ensureConfigDir();
  const current = loadSettings();
  const now = new Date().toISOString();
  const providers = [...(current.providers || [])];

  const targetId = providerData.id ? String(providerData.id).trim() : '';
  const existingIndex = targetId ? providers.findIndex(p => p.id === targetId) : -1;
  const existing = existingIndex >= 0 ? providers[existingIndex] : null;

  let finalApiKey = existing ? existing.apiKey : '';
  if (providerData.apiKey !== undefined) {
    const rawInput = String(providerData.apiKey).trim();
    if (rawInput && !rawInput.includes('***')) {
      finalApiKey = rawInput;
    } else if (providerData.clearApiKey === true) {
      finalApiKey = '';
    }
  }

  const updatedProvider = {
    id: existing ? existing.id : (targetId || `prov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
    name: providerData.name ? String(providerData.name).trim() : (existing ? existing.name : '新供应商'),
    provider: providerData.provider ? String(providerData.provider).trim() : (existing ? existing.provider : 'openai'),
    endpoint: providerData.endpoint ? String(providerData.endpoint).trim() : (existing ? existing.endpoint : 'https://api.deepseek.com'),
    apiKey: finalApiKey,
    model: providerData.model ? String(providerData.model).trim() : (existing ? existing.model : 'deepseek-chat'),
    temperature: Number(providerData.temperature ?? (existing ? existing.temperature : 0.7)),
    maxTokens: Number(providerData.maxTokens ?? (existing ? existing.maxTokens : 150)),
    timeoutMs: Number(providerData.timeoutMs ?? (existing ? existing.timeoutMs : 15000)),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now
  };

  if (existingIndex >= 0) {
    providers[existingIndex] = updatedProvider;
  } else {
    providers.push(updatedProvider);
  }

  let activeProviderId = current.activeProviderId;
  if (providerData.isDefault === true || providers.length === 1) {
    activeProviderId = updatedProvider.id;
  }

  return saveSettings({
    providers,
    activeProviderId,
    updatedAt: now
  });
}

function deleteProvider(providerId) {
  ensureConfigDir();
  const current = loadSettings();
  const providers = [...(current.providers || [])];

  if (providers.length <= 1) {
    const err = new Error('系统至少需要保留一个 AI 供应商');
    err.code = 'LAST_PROVIDER';
    throw err;
  }

  const remaining = providers.filter(p => p.id !== providerId);
  if (remaining.length === providers.length) {
    const err = new Error('指定的供应商不存在');
    err.code = 'PROVIDER_NOT_FOUND';
    throw err;
  }

  let activeProviderId = current.activeProviderId;
  if (activeProviderId === providerId) {
    activeProviderId = remaining[0].id;
  }

  return saveSettings({
    providers: remaining,
    activeProviderId,
    updatedAt: new Date().toISOString()
  });
}

function setDefaultProvider(providerId) {
  ensureConfigDir();
  const current = loadSettings();
  const found = (current.providers || []).find(p => p.id === providerId);
  if (!found) {
    const err = new Error('指定的供应商不存在');
    err.code = 'PROVIDER_NOT_FOUND';
    throw err;
  }

  return saveSettings({
    activeProviderId: providerId,
    updatedAt: new Date().toISOString()
  });
}

function getEffectiveConfig(deviceId = null) {
  const settings = loadSettings();
  let activeProvider = null;
  if (Array.isArray(settings.providers) && settings.providers.length > 0) {
    activeProvider = settings.providers.find(p => p.id === settings.activeProviderId) || settings.providers[0];
  }

  const baseConfig = {
    ...settings,
    ...(activeProvider ? {
      activeProviderId: activeProvider.id,
      activeProviderName: activeProvider.name,
      provider: activeProvider.provider,
      endpoint: activeProvider.endpoint,
      apiKey: activeProvider.apiKey,
      model: activeProvider.model,
      temperature: activeProvider.temperature,
      maxTokens: activeProvider.maxTokens,
      timeoutMs: activeProvider.timeoutMs
    } : {})
  };

  if (deviceId && settings.deviceOverrides && settings.deviceOverrides[deviceId]) {
    return { ...baseConfig, ...settings.deviceOverrides[deviceId] };
  }
  return baseConfig;
}

module.exports = {
  CONFIG_FILE,
  DEFAULT_SETTINGS,
  maskApiKey,
  loadSettings,
  listProviders,
  saveProvider,
  deleteProvider,
  setDefaultProvider,
  getSanitizedSettings,
  saveSettings,
  getEffectiveConfig
};
