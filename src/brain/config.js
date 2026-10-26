'use strict';

/**
 * MOMO 调度中枢配置模块 (Brain Configuration)
 *
 * 遵循中枢执行计划第 12 节与 R1/B4 门禁：
 * 1. 默认模式为 observe (仅巡检/读取归档，不调用生成 API、不发送、不处理招呼或浏览)。
 * 2. 严格参数范围校验与版本化 revision 乐观锁。
 * 3. 独立持久化于 .runtime/momo-brain/config.json。
 */

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT } = require('../automation/runtime');

const BRAIN_DIR = path.join(PROJECT_ROOT, '.runtime', 'momo-brain');
const BRAIN_CONFIG_FILE = path.join(BRAIN_DIR, 'config.json');

const VALID_MODES = Object.freeze(['plan', 'observe', 'draft', 'execute']);

const DEFAULT_BRAIN_CONFIG = {
  revision: 1,
  mode: 'observe', // plan | observe | draft | execute
  autoReplyEnabled: false,
  pollIntervalMs: 2000,
  idleMaxPollIntervalMs: 5000,
  fullSweepIntervalMs: 60000,
  maxListPagesPerSlice: 2,
  maxContactsPerReplyRun: 1,
  maxIdleOffListMs: 15000,
  maxBackSteps: 8,
  recoveryTimeoutMs: 30000,
  browseEnabled: false,
  browseIntervalMs: 900000,
  greetingsEnabled: false,
  greetingsIntervalMs: 1200000,
  maxApprovedPerRun: 2,
  autoResumeAfterRestart: false,
  resumeAfterManual: false,
  deviceOverrides: {}
};

function validateBrainConfig(updates = {}, current = DEFAULT_BRAIN_CONFIG) {
  const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_CONFIG' }); };
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) invalid('Config must be an object');
  for (const field of ['autoReplyEnabled','browseEnabled','greetingsEnabled','autoResumeAfterRestart','resumeAfterManual']) {
    if (updates[field] !== undefined && typeof updates[field] !== 'boolean') invalid(field + ' must be boolean');
  }
  for (const field of ['pollIntervalMs','idleMaxPollIntervalMs','fullSweepIntervalMs','maxListPagesPerSlice','maxContactsPerReplyRun',
    'maxIdleOffListMs','maxBackSteps','recoveryTimeoutMs','browseIntervalMs','greetingsIntervalMs','maxApprovedPerRun']) {
    if (updates[field] !== undefined && (!Number.isSafeInteger(updates[field]) || updates[field] < 1 || updates[field] > 86400000)) invalid(field + ' must be a bounded integer');
  }
  if (updates.maxContactsPerReplyRun !== undefined && updates.maxContactsPerReplyRun > 5) invalid('maxContactsPerReplyRun must be <= 5');
  const combined = { ...current, ...updates };
  if (combined.idleMaxPollIntervalMs < combined.pollIntervalMs || combined.fullSweepIntervalMs < combined.pollIntervalMs) invalid('Poll intervals are inconsistent');
  if (updates.deviceOverrides !== undefined) {
    if (!updates.deviceOverrides || typeof updates.deviceOverrides !== 'object' || Array.isArray(updates.deviceOverrides)) invalid('deviceOverrides must be an object');
    for (const override of Object.values(updates.deviceOverrides)) {
      if (override?.deviceOverrides !== undefined) invalid('Nested deviceOverrides are not allowed');
      validateBrainConfig(override, { ...combined, deviceOverrides: {} });
    }
  }
  if (updates.mode !== undefined) {
    if (!VALID_MODES.includes(updates.mode)) {
      const err = new Error(`Invalid mode: "${updates.mode}". Allowed modes: ${VALID_MODES.join(', ')}`);
      err.code = 'INVALID_CONFIG';
      throw err;
    }
  }

  if (updates.pollIntervalMs !== undefined) {
    const val = Number(updates.pollIntervalMs);
    if (!Number.isFinite(val) || val < 500 || val > 60000) {
      const err = new Error(`pollIntervalMs must be between 500 and 60000 (got ${updates.pollIntervalMs})`);
      err.code = 'INVALID_CONFIG';
      throw err;
    }
  }

  const pollInterval = updates.pollIntervalMs !== undefined ? Number(updates.pollIntervalMs) : current.pollIntervalMs;

  if (updates.idleMaxPollIntervalMs !== undefined) {
    const val = Number(updates.idleMaxPollIntervalMs);
    if (!Number.isFinite(val) || val < pollInterval) {
      const err = new Error(`idleMaxPollIntervalMs must be >= pollIntervalMs (${pollInterval})`);
      err.code = 'INVALID_CONFIG';
      throw err;
    }
  }

  if (updates.fullSweepIntervalMs !== undefined) {
    const val = Number(updates.fullSweepIntervalMs);
    if (!Number.isFinite(val) || val < pollInterval) {
      const err = new Error(`fullSweepIntervalMs must be >= pollIntervalMs (${pollInterval})`);
      err.code = 'INVALID_CONFIG';
      throw err;
    }
  }

  if (updates.maxListPagesPerSlice !== undefined) {
    const val = Number(updates.maxListPagesPerSlice);
    if (!Number.isInteger(val) || val < 1 || val > 10) {
      const err = new Error(`maxListPagesPerSlice must be integer between 1 and 10 (got ${updates.maxListPagesPerSlice})`);
      err.code = 'INVALID_CONFIG';
      throw err;
    }
  }

  if (updates.maxBackSteps !== undefined) {
    const val = Number(updates.maxBackSteps);
    if (!Number.isInteger(val) || val < 1 || val > 8) {
      const err = new Error(`maxBackSteps must be integer between 1 and 8 (got ${updates.maxBackSteps})`);
      err.code = 'INVALID_CONFIG';
      throw err;
    }
  }

  if (updates.recoveryTimeoutMs !== undefined) {
    const val = Number(updates.recoveryTimeoutMs);
    if (!Number.isFinite(val) || val < 1000 || val > 60000) {
      const err = new Error(`recoveryTimeoutMs must be between 1000 and 60000 (got ${updates.recoveryTimeoutMs})`);
      err.code = 'INVALID_CONFIG';
      throw err;
    }
  }

  if (updates.maxApprovedPerRun !== undefined) {
    const val = Number(updates.maxApprovedPerRun);
    if (!Number.isInteger(val) || val < 1 || val > 20) {
      const err = new Error(`maxApprovedPerRun must be integer between 1 and 20 (got ${updates.maxApprovedPerRun})`);
      err.code = 'INVALID_CONFIG';
      throw err;
    }
  }
}

