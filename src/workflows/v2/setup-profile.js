'use strict';

/**
 * MOMO 资料完善工作流 (第二阶段：选择女生 -> 修改昵称为女名 -> 仿真滑动选择生日 -> 下一步)
 *
 * 业务流程规范（严格参照 GEMINI.md 核心守则）：
 * 1. 状态机识别：
 *    - 若处于“你的性别是？”界面：精确全等匹配“女生”卡片文本（避免被副标题“男生还是女生”子串干扰），点击进入资料页；
 *    - 若已处于“你的昵称和生日是？”界面：直接推进；
 * 2. 昵称处理：
 *    - 依副标题精准定位下方输入框，双向全范围清空残留字符；
 *    - 粘贴指定网名（默认内置“菲菲菲”，显式保留词库扩展 TODO 注释）；
 *    - 发送返回键收起输入法，杜绝遮挡下方生日项；
 * 3. 生日选择：
 *    - 通过 TAB + DPAD_CENTER 精准唤起生日滚轮选择弹窗，杜绝焦点误触输入法；
 *    - 自适应屏幕分辨率比例 (400x720 / 360x640)，仿真手势对“年、月、日”三列向上滑动滚动；
 *    - 通过 tapBox 动态计算“确定”按钮物理坐标点击保存，确保生日生效；
 * 4. 终态推进：
 *    - 通过 tapBox 动态计算高亮可用的“下一步”按钮坐标并点击，进入后续阶段（头像设置）。
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
// TODO: 当前内置默认女姓名“菲菲菲”，方便后续随时接入外部词库动态生成网名
const DEFAULT_NICKNAME = '菲菲菲';

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

function isGenderScreen(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('你的性别是') || t.includes('男生还是女生');
  });
}

function isNicknameAndBirthdayScreen(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('你的昵称和生日是') || t.includes('如何称呼及了解你');
  });
}

function isKeyboardVisible(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t === '中英' || t === '123' || t === '分词' || t === '完成' || t === '符' || t === 'ab' || t === '下个';
  });
}

function isBirthdayWheelDialog(items) {
  const hasWheelYear = items.some(it => /^(19\d{2}|20\d{2})$/.test(it.text.trim()));
  const hasOk = items.some(it => normalizeText(it.text).includes('确定'));
  return hasWheelYear && hasOk;
}

async function runSetupProfile(client, targetDeviceId, options = {}, logger = console) {
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
  // TODO: 当前内置女姓名“菲菲菲”，方便后续随时接入外部词库动态生成网名
  const nickname = String(options.nickname || process.env.YUNMOMO_MOMO_NICKNAME || DEFAULT_NICKNAME).trim();

  await log.file('Setup profile task initialized', { deviceName, resolvedDeviceId, nickname });

  log.console(`[目标设备] ${deviceName} (${resolvedDeviceId}) | V2 (安卓 12)`);
  log.console(`[执行操作] 陌陌资料完善 (选择女生 -> 设置网名: "${nickname}" -> 仿真滑动生日 -> 下一步)`);

  const phone = client.device(resolvedDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const runId = randomUUID();
  const screenshotsDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'setup-profile', runId);
  const ocrDir = await shared.createOcrDirectory('yunmomo-setup-profile-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let lastScreenshotPath = null;

  try {
    await control.connect();
    await log.file('Control connected successfully', { screen: `${control.screenWidth}x${control.screenHeight}` });

    // 1. 分析起始画面
    log.console('[1/4] 分析当前屏幕状态...');
    let obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-inspect-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '01-initial-state', '初始分析画面', log);

    // 若在性别选择页，点击女生卡片
    if (isGenderScreen(obs.items)) {
      log.console('[1/4] 检测到性别选择页，选择“女生”...');
      // 必须精准全等匹配“女生”，严禁使用 includes('女生') 误匹配副标题“让大家了解下你是男生还是女生”
      const femaleItem = obs.items.find(i => i.text.trim() === '女生');
      if (femaleItem) {
        const pt = tapBox(control, femaleItem, obs);
        await control.tap(pt.x, pt.y);
      } else {
        const scaleX = control.screenWidth / Math.max(1, obs.width);
        const scaleY = control.screenHeight / Math.max(1, obs.height);
        await control.tap(Math.round(263 * scaleX), Math.round(465 * scaleY));
      }
      await control.flush();
      await sleep(1500);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-after-female-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '02-gender-selected', '已选择女生', log);
    }

    // 确认进入“你的昵称和生日是？”界面
    const nickDeadline = Date.now() + 10000;
    while (!isNicknameAndBirthdayScreen(obs.items) && Date.now() < nickDeadline) {
      await sleep(DEFAULT_POLL_MS);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step2-wait-nick-${state.counter++}`);
    }

    if (!isNicknameAndBirthdayScreen(obs.items)) {
      throw new Error('未进入“你的昵称和生日是？”界面，请确认当前前台状态');
    }

    // 2. 昵称清空并填入指定网名
    log.console(`[2/4] 设置女生网名: "${nickname}"...`);
    const scaleX = control.screenWidth / Math.max(1, obs.width);
    const scaleY = control.screenHeight / Math.max(1, obs.height);

    // 依据副标题文本动态定位输入框热区
    const subtitleItem = obs.items.find(i => i.text.includes('如何称呼') || i.text.includes('了解你'));
    const nickPt = subtitleItem ? tapBox(control, subtitleItem, obs, 45) : { x: Math.round(control.screenWidth / 2), y: Math.round(368 * scaleY) };
    await control.tap(nickPt.x, nickPt.y);
    await control.flush();
    await sleep(600);

    // 双向清空残留旧字符（向右移光标退格 + 向左移光标前向删除）
    for (let i = 0; i < 30; i++) control.key(protocol.KEY_CODES.DPAD_RIGHT);
    for (let i = 0; i < 50; i++) control.key(protocol.KEY_CODES.DEL);
    for (let i = 0; i < 30; i++) control.key(protocol.KEY_CODES.DPAD_LEFT);
    for (let i = 0; i < 30; i++) control.key(112); // KEYCODE_FORWARD_DEL
    await control.flush();
    await sleep(400);

    // 粘贴新昵称
    await control.paste(nickname);
    await control.flush();
    await sleep(800);

    // 收起软键盘
    control.back();
    await control.flush();
    await sleep(800);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '03-nickname-set', '网名填写完成', log);

    // 3. 唤起生日滚轮弹窗
    log.console('[3/4] 唤起生日滚轮选择框...');
    // 使用 TAB + DPAD_CENTER 精准唤起生日选择器，杜绝点击再次拉起输入法
    control.key(protocol.KEY_CODES.TAB);
    await control.flush();
    await sleep(300);
    control.key(protocol.KEY_CODES.DPAD_CENTER);
    await control.flush();
    await sleep(1200);

    obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-open-wheel-${state.counter++}`);
    if (!isBirthdayWheelDialog(obs.items)) {
      // 备用策略：点击生日区域
      const bdayItem = obs.items.find(i => /^(19\d{2}|20\d{2})/.test(i.text.trim()) || i.text.includes('-'));
      if (bdayItem) {
        const bdayPt = tapBox(control, bdayItem, obs);
        await control.tap(bdayPt.x, bdayPt.y);
        await control.flush();
        await sleep(1200);
      }
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-retry-wheel-${state.counter++}`);
    }

    if (!isBirthdayWheelDialog(obs.items)) {
      throw new Error('未能唤起生日滚轮选择弹窗');
    }

    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '04-wheel-opened', '生日滚轮弹窗已就绪', log);

    // 4. 三列仿真滑动
    log.console('[3/4] 执行生日三列仿真滑动 (年/月/日)...');
    const columns = [
      { label: '年份', x: Math.round(96 * scaleX) },
      { label: '月份', x: Math.round(180 * scaleX) },
      { label: '日期', x: Math.round(260 * scaleX) },
    ];

    for (const col of columns) {
      // 仿真参数：轻微拟人化抖动 (±2px)，持续 380~460ms，18 步
      const jitterFromX = col.x + Math.floor(Math.random() * 5 - 2);
      const jitterToX = col.x + Math.floor(Math.random() * 5 - 2);
      const startY = Math.round(395 * scaleY) + Math.floor(Math.random() * 6 - 3);
      const endY = Math.round(280 * scaleY) + Math.floor(Math.random() * 6 - 3);
      const durationMs = 380 + Math.floor(Math.random() * 80);

      await control.swipe(
        { x: jitterFromX, y: startY },
        { x: jitterToX, y: endY },
        { durationMs, steps: 18 }
      );
      await control.flush();
      await sleep(500);
    }

    await sleep(600);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '05-wheel-swiped', '三列滚轮滑动完成', log);

    // 点击确定保存生日
    log.console('[3/4] 点击确定保存所选生日...');
    obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-wheel-confirm-${state.counter++}`);
    const okItem = obs.items.find(i => i.text.trim() === '确定' || i.text.includes('确定'));
    if (okItem) {
      const okPt = tapBox(control, okItem, obs);
      await control.tap(okPt.x, okPt.y);
    } else {
      await control.tap(Math.round(266 * scaleX), Math.round(452 * scaleY));
    }
    await control.flush();
    await sleep(1500);

    obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-wheel-dismissed-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '06-birthday-confirmed', '生日选择确认完成', log);

    // 5. 点击下一步
    log.console('[4/4] 点击“下一步”提交资料...');
    const nextBtn = obs.items.find(i => i.text.trim() === '下一步' || i.text.includes('下一步'));
    if (nextBtn) {
      const nextPt = tapBox(control, nextBtn, obs);
      await control.tap(nextPt.x, nextPt.y);
    } else {
      await control.tap(Math.round(180 * scaleX), Math.round(577 * scaleY));
    }
    await control.flush();
    await sleep(2500);

    // 截取最终完成画面
    obs = await screenshotAndOcr(phone, worker, ocrDir, `step4-final-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '07-final-result', '资料完善后下一阶段画面', log);

    return {
      ok: true,
      state: 'completed',
      runId,
      nickname,
      screenshotsDir,
      lastScreenshotPath,
    };
  } catch (error) {
    if (phone) {
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '99-error-snapshot', '失败现场截图', log);
    }
    throw Object.assign(error, { screenshotsDir, lastScreenshotPath });
  } finally {
    await control.close().catch(() => {});
    await worker.close().catch(() => {});
    if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
      await fs.rm(ocrDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function parseCliArgs(argv) {
  const opts = {
    execute: argv.includes('--execute'),
    deviceId: process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID,
    nickname: process.env.YUNMOMO_MOMO_NICKNAME || DEFAULT_NICKNAME,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device-id') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.deviceId = val;
    } else if (a === '--nickname' || a === '--name') {
      const val = argv[++i];
      if (val && !val.startsWith('--')) opts.nickname = val;
    }
  }
  return opts;
}

function printSummary(result, duration, error = null) {
  console.log('\n' + '='.repeat(60));
  if (result?.ok) {
    console.log('【执行结果】：成功');
    console.log('【任务名称】：陌陌资料完善 (性别/昵称/生日)');
    console.log('【退出状态码】：0');
    console.log(`【完成步骤】：选择女生 -> 设置网名[${result.nickname}] -> 仿真滑动生日 -> 下一步`);
    console.log(`【执行耗时】：${duration} 秒`);
  } else {
    console.log('【执行结果】：失败');
    console.log('【任务名称】：陌陌资料完善 (性别/昵称/生日)');
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
  const logDir = path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'setup-profile');
  const logFile = path.join(logDir, `${taskId}.log`);
  const logger = createLogger(logFile);

  const startMs = Date.now();
  try {
    if (!options.execute) {
      logger.console('[提示] 本脚本将选择女生、设置网名“菲菲菲”、仿真滑动选择生日并点击下一步。如需执行，请传入 --execute 参数。');
      return;
    }

    const client = new YunmomoClient({ timeoutMs: 100000 });
    const result = await runSetupProfile(client, options.deviceId, options, logger);

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
  runSetupProfile,
};

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
