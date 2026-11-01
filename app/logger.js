/**
 * 云 MOMO 自动化控制台 - 前端工业级全链路诊断日志系统 (Client Logger & Telemetry)
 * 职责：
 * 1. 毫秒级捕获全局 JS 异常 (window.onerror / unhandledrejection)；
 * 2. 自动化拦截监测 API 请求生命周期与耗时 (Fetch Interceptor)；
 * 3. 内存环形缓冲区 (Ring Buffer) 暂存日志，支持会话持久化与刷新回溯；
 * 4. 自动限流上报异常到服务端 /api/client-logs；
 * 5. 支持 UI 实时订阅与一键导出完整诊断报告包 (Diagnostics Report)。
 */

(function (window) {
  'use strict';

  const MAX_MEMORY_LOGS = 300;
  const PERSIST_KEY = 'yunmomo_client_logs_v1';
  const REPORT_ENDPOINT = '/api/client-logs';
  const MAX_REPORTS_PER_MINUTE = 30;

  let logSequence = 0;
  const inMemoryLogs = [];
  const subscribers = new Set();
  const pendingReports = [];
  let reportTimer = null;
  let reportCountWindow = 0;
  let reportWindowStart = Date.now();
  let errorCount = 0;

  // 恢复上一次会话保留的最近日志（用于刷新后排查）
  try {
    const saved = sessionStorage.getItem(PERSIST_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        parsed.slice(-30).forEach(entry => inMemoryLogs.push({ ...entry, restored: true }));
      }
    }
  } catch {}

  function formatTime(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  }

  function persistToSession() {
    try {
      const recent = inMemoryLogs.slice(-50);
      sessionStorage.setItem(PERSIST_KEY, JSON.stringify(recent));
    } catch {}
  }

  function notifySubscribers(entry) {
    for (const sub of subscribers) {
      try { sub(entry, inMemoryLogs); } catch {}
    }
  }

  function scheduleReport(entry) {
    if (!['WARN', 'ERROR'].includes(entry.level)) return;
    pendingReports.push(entry);

    if (reportTimer) return;
    reportTimer = setTimeout(flushReports, 1200);
  }

  async function flushReports() {
    reportTimer = null;
    if (!pendingReports.length) return;

    // 限流保护：1分钟内最多上报 30 次，防止死循环刷爆
    const now = Date.now();
    if (now - reportWindowStart > 60000) {
      reportWindowStart = now;
      reportCountWindow = 0;
    }
    if (reportCountWindow >= MAX_REPORTS_PER_MINUTE) {
      pendingReports.length = 0;
      return;
    }

    const batch = pendingReports.splice(0, 10);
    reportCountWindow += batch.length;

    for (const item of batch) {
      try {
        await fetch(REPORT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            level: item.level.toLowerCase(),
            message: `[${item.tag}] ${item.message}`,
            details: item.details,
            timestamp: item.isoTime
          }),
          keepalive: true
        });
      } catch {}
    }
  }

  function record(level, tag, message, details = null) {
    const now = new Date();
    if (level === 'ERROR') errorCount++;

    const entry = {
      id: ++logSequence,
      time: formatTime(now),
      isoTime: now.toISOString(),
      level: level.toUpperCase(),
      tag: String(tag || 'App'),
      message: String(message || ''),
      details: details || null
    };

    inMemoryLogs.push(entry);
    if (inMemoryLogs.length > MAX_MEMORY_LOGS) {
      inMemoryLogs.shift();
    }

    persistToSession();
    notifySubscribers(entry);
    scheduleReport(entry);

    // 同步到开发者工具原生控制台
    const prefix = `[YM ${entry.time}] [${entry.level}] [${entry.tag}]`;
    if (level === 'ERROR') {
      console.error(prefix, entry.message, details || '');
    } else if (level === 'WARN') {
      console.warn(prefix, entry.message, details || '');
    } else {
      console.log(prefix, entry.message, details || '');
    }

    return entry;
  }

  const AppLogger = {
    info(tag, message, details) {
      return record('INFO', tag, message, details);
    },
    warn(tag, message, details) {
      return record('WARN', tag, message, details);
    },
    error(tag, message, details) {
      return record('ERROR', tag, message, details);
    },
    http(method, url, status, durationMs, errorMsg = '') {
      const level = !status || status >= 400 ? 'ERROR' : 'INFO';
      const cleanUrl = new URL(url, location.href).pathname;
      const msg = `${method.toUpperCase()} ${cleanUrl} -> ${status || 'FAILED'} (${Math.round(durationMs)}ms)${errorMsg ? ' ' + errorMsg : ''}`;
      return record(level, 'HTTP', msg, errorMsg ? { path: cleanUrl, status, error: errorMsg } : null);
    },
    getLogs() {
      return [...inMemoryLogs];
    },
    getErrorCount() {
      return errorCount;
    },
    clear() {
      inMemoryLogs.length = 0;
      errorCount = 0;
      try { sessionStorage.removeItem(PERSIST_KEY); } catch {}
      notifySubscribers(null);
    },
    subscribe(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    exportDiagnostics() {
      const now = new Date();
      const stateObj = window.state || {};
      const diag = {
        title: '云 MOMO 自动化控制台客户端诊断报告',
        generatedAt: now.toISOString(),
        client: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language,
          screenResolution: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          devicePixelRatio: window.devicePixelRatio || 1,
          online: navigator.onLine,
          location: window.location.origin + window.location.pathname
        },
        state: {
          tokenConfigured: stateObj.tokenConfigured ?? null,
          currentUser: stateObj.currentUser?.email || null,
          userRole: stateObj.currentUser?.role || null,
          selectedDeviceId: stateObj.selectedDeviceId || null,
          devicesCount: stateObj.devices?.length || 0,
          devices: (stateObj.devices || []).map(d => ({
            deviceId: d.deviceId,
            name: d.name,
            sdkVersion: d.sdkVersion,
            online: d.online
          })),
          scriptsCount: stateObj.scripts?.length || 0
        },
        recentLogs: inMemoryLogs.slice(-60)
      };
      return JSON.stringify(diag, null, 2);
    }
  };

  // 全局未捕获异常捕获
  window.addEventListener('error', event => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      // 静态资源加载失败 (如 JS / CSS 404)
      AppLogger.error('Resource', `静态资源加载失败: ${target.src || target.href}`, {
        tagName: target.tagName,
        outerHTML: target.outerHTML?.slice(0, 160)
      });
      return;
    }
    AppLogger.error('Runtime', event.message || '未知脚本运行时异常', {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack || null
    });
  }, true);

  // 全局 Promise 拒绝捕获
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    const msg = reason?.message || String(reason || '未处理的 Promise 拒绝');
    AppLogger.error('Promise', msg, {
      stack: reason?.stack || null
    });
  });

  // 全局 Fetch 自动监听拦截器（只监测本源 API，不修改认证头）
  if (typeof window.fetch === 'function') {
    const rawFetch = window.fetch;
    window.fetch = async function (...args) {
      let input = args[0];
      let init = args[1] || {};

      const url = typeof input === 'string' ? input : (input?.url || '');
      const method = (init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();

      // 避免自身上报产生循环请求
      if (url.includes(REPORT_ENDPOINT)) {
        return rawFetch.apply(this, args);
      }

      // 浏览器登录态由 HttpOnly Cookie 承担，日志代理不注入 Bearer。
      const isApi = (() => {
        try { const u = new URL(url, location.href); return u.origin === location.origin && u.pathname.startsWith('/api/'); }
        catch { return false; }
      })();

      const start = performance.now();
      try {
        const response = await rawFetch.apply(this, args);
        const duration = performance.now() - start;
        // 仅对 API 请求进行追踪记录
        if (isApi) {
          AppLogger.http(method, url, response.status, duration, response.ok ? '' : `HTTP ${response.status}`);
        }
        return response;
      } catch (err) {
        const duration = performance.now() - start;
        if (isApi) {
          AppLogger.http(method, url, 0, duration, err.message || '网络断开或超时');
        }
        throw err;
      }
    };
  }

  // 全局 WebSocket 自动监听拦截器（仅监测连接与关闭码）
  if (typeof window.WebSocket === 'function') {
    const RawWebSocket = window.WebSocket;
    class InstrumentedWebSocket extends RawWebSocket {
      constructor(url, protocols) {
        const finalUrl = url;

        if (protocols !== undefined) {
          super(finalUrl, protocols);
        } else {
          super(finalUrl);
        }

        const urlStr = String(finalUrl || '');
        if (urlStr.includes('/api/')) {
          const cleanUrl = new URL(urlStr, location.href).pathname;
          const start = performance.now();
          AppLogger.info('WebSocket', `发起连接 -> ${cleanUrl}`);

          this.addEventListener('open', () => {
            const duration = Math.round(performance.now() - start);
            AppLogger.info('WebSocket', `连接成功 -> ${cleanUrl} (${duration}ms)`);
          });

          this.addEventListener('error', () => {
            AppLogger.error('WebSocket', `连接异常 -> ${cleanUrl}`);
          });

          this.addEventListener('close', event => {
            AppLogger.warn('WebSocket', `连接断开 [${event.code}] -> ${cleanUrl}`);
          });
        }
      }
    }
    window.WebSocket = InstrumentedWebSocket;
  }

  // 全局 XMLHttpRequest 自动监听拦截器 (全格式 API 覆盖备用)
  if (typeof window.XMLHttpRequest === 'function') {
    const RawXHR = window.XMLHttpRequest;
    const rawOpen = RawXHR.prototype.open;
    const rawSend = RawXHR.prototype.send;

    RawXHR.prototype.open = function (method, url, ...rest) {
      this._ymUrl = String(url || '');
      this._ymMethod = String(method || 'GET').toUpperCase();
      return rawOpen.call(this, method, url, ...rest);
    };

    RawXHR.prototype.send = function (...args) {
      const url = this._ymUrl || '';
      const isApi = (() => {
        try { const u = new URL(url, location.href); return u.origin === location.origin && u.pathname.startsWith('/api/') && u.pathname !== REPORT_ENDPOINT; }
        catch { return false; }
      })();
      if (isApi) {
        const start = performance.now();
        this.addEventListener('loadend', () => {
          const duration = performance.now() - start;
          const status = this.status;
          AppLogger.http(this._ymMethod, url, status, duration, (status >= 400 || status === 0) ? `HTTP ${status}` : '');
        });
      }
      return rawSend.apply(this, args);
    };
  }

  // 记录页面启动生命周期
  AppLogger.info('Lifecycle', '控制台诊断日志引擎已启动就绪');

  window.AppLogger = AppLogger;
})(window);
