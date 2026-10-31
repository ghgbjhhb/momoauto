'use strict';

const path = require('node:path');
const { readFile, stat } = require('node:fs/promises');
const { URL } = require('node:url');
const { appendLogLine } = require('../automation/log-file');
const { PROJECT_ROOT, APP_ROOT, MAX_BODY_BYTES, activeToken } = require('./context');

// 内网穿透入口，默认关闭：YUNMOMO_PUBLIC_ORIGINS=https://example.com:14318（逗号分隔多个）。
// 命中入口的请求仍要求 Origin 与该入口完全同源，loopback 的校验语义不变。
const PUBLIC_ENTRIES = String(process.env.YUNMOMO_PUBLIC_ORIGINS || '')
  .split(',')
  .map((item) => {
    try {
      const url = new URL(item.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      return { origin: url.origin, authority: url.host.toLowerCase(), socket: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host.toLowerCase()}` };
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
});

// 页面大量使用内联 script 与 onclick 属性，script-src 只能放宽到 unsafe-inline；
// 但 object/base/form-action/frame-ancestors 仍收紧，配合同源-only 的 Host/Origin 校验阻断点击劫持与外链注入。
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:*" +
      PUBLIC_ENTRIES.map((entry) => ` ${entry.socket}`).join(''),
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; ')
};

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers
  });
  response.end(body);
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('请求 JSON 格式不正确'));
      }
    });
  });
}

async function staticFile(request, response, pathname) {
  let requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (pathname === '/login' || pathname === '/login/') requested = 'login.html';
  if (pathname === '/admin' || pathname === '/admin/' || (pathname.startsWith('/admin/') && !path.extname(pathname))) requested = 'admin.html';
  if (!requested || requested.includes('..') || requested.includes('\\')) {
    json(response, 404, { ok: false, error: '页面不存在' });
    return;
  }
  const file = path.resolve(APP_ROOT, requested);
  if (!file.startsWith(APP_ROOT + path.sep)) {
    json(response, 403, { ok: false, error: '非法路径' });
    return;
  }
  try {
    const [data, stats] = await Promise.all([readFile(file), stat(file)]);
    // no-cache 必须配 ETag 才有可靠的刷新校验：文件变更后 ETag 随 mtime 变化，
    // 浏览器强刷/普通刷新都会拿到 200 新内容，未变更时 304 省流量。
    const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      ...SECURITY_HEADERS
    });
    response.end(data);
  } catch {
    json(response, 404, { ok: false, error: '页面不存在' });
  }
}

function errorStatus(error) {
  if (error.status === 400) return 400;
  if (/正在执行脚本|手动控制/.test(error.message)) return 409;
  if (error.status === 401) return 401;
  // 403 不能并入 401：前端把 401 当作「登录态失效」处理并触发重新登录，权限不足应当直接呈现错误原因
  if (error.status === 403) return 403;
  if (/请选择|未知脚本|YUNMOMO_CERT_PATH|请求内容|请求 JSON|浏览器会话令牌|邮箱或密码不正确|卡密|验证码/.test(error.message)) return 400;
  if (/YUNMOMO_TOKEN/.test(error.message)) return 401;
  return 500;
}

function allowedRequest(request) {
  try {
    const host = new URL('http://' + request.headers.host);
    if (host.username || host.password) return false;
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname);
    const entry = PUBLIC_ENTRIES.find((item) => item.authority === host.host.toLowerCase());
    if (!loopback && !entry) return false;
    return !request.headers.origin || new URL(request.headers.origin).origin === (entry ? entry.origin : host.origin);
  } catch { return false; }
}

function redact(value) {
  let output = String(value ?? '');
  const token = activeToken();
  if (token) output = output.split(token).join('<redacted>');
  return output.replace(/([?&]token=)[^&\s]+/gi, '$1<redacted>');
}

async function appendServerLog(level, message, details = '') {
  const logLine = `[Server ${level.toUpperCase()}] ${new Date().toISOString()} ${message}${details ? ' ' + details : ''}\n`;
  await appendLogLine(path.join(PROJECT_ROOT, 'logs', 'server.log'), logLine);
}

module.exports = {
  MIME_TYPES,
  SECURITY_HEADERS,
  json,
  readJsonBody,
  staticFile,
  errorStatus,
  allowedRequest,
  redact,
  appendLogLine,
  appendServerLog
};
