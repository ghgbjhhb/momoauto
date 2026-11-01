'use strict';

/**
 * 单设备中枢执行者 (Single Device Brain Actor)
 *
 * 遵循中枢执行计划第 7、9、13 节与 R1/B4 门禁：
 * 1. 单设备单执行循环：每台手机只有一个 Actor 和一条串行主线，杜绝并发竞争与重叠 tick。
 * 2. 状态机流转：stopped -> starting -> reconciling -> running -> paused_manual / cooldown / needs_review -> stopping -> stopped。
 * 3. 租约与互斥管理：每次操作前向 DeviceArbiter 申请带代次/令牌的租约，动作完成后及时释放。
 * 4. 任务适配器与权限门禁 (F01, F03)：缺失适配器立即抛出 TASK_ADAPTER_MISSING，严格禁止空实现假成功；observe 模式与未启用自动回复严禁下发 execute 动作。
 */

const { randomUUID } = require('node:crypto');
const { defaultArbiter } = require('../server/device-arbiter');
const { recoverToAllowedPage } = require('../automation/page-recovery');
const { observePage } = require('../automation/page-service');
const { scanMessageListCandidates } = require('../tools/momo/message-list-parser');
const { returnMessageListTop, listSignature } = require('../automation/message-list-navigation');
const { observedPoint } = require('../automation/coordinates');

class DeviceActor {
  /**
   * @param {string} deviceId
   * @param {object} store - BrainStore 实例
   * @param {object} scheduler - BrainScheduler 实例
   * @param {object} config - Brain 配置对象
   * @param {object} client - YunmomoClient 实例
   * @param {object} [taskAdapters] - 可注入的业务适配器
   */
  constructor(deviceId, store, scheduler, config, client, taskAdapters = {}) {
    this.deviceId = String(deviceId);
    this.store = store;
    this.scheduler = scheduler;
    this.config = config;
    this.client = client;
    this.taskAdapters = taskAdapters;

    this.sessionId = 'sess_' + randomUUID().replace(/-/g, '');
    this.running = false;
    this.abortController = null;
    this.wakeResolve = null;
    this.currentPhase = 'idle';
    this.lastLoopError = null;
    this.loopPromise = null;
  }

  start(options = {}) {
    if (this.running) return;
    if (this.store.getSchedule(this.deviceId, 'device_guard')?.quotaUsed) {
      throw Object.assign(new Error('Persisted guard requires explicit manual resume'), { code: 'GUARD_ACTIVE' });
    }
    this.running = true;
    this.abortController = new AbortController();

    const mode = options.mode || this.config.mode || 'observe';
    this.store.upsertSession(this.deviceId, {
      sessionId: this.sessionId,
      mode,
      desiredState: 'running',
      actualState: 'starting',
      configRevision: this.config.revision || 1
    });

    this.loopPromise = this._runLoop();
  }

  async stop(reason = 'User stopped') {
    if (!this.running) return;
    this.running = false;

    this.store.upsertSession(this.deviceId, {
      desiredState: 'stopped',
      actualState: 'stopping',
      stoppedReason: reason
    });

    if (this.abortController) {
      this.abortController.abort(new Error(reason));
    }
    this.wake();

    if (this.loopPromise) {
      try { await require('../automation/cancellation').waitFor(this.loopPromise, { timeoutMs: 5000 }); }
      catch {
        defaultArbiter.quarantineDevice(this.deviceId, 'Actor stop not acknowledged');
        this.store.upsertSession(this.deviceId, { actualState: 'needs_review' });
        return;
      }
    }

    this.store.upsertSession(this.deviceId, {
      actualState: 'stopped',
      stoppedReason: reason
    });
  }

  pause() {
    this.taskAbort?.abort(new Error('Manual pause'));
    this.store.upsertSession(this.deviceId, {
      desiredState: 'paused'
    });
    this.wake();
  }

