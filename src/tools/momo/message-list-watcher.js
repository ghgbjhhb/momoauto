'use strict';

/**
 * MOMO 消息列表持续监听器。
 *
 * 这个模块只做三件事：
 * 1. 用统一页面观测服务确认当前仍是 MOMO 消息列表；
 * 2. 在同一帧里读取消息列表模型、OCR 和红点/数字角标；
 * 3. 对新出现或状态变化的未读候选发出回调；显式 drain 模式还会处理未入库联系人。
 *
 * 默认轮询不会自行返回、点击联系人或发送消息。显式 drain 模式会在每个动作前
 * 重新确认页面，并在聊天详情页调用入库/回复回调。
 */

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { observePage } = require('../../automation/page-service');
const { checkSignal, sleep } = require('../../automation/cancellation');
const { recoverToAllowedPage } = require('../../automation/page-recovery');
const { returnMessageListTop, listSignature } = require('../../automation/message-list-navigation');
const { scanMessageListCandidates } = require('./message-list-parser');
const { MomoDatabase, getDeviceDatabasePath } = require('./db');
const { defaultArbiter } = require('../../server/device-arbiter');

const BASELINE_MODES = new Set(['skip', 'process']);

function asError(error, fallbackCode = 'MESSAGE_WATCH_FAILED') {
  return {
    code: error?.code ?? fallbackCode,
    message: error?.message ?? 'Message list watcher failed',
  };
}

function watcherFailure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function candidateSignature(candidate) {
  return JSON.stringify({
    peerName: candidate.peerName,
    unreadState: candidate.unreadState ?? (candidate.hasUnread ? 'unknown' : 'none'),
    unreadCount: candidate.unreadCount ?? null,
    lastMessage: candidate.lastMessage ?? '',
  });
}

function normalizeContactName(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/g, '').trim();
}

function editDistance(left, right) {
  const a = normalizeContactName(left);
  const b = normalizeContactName(right);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

function contactRecordIsRegistered(record) {
  return Boolean(record?.syncedAt && record.syncedAt !== 'IGNORED_NON_CONTACT');
}

function findDatabaseContact(database, peerName) {
  const exact = database.getContactByName(peerName);
  if (exact) return exact;

  const normalizedName = normalizeContactName(peerName);
  if (!normalizedName) return null;
  const contacts = database.listContacts(10000);
  const normalizedMatches = contacts.filter(contact =>
    normalizeContactName(contact?.name) === normalizedName);
  if (normalizedMatches.length === 1) return normalizedMatches[0];

  // OCR 常见的是单字符替换、漏字或多出一个字符。只有最小编辑距离唯一且
  // 不超过 1 时才认为是同一联系人，避免把两个相近昵称错误合并。
  if (normalizedName.length < 2) return null;
  const fuzzyMatches = contacts
    .map(contact => ({ contact, distance: editDistance(contact?.name, normalizedName) }))
    .filter(item => item.distance <= 1)
    .sort((left, right) => left.distance - right.distance);
  if (fuzzyMatches.length && fuzzyMatches[0].distance <= 1 &&
      (fuzzyMatches.length === 1 || fuzzyMatches[0].distance < fuzzyMatches[1].distance)) {
    return fuzzyMatches[0].contact;
  }
  return null;
}

function findCandidateByPeerName(scan, peerName) {
  const candidates = scan?.candidates ?? [];
  const exact = candidates.find(candidate => candidate.peerName === peerName);
  if (exact) return exact;

  const normalizedName = normalizeContactName(peerName);
  if (!normalizedName) return null;
  const normalizedMatches = candidates.filter(candidate =>
    normalizeContactName(candidate.peerName) === normalizedName);
  if (normalizedMatches.length === 1) return normalizedMatches[0];
  if (normalizedName.length < 2) return null;

  const fuzzyMatches = candidates
    .map(candidate => ({ candidate, distance: editDistance(candidate.peerName, normalizedName) }))
    .filter(item => item.distance <= 1)
    .sort((left, right) => left.distance - right.distance);
  if (fuzzyMatches.length && fuzzyMatches[0].distance <= 1 &&
      (fuzzyMatches.length === 1 || fuzzyMatches[0].distance < fuzzyMatches[1].distance)) {
    return fuzzyMatches[0].candidate;
  }
  return null;
}

function targetPageFailure(observation) {
  if (!observation || observation.ok !== true) {
    return { code: observation?.error?.code ?? 'PAGE_OBSERVATION_FAILED',
      message: observation?.error?.message ?? 'A fresh page observation was not available' };
  }
  if (observation.app !== 'momo') return { code: 'TARGET_APP_MISMATCH', message: 'Current page is not MOMO' };
  if (observation.page !== 'message_list') return { code: 'MESSAGE_LIST_UNCONFIRMED', message: 'Current page is not the MOMO message list' };
  if (observation.scene !== 'normal') return { code: 'MESSAGE_LIST_SCENE_UNSAFE', message: 'MOMO message list is not in a normal scene' };
  if (observation.overlay !== 'none') return { code: 'PAGE_GUARD_ACTIVE', message: `MOMO page has a ${observation.overlay} overlay` };
  const list = observation.evidence?.listRaw;
  if (!list || !Array.isArray(list.chat_cards) || !Array.isArray(list.other_elements)) {
    return { code: 'MESSAGE_LIST_RECOGNITION_MISSING', message: 'Message list recognition evidence is incomplete' };
  }
  return null;
}

function detailPageFailure(observation) {
  if (!observation || observation.ok !== true) {
    return { code: observation?.error?.code ?? 'PAGE_OBSERVATION_FAILED',
      message: observation?.error?.message ?? 'A fresh chat detail observation was not available' };
  }
  if (observation.app !== 'momo') return { code: 'TARGET_APP_MISMATCH', message: 'Current page is not MOMO' };
  if (observation.page !== 'chat_detail') return { code: 'CHAT_DETAIL_UNCONFIRMED', message: 'The selected contact did not open a MOMO chat detail page' };
  if (observation.scene !== 'normal') return { code: 'CHAT_DETAIL_SCENE_UNSAFE', message: 'MOMO chat detail is not in a normal scene' };
  if (observation.overlay !== 'none') return { code: 'PAGE_GUARD_ACTIVE', message: `MOMO chat detail has a ${observation.overlay} overlay` };
  return null;
}

function viewportSignature(observation, scan) {
  const ocrSignature = listSignature(observation);
  if (ocrSignature !== '[]') return ocrSignature;
  return JSON.stringify((scan?.candidates ?? []).map(candidate => [
    candidate.peerName,
    candidate.unreadState,
    candidate.unreadCount,
    ...(candidate.box ?? []).map(value => Math.round(Number(value) / 4)),
  ]));
}

function safeCandidate(candidate) {
  return candidate ? {
    peerName: candidate.peerName,
    box: candidate.box,
    unreadCount: candidate.unreadCount,
    unreadState: candidate.unreadState,
    unreadEvidence: candidate.unreadEvidence,
    lastMessage: candidate.lastMessage,
  } : null;
}

function optionInteger(value, name, fallback, min, max) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return result;
}

