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
const { SmsService } = require('../../server/sms/service');
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
// 默认接码项目编码：陌陌换绑3
const DEFAULT_PROJECT_CODE = '369990';

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
    // 严格限制在纵向 170~250 像素范围内的手机号输入行，避免误匹配顶部标题或状态栏
    if (it.top >= 170 && it.bottom <= 250) {
      if (t.includes('+86') || t.includes('手机') || t.includes('编入') || t.includes('输入')) {
        return it;
      }
    }
  }
  return null;
}

function findVerifyCodeInputBox(items) {
  for (const it of items) {
    // 限制在纵向 245~310 像素范围内的验证码输入行
    if (it.top >= 245 && it.bottom <= 310) {
      const t = normalizeText(it.text);
      if (!t.includes('获取')) {
        return it;
      }
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
  const projectCode = String(options.projectCode || process.env.YUNMOMO_MOMO_PROJECT_CODE || DEFAULT_PROJECT_CODE).trim();
  let phoneNumber = String(options.phoneNumber || process.env.YUNMOMO_MOMO_PHONE || '').trim();
  let sessionId = null;

  await log.file('Bind phone task initialized', { deviceName, resolvedDeviceId, projectCode, phoneNumber });

  log.console(`[目标设备] ${deviceName} (${resolvedDeviceId}) | V2 (安卓 12)`);
  log.console(`[执行操作] 陌陌手机号绑定 (接码项目: 陌陌换绑3 [${projectCode}] -> 模拟打字输入)`);

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

    // 2. 从接码平台取号 (若未直接传入手机号)
    if (!phoneNumber) {
      log.console(`[接码平台] 正在向玄武平台申请手机号 (项目编码: ${projectCode} 陌陌换绑3)...`);
      const smsService = new SmsService();
      const smsClient = smsService.getClient();
      const phoneRes = await smsClient.getPhone(projectCode);
      if (!phoneRes.success || !phoneRes.phoneNumber) {
        throw new Error(`玄武接码取号失败: ${phoneRes.message || phoneRes.errorMessage || '未返回可用手机号'}`);
      }
      phoneNumber = String(phoneRes.phoneNumber).trim();
      sessionId = phoneRes.sessionId;
      log.console(`[接码平台] 取号成功: ${phoneNumber} (sessionId: ${sessionId}, 耗时: ${phoneRes.latencyMs}ms)`);
      await log.file('Phone acquired from Xuanwu', { projectCode, phoneNumber, sessionId, raw: phoneRes.raw });
    } else {
      log.console(`[手机号] 使用传入的指定手机号: ${phoneNumber}`);
    }

    const scaleX = control.screenWidth / Math.max(1, obs.width);
    const scaleY = control.screenHeight / Math.max(1, obs.height);

    // 3. 先清理下方的验证码输入框残留（若存在）
    const verifyBox = findVerifyCodeInputBox(obs.items);
    if (verifyBox && (verifyBox.text.length > 5 || /\d/.test(verifyBox.text))) {
      log.console(`[2/3] 清理验证码输入栏历史残留...`);
      const vPt = tapBox(control, verifyBox, obs);
      await control.tap(vPt.x, vPt.y);
      await control.flush();
      await sleep(400);
      control.key(protocol.KEY_CODES.A, { metaState: protocol.META.CTRL_LEFT_ON || protocol.META.CTRL_ON });
      control.key(protocol.KEY_CODES.DEL);
      for (let i = 0; i < 10; i++) control.key(protocol.KEY_CODES.DEL);
      await control.flush();
      await sleep(300);
    }

    // 4. 定位手机号输入框并模拟人工打字输入 (严禁直接粘贴)
    log.console(`[2/3] 定位手机号输入框并开始模拟打字输入...`);
    const phoneBox = findPhoneInputBox(obs.items);
    if (!phoneBox) {
      throw new Error('未在当前界面检测到手机号输入框！');
    }

    // 核心物理热区算法：
    // 手机号输入行左侧 x: 35~85 固定为 "+86 v" 区号选择热区；
    // 文本输入框主体位于 x: 100~310，中心取 x: 160 处于绝对安全输入热区；
    // 纵向取 OCR 识别到的 phoneBox 中心行高，换算至 control 坐标系，绝不偏移。
    const targetY = (phoneBox.top + phoneBox.bottom) / 2;
    const tapPt = {
      x: Math.round(160 * scaleX),
      y: Math.round(targetY * scaleY)
    };

    log.console(`[2/3] 点击手机号输入热区 (${tapPt.x}, ${tapPt.y})...`);
    await control.tap(tapPt.x, tapPt.y);
    await control.flush();
    await sleep(500);

    // 彻底清空原有残留：采用 Ctrl+A 全选 + DEL 删除，彻底清空且绝不破坏光标与焦点
    control.key(protocol.KEY_CODES.A, { metaState: protocol.META.CTRL_LEFT_ON || protocol.META.CTRL_ON });
    control.key(protocol.KEY_CODES.DEL);
    for (let i = 0; i < 10; i++) control.key(protocol.KEY_CODES.DEL);
    await control.flush();
    await sleep(300);

    // 逐字模拟真人打字输入 (带拟人化敲击微停顿，严禁直接黏贴)
    log.console(`[2/3] 模拟人工逐字击键键入手机号: "${phoneNumber}"...`);
    for (let i = 0; i < phoneNumber.length; i++) {
      const char = phoneNumber[i];
      await control.text(char);
      await control.flush();
      const keyDelay = 90 + Math.floor(Math.random() * 110);
      await sleep(keyDelay);
    }

    await sleep(600);
    // 点击空白安全区（顶部标题与提示文字之间）使输入框失焦收起软键盘，严禁盲按 back 导致退出页面
    await control.tap(Math.round(180 * scaleX), Math.round(120 * scaleY));
    await control.flush();
    await sleep(1000);

    obs = await screenshotAndOcr(phone, worker, ocrDir, `step2-after-typed-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '02-phone-typed', '手机号模拟打字完成', log);

    // 后验硬契约（GEMINI.md）：校验手机号确实出现在了屏幕对应的手机号行（严禁将错就错）
    const typedBox = findPhoneInputBox(obs.items);
    const typedText = normalizeText(typedBox?.text || '');
    const cleanPhone = phoneNumber.replace(/\s+/g, '');
    const isMatched = typedText.includes(cleanPhone) || obs.items.some(it => it.top >= 170 && it.bottom <= 250 && normalizeText(it.text).includes(cleanPhone));
    if (!isMatched) {
      throw new Error(`后验核验失败：未在手机号输入栏检测到输入的完整号码 [${cleanPhone}]，当前行识别为: "${typedText}"`);
    }

    // 后验核验：验证码栏不能被误输入数字
    const afterVerifyBox = findVerifyCodeInputBox(obs.items);
    const afterVerifyText = normalizeText(afterVerifyBox?.text || '');
    if (/\d{4,}/.test(afterVerifyText)) {
      throw new Error(`后验核验失败：验证码栏检测到异常溢出数字: "${afterVerifyText}"`);
    }

    log.console(`[2/3] 【后验确认】手机号 ${phoneNumber} 已准确键入手机号栏，验证码栏清爽！`);

    // 4. 终态现场确认
    log.console('[3/3] 手机号输入就绪，现场已保留等待下一步！');
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '03-ready-state', '手机号输入完成现场', log);

    return {
      ok: true,
      state: 'phone_typed',
      runId,
      projectCode,
      phoneNumber,
      sessionId,
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
    projectCode: process.env.YUNMOMO_MOMO_PROJECT_CODE || DEFAULT_PROJECT_CODE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device-id') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.deviceId = val;
    } else if (a === '--phone' || a === '--number') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.phoneNumber = val;
    } else if (a === '--project-code' || a === '--project') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.projectCode = val;
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
