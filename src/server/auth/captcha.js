'use strict';

const { randomUUID, randomInt } = require('node:crypto');

// 字符池：排除易混淆字符（0/O/o, 1/I/l）
const CAPTCHA_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';

// 鲜明高对比度文字颜色板
const TEXT_COLORS = [
  '#1e40af', '#b91c1c', '#047857', '#7c2d12',
  '#4c1d95', '#c2410c', '#0f766e', '#831843',
  '#1d4ed8', '#991b1b', '#15803d', '#a21caf'
];

// 干扰线与噪点颜色板
const NOISE_COLORS = [
  '#94a3b8', '#64748b', '#cbd5e1', '#f87171',
  '#60a5fa', '#34d399', '#fbbf24', '#a78bfa'
];

// 候选字体系列（避免内嵌双引号打断 SVG 属性）
const FONT_FAMILIES = [
  'Arial, Helvetica, sans-serif',
  'Georgia, Cambria, serif',
  'Impact, Charcoal, sans-serif',
  'Trebuchet MS, sans-serif',
  'Verdana, Geneva, sans-serif'
];

// 验证码内存存储（带 TTL 和防重放）
// 映射：id -> { code: 'abcd', expiresAt: number }
const captchaStore = new Map();
const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5分钟有效
const MAX_STORE_SIZE = 2000;

function cleanupExpired() {
  const now = Date.now();
  for (const [id, item] of captchaStore.entries()) {
    if (now > item.expiresAt) {
      captchaStore.delete(id);
    }
  }
}

// 每2分钟自清理一次
setInterval(cleanupExpired, 2 * 60 * 1000).unref();

function getRandomChar() {
  return CAPTCHA_CHARS[randomInt(0, CAPTCHA_CHARS.length)];
}

function getRandomColor(palette) {
  return palette[randomInt(0, palette.length)];
}

/**
 * 生成稍复杂、带角度扭曲、贝塞尔干扰线与随机噪点的图形验证码
 */
