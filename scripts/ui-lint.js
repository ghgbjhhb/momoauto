'use strict';

/**
 * ui-lint —— 把「设计规范」变成可执行检查。
 *
 * 白名单不写死在脚本里，而是从 app/tokens.css 反推：新增/删除令牌，规则自动跟着变。
 * 任何 var(--x) 若不在 tokens.css 中定义，直接判为 UNDEFINED_TOKEN。
 *
 * 用法：
 *   node scripts/ui-lint.js                 检查 app/ 下全部页面与样式（旧样式表除外）
 *   node scripts/ui-lint.js --legacy        额外扫描旧样式表，只统计不阻断
 *   node scripts/ui-lint.js a.css b.html    检查指定文件
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const TOKENS_FILE = path.join(APP, 'tokens.css');

const LEGACY_FILES = new Set(['styles.css', 'theme-a.css', 'theme-b.css']);

/* ---------- 令牌基线 ---------- */

function readTokens(file) {
  const css = stripComments(fs.readFileSync(file, 'utf8'));
  const names = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  const group = prefix => new Set([...names].filter(n => n.startsWith(prefix)));
  return {
    names,
    fontSizes: group('--fs-'),
    fontWeights: group('--fw-'),
    lineHeights: group('--lh-'),
    radii: group('--r-'),
    spacing: group('--sp-'),
    shadows: group('--shadow-'),
    heights: group('--h-'),
    icons: group('--icon-'),
    zIndex: group('--z-'),
    fontFamilies: group('--font-'),
  };
}

/* ---------- 解析 ---------- */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function parseDeclarations(css) {
  const out = [];
  const re = /([a-zA-Z-]+)\s*:\s*([^;{}]+)[;}]/g;
  let m;
  while ((m = re.exec(css))) {
    out.push({ prop: m[1].toLowerCase(), value: m[2].trim(), line: lineAt(css, m.index) });
  }
  return out;
}

/** 去掉 url(...) 后再做颜色检查，避免 data URI 里的字符误判 */
function stripUrls(value) {
  return value.replace(/url\([^)]*\)/gi, 'url()');
}

function varsIn(value) {
  return [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]);
}

/* ---------- 规则常量 ---------- */

const SPACING_PROPS = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap',
]);

const TRANSITION_PROPS = new Set([
  'opacity', 'transform', 'background-color', 'border-color', 'color', 'box-shadow',
]);

const KEYWORDS = new Set(['0', 'auto', 'none', 'inherit', 'initial', 'unset', 'transparent', 'currentcolor', 'fit-content']);

/* ---------- 检查 ---------- */

