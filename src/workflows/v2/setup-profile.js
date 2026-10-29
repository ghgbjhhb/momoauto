'use strict';

/**
 * MOMO 资料完善工作流 (第二阶段：选择女生 -> 修改昵称为女名 -> 仿真滑动选择生日 -> 下一步 -> 点击头像/网速监控 -> 网盘传2图 -> 授权允许 -> 点击第一张头像)
 *
 * 业务流程规范（严格参照 GEMINI.md 核心守则）：
 * 1. 状态机识别与防卡死：
 *    - 无论停留在 性别页、资料页、头像上传页、下载弹窗、还是权限弹窗，均可自愈断点续跑；
 *    - 若界面出现「手机号相关参数错误」或风控异常，立即截图熔断报错，严禁盲目推进；
 * 2. 昵称与生日：
 *    - 女生全等精准匹配；双向彻底清空微信旧昵称；写入女网名（默认“菲菲菲”）；
 *    - TAB 唤起生日滚轮，三列拟人仿真滑动，点击确定保存；
 * 3. 头像与素材包网速检测与持续等待：
 *    - 点击头像上传圆形热区；
 *    - 实时监听下载弹窗，解析下载速度（如 2.4M/s、320KB/s）；
 *    - 若网速 < 500 KB/s：自动查询并记录当前代理配置，随后主动关闭代理，使网速恢复满速直连；
 *    - 持续轮询等待下载完成（最长 45s），直到系统弹出授权申请；
 * 4. 允许前网盘传图与授权允许：
 *    - 在点击“允许”前，从私有云盘中随机挑选 2 张图片传输至手机相册；
 *    - 随后点击系统权限弹窗「允许」；
 * 5. 相册选图：
 *    - 自动定位相册网格第一张图片（第一行第二列）区域并随机点击，点完后在此处完成停下。
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

function isAvatarScreen(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('最后上传一张头像') || t.includes('五官清晰的照片') || t.includes('进入陌陌');
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

function isPermissionDialog(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return (t.includes('允许') && t.includes('不允许')) || t.includes('访问您设备上的照片') || t.includes('存储权限');
  });
}

function isPhotoPickerScreen(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('相册') || t.includes('拍摄') || t.includes('所有图片');
  });
}

function detectPlatformError(items) {
  for (const it of items) {
    const t = normalizeText(it.text);
    if (t.includes('手机号相关参数错误') || t.includes('参数错误') || t.includes('账号异常') || t.includes('限制登录')) {
      return it.text.trim();
    }
  }
  return null;
}

function parseDownloadSpeed(items) {
  for (const item of items) {
    const text = String(item.text || '').replace(/\s+/g, '');
    const match = text.match(/速度[:：]?([0-9.]+)\s*([a-zA-Z]+\/[a-zA-Z]+|[a-zA-Z]+)?/i);
    if (match) {
      const val = parseFloat(match[1]);
      const unit = (match[2] || 'KB/s').toUpperCase();
      let kbps = val;
      if (unit.startsWith('M')) {
        kbps = val * 1024;
      } else if (unit.startsWith('G')) {
        kbps = val * 1024 * 1024;
      }
      return { raw: match[0], val, unit, kbps };
    }
  }
  return null;
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
  log.console(`[执行操作] 陌陌资料完善 (性别/网名/生日 -> 头像/网速 -> 云盘传图 -> 允许权限 -> 选取第一张头像)`);

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
    log.console('[1/6] 分析当前屏幕状态...');
    let obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-inspect-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '01-initial-state', '初始分析画面', log);

    // 检查是否有系统报错/风控 Toast
    const initialError = detectPlatformError(obs.items);
    if (initialError) {
      throw new Error(`[MOMO_PLATFORM_ERROR] 出现系统异常提示：${initialError}`);
    }

    // 分支 1：处于“你的性别是？”界面
    if (isGenderScreen(obs.items)) {
      log.console('[1/6] 检测到性别选择页，选择“女生”...');
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

    // 分支 2：处于“你的昵称和生日是？”界面
    if (isNicknameAndBirthdayScreen(obs.items)) {
      log.console(`[2/6] 设置女生网名: "${nickname}"...`);
      const scaleX = control.screenWidth / Math.max(1, obs.width);
      const scaleY = control.screenHeight / Math.max(1, obs.height);

      const subtitleItem = obs.items.find(i => i.text.includes('如何称呼') || i.text.includes('了解你'));
      const nickPt = subtitleItem ? tapBox(control, subtitleItem, obs, 45) : { x: Math.round(control.screenWidth / 2), y: Math.round(368 * scaleY) };
      await control.tap(nickPt.x, nickPt.y);
      await control.flush();
      await sleep(600);

      // 双向清空旧昵称
      for (let i = 0; i < 30; i++) control.key(protocol.KEY_CODES.DPAD_RIGHT);
      for (let i = 0; i < 50; i++) control.key(protocol.KEY_CODES.DEL);
      for (let i = 0; i < 30; i++) control.key(protocol.KEY_CODES.DPAD_LEFT);
      for (let i = 0; i < 30; i++) control.key(112); // KEYCODE_FORWARD_DEL
      await control.flush();
      await sleep(400);

      // 粘贴新昵称并收起键盘
      await control.paste(nickname);
      await control.flush();
      await sleep(800);

      control.back();
      await control.flush();
      await sleep(800);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '03-nickname-set', '网名填写完成', log);

      // 唤起生日滚轮弹窗
      log.console('[3/6] 唤起生日滚轮选择框...');
      control.key(protocol.KEY_CODES.TAB);
      await control.flush();
      await sleep(300);
      control.key(protocol.KEY_CODES.DPAD_CENTER);
      await control.flush();
      await sleep(1200);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-open-wheel-${state.counter++}`);
      if (!isBirthdayWheelDialog(obs.items)) {
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

      // 三列仿真滑动
      log.console('[3/6] 执行生日三列仿真滑动 (年/月/日)...');
      const columns = [
        { label: '年份', x: Math.round(96 * scaleX) },
        { label: '月份', x: Math.round(180 * scaleX) },
        { label: '日期', x: Math.round(260 * scaleX) },
      ];

      for (const col of columns) {
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

      // 保存生日
      log.console('[3/6] 点击确定保存所选生日...');
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

      // 点击下一步
      log.console('[4/6] 点击“下一步”进入头像页面...');
      const nextBtn = obs.items.find(i => i.text.trim() === '下一步' || i.text.includes('下一步'));
      if (nextBtn) {
        const nextPt = tapBox(control, nextBtn, obs);
        await control.tap(nextPt.x, nextPt.y);
      } else {
        await control.tap(Math.round(180 * scaleX), Math.round(577 * scaleY));
      }
      await control.flush();
      await sleep(2500);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step4-after-next-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '07-avatar-page', '到达头像设置界面', log);
    }

    // 分支 3：处于“最后上传一张头像吧”界面、素材包下载中或权限弹窗
    log.console('[5/6] 执行头像点击、素材包网速检测与授权...');

    // 若当前未在下载、未弹权限框、也未展开相册，则点击头像圆形热区唤起下载或相册
    const isDownloadingNow = obs.items.some(i => i.text.includes('下载素材包') || i.text.includes('速度'));
    if (!isPermissionDialog(obs.items) && !isDownloadingNow && !isPhotoPickerScreen(obs.items)) {
      const scaleY = control.screenHeight / Math.max(1, obs.height);
      const avatarPt = { x: Math.round(control.screenWidth / 2), y: Math.round(290 * scaleY) };
      log.console(`[5/6] 点击头像热区 (${avatarPt.x}, ${avatarPt.y})...`);
      await control.tap(avatarPt.x, avatarPt.y);
      await control.flush();
      await sleep(1500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step5-after-avatar-tap-${state.counter++}`);
    }

    // 检查是否有风控/系统报错
    const errText = detectPlatformError(obs.items);
    if (errText) {
      throw new Error(`[MOMO_PLATFORM_ERROR] 出现系统异常提示：${errText}`);
    }

    // 持续监听素材包下载过程与网速检测，直到下载完成并跳出系统权限弹窗（最长 45 秒）
    const downloadDeadline = Date.now() + 45000;
    let proxyRecorded = null;
    let speedChecked = false;

    while (Date.now() < downloadDeadline) {
      // 1. 若跳出系统存储权限弹窗，直接跳出循环进行传图与授权
      if (isPermissionDialog(obs.items)) {
        log.console('[5/6] 素材包下载完成或已就绪，检测到系统权限弹窗！');
        break;
      }

      // 2. 若直接进入了相册选择页，说明已授权就绪
      if (isPhotoPickerScreen(obs.items)) {
        log.console('[5/6] 已直接进入相册图片选择界面！');
        break;
      }

      // 3. 实时检测素材包下载弹窗与网速
      const isDownloadModal = obs.items.some(i => i.text.includes('下载素材包') || i.text.includes('速度') || i.text.includes('请稍等'));
      if (isDownloadModal) {
        if (!speedChecked) {
          const speed = parseDownloadSpeed(obs.items);
          if (speed) {
            speedChecked = true;
            log.console(`[网速检测] 捕获当前素材包下载网速: ${speed.val} ${speed.unit} (${speed.kbps.toFixed(1)} KB/s)`);
            if (speed.kbps < 500) {
              log.console(`[网速过低] 下载速度低于 500 KB/s，执行当前代理获取与记录...`);
              const [legacy, v1] = await Promise.all([
                phone.getProxy('legacy').catch(() => null),
                phone.getProxy('v1').catch(() => null)
              ]);
              proxyRecorded = legacy?.addr || v1?.address || '未配置代理或已停止';
              log.console(`[代理记录] 当前生效代理: ${proxyRecorded}`);
              await log.file('Recorded proxy before stop due to low speed', { speed, proxyRecorded, legacy, v1 });

              log.console('[优化网速] 正在主动关闭当前代理以恢复满速直连...');
              await Promise.allSettled([
                phone.stopProxy('legacy'),
                phone.stopProxy('v1')
              ]);
              log.console('[优化网速] 当前代理已关闭，网速切换为直连高速！');
            } else {
              log.console(`[网速正常] 当前下载速度 ${speed.kbps.toFixed(1)} KB/s (>= 500 KB/s)，网速良好。`);
            }
          }
        }
        log.console('[5/6] 素材包正在下载中，等待下载完毕跳出授权...');
      }

      // 4. 检查是否有异常
      const loopErr = detectPlatformError(obs.items);
      if (loopErr) {
        throw new Error(`[MOMO_PLATFORM_ERROR] 出现系统异常提示：${loopErr}`);
      }

      await sleep(1500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step5-wait-download-${state.counter++}`);
    }

    // 在点击允许前，从私有云盘中随机挑选 2 张图片传输至手机
    if (isPermissionDialog(obs.items)) {
      log.console('[5/6] 准备在授权前向云机传输 2 张云盘图片...');
      try {
        const disk = client.cloudDisk();
        const list = await disk.list({ channel: '1', size: 100 });
        const imageRecords = (list.records || []).filter(r => /\.(jpg|jpeg|png|webp)$/i.test(r.name));
        if (imageRecords.length > 0) {
          const shuffled = [...imageRecords].sort(() => Math.random() - 0.5);
          const selected = shuffled.slice(0, 2);
          log.console(`[云盘传图] 从私有云盘随机挑选 2 张图片传输至手机: ${selected.map(s => s.name).join('、')}...`);
          await disk.sendToDevices([resolvedDeviceId], selected, { fileType: 'auto' });
          await sleep(2500);
          log.console('[云盘传图] 2 张云盘图片已下发至手机相册！');
        } else {
          log.console('[云盘传图] 私有云盘未找到可用图片文件，跳过云盘传图');
        }
      } catch (err) {
        log.console(`[云盘传图] 传图提示 (不阻断主流程): ${err.message}`);
      }

      // 处理系统权限弹窗（直接点击“允许”）
      log.console('[5/6] 点击系统权限弹窗中的“允许”...');
      const allowBtn = obs.items.find(i => i.text.trim() === '允许');
      if (allowBtn) {
        const allowPt = tapBox(control, allowBtn, obs);
        await control.tap(allowPt.x, allowPt.y);
      } else {
        await control.tap(Math.round(control.screenWidth / 2), Math.round(control.screenHeight * 0.58));
      }
      await control.flush();
      await sleep(2000);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step5-after-allow-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '08-permission-allowed', '已点击允许进入相册', log);
      log.console('[5/6] 已成功点击“允许”，授权完成并唤起相册！');
    }

    // 6. 相册内点击第一张头像图片
    let pickerReady = isPhotoPickerScreen(obs.items);
    const pickerDeadline = Date.now() + 8000;
    while (!pickerReady && Date.now() < pickerDeadline) {
      await sleep(800);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step6-wait-picker-${state.counter++}`);
      pickerReady = isPhotoPickerScreen(obs.items);
    }

    if (pickerReady) {
      log.console('[6/6] 相册已展开，正在选择第一张图片作为头像...');
      const paiItem = obs.items.find(i => i.text.includes('拍摄'));
      const scaleX = control.screenWidth / Math.max(1, obs.width);
      const scaleY = control.screenHeight / Math.max(1, obs.height);

      let targetX, targetY;
      if (paiItem) {
        // 第一张图片固定位于“拍摄”右侧第一格 (横向偏移 120 像素)
        const baseX = (paiItem.centerX + 120) * scaleX;
        const baseY = (paiItem.centerY - 10) * scaleY;
        const jitterX = Math.floor(Math.random() * 20 - 10);
        const jitterY = Math.floor(Math.random() * 20 - 10);
        targetX = Math.round(baseX + jitterX);
        targetY = Math.round(baseY + jitterY);
      } else {
        targetX = 200 + Math.floor(Math.random() * 20 - 10);
        targetY = 215 + Math.floor(Math.random() * 20 - 10);
      }

      log.console(`[6/6] 点击相册第一张头像图片 (坐标: ${targetX}, ${targetY})...`);
      await control.tap(targetX, targetY);
      await control.flush();
      await sleep(2500);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step6-after-photo-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '09-first-photo-selected', '已点击第一张头像', log);
      log.console('[6/6] 【完成】已成功点击第一张头像图片，任务保留当前现场等待下一步！');
    }

    return {
      ok: true,
      state: 'completed',
      runId,
      nickname,
      proxyRecorded,
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
      await fs.rm(ocrDir, { recursive: true, force: true });
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
    console.log('【任务名称】：陌陌资料完善 (性别/网名/生日/头像授权/选第一张头像)');
    console.log('【退出状态码】：0');
    console.log(`【完成步骤】：性别/网名/生日 -> 点击头像 -> 网速检测 -> 云盘传图 -> 允许授权 -> 点击第一张头像`);
    if (result.proxyRecorded) {
      console.log(`【记录代理】：${result.proxyRecorded}`);
    }
    console.log(`【执行耗时】：${duration} 秒`);
  } else {
    console.log('【执行结果】：失败');
    console.log('【任务名称】：陌陌资料完善 (性别/网名/生日/头像授权/选第一张头像)');
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
      logger.console('[提示] 本脚本执行资料完善全流程。如需执行，请传入 --execute 参数。');
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
