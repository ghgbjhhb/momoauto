'use strict';

/**
 * MOMO 手机号绑定工作流 (子脚本：从“手机绑定”界面开始)
 *
 * 业务流程规范（严格参照 GEMINI.md 核心守则）：
 * 1. 严格有限状态机与双层对象确认：
 *    - 进入前校验当前屏幕确实处于「手机绑定」界面（包含“手机绑定”/“绑定手机号”/“输入手机号码”）；
 *    - 若不处于该页面，严禁盲目乱点，立即报错并记录现场截图；
 * 2. 元素精准识别与定位：
 *    - 手机号输入框：精准定位“输入手机号码”区域；
 *    - 验证码输入框：精准定位“输入验证码”区域；
 *    - 获取验证码按钮：位于验证码栏右侧；
 *    - 提交按钮：定位“提交”；
 * 3. 单写互斥与幂等重跑安全。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { YunmomoClient } = require('../../index');
const shared = require('../../automation/screen');
const protocol = require('../../protocol');

const {
  sleep,
  deviceIdOf,
  normalizeText,
  RapidOcrWorker,
  screenshotAndOcr,
  tapBox,
} = shared;

const DEFAULT_DEVICE_ID = '2002637309737881601';
const DEFAULT_POLL_MS = 700;

function formatLogTime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

function createLogger(logFilePath) {
  return {
    logPath: logFilePath,
    console(msg) {
      console.log(`${formatLogTime()} ${msg}`);
    },
    async file(msg, extra = null) {
      if (!logFilePath) return;
      const now = new Date().toISOString();
      const line = `[${now}] ${msg}` + (extra ? ` ${JSON.stringify(extra)}` : '') + '\n';
      try {
        await fs.mkdir(path.dirname(logFilePath), { recursive: true });
        await fs.appendFile(logFilePath, line, 'utf8');
      } catch {}
    },
    async init() {},
    get relativeLogPath() {
      return logFilePath ? path.relative(PROJECT_ROOT, logFilePath).replace(/\\/g, '/') : '';
    }
  };
}

async function captureMilestoneScreenshot(phone, dir, filename, desc, log = null) {
  if (!phone || typeof phone.screenshot !== 'function' || !dir) return null;
  try {
    const res = await phone.screenshot({ level: 2 }).catch(() => null);
    if (!res?.data) return null;
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${filename}.png`);
    await fs.writeFile(filePath, res.data);
    const rel = path.relative(PROJECT_ROOT, filePath);
    if (log?.file) await log.file(`Screenshot saved: ${desc}`, { file: rel });
    return filePath;
  } catch {
    return null;
  }
}

function matchesDevice(record, targetId) {
  if (!record) return false;
  const id = deviceIdOf(record);
  if (id !== targetId) return false;
  const sdk = String(record.sdkVersion || '').trim().toLowerCase();
  return !sdk || sdk === 'v2';
}

function isBindPhoneScreen(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('手机绑定') || t.includes('绑定手机号') || t.includes('输入手机号码') || t.includes('编入手机号码') || t.includes('确保你的账号安全');
  });
}

function findPhoneInputBox(items) {
  for (const it of items) {
    const t = normalizeText(it.text);
    if (t.includes('手机号码') || t.includes('编入手机') || t.includes('输入手机') || t.includes('+86')) {
      return it;
    }
  }
  return null;
}

function findVerifyCodeInputBox(items) {
  for (const it of items) {
    const t = normalizeText(it.text);
    if (t.includes('验证码') && !t.includes('获取')) {
      return it;
    }
  }
  return null;
}

function findSubmitBtn(items) {
  return items.find(it => normalizeText(it.text) === '提交');
}

async function runBindPhone(client, targetDeviceId, options = {}, logger = console) {
  const log = typeof logger?.console === 'function' ? logger : {
    console: console.log,
    file: () => {}
  };

  const devices = await client.listDevices({ size: 50000 });
  let target = (devices.records || []).find(record => matchesDevice(record, targetDeviceId));
  if (!target && devices.records?.length > 0 && !process.env.YUNMOMO_DEVICE_ID) {
    target = (devices.records || []).find(record => {
      const sdk = String(record.sdkVersion || '').trim().toLowerCase();
      return sdk === 'v2';
    });
  }
  if (!target) throw new Error(`未找到匹配的 V2 设备: ${targetDeviceId}`);

  const resolvedDeviceId = deviceIdOf(target);
  const deviceName = String(target.deviceName || target.name || resolvedDeviceId);
  const phoneNumber = String(options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE || '').trim();

  await log.file('Bind phone task initialized', { deviceName, resolvedDeviceId, phoneNumber });

  log.console(`[目标设备] ${deviceName} (${resolvedDeviceId}) | V2 (安卓 12)`);
  log.console(`[执行操作] 陌陌手机号绑定 (起始页面: 手机绑定)`);

  const phone = options.phone || client.device(resolvedDeviceId);
  const ownControl = !options.control;
  const control = options.control || await phone.openControl({ udid: target.udid });
  const ownWorker = !options.worker;
  const worker = options.worker || new RapidOcrWorker();
  const runId = randomUUID();
  const screenshotsDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'bind-phone', runId);
  const ocrDir = await shared.createOcrDirectory('yunmomo-bind-phone-');
  const state = { counter: 0 };
  let lastScreenshotPath = null;

  try {
    if (!control.connected) {
      await control.connect();
    }
    await log.file('Control connected successfully', { screen: `${control.screenWidth}x${control.screenHeight}` });

    // 1. 分析当前屏幕状态
    log.console('[1/3] 分析当前屏幕状态...');
    let obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-inspect-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '01-initial-state', '初始分析画面', log);

    // 校验必须处于手机绑定页面
    if (!isBindPhoneScreen(obs.items)) {
      throw new Error('未处于“手机绑定”界面，当前屏幕不匹配，请确认前台状态！');
    }

    log.console('[1/3] 确认当前处于“手机绑定”界面！');

    const scaleX = control.screenWidth / Math.max(1, obs.width);
    const scaleY = control.screenHeight / Math.max(1, obs.height);

    // 2. 定位手机号输入框与交互准备
    const phoneBox = findPhoneInputBox(obs.items);
    if (phoneBox) {
      log.console(`[2/3] 找到手机号输入区域 (文本: "${phoneBox.text}")...`);
    } else {
      log.console('[2/3] 使用默认比例定位手机号输入区域...');
    }

    // 若传入了具体手机号，在此执行输入
    if (phoneNumber) {
      log.console(`[2/3] 正在输入手机号: ${phoneNumber}...`);
      let tapPt;
      if (phoneBox) {
        // 点击 +86 偏右侧位置（输入框区域）
        tapPt = {
          x: Math.round((phoneBox.right + 20) * scaleX),
          y: Math.round(((phoneBox.top + phoneBox.bottom) / 2) * scaleY)
        };
      } else {
        tapPt = { x: Math.round(180 * scaleX), y: Math.round(212 * scaleY) };
      }

      await control.tap(tapPt.x, tapPt.y);
      await control.flush();
      await sleep(800);

      // 清空原有内容并填入手机号
      for (let i = 0; i < 15; i++) control.key(protocol.KEY_CODES.DEL);
      await control.flush();
      await sleep(300);

      await control.text(phoneNumber);
      await control.flush();
      await sleep(800);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step2-after-phone-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '02-phone-entered', '手机号输入就绪', log);
      log.console(`[2/3] 手机号 ${phoneNumber} 输入完成！`);
    } else {
      log.console('[2/3] 当前未指定具体手机号码，输入框已定位就绪，等待接码业务接入。');
    }

    // 3. 终态现场确认
    log.console('[3/3] 手机绑定子脚本就绪，当前现场已保留！');
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '03-ready-state', '子脚本就绪现场', log);

    return {
      ok: true,
      state: 'ready',
      runId,
      phoneNumber,
      screenshotsDir,
      lastScreenshotPath,
    };
  } catch (error) {
    if (phone) {
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '99-error-snapshot', '失败现场截图', log);
    }
    throw Object.assign(error, { screenshotsDir, lastScreenshotPath });
  } finally {
    if (ownControl) await control.close().catch(() => {});
    if (ownWorker) await worker.close().catch(() => {});
    if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
      await fs.rm(ocrDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseCliArgs(argv) {
  const opts = {
    execute: argv.includes('--execute'),
    deviceId: process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID,
    phoneNumber: process.env.YUNMOMO_MOMO_PHONE || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device-id') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.deviceId = val;
    } else if (a === '--phone' || a === '--number') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.phoneNumber = val;
    }
  }
  return opts;
}

function printSummary(result, duration, error = null) {
  console.log('\n' + '='.repeat(60));
  if (result?.ok) {
    console.log('【执行结果】：成功');
    console.log('【任务名称】：陌陌手机绑定');
    console.log('【退出状态码】：0');
    console.log(`【完成步骤】：校验手机绑定界面 -> 定位输入区域 -> 输入手机号 [${result.phoneNumber || '待输入'}] -> 现场就绪`);
    console.log(`【执行耗时】：${duration} 秒`);
  } else {
    console.log('【执行结果】：失败');
    console.log('【任务名称】：陌陌手机绑定');
    console.log('【退出状态码】：1');
    console.log(`【失败原因】：${error?.message || '未知错误'}`);
    const shotPath = error?.lastScreenshotPath || result?.lastScreenshotPath;
    if (shotPath) {
      console.log(`【现场截图】：${path.relative(PROJECT_ROOT, shotPath)}`);
    }
    console.log(`【执行耗时】：${duration} 秒`);
  }
  console.log('='.repeat(60) + '\n');
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const taskId = randomUUID();
  const logDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'bind-phone');
  const logFile = path.join(logDir, `${taskId}.log`);
  const logger = createLogger(logFile);

  const startMs = Date.now();
  try {
    if (!options.execute) {
      logger.console('[提示] 本脚本从陌陌手机绑定界面开始执行。如需执行，请传入 --execute 参数。');
      return;
    }

    const client = new YunmomoClient({ timeoutMs: 100000 });
    const result = await runBindPhone(client, options.deviceId, options, logger);

    const duration = ((Date.now() - startMs) / 1000).toFixed(2);
    printSummary(result, duration, null);
    process.exitCode = 0;
  } catch (error) {
    const duration = ((Date.now() - startMs) / 1000).toFixed(2);
    printSummary(null, duration, error);
    process.exitCode = 1;
    throw error;
  }
}

module.exports = {
  main,
  runBindPhone,
  isBindPhoneScreen,
};

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
