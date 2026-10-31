'use strict';

/**
 * MOMO 资料完善工作流 (第二阶段：选择女生 -> 修改昵称为女名 -> 仿真滑动选择生日 -> 下一步 -> 点击头像/网速监控 -> 网盘传2图 -> 授权允许 -> 点击第一张头像 -> 确认下载素材 -> 裁切确认 -> 滤镜完成 -> 进入陌陌 -> 手机绑定停下)
 *
 * 业务流程规范（严格参照 GEMINI.md 核心守则）：
 * 1. 状态机识别与防卡死：
 *    - 无论停留在 性别页、资料页、头像上传页、下载弹窗、权限弹窗、相册页、裁切页、滤镜页、或手机绑定页，均可自愈断点续跑；
 *    - 若界面出现「手机号相关参数错误」或风控异常，立即截图熔断报错，严禁盲目推进；
 * 2. 昵称与生日：
 *    - 女生全等精准匹配；双向彻底清空微信旧昵称；写入女生网名（默认随机生成）；
 *    - TAB 唤起生日滚轮，三列拟人仿真滑动，点击确定保存；
 * 3. 头像与素材包网速检测与持续等待：
 *    - 点击头像上传圆形热区；
 *    - 实时监听下载弹窗，解析下载速度（如 2.4M/s、320KB/s）；
 *    - 若网速 < 500 KB/s：自动查询并记录当前代理配置，随后主动关闭代理，使网速恢复满速直连；
 *    - 持续轮询等待下载完成（最长 45s），直到系统弹出授权申请；
 * 4. 允许前网盘传图与授权允许：
 *    - 在点击“允许”前，从私有云盘中随机挑选 2 张图片传输至手机相册；
 *    - 随后点击系统权限弹窗「允许」；
 * 5. 相册选图与素材更新确认：
 *    - 自动定位相册网格第一张图片（第一行第二列）区域并随机抖动点击；
 *    - 若弹出「素材包更新，需先下载才可使用」提示弹窗，自动点击「确认」并等待下载完成；
 * 6. 裁切图片与滤镜美化完成：
 *    - 进入「裁切图片」界面后，自动点击右下角「确认」；
 *    - 进入滤镜/编辑美化界面后，自动点击右下角「完成」；
 * 7. 进入陌陌与停靠手机绑定终态：
 *    - 返回至头像页面后，检测到「进入陌陌」按钮可用并点击；
 *    - 成功进入「手机绑定」界面（出现“绑定手机号”/“输入手机号码”），全流程圆满结束并在此安全停下！
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { YunmomoClient } = require('../../index');
const shared = require('../../automation/screen');
const { logAuthBudget } = require('../../automation/auth-session');
const { resolveGirlNickname } = require('../../automation/nickname-generator');
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
  const fullText = items.map(it => normalizeText(it.text)).join('');
  const hasAllowBtn = items.some(it => {
    const t = normalizeText(it.text);
    return t === '允许' || t === '始终允许' || t === '仅在使用中允许';
  });
  const hasPermissionKeywords = fullText.includes('照片') || fullText.includes('媒体') || fullText.includes('存储') || fullText.includes('访问您设备') || fullText.includes('权限');
  return hasAllowBtn && (hasPermissionKeywords || fullText.includes('不允许') || fullText.includes('拒绝'));
}

function findPermissionAllowButton(items) {
  return items.find(it => {
    const t = normalizeText(it.text);
    return t === '允许' || t === '始终允许' || t === '仅在使用中允许';
  }) || null;
}

function isPhotoPickerScreen(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('相册') || t.includes('拍摄') || t.includes('所有图片');
  });
}

function isMaterialPackUpdateDialog(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('素材包更新') || t.includes('需先下载才可使用');
  });
}

function isCropScreen(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('裁切图片') || t.includes('裁切');
  });
}

function isPhotoEditScreen(items) {
  const hasDone = items.some(it => it.text.trim() === '完成');
  const hasCancel = items.some(it => it.text.includes('取消') || it.text.includes('取酒'));
  return hasDone || (hasCancel && items.length <= 4);
}

function isEnterMomoButton(items) {
  return items.some(it => normalizeText(it.text).includes('进入陌陌'));
}

function isBindPhoneOrHomeScreen(items) {
  return items.some(it => {
    const t = normalizeText(it.text);
    return t.includes('手机绑定') ||
           t.includes('绑定手机号') ||
           t.includes('输入手机号码') ||
           t.includes('附近的人') ||
           t.includes('切换登录账号') ||
           t.includes('开启附近功能');
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

function parseProxyAddress(rawAddr) {
  if (!rawAddr || typeof rawAddr !== 'string') return null;
  try {
    const parsed = new URL(rawAddr.startsWith('socks5://') ? rawAddr : `socks5://${rawAddr}`);
    return {
      s5ip: parsed.hostname,
      s5port: Number(parsed.port),
      s5user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      s5pwd: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    };
  } catch {
    const match = rawAddr.match(/^(?:socks5:\/\/)?(?:([^:]+):([^@]+)@)?([^:]+):(\d+)$/i);
    if (match) {
      return {
        s5ip: match[3],
        s5port: Number(match[4]),
        s5user: match[1],
        s5pwd: match[2],
      };
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
  // 网名解析：留空即随机生成（显式指定则原样使用）；生成失败直接中断，不回退固定网名。
  const { nickname, generated } = await resolveGirlNickname(
    options.nickname || process.env.YUNMOMO_MOMO_NICKNAME
  );
  log.console(`[人设网名] ${generated ? '已随机生成' : '使用指定'}女生网名: "${nickname}"`);

  await log.file('Setup profile task initialized', { deviceName, resolvedDeviceId, nickname });

  log.console(`[目标设备] ${deviceName} (${resolvedDeviceId}) | V2 (安卓 12)`);
  log.console(`[执行操作] 陌陌资料完善 (性别/网名/生日 -> 头像/网速 -> 云盘传图 -> 允许权限 -> 选第一张图 -> 裁切/美化 -> 进入陌陌 -> 手机绑定停下)`);

  const phone = options.phone || client.device(resolvedDeviceId);
  const ownControl = !options.control;
  const control = options.control || await phone.openControl({ udid: target.udid });
  const ownWorker = !options.worker;
  const worker = options.worker || new RapidOcrWorker();
  const runId = randomUUID();
  const screenshotsDir = options.screenshotsDir || path.join(PROJECT_ROOT, '.local-output', 'logs', 'v2', 'setup-profile', runId);
  const ocrDir = await shared.createOcrDirectory('yunmomo-setup-profile-');
  const state = { counter: 0 };
  let lastScreenshotPath = null;
  let proxyRecorded = null;
  let savedProxyConfig = null;

  try {
    if (!control.connected) {
      await control.connect();
    }
    await log.file('Control connected successfully', { screen: `${control.screenWidth}x${control.screenHeight}` });

    // 1. 分析起始画面
    log.console('[1/7] 分析当前屏幕状态...');
    let obs = await screenshotAndOcr(phone, worker, ocrDir, `step1-inspect-${state.counter++}`);
    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '01-initial-state', '初始分析画面', log);

    // 检查是否有系统报错/风控 Toast
    const initialError = detectPlatformError(obs.items);
    if (initialError) {
      throw new Error(`[MOMO_PLATFORM_ERROR] 出现系统异常提示：${initialError}`);
    }

    // 若当前已处于手机绑定或陌陌首页，直接判定为成功完成
    if (isBindPhoneOrHomeScreen(obs.items)) {
      log.console('[1/7] 检测到已处于手机绑定界面或陌陌首页，资料完善已达成，直接安全停靠！');
      return {
        ok: true,
        state: 'completed',
        runId,
        nickname,
        proxyRecorded,
        screenshotsDir,
        lastScreenshotPath,
      };
    }

    // 分支 1：处于“你的性别是？”界面
    if (isGenderScreen(obs.items)) {
      log.console('[2/7] 检测到性别选择页，选择“女生”...');
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
    if (isNicknameAndBirthdayScreen(obs.items) || isBirthdayWheelDialog(obs.items)) {
      const scaleX = control.screenWidth / Math.max(1, obs.width);
      const scaleY = control.screenHeight / Math.max(1, obs.height);

      if (!isBirthdayWheelDialog(obs.items)) {
        log.console(`[3/7] 设置女生网名: "${nickname}"...`);

        // 精准定位网名输入框（位于副标题下方，y 约 350~400 区间，排除标题与生日）
        const nickBox = obs.items.find(i => (i.top >= 330 && i.bottom <= 410) && !i.text.includes('生日') && !i.text.includes('如何称呼') && !i.text.includes('你的昵称'));
        const nickPt = nickBox ? tapBox(control, nickBox, obs) : { x: Math.round(control.screenWidth / 2), y: Math.round(368 * scaleY) };
        await control.tap(nickPt.x, nickPt.y);
        await control.flush();
        await sleep(600);

        // 彻底清空旧昵称：Ctrl+A 全选 + DEL 删除
        control.key(protocol.KEY_CODES.A, { metaState: protocol.META.CTRL_LEFT_ON || protocol.META.CTRL_ON });
        control.key(protocol.KEY_CODES.DEL);
        for (let i = 0; i < 15; i++) control.key(protocol.KEY_CODES.DEL);
        await control.flush();
        await sleep(300);

        // 输入新昵称：中文字符通过剪贴板+Ctrl+V原子注入，英文字符逐字击键
        const isAscii = /^[\x00-\x7F]*$/.test(nickname);
        if (isAscii) {
          for (const char of nickname) {
            await control.text(char);
            await control.flush();
            await sleep(100 + Math.floor(Math.random() * 80));
          }
        } else {
          control.setClipboard(nickname);
          await control.flush();
          await sleep(300);
          control.key(protocol.KEY_CODES.V, { metaState: protocol.META.CTRL_LEFT_ON || protocol.META.CTRL_ON });
          await control.flush();
        }
        await sleep(600);

        // 点击空白安全区（顶部标题上方）使输入框失焦收起软键盘（严禁使用 control.back()，避免误退回上一页性别选择！）
        await control.tap(Math.round(control.screenWidth / 2), Math.round(100 * scaleY));
        await control.flush();
        await sleep(800);
        lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '03-nickname-set', '网名填写完成', log);
      }

      // 重新 OCR 获取当前界面的网名与生日输入框
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-inspect-bday-${state.counter++}`);

      // 后验核验：若界面上仍有“写个好听的昵称”占位符且没有包含目标网名，执行二次聚焦与注入自愈
      const hasNick = obs.items.some(i => normalizeText(i.text).includes(normalizeText(nickname)));
      const hasPlaceholder = obs.items.some(i => normalizeText(i.text).includes('写个好听的昵称'));
      if (!hasNick && hasPlaceholder) {
        log.console(`[网名自愈] 观测到网名尚未生效（仍显示占位符），执行二次聚焦并重新注入: "${nickname}"...`);
        const scaleY = control.screenHeight / Math.max(1, obs.height);
        const retryNickPt = { x: Math.round(control.screenWidth / 2), y: Math.round(368 * scaleY) };
        await control.tap(retryNickPt.x, retryNickPt.y);
        await control.flush();
        await sleep(500);

        control.key(protocol.KEY_CODES.A, { metaState: protocol.META.CTRL_LEFT_ON || protocol.META.CTRL_ON });
        control.key(protocol.KEY_CODES.DEL);
        for (let i = 0; i < 10; i++) control.key(protocol.KEY_CODES.DEL);
        await control.flush();
        await sleep(200);

        control.setClipboard(nickname);
        await control.flush();
        await sleep(300);
        control.key(protocol.KEY_CODES.V, { metaState: protocol.META.CTRL_LEFT_ON || protocol.META.CTRL_ON });
        await control.flush();
        await sleep(600);

        await control.tap(Math.round(control.screenWidth / 2), Math.round(100 * scaleY));
        await control.flush();
        await sleep(800);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-after-nick-retry-${state.counter++}`);
      }

      // 防御自愈：若因任何手势或键盘事件误退回了性别选择页，自动重新选回女生
      if (isGenderScreen(obs.items)) {
        log.console('[自愈恢复] 观测到界面处于性别选择页，重新选择“女生”推进...');
        const femaleItem = obs.items.find(i => i.text.trim() === '女生');
        if (femaleItem) {
          const pt = tapBox(control, femaleItem, obs);
          await control.tap(pt.x, pt.y);
        } else {
          await control.tap(Math.round(263 * scaleX), Math.round(465 * scaleY));
        }
        await control.flush();
        await sleep(1500);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-after-female-reclick-${state.counter++}`);
      }
      const bdayBox = obs.items.find(i => /^(19\d{2}|20\d{2})/.test(i.text.trim()) || i.text.includes('-'));
      let bdayPt;
      if (bdayBox) {
        bdayPt = tapBox(control, bdayBox, obs);
        log.console(`[3/7] 点击生日栏 (${bdayPt.x}, ${bdayPt.y}) [${bdayBox.text}] 唤起生日滚轮选择框...`);
      } else {
        bdayPt = { x: Math.round(control.screenWidth / 2), y: Math.round(437 * scaleY) };
        log.console(`[3/7] 使用默认热区 (${bdayPt.x}, ${bdayPt.y}) 唤起生日滚轮选择框...`);
      }
      await control.tap(bdayPt.x, bdayPt.y);
      await control.flush();
      await sleep(1500);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-open-wheel-${state.counter++}`);
      if (!isBirthdayWheelDialog(obs.items)) {
        await control.tap(bdayPt.x, bdayPt.y);
        await control.flush();
        await sleep(1500);
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step3-retry-wheel-${state.counter++}`);
      }

      if (!isBirthdayWheelDialog(obs.items)) {
        throw new Error('未能唤起生日滚轮选择弹窗');
      }

      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '04-wheel-opened', '生日滚轮弹窗已就绪', log);

      // 三列拟人化动态仿真滑动 (年份向上2-4随机距离，月/日随机上下/随机次数/随机长度)
      log.console('[3/7] 执行生日三列仿真滑动 (年份向上滑2-4随机距离，月日随机上下/次数/长度)...');

      // 1. 年份列：方向固定向上，随机滑动 1~2 次，距离为 2~4 格随机长度
      const yearX = Math.round(96 * scaleX);
      const yearRounds = Math.floor(Math.random() * 2) + 1;
      for (let r = 0; r < yearRounds; r++) {
        const gridUnits = 2 + Math.random() * 2; // 2.0 ~ 4.0 个单位格距
        const distance = Math.round(gridUnits * 36 * scaleY);
        const centerY = Math.round(335 * scaleY);
        const startY = Math.min(Math.round(425 * scaleY), centerY + Math.round(distance / 2) + Math.floor(Math.random() * 10 - 5));
        const endY = Math.max(Math.round(235 * scaleY), startY - distance);
        const fromX = yearX + Math.floor(Math.random() * 6 - 3);
        const toX = yearX + Math.floor(Math.random() * 6 - 3);
        const durationMs = 280 + Math.floor(Math.random() * 140);

        await control.swipe(
          { x: fromX, y: startY },
          { x: toX, y: endY },
          { durationMs, steps: 16 }
        );
        await control.flush();
        await sleep(350 + Math.floor(Math.random() * 200));
      }

      // 2. 月份与日期列：随机上下方向、随机次数 (1~3次)、随机滑动长度 (45~150px)
      const monthAndDayColumns = [
        { label: '月份', x: Math.round(180 * scaleX) },
        { label: '日期', x: Math.round(260 * scaleX) },
      ];

      for (const col of monthAndDayColumns) {
        const swipeCount = Math.floor(Math.random() * 3) + 1; // 随机 1 ~ 3 次
        for (let i = 0; i < swipeCount; i++) {
          const isUp = Math.random() > 0.5; // 随机向上或向下
          const distance = Math.round((45 + Math.random() * 105) * scaleY); // 随机长度 45 ~ 150px
          const centerY = Math.round(335 * scaleY);

          let startY, endY;
          if (isUp) {
            startY = Math.min(Math.round(425 * scaleY), centerY + Math.round(distance / 2) + Math.floor(Math.random() * 8 - 4));
            endY = Math.max(Math.round(235 * scaleY), startY - distance);
          } else {
            startY = Math.max(Math.round(245 * scaleY), centerY - Math.round(distance / 2) + Math.floor(Math.random() * 8 - 4));
            endY = Math.min(Math.round(425 * scaleY), startY + distance);
          }

          const fromX = col.x + Math.floor(Math.random() * 8 - 4);
          const toX = col.x + Math.floor(Math.random() * 8 - 4);
          const durationMs = 260 + Math.floor(Math.random() * 160);

          await control.swipe(
            { x: fromX, y: startY },
            { x: toX, y: endY },
            { durationMs, steps: 16 }
          );
          await control.flush();
          await sleep(300 + Math.floor(Math.random() * 200));
        }
      }

      await sleep(600);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '05-wheel-swiped', '三列滚轮滑动完成', log);

      // 保存生日
      log.console('[3/7] 点击确定保存所选生日...');
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
      log.console('[3/7] 点击“下一步”进入头像页面...');
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

      // 若点击下一步后仍停留在昵称生日页（例如软键盘未收起或按钮初次失焦），补击一次“下一步”
      if (isNicknameAndBirthdayScreen(obs.items)) {
        log.console('[3/7] 仍在昵称生日页，补击“下一步”...');
        const retryBtn = obs.items.find(i => i.text.trim() === '下一步' || i.text.includes('下一步'));
        if (retryBtn) {
          const pt = tapBox(control, retryBtn, obs);
          await control.tap(pt.x, pt.y);
          await control.flush();
          await sleep(2500);
          obs = await screenshotAndOcr(phone, worker, ocrDir, `step4-after-retry-next-${state.counter++}`);
        }
      }
    }

    // 分支 3：处于“最后上传一张头像吧”界面、素材包下载中或权限弹窗
    log.console('[4/7] 执行头像点击、素材包网速检测与代理控制...');

    // 若当前未在下载、未弹权限框、也未展开相册，则点击头像圆形热区唤起下载或相册
    const isDownloadingNow = obs.items.some(i => i.text.includes('下载素材包') || i.text.includes('速度'));
    const isAlreadyPickerOrLater = isPhotoPickerScreen(obs.items) || isCropScreen(obs.items) || isPhotoEditScreen(obs.items) || isMaterialPackUpdateDialog(obs.items);
    if (!isPermissionDialog(obs.items) && !isDownloadingNow && !isAlreadyPickerOrLater && !isBindPhoneOrHomeScreen(obs.items)) {
      const scaleY = control.screenHeight / Math.max(1, obs.height);
      const avatarPt = { x: Math.round(control.screenWidth / 2), y: Math.round(290 * scaleY) };
      log.console(`[4/7] 点击头像热区 (${avatarPt.x}, ${avatarPt.y})...`);
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
    let speedChecked = false;

    while (Date.now() < downloadDeadline) {
      // 1. 若跳出系统存储权限弹窗，直接跳出循环进行传图与授权
      if (isPermissionDialog(obs.items)) {
        log.console('[4/7] 素材包下载完成或已就绪，检测到系统权限弹窗！');
        break;
      }

      // 2. 若直接进入了相册选择页或后续页面，说明已授权就绪
      if (isPhotoPickerScreen(obs.items) || isCropScreen(obs.items) || isPhotoEditScreen(obs.items) || isMaterialPackUpdateDialog(obs.items) || isBindPhoneOrHomeScreen(obs.items)) {
        log.console('[4/7] 已进入相册或后续编辑界面！');
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
              const rawLegacy = legacy?.addr || legacy?.address;
              const rawV1 = v1?.address || v1?.addr;
              if (rawLegacy) {
                const parsed = parseProxyAddress(rawLegacy);
                if (parsed) {
                  savedProxyConfig = {
                    version: 'legacy',
                    ...parsed,
                    domainMode: '2',
                    proxyMode: '1',
                    raw: rawLegacy,
                  };
                }
              } else if (rawV1) {
                const parsed = parseProxyAddress(rawV1);
                if (parsed) {
                  savedProxyConfig = {
                    version: 'v1',
                    ...parsed,
                    domainMode: '0',
                    proxyMode: '2',
                    raw: rawV1,
                  };
                }
              }

              proxyRecorded = savedProxyConfig?.raw || rawLegacy || rawV1 || '未配置代理或已停止';
              log.console(`[代理记录] 当前生效代理: ${proxyRecorded}`);
              await log.file('Recorded proxy before stop due to low speed', { speed, proxyRecorded, savedProxyConfig, legacy, v1 });

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
        log.console('[4/7] 素材包正在下载中，等待下载完毕跳出授权...');
      }

      // 4. 检查是否有异常
      const loopErr = detectPlatformError(obs.items);
      if (loopErr) {
        throw new Error(`[MOMO_PLATFORM_ERROR] 出现系统异常提示：${loopErr}`);
      }

      await sleep(1500);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step5-wait-download-${state.counter++}`);
    }

    // 5. 在点击允许前，从私有云盘中随机挑选 2 张图片传输至手机，随后点击系统权限允许
    if (isPermissionDialog(obs.items)) {
      log.console('[5/7] 准备在授权前向云机传输 2 张云盘图片...');
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

      // 处理系统权限弹窗（若出现则点击“允许”/“仅在使用中允许”，若未出现则不阻塞）
      log.console('[5/7] 检测到系统权限弹窗，点击允许授权...');
      const allowBtn = findPermissionAllowButton(obs.items);
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
      log.console('[5/7] 已成功点击“允许”，授权完成并唤起相册！');
    }

    // 6. 相册内点击第一张头像图片
    let pickerReady = isPhotoPickerScreen(obs.items);
    const pickerDeadline = Date.now() + 8000;
    while (!pickerReady && Date.now() < pickerDeadline) {
      if (isCropScreen(obs.items) || isPhotoEditScreen(obs.items) || isMaterialPackUpdateDialog(obs.items) || isBindPhoneOrHomeScreen(obs.items)) {
        break;
      }
      await sleep(800);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step6-wait-picker-${state.counter++}`);
      pickerReady = isPhotoPickerScreen(obs.items);
    }

    if (pickerReady) {
      log.console('[6/7] 相册已展开，正在选择第一张图片作为头像...');
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
        targetX = Math.round(200 * scaleX) + Math.floor(Math.random() * 20 - 10);
        targetY = Math.round(215 * scaleY) + Math.floor(Math.random() * 20 - 10);
      }

      log.console(`[6/7] 点击相册第一张头像图片 (坐标: ${targetX}, ${targetY})...`);
      await control.tap(targetX, targetY);
      await control.flush();
      await sleep(2500);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step6-after-photo-${state.counter++}`);
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '09-first-photo-selected', '已点击第一张头像', log);
    }

    // 7. 处理后续确认流程：素材更新确认 -> 裁切图片确认 -> 滤镜美化完成 -> 点击进入陌陌 -> 到达手机绑定停下
    log.console('[7/7] 执行后续确认推进流程 (素材下载/裁切确认/滤镜完成/进入陌陌)...');

    // 7.1 如果弹出“素材包更新，需先下载才可使用”，直接点击“确认”并等待下载
    if (isMaterialPackUpdateDialog(obs.items)) {
      log.console('[7/7] 检测到素材包更新弹窗，点击“确认”下载...');
      const confirmItem = obs.items.find(i => i.text.trim() === '确认');
      if (confirmItem) {
        const pt = tapBox(control, confirmItem, obs);
        await control.tap(pt.x, pt.y);
      } else {
        const scaleX = control.screenWidth / Math.max(1, obs.width);
        const scaleY = control.screenHeight / Math.max(1, obs.height);
        await control.tap(Math.round(290 * scaleX), Math.round(370 * scaleY));
      }
      await control.flush();
      await sleep(2000);

      // 等待下载完成并进入裁切界面 (最长 35s)
      const downloadWaitDeadline = Date.now() + 35000;
      while (Date.now() < downloadWaitDeadline) {
        obs = await screenshotAndOcr(phone, worker, ocrDir, `step7-wait-crop-${state.counter++}`);
        if (isCropScreen(obs.items) || isPhotoEditScreen(obs.items) || isBindPhoneOrHomeScreen(obs.items)) {
          break;
        }
        await sleep(1500);
      }
    }

    // 7.2 如果处于“裁切图片”界面，点击右下角“确认”
    if (isCropScreen(obs.items)) {
      log.console('[7/7] 检测到裁切图片界面，点击右下角“确认”...');
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '10-crop-screen', '裁切图片界面', log);
      const cropConfirmItem = obs.items.find(i => i.text.trim() === '确认' && i.top > (obs.height * 0.7));
      if (cropConfirmItem) {
        const pt = tapBox(control, cropConfirmItem, obs);
        await control.tap(pt.x, pt.y);
      } else {
        const scaleX = control.screenWidth / Math.max(1, obs.width);
        const scaleY = control.screenHeight / Math.max(1, obs.height);
        await control.tap(Math.round(270 * scaleX), Math.round(618 * scaleY));
      }
      await control.flush();
      await sleep(2500);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step7-after-crop-${state.counter++}`);
    }

    // 7.3 如果处于滤镜/美化编辑页面，右下角出现“完成”时先将原代理加回，再点击“完成”
    if (isPhotoEditScreen(obs.items)) {
      log.console('[7/7] 检测到照片美化编辑页面，右下角出现“完成”！');

      // 若之前因下载素材包加速而关掉了代理，在此处必须将原有代理加回去
      let proxyToRestore = savedProxyConfig;
      if (!proxyToRestore) {
        // 尝试从最新本地 VPC 记录获取保底
        try {
          const vpcFile = path.join(PROJECT_ROOT, '.local-output', 'VPC网络', 'latest.json');
          const content = await fs.readFile(vpcFile, 'utf8').catch(() => null);
          if (content) {
            const parsedVpc = JSON.parse(content);
            const net = parsedVpc.networks?.[0];
            if (net?.ip && net?.port) {
              proxyToRestore = {
                version: 'legacy',
                s5ip: net.ip,
                s5port: Number(net.port),
                domainMode: '2',
                proxyMode: '1',
              };
            }
          }
        } catch {}
      }

      if (proxyToRestore) {
        log.console(`[代理恢复] 正在重新加回之前关闭的代理 (${proxyToRestore.s5ip}:${proxyToRestore.s5port})...`);
        try {
          await phone.setProxy({
            s5ip: proxyToRestore.s5ip,
            s5port: proxyToRestore.s5port,
            s5user: proxyToRestore.s5user,
            s5pwd: proxyToRestore.s5pwd,
            domainMode: proxyToRestore.domainMode || '2',
            proxyMode: proxyToRestore.proxyMode || '1',
          }, proxyToRestore.version || 'legacy');

          // 校验读回生效
          const checkProxy = await phone.getProxy(proxyToRestore.version || 'legacy').catch(() => null);
          const isRestored = Boolean(checkProxy?.addr || checkProxy?.address || Number(checkProxy?.status) === 1);
          log.console(`[代理恢复] 代理恢复结果: ${isRestored ? '成功恢复生效' : '指令已下发'}`);
          await log.file('Proxy restored on photo edit screen', { proxyToRestore, checkProxy });
        } catch (proxyErr) {
          log.console(`[代理恢复] 恢复代理提示 (不阻断主流程): ${proxyErr.message}`);
        }
      }

      log.console('[7/7] 点击右下角“完成”保存头像...');
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '11-edit-screen', '照片美化编辑界面', log);
      const doneItem = obs.items.find(i => i.text.trim() === '完成');
      if (doneItem) {
        const pt = tapBox(control, doneItem, obs);
        await control.tap(pt.x, pt.y);
      } else {
        await control.tap(Math.round(control.screenWidth * 0.88), Math.round(control.screenHeight * 0.92));
      }
      await control.flush();
      await sleep(3500);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step7-after-done-${state.counter++}`);
    }

    // 7.4 返回到头像界面，点击底部的“进入陌陌”
    const enterDeadline = Date.now() + 10000;
    while (!isEnterMomoButton(obs.items) && !isBindPhoneOrHomeScreen(obs.items) && Date.now() < enterDeadline) {
      await sleep(1000);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step7-wait-enter-${state.counter++}`);
    }

    if (isEnterMomoButton(obs.items)) {
      log.console('[7/7] 头像保存成功，点击底部“进入陌陌”...');
      lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '12-avatar-done', '头像上传完成可进入陌陌', log);
      const enterBtn = obs.items.find(i => i.text.includes('进入陌陌'));
      if (enterBtn) {
        const pt = tapBox(control, enterBtn, obs);
        await control.tap(pt.x, pt.y);
      } else {
        await control.tap(Math.round(control.screenWidth / 2), Math.round(control.screenHeight * 0.90));
      }
      await control.flush();
      await sleep(3500);

      obs = await screenshotAndOcr(phone, worker, ocrDir, `step7-after-enter-${state.counter++}`);
    }

    // 7.5 到达手机绑定界面（或陌陌首页）终态确认并安全停下
    const finalDeadline = Date.now() + 10000;
    while (!isBindPhoneOrHomeScreen(obs.items) && Date.now() < finalDeadline) {
      await sleep(1000);
      obs = await screenshotAndOcr(phone, worker, ocrDir, `step7-wait-final-${state.counter++}`);
    }

    if (!isBindPhoneOrHomeScreen(obs.items)) {
      throw new Error('未能到达“手机绑定”或陌陌首页，当前界面状态不匹配！');
    }

    lastScreenshotPath = await captureMilestoneScreenshot(phone, screenshotsDir, '13-final-phone-bind', '到达手机绑定终态', log);
    log.console('[7/7] 【成功达成】已成功到达“手机绑定”界面，资料完善全流程圆满结束并在此停下！');
    await logAuthBudget(log, resolvedDeviceId, '资料完善到达手机绑定');

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
    nickname: process.env.YUNMOMO_MOMO_NICKNAME || '',
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
    console.log('【任务名称】：陌陌资料完善 (性别/网名/生日/头像上传/到达手机绑定)');
    console.log('【退出状态码】：0');
    console.log(`【完成步骤】：性别/网名/生日 -> 点击头像 -> 网速监控/代理优化 -> 云盘传图 -> 授权允许 -> 选第一张图 -> 裁切美化 -> 进入陌陌 -> 手机绑定停下`);
    if (result.proxyRecorded) {
      console.log(`【记录代理】：${result.proxyRecorded}`);
    }
    console.log(`【执行耗时】：${duration} 秒`);
  } else {
    console.log('【执行结果】：失败');
    console.log('【任务名称】：陌陌资料完善 (性别/网名/生日/头像上传/到达手机绑定)');
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
