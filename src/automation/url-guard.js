'use strict';

/**
 * 出站 URL 安全校验（SSRF 防护）共享工具。CommonJS、零第三方依赖。
 *
 * 背景：
 * 本控制台的「玄武接码网关地址」与「AI 供应商 endpoint」均由用户/管理员在界面填写，
 * 服务端会直接向该地址发起 HTTP 请求并携带密钥（X-API-Key / Authorization: Bearer apiKey）。
 * 若不做校验，攻击者可填写 http://169.254.169.254（云厂商元数据）、http://127.0.0.1:<其它端口>
 * （打本机其它服务）等地址，把密钥发走或探测内网。
 *
 * 规则：
 * 1. 仅允许 http: / https: 协议；拒绝 file:、gopher: 等其它 scheme。
 * 2. 拒绝包含 userinfo（user:pass@）的 URL。
 * 3. 解析 hostname：
 *    - IP 字面量：直接按私网/特殊地址清单判定拒绝。
 *    - 域名（异步版本 assertSafeOutboundUrl）：做 DNS 解析（dns.promises.lookup all），
 *      任一解析结果命中清单即拒绝。
 *    - 域名（同步版本 assertSafeOutboundUrlSync）：无法做 DNS，仅拦截字面违规；
 *      另对 "localhost"/".localhost"/metadata.google.internal 这类固定危险主机名做黑名单。
 *      调用方在真正发请求前必须再走一次异步完整校验。
 * 4. 拒绝的地址清单：127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、
 *    169.254.0.0/16（含 169.254.169.254）、0.0.0.0/8、100.64.0.0/10（运营商 NAT）、
 *    ::1、::（未指定）、fc00::/7（ULA）、fe80::/10（链路本地）、
 *    以及 ::ffff: 映射的上述 IPv4 地址。
 *
 * 放行开关（默认全部拒绝）：
 * - allowLoopback: true 时仅放行回环（127.0.0.0/8、::1、localhost）。
 *   原因：玄武接码网关是用户自建服务，部署在本机（http://127.0.0.1:<端口>）是合法用法；
 *   其余私网段默认仍拒绝，需配合环境变量 YUNMOMO_SMS_ALLOW_PRIVATE=1（见 xuanwu-client.js）。
 * - allowPrivate: true 时放行全部私网/特殊地址（仅限显式开关场景），AI endpoint 不使用。
 *
 * 校验失败统一抛出 Error，message 为中文且包含具体拒绝原因。
 */

const dns = require('node:dns').promises;
const net = require('node:net');

/**
 * 判定 IPv4 是否属于私网/特殊地址。
 * 命中返回 { kind: 'loopback' | 'private', label: string }，否则返回 null。
 */
function classifyIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b] = parts;
  if (a === 127) return { kind: 'loopback', label: '127.0.0.0/8 回环地址' };
  if (a === 10) return { kind: 'private', label: '10.0.0.0/8 内网地址' };
  if (a === 172 && b >= 16 && b <= 31) return { kind: 'private', label: '172.16.0.0/12 内网地址' };
  if (a === 192 && b === 168) return { kind: 'private', label: '192.168.0.0/16 内网地址' };
  if (a === 169 && b === 254) return { kind: 'private', label: '169.254.0.0/16 链路本地地址（含云厂商元数据服务 169.254.169.254）' };
  if (a === 0) return { kind: 'private', label: '0.0.0.0/8 保留地址' };
  if (a === 100 && b >= 64 && b <= 127) return { kind: 'private', label: '100.64.0.0/10 运营商级 NAT（CGNAT）共享地址' };
  return null;
}

/**
 * 将 IPv6 字符串展开为 16 字节数组（支持 :: 缩写、%zone、结尾内嵌 IPv4）。
 * 解析失败返回 null。
 */