function ensureBrainDir() {
  if (!fs.existsSync(BRAIN_DIR)) {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
  }
}

function loadBrainConfig() {
  ensureBrainDir();
  if (!fs.existsSync(BRAIN_CONFIG_FILE)) {
    const initial = { ...DEFAULT_BRAIN_CONFIG, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    fs.writeFileSync(BRAIN_CONFIG_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }

  try {
    const raw = fs.readFileSync(BRAIN_CONFIG_FILE, 'utf8');
    return { ...DEFAULT_BRAIN_CONFIG, ...JSON.parse(raw) };
  } catch (cause) {
    throw Object.assign(new Error('Brain config is corrupt; refusing automatic fallback'), { code: 'CONFIG_CORRUPT', cause });
  }
}

function saveBrainConfig(updates = {}, expectedRevision = null) {
  ensureBrainDir();
  const current = loadBrainConfig();

  if (expectedRevision !== null && expectedRevision !== undefined) {
    if (Number(expectedRevision) !== Number(current.revision)) {
      const err = new Error(`Brain config revision conflict: current is ${current.revision}, expected ${expectedRevision}`);
      err.code = 'REVISION_CONFLICT';
      throw err;
    }
  }

  // 严格参数范围校验 (F16)
  validateBrainConfig(updates, current);

  const newRevision = (current.revision || 1) + 1;
  const now = new Date().toISOString();

  const merged = {
    ...current,
    ...updates,
    revision: newRevision,
    updatedAt: now
  };
  validateBrainConfig(merged);

  const tmpFile = BRAIN_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(merged, null, 2), 'utf8');
  fs.renameSync(tmpFile, BRAIN_CONFIG_FILE);

  return merged;
}

function getEffectiveBrainConfig(deviceId = null) {
  const config = loadBrainConfig();
  validateBrainConfig(config);
  if (deviceId && config.deviceOverrides && config.deviceOverrides[deviceId]) {
    return { ...config, ...config.deviceOverrides[deviceId] };
  }
  return config;
}

module.exports = {
  BRAIN_DIR,
  BRAIN_CONFIG_FILE,
  DEFAULT_BRAIN_CONFIG,
  VALID_MODES,
  validateBrainConfig,
  loadBrainConfig,
  saveBrainConfig,
  getEffectiveBrainConfig
};