function createCaptcha() {
  if (captchaStore.size > MAX_STORE_SIZE) {
    cleanupExpired();
  }

  const width = 124;
  const height = 40;
  const length = 4;
  let code = '';
  for (let i = 0; i < length; i++) {
    code += getRandomChar();
  }

  const id = randomUUID();
  captchaStore.set(id, {
    code: code.toLowerCase(),
    expiresAt: Date.now() + CAPTCHA_TTL_MS
  });

  // 1. 背景底色与柔和渐变
  const bgGradId = `bg-${id.slice(0, 8)}`;
  const bgColors = ['#f8fafc', '#f1f5f9', '#eff6ff', '#fdf4ff', '#ecfdf5'];
  const bg1 = bgColors[randomInt(0, bgColors.length)];
  const bg2 = bgColors[randomInt(0, bgColors.length)];

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`;
  svg += `<defs>
    <linearGradient id="${bgGradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bg1}" />
      <stop offset="100%" stop-color="${bg2}" />
    </linearGradient>
  </defs>`;
  svg += `<rect width="${width}" height="${height}" rx="6" fill="url(#${bgGradId})" />`;

  // 2. 底层轻微网格/散点
  for (let i = 0; i < 6; i++) {
    const gx = randomInt(5, width - 5);
    const gy = randomInt(5, height - 5);
    svg += `<line x1="${gx - 4}" y1="${gy}" x2="${gx + 4}" y2="${gy}" stroke="#cbd5e1" stroke-width="0.7" opacity="0.4" />`;
    svg += `<line x1="${gx}" y1="${gy - 4}" x2="${gx}" y2="${gy + 4}" stroke="#cbd5e1" stroke-width="0.7" opacity="0.4" />`;
  }

  // 3. 底层贝塞尔平滑干扰曲线 (2条)
  for (let i = 0; i < 2; i++) {
    const x1 = randomInt(0, 20);
    const y1 = randomInt(5, height - 5);
    const cx = randomInt(30, width - 30);
    const cy = randomInt(0, height);
    const x2 = randomInt(width - 25, width);
    const y2 = randomInt(5, height - 5);
    const stroke = getRandomColor(NOISE_COLORS);
    const strokeWidth = (randomInt(12, 22) / 10).toFixed(1);
    const opacity = (randomInt(40, 70) / 100).toFixed(2);
    svg += `<path d="M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="none" opacity="${opacity}" />`;
  }

  // 4. 随机噪点 (底层 20 个)
  for (let i = 0; i < 20; i++) {
    const cx = randomInt(2, width - 2);
    const cy = randomInt(2, height - 2);
    const r = (randomInt(8, 20) / 10).toFixed(1);
    const fill = getRandomColor(NOISE_COLORS);
    const op = (randomInt(30, 70) / 100).toFixed(2);
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" opacity="${op}" />`;
  }

  // 5. 核心文字渲染 (每个字符独立旋转、缩放、偏移、颜色与字体)
  const charSpacing = (width - 24) / length;
  for (let i = 0; i < length; i++) {
    const char = code[i];
    const x = Math.round(16 + i * charSpacing + randomInt(-2, 3));
    const y = Math.round(27 + randomInt(-3, 3));
    const angle = randomInt(-26, 27);
    const fontSize = randomInt(23, 27);
    const font = FONT_FAMILIES[randomInt(0, FONT_FAMILIES.length)];
    const color = getRandomColor(TEXT_COLORS);
    const weight = randomInt(0, 2) === 0 ? 'bold' : '800';

    svg += `<text x="${x}" y="${y}" font-family="${font}" font-size="${fontSize}" font-weight="${weight}" fill="${color}" transform="rotate(${angle}, ${x}, ${y})" text-anchor="middle" dominant-baseline="alphabetic">${char}</text>`;
  }

  // 6. 顶层穿插贝塞尔干扰曲线 (1-2条穿过字符)
  for (let i = 0; i < 2; i++) {
    const x1 = randomInt(0, 25);
    const y1 = randomInt(10, height - 10);
    const cx1 = randomInt(25, 60);
    const cy1 = randomInt(0, height);
    const cx2 = randomInt(60, width - 25);
    const cy2 = randomInt(0, height);
    const x2 = randomInt(width - 20, width);
    const y2 = randomInt(10, height - 10);
    const stroke = getRandomColor(NOISE_COLORS);
    const strokeWidth = (randomInt(12, 20) / 10).toFixed(1);
    const opacity = (randomInt(45, 75) / 100).toFixed(2);
    svg += `<path d="M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="none" opacity="${opacity}" />`;
  }

  // 7. 顶层穿插直线与噪点 (强化防 OCR 识别能力)
  for (let i = 0; i < 2; i++) {
    const lx1 = randomInt(5, width - 5);
    const ly1 = randomInt(5, height - 5);
    const lx2 = randomInt(5, width - 5);
    const ly2 = randomInt(5, height - 5);
    svg += `<line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="${getRandomColor(NOISE_COLORS)}" stroke-width="1.2" opacity="0.45" />`;
  }

  for (let i = 0; i < 25; i++) {
    const cx = randomInt(2, width - 2);
    const cy = randomInt(2, height - 2);
    const r = (randomInt(7, 18) / 10).toFixed(1);
    const fill = getRandomColor(NOISE_COLORS);
    const op = (randomInt(35, 75) / 100).toFixed(2);
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" opacity="${op}" />`;
  }

  svg += '</svg>';

  return { id, svg, code };
}

/**
 * 校验验证码（一次性使用，校验后立即失效，防重放攻击）
 */
function verifyCaptcha(id, userInput) {
  if (!id || typeof id !== 'string') {
    return { valid: false, reason: '请点击图形验证码刷新后再试' };
  }
  const entry = captchaStore.get(id);
  // 无论校验成功与否，立即销毁，确保一体验证码绝无法复用
  captchaStore.delete(id);

  if (!entry) {
    return { valid: false, reason: '验证码已失效，请点击刷新' };
  }

  if (Date.now() > entry.expiresAt) {
    return { valid: false, reason: '验证码已过期，请点击刷新' };
  }

  if (!userInput || typeof userInput !== 'string') {
    return { valid: false, reason: '请输入图形验证码' };
  }

  const normalizedInput = userInput.trim().toLowerCase();
  if (normalizedInput !== entry.code) {
    return { valid: false, reason: '验证码输入错误，请重新输入' };
  }

  return { valid: true };
}

module.exports = {
  createCaptcha,
  verifyCaptcha
};
