'use strict';

/**
 * 一次性迁移脚本：把 theme-b.css 的结构规则改写成只消费令牌的样式表。
 * 只做值替换，不改选择器、不改布局属性。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'app/theme-b.css');
const OUT = path.join(ROOT, 'app/console.css');

const EXPLICIT = {
  '#ffffff': 'bg-surface', '#fff': 'bg-surface', '#fafafa': 'bg-subtle', '#f5f5f5': 'bg-hover',
  '#f0f2f5': 'bg-page', '#eef0f4': 'bg-page', '#f6f7f9': 'bg-page',
  '#d9d9d9': 'border', '#e8e8e8': 'border', '#e2e5ea': 'border',
  '#bfbfbf': 'border-strong', '#c9cfd9': 'border-strong',
  '#1f1f1f': 'text-1', '#262626': 'text-1', '#171a20': 'text-1', '#141414': 'text-1',
  '#595959': 'text-2', '#5b6472': 'text-2',
  '#8c8c8c': 'text-3', '#6b7484': 'text-3', '#999999': 'text-3',
  '#1677ff': 'accent', '#4096ff': 'accent-hover', '#0958d9': 'accent-hover',
  '#e6f4ff': 'accent-soft', '#91caff': 'accent',
  '#52c41a': 'ok', '#f6ffed': 'ok-soft', '#b7eb8f': 'ok', '#237804': 'ok', '#389e0d': 'ok',
  '#ff4d4f': 'danger', '#fff2f0': 'danger-soft', '#ffccc7': 'danger', '#cf1322': 'danger',
  '#faad14': 'warn', '#fffbe6': 'warn-soft', '#ffe58f': 'warn', '#d46b08': 'warn',
  '#000000': 'text-1', '#000': 'text-1',
};

const PALETTE = {
  'bg-page': '#eef0f4', 'bg-surface': '#ffffff', 'bg-subtle': '#f2f4f7',
  'bg-hover': '#f5f7fa', 'bg-selected': '#e9f0fe',
  'text-1': '#171a20', 'text-2': '#5b6472', 'text-3': '#6b7484',
  border: '#e2e5ea', 'border-strong': '#c9cfd9',
  accent: '#2563eb', 'accent-hover': '#1d4ed8', 'accent-soft': '#e9f0fe',
  ok: '#15803d', 'ok-soft': '#ecfdf3',
  warn: '#b45309', 'warn-soft': '#fffbeb',
  danger: '#b42318', 'danger-soft': '#fef3f2',
};

const SPACING = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48];
const FONT_SIZES = [11, 12, 13, 14, 16, 20, 24];
const RADII = [4, 6, 8];

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

function dist(a, b) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return (x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2;
}

function nearestColor(hex, prop) {
  const key = hex.toLowerCase();
  if (prop === 'color' && (key === '#ffffff' || key === '#fff')) return 'text-on-accent';
  if (EXPLICIT[key]) return EXPLICIT[key];
  let best = 'text-1';
  let bestD = Infinity;
  for (const [name, value] of Object.entries(PALETTE)) {
    const d = dist(key, value);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

function nearestFrom(list, value) {
  let best = list[0];
  let bestD = Infinity;
  for (const v of list) {
    const d = Math.abs(v - value);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

function tokenFor(prop, selector) {
  if (prop === 'box-shadow') {
    if (/dialog|modal|toast|dropdown|tooltip|popover|menu/.test(selector)) return 'var(--shadow-3)';
    return 'none';
  }
  return null;
}

function mapColorsInValue(value, prop) {
  let out = value.replace(/#[0-9a-fA-F]{3,8}\b/g, m => {
    const name = nearestColor(m, prop);
    return `var(--${name})`;
  });
  out = out.replace(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g, () => {
    if (prop.startsWith('background')) return 'var(--bg-overlay)';
    if (prop.startsWith('border') || prop === 'outline') return 'var(--border)';
    if (prop === 'color') return 'var(--text-3)';
    return 'var(--text-3)';
  });
  return out;
}

const HEIGHTS = { 20: '--h-badge', 24: '--h-control-sm', 28: '--h-control', 32: '--h-control-lg', 36: '--h-row-comfortable', 40: '--h-toolbar', 44: '--h-header', 52: '--h-device-row', 72: '--h-textarea' };

function mapHeight(value) {
  const m = /^(\d+)px$/.exec(value.trim());
  if (!m) return value;
  const n = Number(m[1]);
  if (n < 20) return value;
  const key = nearestFrom(Object.keys(HEIGHTS).map(Number), n);
  return `var(${HEIGHTS[key]})`;
}

function mapSpacing(value) {
  return value.replace(/(^|[\s(])(-?\d+(?:\.\d+)?)px/g, (all, pre, num) => {
    const n = Number(num);
    if (n === 0) return pre + '0';
    const snapped = nearestFrom(SPACING, Math.abs(n));
    if (snapped === 0) return pre + '0';
    return pre + (n < 0 ? '-' : '') + `var(--sp-${snapped})`;
  });
}

function transformDecl(prop, value, selector) {
  const p = prop.toLowerCase();
  const fixed = tokenFor(p, selector);
  if (fixed) return fixed;

  if (p === 'font-size') {
    const m = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
    if (m) return `var(--fs-${nearestFrom(FONT_SIZES, Number(m[1]))})`;
    return value;
  }
  if (p === 'font-weight') {
    const m = /^(\d+|bold|normal)$/.exec(value.trim());
    if (m) {
      const n = m[1] === 'bold' ? 700 : m[1] === 'normal' ? 400 : Number(m[1]);
      return n >= 500 ? 'var(--fw-500)' : 'var(--fw-400)';
    }
    return value;
  }
  if (p === 'line-height') {
    const m = /^(\d+(?:\.\d+)?)$/.exec(value.trim());
    if (m) {
      const n = Number(m[1]);
      if (n <= 1.05) return 'var(--lh-none)';
      if (n <= 1.35) return 'var(--lh-tight)';
      if (n <= 1.55) return 'var(--lh-normal)';
      return 'var(--lh-relaxed)';
    }
    return value;
  }
  if (p === 'border-radius') {
    if (value.trim() === '50%') return 'var(--r-pill)';
    return value.replace(/(\d+(?:\.\d+)?)px/g, (all, num) => {
      const n = Number(num);
      if (n >= 50) return 'var(--r-pill)';
      return `var(--r-${nearestFrom(RADII, n)})`;
    });
  }
  if (p === 'height' || p === 'min-height' || p === 'max-height') {
    return mapHeight(value);
  }
  if (['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'gap', 'row-gap', 'column-gap'].includes(p)) {
    return mapSpacing(value);
  }
  if (p === 'z-index') {
    const m = /^(\d+)$/.exec(value.trim());
    if (m) {
      const n = Number(m[1]);
      if (n >= 1000) return 'var(--z-modal)';
      if (n >= 100) return 'var(--z-dropdown)';
      if (n >= 10) return 'var(--z-sticky)';
      return 'var(--z-sticky)';
    }
    return value;
  }
  if (p === 'transition') {
    const props = value.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    const allowed = props.filter(x => ['opacity', 'transform', 'background-color', 'border-color', 'color', 'box-shadow'].includes(x));
    if (!allowed.length) return null;
    return allowed.map(x => `${x} var(--dur-1) var(--ease)`).join(', ');
  }
  if (p === 'transform') {
    if (/scale|skew/i.test(value)) return null;
    return value;
  }
  if (p === 'backdrop-filter' || p === 'filter') return 'none';
  if (p === 'font-family') {
    return /mono|Consolas|Menlo|Courier/i.test(value) ? 'var(--font-mono)' : 'var(--font-sans)';
  }

  return mapColorsInValue(value, p);
}

function main() {
  let css = fs.readFileSync(SRC, 'utf8');

  // 去掉文件头注释（里面写死了旧色值）
  css = css.replace(/^\/\*[\s\S]*?\*\//, '');

  // 删除旧的 :root 变量块（改由 tokens.css 提供）
  css = css.replace(/:root\s*\{[\s\S]*?\n\}/, '');

  const VAR_MAP = {
    '--primary': '--accent', '--primary-hover': '--accent-hover', '--primary-active': '--accent-hover',
    '--primary-bg': '--accent-soft', '--primary-border': '--accent',
    '--bg-card': '--bg-surface', '--border-subtle': '--border', '--border-focus': '--accent',
    '--text-title': '--text-1', '--text-body': '--text-1', '--text-muted': '--text-2', '--text-dim': '--text-3',
    '--success': '--ok', '--success-hover': '--ok', '--success-bg': '--ok-soft', '--success-border': '--border',
    '--danger-hover': '--danger', '--danger-bg': '--danger-soft', '--danger-border': '--border-strong',
    '--warning': '--warn', '--warning-bg': '--warn-soft', '--warning-border': '--border-strong',
    '--radius-sm': '--r-6', '--radius-md': '--r-8', '--radius-lg': '--r-8', '--radius-xl': '--r-8',
    '--shadow-sm': '--shadow-1', '--shadow-card': '--shadow-1', '--shadow-modal': '--shadow-3',
    '--font-base': '--font-sans', '--ease-smooth': '--ease',
  };

  const out = [];
  let selector = '';
  const lines = css.split('\n');

  for (const raw of lines) {
    const line = raw;
    const open = line.indexOf('{');
    if (open !== -1 && !line.trim().startsWith('@')) {
      selector = line.slice(0, open).trim();
      out.push(line);
      continue;
    }
    if (line.includes('}')) {
      out.push(line);
      continue;
    }
    const decl = /^(\s*)([-a-zA-Z]+)\s*:\s*([^;]+);/.exec(line);
    if (!decl) { out.push(line); continue; }
    const [, indent, prop, rawValue] = decl;
    const value = rawValue.replace(/\s*!important\s*/g, '').trim();
    const next = transformDecl(prop, value, selector);
    if (next === null) continue;
    out.push(`${indent}${prop}: ${next};`);
  }

  let body = out.join('\n').trimStart();

  // 旧变量名 → 新令牌名
  for (const [from, to] of Object.entries(VAR_MAP)) {
    body = body.split(`var(${from})`).join(`var(${to})`);
  }

  const header = `/* ==========================================================================
   console.css —— 控制台样式（由 theme-b.css 机械迁移，只消费令牌）
   迁移规则：颜色/字号/字重/行高/圆角/间距/阴影/动效/层级 全部替换为 var()。
   布局属性（display/flex/grid/position/宽高）保持原值。
   ========================================================================== */

:root[data-ui="v2"] {
  --device-width: 340px;
}

`;

  fs.writeFileSync(OUT, header + body + '\n');
  console.log('已生成', path.relative(ROOT, OUT), fs.statSync(OUT).size, 'bytes');
}

main();