function currentCandidate(scan, peerName) {
  const candidate = findCandidateByPeerName(scan, peerName);
  return candidate ?? null;
}

class MomoMessageListWatcher {
  constructor(options = {}) {
    if (!options.deviceId) throw new TypeError('deviceId is required');
    if (options.client === undefined && options.tools === undefined && options.observePage === undefined) {
      throw new TypeError('client, tools, or observePage is required');
    }
    if (options.onUnread !== undefined && typeof options.onUnread !== 'function') throw new TypeError('onUnread must be a function');
    if (options.onContact !== undefined && typeof options.onContact !== 'function') throw new TypeError('onContact must be a function');
    if (options.onUnregisteredContact !== undefined && typeof options.onUnregisteredContact !== 'function') {
      throw new TypeError('onUnregisteredContact must be a function');
    }
    if (options.contactLookup !== undefined && typeof options.contactLookup !== 'function') {
      throw new TypeError('contactLookup must be a function');
    }
    if (options.includeUnregistered !== undefined && typeof options.includeUnregistered !== 'boolean') {
      throw new TypeError('includeUnregistered must be a boolean');
    }
    if (options.dbPath !== undefined &&
        (typeof options.dbPath !== 'string' || !options.dbPath.trim() || /[\r\n\0]/.test(options.dbPath))) {
      throw new TypeError('dbPath must be a non-empty single-line path');
    }
    if (options.onState !== undefined && typeof options.onState !== 'function') throw new TypeError('onState must be a function');
    if (options.baselineMode !== undefined && !BASELINE_MODES.has(options.baselineMode)) {
      throw new TypeError('baselineMode must be skip or process');
    }

    this.deviceId = String(options.deviceId);
    this.client = options.client ?? null;
    this.phone = null;
    this.tools = options.tools ?? null;
    this.control = options.control ?? null;
    this.pool = options.pool ?? this.tools?._recognitionPool ?? null;
    this.observePageFn = options.observePage ?? observePage;
    this.customObserver = options.observePage !== undefined;
    this.sleepFn = options.sleep ?? sleep;
    this.arbiter = options.arbiter ?? defaultArbiter;
    this.ownerId = String(options.ownerId ?? `momo-message-watch:${this.deviceId}:${randomUUID()}`);
    this.onUnread = options.onUnread ?? (async () => {});
    // Deliberately empty by default. The future reply script is called only after
    // a fresh chat_detail observation has passed detailPageFailure().
    this.onContact = options.onContact ?? (async () => {});
    // The workflow supplies the existing contact/message ingestion script here.
    // Direct watcher users opt into this branch with includeUnregistered:true.
    this.onUnregisteredContact = options.onUnregisteredContact ?? (async () => {});
    this.onState = options.onState ?? null;
    this.intervalMs = Number(options.intervalMs ?? 3000);
    this.timeoutMs = Number(options.timeoutMs ?? 15000);
    this.baselineMode = 'process'; // 永久固定为 process：只要视口内发现未读红点，必须即刻处理，彻底废弃“开局装瞎跳过”
    this.missingScansToClear = Number(options.missingScansToClear ?? 2);
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 0 || this.intervalMs > 300000) {
      throw new TypeError('intervalMs must be an integer between 0 and 300000');
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300000) {
      throw new TypeError('timeoutMs must be an integer between 1 and 300000');
    }
    if (!Number.isInteger(this.missingScansToClear) || this.missingScansToClear < 1 || this.missingScansToClear > 20) {
      throw new TypeError('missingScansToClear must be an integer between 1 and 20');
    }
    this.onlyContacts = Array.isArray(options.onlyContacts) ? [...options.onlyContacts] : undefined;
    this.contactLookup = options.contactLookup ?? null;
    this.dbPath = options.dbPath ?? null;
    this.contactDb = null;
    this.contactDbPath = null;
    this.includeUnregistered = options.includeUnregistered === undefined ?
      Boolean(options.onUnregisteredContact) : options.includeUnregistered;
    this.contactSyncOptions = options.contactSyncOptions && typeof options.contactSyncOptions === 'object' ?
      { ...options.contactSyncOptions } : {};
    this.aiReplyOptions = options.aiReplyOptions && typeof options.aiReplyOptions === 'object' ?
      { ...options.aiReplyOptions } : {};
    this.stopOnCallbackError = options.stopOnCallbackError === true;
    this.activeSignals = new Map();
    this.initialized = false;
    this.iterations = 0;
    this.eventsDetected = 0;
    this.callbacksCompleted = 0;
    this.callbacksFailed = 0;
    this.lease = options.lease ?? null;
    this.ownsLease = false;
    this.closed = false;
    this.stopController = new AbortController();
  }

  _assertLease() {
    if (this.lease && this.arbiter?.assertLease) this.arbiter.assertLease(this.lease);
  }

  async _ensureRuntime() {
    if (this.customObserver) return;
    if (this.tools) {
      this.pool ||= this.tools._recognitionPool;
      this._syncRuntimeControl();
      return;
    }
    if (!this.client) throw watcherFailure('NO_DEVICE_PROVIDER', 'A client is required to create the device tools');
    this.phone = this.client.device(this.deviceId);
    this.tools = this.phone.tools({ control: this.control ?? undefined });
    this.pool = this.tools._recognitionPool;
    this._syncRuntimeControl();
  }

  _syncRuntimeControl() {
    if (!this.control) this.control = this.tools?._control ?? this.tools?.control ?? null;
    return this.control;
  }

  _session() {
    this._syncRuntimeControl();
    return {
      deviceId: this.deviceId,
      control: this.control,
      tools: this.tools,
      pool: this.pool,
      recognitionPool: this.pool,
      generation: this.control?.generation ?? this.control?._generation ?? 1,
      assertActive: () => this._assertLease(),
    };
  }

  async _observe(options = {}) {
    await this._ensureRuntime();
    this._assertLease();
    return this.observePageFn(this._session(), {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxFrameAgeMs: options.maxFrameAgeMs ?? 2000,
    });
  }

  _ensureContactDatabase() {
    if (this.contactLookup) return null;
    if (this.contactDb) return this.contactDb;
    const selectedPath = this.dbPath ?? getDeviceDatabasePath(this.deviceId);
    this.contactDbPath = selectedPath === ':memory:' ? ':memory:' : path.resolve(selectedPath);
    try {
      this.contactDb = new MomoDatabase(this.contactDbPath);
      return this.contactDb;
    } catch (error) {
      throw watcherFailure('MOMO_DATABASE_OPEN_FAILED', 'Could not open the MOMO contact database', {
        causeCode: error.code ?? 'DATABASE_ERROR',
      });
    }
  }

  async _contactStatus(peerName) {
    const record = this.contactLookup ?
      await this.contactLookup(peerName) :
      findDatabaseContact(this._ensureContactDatabase(), peerName);
    return { record: record ?? null, registered: contactRecordIsRegistered(record) };
  }

  async _findNextActionCandidate(scan, handled, includeUnregistered) {
    for (const candidate of scan?.candidates ?? []) {
      const signature = candidateSignature(candidate);
      if (handled.get(candidate.peerName) === signature) continue;
      const isUnread = Boolean(candidate.hasUnread);
      let contactStatus = { record: null, registered: true };
      if (includeUnregistered) contactStatus = await this._contactStatus(candidate.peerName);
      const isUnregistered = includeUnregistered && !contactStatus.registered;
      if (isUnread || isUnregistered) {
        return { candidate, isUnread, isUnregistered, contactRecord: contactStatus.record };
      }
    }
    return null;
  }

  async observeTargetPage(options = {}) {
    const observation = await this._observe(options);
    const failure = targetPageFailure(observation);
    if (failure) {
      return { ok: false, status: observation?.ok === false ? 'observation_failed' : 'waiting_page',
        code: failure.code, error: failure, observation, scan: null };
    }
    const scan = scanMessageListCandidates(observation.evidence.ocrData, observation.evidence.listRaw,
      observation.evidence.pageRaw, { onlyContacts: this.onlyContacts });
    if (scan.isOnMatchTab || scan.isConfirmedMessageList === false) {
      return { ok: false, status: 'waiting_page', code: 'MESSAGE_LIST_UNCONFIRMED',
        error: { code: 'MESSAGE_LIST_UNCONFIRMED', message: 'Message list candidate evidence is not confirmed' },
        observation, scan };
    }
    return { ok: true, status: 'target_ready', observation, scan };
  }

  clearActiveSignal(peerName) {
    if (peerName) this.activeSignals.delete(peerName);
  }

  _reconcile(scan, observation) {
    const unread = new Map((scan.candidates ?? []).filter(candidate => candidate.hasUnread)
      .map(candidate => [candidate.peerName, candidate]));
    const events = [];

    this.initialized = true;
    for (const candidate of unread.values()) {
      const previous = this.activeSignals.get(candidate.peerName);
      const signature = candidateSignature(candidate);
      if (!previous) {
        events.push(this._event('new_unread', candidate, null, observation));
      } else if (previous.signature !== signature) {
        events.push(this._event('unread_changed', candidate, previous.candidate, observation));
      }
      this.activeSignals.set(candidate.peerName, { candidate, signature, misses: 0 });
    }

    for (const [peerName, state] of this.activeSignals) {
      if (unread.has(peerName)) continue;
      const misses = state.misses + 1;
      if (misses >= this.missingScansToClear) this.activeSignals.delete(peerName);
      else this.activeSignals.set(peerName, { ...state, misses });
    }
    return events;
  }

  _event(type, candidate, previous, observation) {
    return {
      type,
      peerName: candidate.peerName,
      candidate,
      previous,
      snapshotId: observation.snapshotId,
      capturedAt: observation.capturedAt,
      generation: observation.generation,
      detectedAt: new Date().toISOString(),
      clearSignal: () => this.clearActiveSignal(candidate.peerName),
      withTargetPage: action => this.runWithTargetPage(candidate.peerName, action, {
        initialObservation: observation,
        initialCandidate: candidate,
      }),
    };
  }

  async runWithTargetPage(peerName, action, options = {}) {
    if (typeof action !== 'function') throw new TypeError('action must be a function');
    this._assertLease();

    let observation = null;
    let scan = null;
    let candidate = null;

    // 若传入了上一阶段刚获取且未被动作破坏的同帧证据，直接复用新鲜坐标，避免无谓重测引发 TOCTOU 抖动
    const initObs = options.initialObservation;
    const initCandidate = options.initialCandidate;
    const isFresh = initObs && !targetPageFailure(initObs) &&
      (Date.now() - new Date(initObs.capturedAt).getTime() < 3000);

    if (isFresh && initCandidate && initCandidate.peerName === peerName) {
      observation = initObs;
      candidate = initCandidate;
      scan = options.initialScan ?? null;
    } else {
      const result = await this.observeTargetPage(options);
      if (!result.ok) throw watcherFailure(result.code, result.error.message, { observation: result.observation });
      candidate = currentCandidate(result.scan, peerName);
      if (!candidate) throw watcherFailure('CANDIDATE_CHANGED', 'The unread candidate is no longer present on the confirmed message list', { peerName });
      observation = result.observation;
      scan = result.scan;
    }

    this._assertLease();
    return action({
      deviceId: this.deviceId,
      peerName,
      candidate,
      observation,
      scan,
      tools: this.tools,
      control: this.control,
      leaseToken: this.lease?.leaseToken,
      assertTargetPage: async () => this.runWithTargetPage(peerName, async context => context, {}),
    });
  }

  async _requireTargetPage(options = {}) {
    const result = await this.observeTargetPage(options);
    if (!result.ok) throw watcherFailure(result.code, result.error?.message ?? 'MOMO message list is not confirmed', {
      observation: result.observation, scan: result.scan,
    });
    return result;
  }

  async _requireChatDetail(options = {}) {
    const observation = await this._observe(options);
    const failure = detailPageFailure(observation);
    if (failure) throw watcherFailure(failure.code, failure.message, { observation });
    return observation;
  }

  async _swipeList(observation, direction, options = {}) {
    if (!this.tools || typeof this.tools.swipe !== 'function') {
      throw watcherFailure('NO_SWIPE_PROVIDER', 'Message-list drain requires a swipe provider');
    }
    const width = Number(observation?.width);
    const height = Number(observation?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
      throw watcherFailure('INVALID_OBSERVATION_SIZE', 'Message-list observation has no usable dimensions');
    }
    const fingerDown = direction === 'backward';
    const fromY = fingerDown ? height * .30 : height * .78;
    const toY = fingerDown ? height * .78 : height * .30;
    const result = await this.tools.swipe([
      { x: Math.round(width * .5), y: Math.round(fromY) },
      { x: Math.round(width * .5), y: Math.round(toY) },
    ], {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      durationMs: options.swipeDurationMs ?? 450,
      coordinateSpace: { width, height },
    });
    this._syncRuntimeControl();
    if (!result || result.ok !== true) {
      throw watcherFailure(result?.error?.code ?? 'SWIPE_FAILED', result?.error?.message ?? 'Message-list swipe failed', { result });
    }
    await this.sleepFn(options.settleMs ?? 500, options.signal);
    return result;
  }

  async _moveToTop(observation, options = {}) {
    let current = observation;
    this._syncRuntimeControl();

    // The public tool owns the control connection and exposes it only after a
    // real gesture. Prime that connection with a guarded downward swipe when
    // the watcher was created without a borrowed control.
    if (typeof this.control?.swipe !== 'function') {
      await this._swipeList(current, 'backward', options);
      current = (await this._requireTargetPage(options)).observation;
      this._syncRuntimeControl();
    }

    const result = await returnMessageListTop(this._session(), current, {
      signal: options.signal,
      maxSteps: options.maxTopSteps ?? 26,
      settleMs: options.settleMs ?? 500,
      observePage: this.observePageFn,
      validateObservation: targetPageFailure,
    });
    if (!result.ok) {
      throw watcherFailure(result.code ?? 'LIST_TOP_UNCONFIRMED', 'Unable to confirm the top of the MOMO message list', {
        result,
      });
    }
    return result.observation;
  }

  async _returnToMessageList(options = {}) {
    this._syncRuntimeControl();
    const recovery = await recoverToAllowedPage(this._session(), ['message_list'], {
      signal: options.signal,
      allowOpenMomo: false,
      maxBackSteps: options.maxBackSteps ?? 3,
      maxNoProgressBacks: options.maxNoProgressBacks ?? 2,
      recoveryTimeoutMs: options.recoveryTimeoutMs ?? Math.min(30000, this.timeoutMs * 2),
      settleMs: options.settleMs ?? 500,
      observePage: this.observePageFn,
    });
    if (recovery.status !== 'reached_target') {
      throw watcherFailure(recovery.error?.code ?? 'MESSAGE_LIST_RECOVERY_FAILED',
        recovery.error?.message ?? 'Unable to return to the confirmed MOMO message list', { recovery });
    }
    return this._requireTargetPage(options);
  }

  async _processContact(peerName, options = {}) {
    const listResult = await this._requireTargetPage(options);
    const candidate = findCandidateByPeerName(listResult.scan, peerName);
    if (!candidate) throw watcherFailure('CANDIDATE_CHANGED', 'The contact is no longer present on the confirmed message list', { peerName });
    const includeUnregistered = options.includeUnregistered ?? this.includeUnregistered;
    const isUnread = Boolean(candidate.hasUnread);
    const contactStatus = includeUnregistered ?
      await this._contactStatus(peerName) : { record: null, registered: true };
    const isUnregistered = includeUnregistered && !contactStatus.registered;
    const actionContactName = contactStatus.registered && contactStatus.record?.name ?
      contactStatus.record.name : peerName;
    if (!isUnread && !isUnregistered) {
      throw watcherFailure('CANDIDATE_NOT_ACTIONABLE', 'The contact has no unread badge and is already registered', {
        peerName,
      });
    }
    if (!this.tools || typeof this.tools.clickRegion !== 'function') {
      throw watcherFailure('NO_CLICK_PROVIDER', 'Message-list drain requires a click provider');
    }

    let actionError = null;
    let detailObservation = null;
    let listAfter = null;
    try {
      this._assertLease();
      const clickResult = await this.tools.clickRegion(candidate.box, {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.timeoutMs,
        coordinateSpace: { width: listResult.observation.width, height: listResult.observation.height },
      });
      this._syncRuntimeControl();
      if (!clickResult || clickResult.ok !== true) {
        throw watcherFailure(clickResult?.error?.code ?? 'CONTACT_CLICK_FAILED',
          clickResult?.error?.message ?? 'Unable to click the unread contact', { clickResult });
      }

      detailObservation = await this._observe(options);
      const detailFailure = detailPageFailure(detailObservation);
      if (detailFailure) throw watcherFailure(detailFailure.code, detailFailure.message, { observation: detailObservation });

      const callbackContext = {
        deviceId: this.deviceId,
        peerName,
        contactName: actionContactName,
        candidate,
        client: this.client,
        listObservation: listResult.observation,
        detailObservation,
        tools: this.tools,
        control: this.control,
        leaseToken: this.lease?.leaseToken ?? null,
        assertActive: () => this._assertLease(),
        signal: options.signal,
        isUnread,
        isUnregistered,
        contactRecord: contactStatus.record,
        dbPath: this.contactDbPath ?? this.dbPath ?? null,
        contactSyncOptions: { ...this.contactSyncOptions },
        aiReplyOptions: { ...this.aiReplyOptions },
        assertChatDetail: async () => this._requireChatDetail(options),
      };

      // 入库先于回复：这样后续回复脚本可以直接使用刚刚写入的联系人和历史。
      // 每个回调前都重新确认聊天详情页；回调不能依赖点击后的旧页面状态。
      if (isUnregistered) {
        await this.onUnregisteredContact({
          ...callbackContext,
          type: 'unregistered_contact_opened',
          detailObservation,
        });
      }
      if (isUnread) {
        if (isUnregistered) detailObservation = await this._requireChatDetail(options);
        await this.onContact({
          ...callbackContext,
          type: 'unread_contact_opened',
          detailObservation,
        });
      }
    } catch (error) {
      actionError = error;
    } finally {
      try {
        listAfter = await this._returnToMessageList(options);
      } catch (error) {
        if (!actionError) actionError = error;
        else actionError = watcherFailure('CONTACT_ACTION_AND_RECOVERY_FAILED',
          `${actionError.message}; returning to the message list also failed`, {
            action: asError(actionError, 'CONTACT_ACTION_FAILED'),
            recovery: asError(error, 'MESSAGE_LIST_RECOVERY_FAILED'),
          });
      }
    }

    if (actionError) throw actionError;
    return {
      ok: true,
      peerName,
      candidate,
      actions: { unread: isUnread, unregistered: isUnregistered },
      detailObservation,
      listAfter: listAfter?.observation ?? null,
    };
  }

  async drainUnread(options = {}) {
    if (this.closed) throw watcherFailure('WATCHER_CLOSED', 'Message list watcher is closed');
    const externalSignal = options.signal;
    const signal = externalSignal && typeof AbortSignal.any === 'function' ?
      AbortSignal.any([externalSignal, this.stopController.signal]) : this.stopController.signal;
    const maxPages = optionInteger(options.maxPages, 'maxPages', 30, 1, 200);
    const maxRounds = optionInteger(options.maxRounds, 'maxRounds', 3, 1, 20);
    const maxContacts = optionInteger(options.maxContacts, 'maxContacts', 100, 1, 1000);
    const execute = options.execute === true;
    const includeUnregistered = options.includeUnregistered === undefined ?
      this.includeUnregistered : options.includeUnregistered;
    if (typeof includeUnregistered !== 'boolean') {
      throw new TypeError('includeUnregistered must be a boolean');
    }

    if (!execute) {
      const result = await this.observeTargetPage({ signal, timeoutMs: options.timeoutMs ?? this.timeoutMs });
      return {
        ok: false,
        status: 'execution_required',
        code: 'EXECUTION_REQUIRED',
        message: 'Unread drain is observation-only until execute:true is explicitly supplied',
        target: result,
      };
    }

    await this._acquireLease();
    const clicked = [];
    const failures = [];
    const handled = new Map();
    let pagesScanned = 0;
    let rounds = 0;
    let lastTarget = null;
    try {
      for (rounds = 1; rounds <= maxRounds; rounds++) {
        checkSignal(signal);
        this._assertLease();
        const initial = await this._requireTargetPage({ signal, timeoutMs: options.timeoutMs ?? this.timeoutMs });
        lastTarget = initial;
        let observation = await this._moveToTop(initial.observation, { ...options, signal });
        let passClicked = 0;
        const seenViewports = new Set();
        let reachedBottom = false;

        for (let page = 0; page < maxPages; page++) {
          checkSignal(signal);
          this._assertLease();
          let current = await this._requireTargetPage({ signal, timeoutMs: options.timeoutMs ?? this.timeoutMs });
          observation = current.observation;
          const pageSignature = viewportSignature(current.observation, current.scan);
          if (seenViewports.has(pageSignature)) {
            reachedBottom = true;
            break;
          }
          seenViewports.add(pageSignature);
          pagesScanned++;

          // Re-observe after every contact because opening a conversation can
          // change the list, scroll position, and the red-dot state.
          for (;;) {
            checkSignal(signal);
            current = await this._requireTargetPage({ signal, timeoutMs: options.timeoutMs ?? this.timeoutMs });
            observation = current.observation;
            const action = await this._findNextActionCandidate(current.scan, handled, includeUnregistered);
            if (!action) break;
            const candidate = action.candidate;
            if (clicked.length >= maxContacts) {
              return {
                ok: false, status: 'contact_budget_exhausted', code: 'MAX_CONTACTS_REACHED',
                rounds, pagesScanned, clicked, failures, lastTarget,
              };
            }
            try {
              const processed = await this._processContact(candidate.peerName, {
                ...options, includeUnregistered, signal,
              });
              handled.set(candidate.peerName, candidateSignature(processed.candidate));
              clicked.push({
                peerName: candidate.peerName,
                candidate: safeCandidate(processed.candidate),
                actions: processed.actions,
              });
              passClicked++;
            } catch (error) {
              const failure = { peerName: candidate.peerName, candidate: safeCandidate(candidate), error: asError(error, 'CONTACT_ACTION_FAILED') };
              failures.push(failure);
              if (options.stopOnActionError !== false) {
                return { ok: false, status: 'failed', code: failure.error.code, rounds, pagesScanned, clicked, failures, lastTarget };
              }
              handled.set(candidate.peerName, candidateSignature(candidate));
            }
          }

          const before = await this._requireTargetPage({ signal, timeoutMs: options.timeoutMs ?? this.timeoutMs });
          observation = before.observation;
          const beforeSignature = viewportSignature(before.observation, before.scan);
          await this._swipeList(before.observation, 'forward', { ...options, signal });
          const after = await this._requireTargetPage({ signal, timeoutMs: options.timeoutMs ?? this.timeoutMs });
          observation = after.observation;
          const afterSignature = viewportSignature(after.observation, after.scan);
          if (afterSignature === beforeSignature) {
            reachedBottom = true;
            break;
          }
        }

        if (!reachedBottom) {
          return { ok: false, status: 'page_budget_exhausted', code: 'MAX_PAGES_REACHED', rounds, pagesScanned, clicked, failures, lastTarget };
        }

        // Explicitly swipe back to the top before the next verification pass.
        // This is the downward half of the up/down sweep and also ensures that
        // cards shifted by an earlier click are seen again from a stable anchor.
        const top = await this._moveToTop(observation, { ...options, signal });
        lastTarget = await this._requireTargetPage({ signal, timeoutMs: options.timeoutMs ?? this.timeoutMs });
        observation = top;
        if (passClicked === 0) {
          return {
            ok: true, status: 'completed', rounds, pagesScanned, clicked, failures,
            remainingVisibleUnread: lastTarget.scan.candidates.filter(item => item.hasUnread).map(safeCandidate),
          };
        }
      }

      return {
        ok: false, status: 'round_budget_exhausted', code: 'MAX_ROUNDS_REACHED',
        rounds: maxRounds, pagesScanned, clicked, failures, lastTarget,
      };
    } catch (error) {
      if (signal.aborted) {
        return { ok: true, status: 'stopped', reason: 'ABORTED', rounds, pagesScanned, clicked, failures, lastTarget };
      }
      return { ok: false, status: 'failed', error: asError(error, 'UNREAD_DRAIN_FAILED'), rounds, pagesScanned, clicked, failures, lastTarget };
    } finally {
      if (this.ownsLease && this.lease) {
        this.arbiter.releaseLease(this.lease);
        this.lease = null;
        this.ownsLease = false;
      }
    }
  }

  async runDrainLoop(options = {}) {
    if (this.closed) throw watcherFailure('WATCHER_CLOSED', 'Message list watcher is closed');
    const externalSignal = options.signal;
    const maxIterations = options.maxIterations === undefined ? Infinity : Number(options.maxIterations);
    if (maxIterations !== Infinity && (!Number.isInteger(maxIterations) || maxIterations < 1)) {
      throw new TypeError('maxIterations must be a positive integer when provided');
    }
    if (options.execute !== true) {
      return { ok: false, status: 'execution_required', code: 'EXECUTION_REQUIRED', iterations: 0 };
    }
    const signal = externalSignal && typeof AbortSignal.any === 'function' ?
      AbortSignal.any([externalSignal, this.stopController.signal]) : this.stopController.signal;
    let iterations = 0;
    let last = null;
    try {
      while (!signal.aborted && iterations < maxIterations) {
        last = await this.drainUnread({ ...options, signal });
        iterations++;
        if (!last.ok) return { ok: false, status: 'failed', iterations, last };
        if (!signal.aborted && iterations < maxIterations) await this.sleepFn(this.intervalMs, signal);
      }
      return { ok: true, status: signal.aborted ? 'stopped' : 'completed', iterations, last };
    } catch (error) {
      if (signal.aborted) return { ok: true, status: 'stopped', reason: 'ABORTED', iterations, last };
      return { ok: false, status: 'failed', error: asError(error, 'UNREAD_DRAIN_LOOP_FAILED'), iterations, last };
    }
  }

  async pollOnce(options = {}) {
    const result = await this.observeTargetPage(options);
    if (!result.ok) {
      await this.onState?.({ ...result, events: [], iteration: this.iterations + 1 });
      return { ...result, events: [] };
    }

    const events = this._reconcile(result.scan, result.observation);
    this.eventsDetected += events.length;
    const delivered = [];
    for (const event of events) {
      try {
        await this.onUnread(event);
        this.callbacksCompleted++;
        delivered.push({ type: event.type, peerName: event.peerName, status: 'callback_completed' });
      } catch (error) {
        this.callbacksFailed++;
        const safeError = asError(error, 'UNREAD_CALLBACK_FAILED');
        delivered.push({ type: event.type, peerName: event.peerName, status: 'callback_failed', error: safeError });
        this.clearActiveSignal(event.peerName);
        if (typeof this.logger?.error === 'function') {
          this.logger.error(`[${event.peerName}] 未读事件处理异常: ${error?.message || error}`);
        } else if (typeof console?.error === 'function') {
          console.error(`[${event.peerName}] 未读事件处理异常: ${error?.message || error}`);
        }
        if (this.stopOnCallbackError) throw error;
      }
    }
    const output = { ...result, status: events.length ? 'unread_detected' : 'target_ready', events, delivered };
    await this.onState?.({ ...output, iteration: this.iterations + 1 });
    return output;
  }

  async _acquireLease() {
    if (this.lease) { this._assertLease(); return; }
    if (!this.arbiter?.acquireDevice) return;
    const result = this.arbiter.acquireDevice(this.deviceId, this.ownerId,
      { returnLease: true, task: 'momo-message-watch' });
    if (!result.ok) throw watcherFailure(result.reason, `Device cannot be watched: ${result.reason}`);
    this.lease = result.lease;
    this.ownsLease = true;
  }

  async run(options = {}) {
    if (this.closed) throw watcherFailure('WATCHER_CLOSED', 'Message list watcher is closed');
    const externalSignal = options.signal;
    const maxIterations = options.maxIterations === undefined ? Infinity : Number(options.maxIterations);
    if (maxIterations !== Infinity && (!Number.isInteger(maxIterations) || maxIterations < 1)) {
      throw new TypeError('maxIterations must be a positive integer when provided');
    }
    await this._acquireLease();
    const signal = externalSignal && typeof AbortSignal.any === 'function' ?
      AbortSignal.any([externalSignal, this.stopController.signal]) : this.stopController.signal;
    let last = null;
    try {
      while (!signal.aborted && this.iterations < maxIterations) {
        this._assertLease();
        last = await this.pollOnce({ signal, timeoutMs: options.timeoutMs ?? this.timeoutMs });
        this.iterations++;
        if (!signal.aborted && this.iterations < maxIterations) await this.sleepFn(this.intervalMs, signal);
      }
      return {
        ok: true,
        status: signal.aborted ? 'stopped' : 'completed',
        iterations: this.iterations,
        eventsDetected: this.eventsDetected,
        callbacksCompleted: this.callbacksCompleted,
        callbacksFailed: this.callbacksFailed,
        last: last ? { status: last.status, code: last.code ?? null } : null,
      };
    } catch (error) {
      if (signal.aborted) {
        return { ok: true, status: 'stopped', reason: 'ABORTED', iterations: this.iterations,
          eventsDetected: this.eventsDetected, callbacksCompleted: this.callbacksCompleted,
          callbacksFailed: this.callbacksFailed };
      }
      return { ok: false, status: 'failed', error: asError(error), iterations: this.iterations,
        eventsDetected: this.eventsDetected, callbacksCompleted: this.callbacksCompleted,
        callbacksFailed: this.callbacksFailed };
    } finally {
      if (this.ownsLease && this.lease) {
        this.arbiter.releaseLease(this.lease);
        this.lease = null;
        this.ownsLease = false;
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stopController.abort();
    if (this.ownsLease && this.lease) this.arbiter.releaseLease(this.lease);
    this.lease = null;
    this.ownsLease = false;
    if (this.tools && this.phone && this.client) await this.tools.close();
    if (this.client?.closeScreenshots) await this.client.closeScreenshots().catch(() => {});
    if (this.contactDb) {
      try { this.contactDb.close(); } catch { /* Preserve the primary close result. */ }
      this.contactDb = null;
    }
  }
}

function createMessageListWatcher(options) { return new MomoMessageListWatcher(options); }

module.exports = {
  MomoMessageListWatcher,
  createMessageListWatcher,
  candidateSignature,
  targetPageFailure,
};
