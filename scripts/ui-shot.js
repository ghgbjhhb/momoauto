'use strict';

/**
 * ui-shot —— 用真实浏览器渲染参考页并截图，作为 UI 验收证据。
 * 只读渲染，不改页面；产物写入 .local-output/ui-proof/。
 *
 * 与 ui-lint 的分工：lint 查「写法」，本脚本查「渲染结果」。
 * 任何一项断言失败即退出码非零——截图脚本不能无条件宣布成功。
 *
 * 用法：node scripts/ui-shot.js [url] [--width=1440]
 */

const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.local-output/ui-proof');

const LOCAL = process.env.LOCALAPPDATA || '';
const CANDIDATES = [
  process.env.UI_SHOT_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  LOCAL && path.join(LOCAL, 'Google/Chrome/Application/chrome.exe'),
  LOCAL && path.join(LOCAL, 'Microsoft/Edge/Application/msedge.exe'),
].filter(Boolean);

function findBrowser() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome/Edge，可用 UI_SHOT_BROWSER 指定路径');
}

function fail(message) {
  throw new Error('渲染断言失败：' + message);
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--')) || 'http://127.0.0.1:4318/style-proof.html';
  const widthArg = args.find(a => a.startsWith('--width='));
  const width = widthArg ? Number(widthArg.split('=')[1]) : 1440;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });

  const problems = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => problems.push('页面异常: ' + e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (/Failed to load resource/.test(text)) return; // 由 response 监听统一报告
      problems.push('控制台错误: ' + text);
    });
    page.on('response', r => {
      if (r.status() < 400) return;
      if (/favicon\.ico$/.test(r.url())) return;
      problems.push(`资源 ${r.status()}: ${r.url()}`);
    });

    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
    if (!response || !response.ok()) fail(`页面返回 ${response ? response.status() : '无响应'}`);

    const probe = await page.evaluate(() => ({
      sheets: document.styleSheets.length,
      bg: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      dataUi: document.documentElement.getAttribute('data-ui'),
      theme: document.documentElement.getAttribute('data-theme'),
    }));

    if (probe.sheets < 2) fail(`样式表只加载了 ${probe.sheets} 个，tokens.css / ui.css 可能 404`);
    if (!probe.accent) fail('--accent 为空，令牌未生效（检查 data-ui="v2"）');
    if (probe.bg === 'rgba(0, 0, 0, 0)') fail('body 背景透明，基础样式未生效');
    if (probe.dataUi !== 'v2') fail('页面缺少 data-ui="v2"');

    // 通过真实点击切换主题，保证截图里的按钮文案与实际状态一致
    const toggle = await page.$('#themeBtn');
    if (!toggle) fail('找不到主题切换按钮');

    if (probe.theme !== 'light') { await toggle.click(); await new Promise(r => setTimeout(r, 250)); }
    await page.screenshot({ path: path.join(OUT_DIR, 'light.png'), fullPage: true });
    console.log('已截图 light.png');

    await toggle.click();
    await new Promise(r => setTimeout(r, 250));
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (theme !== 'dark') fail('主题切换未生效');
    await page.screenshot({ path: path.join(OUT_DIR, 'dark.png'), fullPage: true });
    console.log('已截图 dark.png');

    // 窄屏回归：确认没有横向溢出
    for (const w of [1024, 640]) {
      await page.setViewport({ width: w, height: 900, deviceScaleFactor: 1 });
      await new Promise(r => setTimeout(r, 150));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`${w}px 视口横向溢出 ${overflow}px`);
    }
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.log('\n渲染问题：');
    for (const p of problems) console.log('  - ' + p);
    process.exitCode = 1;
  } else {
    console.log('\n渲染断言全部通过');
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