function lintCss(rel, text, tokens, options = {}) {
  const issues = [];
  const isTokens = /tokens\.css$/.test(rel);
  const css = stripComments(text);
  const offset = options.lineOffset || 0;
  const push = (line, rule, message) => issues.push({ rel, line: line + offset, rule, message });

  if (!isTokens) {
    const gradient = /gradient\(/i.exec(css);
    if (gradient) push(lineAt(css, gradient.index), 'GRADIENT', '禁止渐变');

    const effect = /backdrop-filter|(?<![-\w])filter\s*:/i.exec(css);
    if (effect) push(lineAt(css, effect.index), 'EFFECT', '禁止 backdrop-filter / filter（玻璃拟态、发光）');

    const zebra = /[^{}]*nth-child\(\s*(?:even|odd)[^{}]*\{[^}]*background[^}]*\}/i.exec(css);
    if (zebra) push(lineAt(css, zebra.index + zebra[0].indexOf('nth-child')), 'ZEBRA', '禁止表格斑马纹，用 hover 与选中态区分行');

    const bar = /border-(?:left|right)\s*:\s*([2-9]|\d{2,})px[^;}]*var\(--accent[^;}]*/i.exec(css);
    if (bar) push(lineAt(css, bar.index), 'ACCENT_BAR', '禁止 accent 侧边色条，用全边框或明度差');

    const reduced = atRuleRanges(css, '@media[^{]*prefers-reduced-motion[^{]*');
    let idx = -1;
    while ((idx = css.indexOf('!important', idx + 1)) !== -1) {
      if (inRanges(idx, reduced)) continue;
      push(lineAt(css, idx), 'IMPORTANT', '禁止 !important（仅 prefers-reduced-motion 降级块例外）');
    }
  }

  for (const d of parseDeclarations(css)) {
    const { prop, value, line } = d;
    const bare = stripUrls(value);

    // 任何颜色字面量都违规（tokens.css 除外）
    if (!isTokens && /#[0-9a-f]{3,8}\b/i.test(bare)) {
      push(line, 'COLOR', `${prop}: ${value} 出现字面量 hex 颜色`);
    } else if (!isTokens && /\b(?:rgb|rgba|hsl|hsla|oklch)\(/i.test(bare)) {
      push(line, 'COLOR', `${prop}: ${value} 出现字面量色彩函数`);
    }

    // var() 必须真实存在
    for (const name of varsIn(value)) {
      if (!tokens.names.has(name)) push(line, 'UNDEFINED_TOKEN', `var(${name}) 未在 tokens.css 中定义`);
    }

    if (prop === 'font-size' && !/^var\(--fs-[\w-]+\)$/.test(value)) {
      push(line, 'FONT_SIZE', `字号 ${value} 越界，只允许 var(--fs-*)`);
    }
    if (prop === 'font-weight' && !/^var\(--fw-[\w-]+\)$/.test(value)) {
      push(line, 'FONT_WEIGHT', `字重 ${value} 越界，只允许 var(--fw-400/500)`);
    }
    if (prop === 'line-height' && !/^var\(--lh-[\w-]+\)$/.test(value)) {
      push(line, 'LINE_HEIGHT', `行高 ${value} 越界，只允许 var(--lh-*)`);
    }
    if (prop === 'border-radius') {
      const ok = value.split(/\s+/).every(p => /^var\(--r-[\w-]+\)$/.test(p) || p === '0');
      if (!ok) push(line, 'RADIUS', `圆角 ${value} 越界，只允许 var(--r-4/6/8/pill)`);
    }
    if (SPACING_PROPS.has(prop) && !isTokens) {
      const bad = value.split(/\s+/).find(p => /^-?\d/.test(p) && p !== '0');
      if (bad) push(line, 'SPACING', `${prop}: ${bad} 是字面量，必须用 var(--sp-N)`);
    }
    if ((prop === 'height' || prop === 'min-height') && !isTokens) {
      const px = /^(\d+)px$/.exec(value);
      if (px && Number(px[1]) >= 20 && !/^var\(--(h|icon)-/.test(value)) {
        push(line, 'HEIGHT', `高度 ${value} 必须用 var(--h-*) 或 var(--icon-*)`);
      }
    }
    if (prop === 'box-shadow' && !isTokens) {
      const ok = value === 'none' || /^var\(--(shadow|focus-ring)/.test(value);
      if (!ok) push(line, 'SHADOW', `阴影 ${value} 必须用 var(--shadow-1/2/3) 或 var(--focus-ring)`);
    }
    if (prop === 'transition') {
      const props = value.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
      const bad = props.find(p => !TRANSITION_PROPS.has(p));
      if (bad) push(line, 'MOTION', `过渡属性 ${bad} 不允许（只允许 opacity / transform / 颜色类）`);
    }
    if (prop === 'transform' && /scale|skew/i.test(value)) {
      push(line, 'TRANSFORM', `transform: ${value} 禁止缩放/斜切，只用位移与旋转`);
    }
    if (prop === 'font-family' && !/^var\(--font-[\w-]+\)$/.test(value) &&
      !['inherit', 'initial', 'unset'].includes(value.toLowerCase())) {
      push(line, 'FONT_FAMILY', '字体家族必须用 var(--font-sans/mono)');
    }
    if (prop === 'z-index' && value !== 'auto' && !/^var\(--z-/.test(value)) {
      push(line, 'Z_INDEX', `z-index ${value} 必须用 var(--z-*)`);
    }
  }
  return issues;
}

function lintMarkup(rel, text, tokens) {
  const issues = [];
  const push = (line, rule, message) => issues.push({ rel, line, rule, message });

  // 内联 <style> 块也要检查
  for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const bodyStart = m.index + m[0].indexOf(m[1]);
    const lineOffset = lineAt(text, bodyStart) - 1;
    issues.push(...lintCss(rel, m[1], tokens, { lineOffset }));
  }

  // 内联 style 属性
  for (const m of text.matchAll(/style="([^"]*)"/gi)) {
    const line = lineAt(text, m.index);
    const decls = m[1].split(';').map(s => s.trim()).filter(Boolean);
    for (const decl of decls) {
      const [prop, ...rest] = decl.split(':');
      const value = rest.join(':').trim();
      if (!prop || !value) continue;
      if (/#[0-9a-f]{3,8}\b/i.test(value) || /\b(?:rgb|rgba|hsl)\(/i.test(value)) {
        push(line, 'INLINE_STYLE', `内联样式出现硬编码颜色：${decl}`);
      }
      if (SPACING_PROPS.has(prop.trim().toLowerCase()) && /\d+px/.test(value)) {
        push(line, 'INLINE_STYLE', `内联样式出现字面量间距：${decl}`);
      }
    }
  }

  // emoji（排除 ✓ ✗ ★ ☆ 这类排版符号）
  const emoji = /(?![\u2713\u2717\u2605\u2606])[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  let m;
  while ((m = emoji.exec(text))) {
    push(lineAt(text, m.index), 'EMOJI', `禁止 emoji 当图标（${m[0]}），改用线性图标或纯文字`);
  }

  // 迁移期边界
  if (/<link[^>]+href="\/?(styles|theme-[ab])\.css"/i.test(text)) {
    push(1, 'LINK_LEGACY', '本页仍在引用旧样式表，迁移完成前不允许宣称已迁移');
  }
  if (/<link[^>]+href="\/?tokens\.css"/i.test(text) && !/data-ui="v2"/.test(text)) {
    push(1, 'DATA_UI', '引用 tokens.css 的页面必须在 <html> 上声明 data-ui="v2"，否则令牌不生效');
  }

  return issues;
}

/* ---------- @media 区间 ---------- */

function atRuleRanges(css, pattern) {
  const ranges = [];
  const re = new RegExp(pattern, 'gi');
  let m;
  while ((m = re.exec(css))) {
    const open = css.indexOf('{', m.index);
    if (open === -1) continue;
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    ranges.push([open, i]);
  }
  return ranges;
}

function inRanges(index, ranges) {
  return ranges.some(([a, b]) => index > a && index < b);
}

/* ---------- 统计 ---------- */

function summarize(rel, text) {
  const css = stripComments(text);
  const uniq = re => new Set([...css.matchAll(re)].map(x => x[0].toLowerCase()));
  return {
    rel,
    lines: text.split('\n').length,
    colors: uniq(/#[0-9a-f]{3,8}\b/g).size,
    fontSizes: uniq(/font-size:\s*[^;}]+/g).size,
    shadows: uniq(/box-shadow:\s*[^;}]+/g).size,
    radii: uniq(/border-radius:\s*[^;}]+/g).size,
  };
}