function expandIpv6ToBytes(input) {
  let ip = String(input).toLowerCase();
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  if (!ip) return null;

  // 内嵌 IPv4（如 ::ffff:127.0.0.1、::1.2.3.4）转换为两个 16 位分组
  const lastColon = ip.lastIndexOf(':');
  if (ip.includes('.') && lastColon > 0) {
    const v4 = ip.slice(lastColon + 1);
    if (net.isIP(v4) !== 4) return null;
    const o = v4.split('.').map(Number);
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    ip = ip.slice(0, lastColon) + ':' + hi + ':' + lo;
  }

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  let groups;
  if (halves.length === 2) {
    const left = halves[0] === '' ? [] : halves[0].split(':');
    const right = halves[1] === '' ? [] : halves[1].split(':');
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  } else {
    groups = ip.split(':');
    if (groups.length !== 8) return null;
  }

  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 255, v & 255);
  }
  return bytes;
}

/**
 * 判定 IPv6 是否属于私网/特殊地址（含 ::ffff: 映射的 IPv4 私网地址）。
 * 命中返回 { kind, label }，否则返回 null。
 */
function classifyIpv6(ip) {
  const bytes = expandIpv6ToBytes(ip);
  if (!bytes || bytes.length !== 16) return null;

  const isV4Mapped = bytes.slice(0, 10).every(x => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const isV4Compat = bytes.slice(0, 12).every(x => x === 0);
  // ::ffff:a.b.c.d 与 ::a.b.c.d：还原出 IPv4 后按 IPv4 规则判定
  if (isV4Mapped || (isV4Compat && ip.includes('.'))) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return classifyIpv4(v4);
  }
  if (bytes.every((x, i) => (i === 15 ? x === 1 : x === 0))) {
    return { kind: 'loopback', label: '::1 回环地址' };
  }
  if (bytes.every(x => x === 0)) {
    return { kind: 'private', label: ':: 未指定地址' };
  }
  if ((bytes[0] & 0xfe) === 0xfc) {
    return { kind: 'private', label: 'fc00::/7 唯一本地地址（ULA）' };
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return { kind: 'private', label: 'fe80::/10 链路本地地址' };
  }
  return null;
}

/** 统一入口：给出 IP 字面量，命中清单返回 { kind, label }，否则 null。 */
function describePrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return classifyIpv4(ip);
  if (family === 6) return classifyIpv6(ip);
  return null;
}

function isReasonAllowed(reason, { allowLoopback, allowPrivate }) {
  if (!reason) return true;
  if (allowPrivate) return true;
  if (allowLoopback && reason.kind === 'loopback') return true;
  return false;
}

/**
 * 判定「混淆编码的 IP 主机名」：如 2130706433、0x7f000001、017700000001、0177.0.0.1 等。
 * 这类主机名 net.isIP() 不识别，但系统 getaddrinfo/部分解析器会把它还原成 IP（常用于
 * 绕过 SSRF 黑名单，如 2130706433 => 127.0.0.1），同步校验无法确定其真实指向，一律拒绝。
 */
function isObfuscatedIpHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (/^\d+$/.test(h)) return true; // 十进制单值，如 2130706433
  if (/^0x[0-9a-f]+$/.test(h)) return true; // 十六进制单值，如 0x7f000001
  if (/^[0-9.]+$/.test(h) && h.includes('.')) {
    const segs = h.split('.');
    if (segs.every(s => /^\d+$/.test(s))) {
      // 规范点分四段已由 net.isIP + 私网清单处理；这里只拦非规范形态
      if (segs.length !== 4) return true; // 段数异常，如 1.2.3
      if (segs.some(s => s.length > 1 && s.startsWith('0'))) return true; // 八进制前导 0，如 0177.0.0.1
    }
  }
  return false;
}

/**
 * 结构 + IP 字面量同步校验。通过则返回 { url, hostname }，否则抛中文 Error。
 */