  resume() {
    this.store.updateSchedule(this.deviceId, 'device_guard', { quotaUsed: 0, cooldownUntil: 0 });
    this.store.upsertSession(this.deviceId, {
      desiredState: 'running'
    });
    this.wake();
  }

  wake() {
    if (this.wakeResolve) {
      const fn = this.wakeResolve;
      this.wakeResolve = null;
      fn();
    }
  }

  async sleep(ms) {
    if (!this.running || this.abortController?.signal?.aborted) return;
    await new Promise(resolve => {
      let timer = null;
      let onAbort = null;
      const signal = this.abortController?.signal;

      const cleanup = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
          onAbort = null;
        }
        this.wakeResolve = null;
      };

      const finish = () => {
        cleanup();
        resolve();
      };

      onAbort = () => {
        finish();
      };

      this.wakeResolve = finish;

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      timer = setTimeout(finish, ms);
    });
  }

  _reconcileUnfinishedWork() {
    let momoDb;
    try {
      this.store.reconcileInterruptedTasks(this.deviceId);
      const { MomoDatabase, getDeviceDatabasePath } = require('../tools/momo/db');
      const { ReplyStore } = require('../tools/momo/reply-store');
      const dbPath = getDeviceDatabasePath(this.deviceId);
      momoDb = new MomoDatabase(dbPath);
      const replyStore = new ReplyStore(momoDb);
      // A crashed generation may have reached the API; do not silently generate it again.
      replyStore.db.prepare("UPDATE ai_reply_jobs SET state='failed', outcome='generation_interrupted_needs_review' WHERE state='generating'").run();

      const pendingJobs = replyStore.db.prepare(`
        SELECT * FROM ai_reply_jobs 
        WHERE state IN ('send_attempted', 'uncertain')
      `).all();

      for (const job of pendingJobs) {
        this.scheduler.enqueueVerifyTask(this.deviceId, job.id);
      }

    } catch (error) {
      this.store.recordEvent(this.deviceId, 'reconciliation_failed', { code: error.code || 'DATABASE_FAILED' });
      this.store.upsertSession(this.deviceId, { desiredState: 'paused', actualState: 'needs_review' });
    } finally { momoDb?.close(); }
  }

  async _runLoop() {
    this.store.upsertSession(this.deviceId, { actualState: 'reconciling' });
    this._reconcileUnfinishedWork();
    await new Promise(r => setTimeout(r, 100)); // 启动初始就绪缓冲

    while (this.running) {
      if (this.abortController?.signal.aborted) break;

      const session = this.store.getSession(this.deviceId);
      if (session?.desiredState === 'stopped') {
        break;
      }
      if (session?.desiredState === 'paused') {
        this.store.upsertSession(this.deviceId, { actualState: 'paused_manual' });
        await this.sleep(2000);
        continue;
      }

      // 1. 检查设备隔离区
      if (defaultArbiter.isDeviceQuarantined(this.deviceId)) {
        this.store.upsertSession(this.deviceId, { actualState: 'needs_review' });
        this.store.recordEvent(this.deviceId, 'device_quarantined', {
          info: defaultArbiter.getQuarantineInfo(this.deviceId)
        });
        await this.sleep(5000);
        continue;
      }

      // 2. 申请设备排他执行租约
      const leaseRes = defaultArbiter.acquireDevice(this.deviceId, this.sessionId, {
        returnLease: true,
        phase: this.currentPhase
      });

      if (!leaseRes.ok) {
        // 设备被手动控制台或其它任务占用，让出并等待
        this.store.upsertSession(this.deviceId, { actualState: 'paused_manual' });
        await this.sleep(1500);
        continue;
      }

      const lease = leaseRes.lease;

      try {
        // 3. 生成周期到期任务并认领最高优先级任务
        this.scheduler.generateDueTasks(this.deviceId, Date.now());
        const task = this.scheduler.claimNextFairTask(this.deviceId);

        if (!task) {
          // 无任何任务，处于空闲巡检等待
          this.store.upsertSession(this.deviceId, { actualState: 'idle' });
          defaultArbiter.releaseLease(lease);
          await this.sleep(this.config.pollIntervalMs);
          continue;
        }

        // 4. 执行认领的具体任务
        await this._executeTask(task, lease);
      } catch (err) {
        this.lastLoopError = err;
        this.store.recordEvent(this.deviceId, 'actor_loop_error', {
          message: err.message,
          code: err.code
        });
      } finally {
        if (!defaultArbiter.isDeviceQuarantined(this.deviceId)) defaultArbiter.releaseLease(lease);
      }

      // 任务间常规短间隙，防 CPU 跑满
      await this.sleep(200);
    }
  }

  async _executeTask(task, lease) {
    const label = ['reply', 'browse', 'greetings', 'verify_uncertain', 'inspect_list', 'sweep_list'].includes(task.type) ? task.type : 'unknown';
    const span = require('../automation/timing').begin('brain.task.' + label, { root: true, deviceId: this.deviceId, taskId: task.id });
    return span.run(async () => {
      let outcome;
      try {
        const value = await this._executeTaskMeasured(task, lease, result => { outcome = result; });
        span.end(outcome); return value;
      } catch (error) { span.end(undefined, error); throw error; }
    });
  }

  async _executeTaskMeasured(task, lease, recordOutcome) {
    const { checkSignal, waitFor, sleep } = require('../automation/cancellation');
    const registry = { reply: 'runReply', browse: 'runBrowse', greetings: 'runGreetings', verify_uncertain: 'verifyUncertain' };
    const adapter = this.taskAdapters[registry[task.type]] || this.taskAdapters[task.type];
    const isInspection = ['inspect_list', 'sweep_list'].includes(task.type);
    this.currentPhase = task.type;
    this.taskAbort = new AbortController();
    const signal = this.abortController ? AbortSignal.any([this.abortController.signal, this.taskAbort.signal]) : this.taskAbort.signal;
    const mode = this.store.getSession(this.deviceId)?.mode || this.config.mode || 'observe';
    let control, tools, timer, cleanupFailed = false;
    const check = () => { checkSignal(signal); defaultArbiter.assertLease(lease); };
    const update = (state, checkpoint) => {
      recordOutcome({ status: state, error: checkpoint?.error });
      return this.store.updateTaskState(task.id, 'running', state, { checkpointJson: checkpoint });
    };
    const block = result => {
      if (result.guardType || result.rateLimited || result.error?.code?.startsWith('GUARD_')) {
        this.store.updateSchedule(this.deviceId, task.type, { cooldownUntil: Date.now() + 20 * 60000 });
        this.store.updateSchedule(this.deviceId, 'device_guard', { quotaUsed: 1, cooldownUntil: Date.now() + 20 * 60000 });
        this.store.upsertSession(this.deviceId, { desiredState: 'paused', actualState: 'needs_review' });
      }
    };
    try {
      if (!isInspection && typeof adapter !== 'function') throw Object.assign(new Error('Task adapter missing: ' + task.type), { code: 'TASK_ADAPTER_MISSING' });
      if (!['plan', 'observe', 'draft', 'execute'].includes(mode)) throw Object.assign(new Error('Invalid actor mode'), { code: 'INVALID_MODE' });
      if (mode === 'plan' || (['browse','greetings'].includes(task.type) && (mode !== 'execute' || this.config[task.type === 'browse' ? 'browseEnabled' : 'greetingsEnabled'] !== true))) {
        update('completed', { outcome: 'mode_blocked', mode }); return;
      }
      if (task.deadline && task.deadline <= Date.now()) throw Object.assign(new Error('Task deadline expired'), { code: 'TASK_DEADLINE' });
      check();
      this.store.upsertSession(this.deviceId, { actualState: task.type });
      const phone = this.client?.device(this.deviceId);
      if (!phone?.openControl) throw Object.assign(new Error('No device control provider'), { code: 'NO_CONTROL_PROVIDER' });
      control = await phone.openControl();
      await waitFor(control.connect({ timeoutMs: 10000 }), { signal, timeoutMs: 10000 });
      check();
      if (!control.connected || !control.ready) throw Object.assign(new Error('Control not ready'), { code: 'NOT_CONNECTED' });
      tools = phone.tools({ control });
      const context = { deviceId: this.deviceId, client: this.client, sessionId: this.sessionId,
        userId: this.ownerUserId, control, tools,
        pool: tools._recognitionPool, generation: control.generation ?? control._generation ?? 1,
        leaseToken: lease.leaseToken, assertActive: check };
      const maxMs = ['browse','greetings'].includes(task.type) ? (this.config.maxIdleOffListMs || 15000) : 180000;
      timer = setTimeout(() => this.taskAbort?.abort(), Math.min(maxMs, task.deadline ? Math.max(1, task.deadline - Date.now()) : maxMs));
      const recover = async () => {
        check();
        const result = await recoverToAllowedPage(context, ['message_list'], { signal,
          maxBackSteps: this.config.maxBackSteps || 8, recoveryTimeoutMs: this.config.recoveryTimeoutMs || 30000 });
        if (result.status !== 'reached_target') {
          block(result);
          throw Object.assign(new Error('Message list recovery failed'), { code: result.error?.code || 'RECOVERY_FAILED' });
        }
        return result.observation;
      };
      if (isInspection) {
        let obs = await recover();
        const top = await returnMessageListTop(context, obs, { signal });
        if (!top.ok) throw Object.assign(new Error('List top could not be confirmed'), { code: top.code });
        obs = top.observation;
        const maxPages = task.type === 'inspect_list' ? 1 : Math.min(this.config.maxListPagesPerSlice || 2, 10);
        // Persist a bounded continuation index, rather than scanning only the same first two screens.
        let startPage = 0, continuationStalled = false;
        if (task.type === 'sweep_list') {
          const previous = this.store.db.prepare("SELECT checkpointJson FROM brain_tasks WHERE deviceId=? AND type='sweep_list' AND state='completed' ORDER BY rowid DESC LIMIT 1").get(this.deviceId);
          const checkpoint = previous?.checkpointJson ? JSON.parse(previous.checkpointJson) : {};
          startPage = Number.isInteger(checkpoint.nextPage) ? Math.max(0, Math.min(20, checkpoint.nextPage)) : 0;
          for (let page = 0; page < startPage; page++) {
            check();
            const before = listSignature(obs);
            await waitFor(control.swipe(observedPoint(control, obs, { x: Math.round(obs.width / 2), y: Math.round(obs.height * .75) }),
              observedPoint(control, obs, { x: Math.round(obs.width / 2), y: Math.round(obs.height * .30) }), { durationMs: 400, signal }), { signal, timeoutMs: 5000 });
            if (control.flush) await waitFor(control.flush(), { signal, timeoutMs: 5000 });
            await sleep(400, signal);
            obs = await observePage(context, { signal, timeoutMs: 10000 });
            if (!obs.ok || obs.page !== 'message_list' || obs.overlay !== 'none') {
              if (obs.overlay && obs.overlay !== 'none') block({ guardType: obs.overlay });
              throw Object.assign(new Error('List continuation lost its page'), { code: obs.error?.code || 'LIST_UNCONFIRMED' });
            }
            if (listSignature(obs) === before) { continuationStalled = true; break; }
          }
        }
        let pagesScanned = 0, totalFound = 0, noProgress = false;
        const signatures = new Set(), seen = new Set();
        for (; pagesScanned < maxPages;) {
          check();
          if (!obs.ok || obs.page !== 'message_list' || obs.overlay !== 'none') {
            if (obs.overlay && obs.overlay !== 'none') block({ guardType: obs.overlay });
            throw Object.assign(new Error('List observation invalid'), { code: 'LIST_UNCONFIRMED' });
          }
          const scan = scanMessageListCandidates(obs.evidence.ocrData || {}, obs.evidence.listRaw || {}, obs.evidence.pageRaw || {});
          const signature = JSON.stringify(scan.candidates.map(c => [c.peerName, c.lastMessage, c.hasUnread]));
          if (signatures.has(signature)) { noProgress = true; break; }
          signatures.add(signature);
          for (const candidate of scan.candidates) {
            if (seen.has(candidate.peerName)) continue;
            seen.add(candidate.peerName); totalFound++;
            if (candidate.hasUnread) this.scheduler.enqueueReplyTask(this.deviceId, candidate.peerName, candidate.lastMessage || 'unread');
          }
          pagesScanned++;
          if (pagesScanned < maxPages) {
            check();
            await waitFor(control.swipe(observedPoint(control, obs, { x: Math.round(obs.width / 2), y: Math.round(obs.height * .75) }),
              observedPoint(control, obs, { x: Math.round(obs.width / 2), y: Math.round(obs.height * .30) }), { durationMs: 400, signal }), { signal, timeoutMs: 5000 });
            if (control.flush) await waitFor(control.flush(), { signal, timeoutMs: 5000 });
            await sleep(400, signal);
            obs = await observePage(context, { signal, timeoutMs: 10000 });
          }
        }
        const returned = await returnMessageListTop(context, obs, { signal, maxSteps: 26 });
        if (!returned.ok) {
          if (returned.observation?.overlay && returned.observation.overlay !== 'none') block({ guardType: returned.observation.overlay });
          throw Object.assign(new Error('List top restoration failed'), { code: returned.code });
        }
        const coverageBoundReached = startPage + pagesScanned >= 20;
        const nextPage = task.type === 'sweep_list' && !noProgress && !continuationStalled && !coverageBoundReached ? startPage + pagesScanned : 0;
        // A bounded slice is not full coverage. Keep this distinction in durable status.
        update('completed', { pagesScanned, maxPages, totalFound, noProgress, partial: task.type === 'sweep_list',
          budgetReached: pagesScanned >= maxPages, cursor: 'top', atTop: true, topProof: returned.proof,
          startPage, nextPage, continuationStalled, coverageBoundReached });
      } else {
        if (['browse','greetings'].includes(task.type)) await recover();
        const effectiveMode = task.type === 'reply' && mode === 'execute' && this.config.autoReplyEnabled !== true ? 'observe' : mode;
        const result = await adapter(this.deviceId, task, context, { mode: effectiveMode, signal,
          autoReplyEnabled: this.config.autoReplyEnabled === true, maxIdleOffListMs: this.config.maxIdleOffListMs || 15000,
          maxApproved: this.config.maxApprovedPerRun || 2 });
        check(); block(result || {});
        const needsReview = ['uncertain', 'needs_review', 'needs_baseline'].some(state =>
          [result?.status, result?.outcome, result?.data?.outcome].includes(state)) || result?.rateLimited;
        update(needsReview ? 'needs_review' : result?.ok ? 'completed' : 'failed', result);
      }
    } catch (error) {
      update(signal.aborted ? 'cancelled' : 'failed', { error: error.message, code: error.code || 'EXECUTION_FAILED' });
      throw error;
    } finally {
      clearTimeout(timer);
      try { await waitFor(tools?.close?.(), { timeoutMs: 5000 }); } catch { cleanupFailed = true; }
      try { await waitFor(control?.close?.(), { timeoutMs: 5000 }); } catch { cleanupFailed = true; }
      if (cleanupFailed) {
        recordOutcome({ ok: false, error: { code: 'CONTROL_CLEANUP_FAILED' } });
        defaultArbiter.quarantineDevice(this.deviceId, 'Task cleanup not confirmed');
      }
      this.taskAbort = null;
      this.currentPhase = 'idle';
    }
  }
}

module.exports = { DeviceActor };