/* ---------- 入口 ---------- */

function listTargets() {
  return fs.readdirSync(APP)
    .filter(f => /\.(css|html)$/.test(f) && !LEGACY_FILES.has(f))
    .map(f => 'app/' + f);
}

function main() {
  const args = process.argv.slice(2);
  const legacy = args.includes('--legacy');
  const explicit = args.filter(a => !a.startsWith('--'));

  const tokens = readTokens(TOKENS_FILE);
  console.log(`令牌基线：字号 ${tokens.fontSizes.size} / 字重 ${tokens.fontWeights.size} / ` +
    `行高 ${tokens.lineHeights.size} / 圆角 ${tokens.radii.size} / 间距 ${tokens.spacing.size} / ` +
    `高度 ${tokens.heights.size} / 阴影 ${tokens.shadows.size}`);

  const targets = explicit.length ? explicit : listTargets();
  const blocking = [];
  const advisory = [];

  for (const rel of targets) {
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const issues = rel.endsWith('.css') ? lintCss(rel, text, tokens) : lintMarkup(rel, text, tokens);

    // 页面是否已迁入新体系：以 <html data-ui="v2"> 为准。
    // 未迁移页面记入基线，不阻断；一旦声明迁移，全部问题立即转为阻断。
    const migrated = !rel.endsWith('.html') || /data-ui="v2"/.test(text);
    (migrated ? blocking : advisory).push(...issues);
  }

  if (legacy) {
    for (const f of LEGACY_FILES) {
      const rel = 'app/' + f;
      const abs = path.resolve(ROOT, rel);
      if (fs.existsSync(abs)) advisory.push(...lintCss(rel, fs.readFileSync(abs, 'utf8'), tokens));
    }
  }

  report('阻断级问题（已迁移文件）', blocking);
  if (advisory.length) report('待迁移基线（不阻断）', advisory, true);

  console.log('\n--- 现状统计 ---');
  const all = [...targets, ...(legacy ? [...LEGACY_FILES].map(f => 'app/' + f) : [])];
  for (const rel of all) {
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs) || !rel.endsWith('.css')) continue;
    const s = summarize(rel, fs.readFileSync(abs, 'utf8'));
    console.log(`${rel.padEnd(22)} ${String(s.lines).padStart(5)} 行 | 颜色 ${String(s.colors).padStart(3)} | ` +
      `字号 ${String(s.fontSizes).padStart(2)} | 阴影 ${String(s.shadows).padStart(2)} | 圆角 ${String(s.radii).padStart(2)}`);
  }

  if (blocking.length) {
    console.log(`\n结论：不通过（${blocking.length} 项）`);
    process.exitCode = 1;
  } else {
    console.log(`\n结论：通过（检查 ${targets.length} 个文件）`);
  }
}

function report(title, issues, quiet = false) {
  if (!issues.length) {
    if (!quiet) console.log(`\n${title}：0`);
    return;
  }
  const byRule = new Map();
  for (const i of issues) {
    if (!byRule.has(i.rule)) byRule.set(i.rule, []);
    byRule.get(i.rule).push(i);
  }
  console.log(`\n${title}：${issues.length} 项`);
  for (const [rule, list] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${rule.padEnd(16)} ${String(list.length).padStart(4)}  ${list[0].message}`);
    if (!quiet) {
      for (const item of list.slice(0, 3)) console.log(`      ${item.rel}:${item.line}`);
    }
  }
}

main();