function checkUrlShape(rawUrl, { allowLoopback = false, allowPrivate = false } = {}) {
  const text = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!text) {
    throw new Error('URL 校验失败: 地址为空，无法发起出站请求');
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`URL 校验失败: "${text}" 不是合法的 URL 地址`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`URL 校验失败: 目标地址 "${text}" 使用了 ${url.protocol} 协议，出于 SSRF 防护仅允许 http/https`);
  }

  if (url.username !== '' || url.password !== '') {
    throw new Error(`URL 校验失败: 目标地址 "${text}" 禁止包含用户名/密码（user:pass@）形式的凭据`);
  }

  let hostname = url.hostname;
  if (!hostname) {
    throw new Error(`URL 校验失败: 目标地址 "${text}" 缺少主机名`);
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  const lowered = hostname.toLowerCase().replace(/\.$/, '');
  if (lowered === 'localhost' || lowered.endsWith('.localhost') || lowered === 'ip6-localhost') {
    const reason = { kind: 'loopback', label: '"localhost" 主机名（指向回环地址）' };
    if (!isReasonAllowed(reason, { allowLoopback, allowPrivate })) {
      throw new Error(`URL 校验失败: 目标主机 ${hostname} 属于 ${reason.label}，出于 SSRF 防护已拒绝`);
    }
  }
  if (lowered === 'metadata.google.internal') {
    throw new Error('URL 校验失败: 目标主机 metadata.google.internal 是云厂商元数据服务地址，出于 SSRF 防护已拒绝');
  }

  const reason = describePrivateAddress(hostname);
  if (reason && !isReasonAllowed(reason, { allowLoopback, allowPrivate })) {
    throw new Error(`URL 校验失败: 目标主机 ${hostname} 属于 ${reason.label}，出于 SSRF 防护已拒绝`);
  }

  if (isObfuscatedIpHost(hostname) && !allowPrivate) {
    throw new Error(
      `URL 校验失败: 目标主机 ${hostname} 是混淆编码的 IP 字面量（如十进制/十六进制/八进制写法），无法可靠判定其真实指向，出于 SSRF 防护已拒绝`
    );
  }

  return { url, hostname };
}

/**
 * 同步校验（不落请求路径的最终防线）：scheme、userinfo、IP 字面量与危险主机名黑名单。
 * 无法做 DNS 解析，调用方在真正发请求前应再走 assertSafeOutboundUrl。
 */
function assertSafeOutboundUrlSync(rawUrl, options = {}) {
  const result = checkUrlShape(rawUrl, options);
  return result.url;
}

/**
 * 异步完整校验：结构校验 + DNS 解析，任一解析结果命中私网/特殊地址即拒绝。
 * 通过返回解析后的 URL 对象；失败抛出中文 Error。
 */
async function assertSafeOutboundUrl(rawUrl, options = {}) {
  const { allowLoopback = false, allowPrivate = false } = options || {};
  const { url, hostname } = checkUrlShape(rawUrl, { allowLoopback, allowPrivate });

  if (net.isIP(hostname) !== 0) {
    return url; // IP 字面量已在结构校验中判定
  }

  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`URL 校验失败: 无法解析主机名 "${hostname}"（${err.code || err.message}），出于安全考虑拒绝发起请求`);
  }
  if (!records || records.length === 0) {
    throw new Error(`URL 校验失败: 主机名 "${hostname}" 没有可用的 DNS 记录，拒绝发起请求`);
  }

  for (const record of records) {
    const reason = describePrivateAddress(record.address);
    if (reason && !isReasonAllowed(reason, { allowLoopback, allowPrivate })) {
      throw new Error(
        `URL 校验失败: 主机名 "${hostname}" 解析到 ${reason.label}（${record.address}），出于 SSRF 防护已拒绝`
      );
    }
  }

  return url;
}

module.exports = {
  assertSafeOutboundUrl,
  assertSafeOutboundUrlSync,
  describePrivateAddress,
  isObfuscatedIpHost
};
