'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { getAuthService } = require('./auth/service');
const authGuard = require('./auth/guard');
const { attachManualControl } = require('./manual-control');
const { SCRIPT_DEFINITIONS } = require('./script-catalog');
const {
  HOST,
  DEFAULT_PORT,
  loadLocalEnv,
  portValue,
  activeToken,
  selectedDevice,
  client,
  busyDevices,
  manualBridges,
  resetSharedBrainManager,
  resetSharedClient
} = require('./context');
const {
  json,
  staticFile,
  errorStatus,
  allowedRequest,
  redact,
  appendServerLog
} = require('./http');

const { handleAuthRoutes } = require('./routes/auth-routes');
const { handleAdminRoutes } = require('./routes/admin-routes');
const { handleConsoleRoutes } = require('./routes/console-routes');
const { handleExecuteRoutes } = require('./routes/execute-routes');

const authService = getAuthService();

async function handler(request, response) {
  const reqStart = Date.now();
  const reqMethod = request.method;
  const reqUrl = request.url;
  const isApi = typeof reqUrl === 'string' && reqUrl.startsWith('/api/');
  let currentUser = null;

  if (isApi) {
    response.on('finish', () => {
      const duration = Date.now() - reqStart;
      const status = response.statusCode;
      const userTag = currentUser ? `[${currentUser.email}]` : '[guest]';
      const logLine = `${reqMethod} ${authGuard.redact(reqUrl)} -> ${status} (${duration}ms) ${userTag}`;

      // 忽略日志自轮询等无意义的噪音请求
      if (reqUrl.includes('/api/client-logs') || reqUrl.includes('/api/server-logs')) {
        return;
      }

      // 未登录游客访问受保护接口，静默避免刷屏
      const isGuestAuthProbe = !currentUser && (status === 401 || status === 403) && (reqUrl.startsWith('/api/devices') || reqUrl.startsWith('/api/cloud-disk') || reqUrl.startsWith('/api/user'));

      if (status >= 500) {
        console.error(`[API ERROR] ${logLine}`);
        appendServerLog('ERROR', logLine);
      } else if (status >= 400) {
        if (!isGuestAuthProbe) {
          console.warn(`[API WARN] ${logLine}`);
          appendServerLog('WARN', logLine);
        }
      } else {
        console.log(`[API] ${logLine}`);
      }
    });
  }

  try {
    if (!allowedRequest(request)) {
      json(response, 403, { ok: false, error: '仅允许本地控制台同源访问' });
      return;
    }
    const url = new URL(request.url, 'http://' + (request.headers.host || HOST));
    const user = currentUser = authService.getUserFromRequest(request);
    const ctx = { user };

    // 1. Auth routes
    if (await handleAuthRoutes(ctx, request, response, url)) return;

    // 2. Admin routes
    if (await handleAdminRoutes(ctx, request, response, url)) return;

    // 3. Console routes
    if (await handleConsoleRoutes(ctx, request, response, url)) return;

    // 4. Execute routes
    if (await handleExecuteRoutes(ctx, request, response, url)) return;

    if (request.method !== 'GET') {
      json(response, 405, { ok: false, error: '只支持 GET 和 POST' });
      return;
    }
    await staticFile(response, url.pathname);
  } catch (error) {
    const message = redact(error?.message || error);
    const status = errorStatus({ message, status: error?.status });
    const level = status >= 500 ? 'ERROR' : 'WARN';
    const safeUrl = authGuard.redact(request.url || '');
    if (level === 'ERROR') {
      console.error(`[API UNHANDLED] ${request.method} ${safeUrl} -> ${status}:`, error);
      appendServerLog('ERROR', `UNHANDLED ${request.method} ${safeUrl} -> ${status}: ${message}`, error?.stack || '');
    } else {
      console.warn(`[API REJECTED] ${request.method} ${safeUrl} -> ${status}: ${message}`);
      appendServerLog('WARN', `REJECTED ${request.method} ${safeUrl} -> ${status}: ${message}`);
    }
    json(response, status, {
      ok: false,
      error: message,
      ...(error?.name === 'StreamScreenshotError' ? { code: error.code } : {}),
      ...(error?.timing || {})
    });
  }
}

function createServer() {
  const server = http.createServer((request, response) =>
    require('../automation/timing').detached(() => handler(request, response))
  );
  const bridge = attachManualControl(server, {
    allowedRequest,
    selectedDevice,
    client,
    busyDevices,
    redact,
    authService
  });
  manualBridges.add(bridge);
  server.on('close', () => {
    manualBridges.delete(bridge);
    resetSharedBrainManager().catch(() => {});
    bridge.closeAll().catch(() => {});
    resetSharedClient().catch(() => {});
  });
  server.closeManual = () => bridge.closeAll();
  return server;
}

async function start() {
  await loadLocalEnv();
  require('../automation/recognition-service').serviceCommand('start')
    .then(() => console.log('GPU recognition service ready'))
    .catch(error => console.error('GPU recognition startup failed: ' + (error.code ?? 'SERVICE_FAILED')));
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) throw new Error('测试控制台只允许绑定本机回环地址');
  const port = portValue(process.env.YUNMOMO_APP_PORT || DEFAULT_PORT);
  const server = createServer();
  server.listen(port, HOST, () => {
    console.log('Yunmomo local console: http://' + HOST + ':' + port);
    if (!activeToken()) {
      console.log('提示：尚未导入网页登录态，请通过本地会话设置同步。');
    }
  });
  const close = () => {
    Promise.allSettled([resetSharedBrainManager(), server.closeManual(), resetSharedClient()])
      .finally(() => server.close(() => process.exit(0)));
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return server;
}

if (require.main === module) {
  require('../automation/timing').timedScript('service.app.start', start)().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { start, createServer, SCRIPT_DEFINITIONS };
