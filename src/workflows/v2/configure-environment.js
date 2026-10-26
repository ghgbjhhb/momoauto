'use strict';

// Script 4: open 密钥认证 on the first cloud phone, verify its keybox state,
// then return to the Android home screen. The phone is a video stream, so the
// flow uses local RapidOCR text/coordinates as anchors and the existing
// proxy-ADB control channel for HOME, swipe and tap events.
const fs = require('node:fs/promises');
const path = require('node:path');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { YunmomoClient } = require('../../index');

const DEFAULT_POLL_MS = 700;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_APP_TIMEOUT_MS = 20000;
const DEFAULT_MAX_PAGES_PER_DIRECTION = 5;

const shared = require('../../automation/screen');
const { openAppWithRecovery } = require('../../automation/app-navigation');
const { numberOr, deviceIdOf, findPhrase, RapidOcrWorker, confirmHome, findApp, sendHome, homeAnchorMatches } = shared;

function successState(items) {
  const certificate = Boolean(
    findPhrase(items, '谷歌硬件根证书') ||
    (findPhrase(items, '谷歌') && findPhrase(items, '硬件') && findPhrase(items, '根证书')) ||
    (findPhrase(items, '硬件') && findPhrase(items, '根证书'))
  );
  const bootloader = Boolean(
    findPhrase(items, '引导加载程序已锁定') ||
    (findPhrase(items, '引导') && findPhrase(items, '锁定'))
  );
  return { certificate, bootloader, ok: certificate && bootloader };
}

function failureState(items) {
  const softwareCert = Boolean(
    findPhrase(items, '谷歌软件根证书') ||
    (findPhrase(items, '软件') && findPhrase(items, '根证书'))
  );
  const bootloaderUnlocked = Boolean(
    findPhrase(items, '引导加载程序已解锁') ||
    findPhrase(items, '引导加载程序未锁定') ||
    (findPhrase(items, '引导') && (findPhrase(items, '解锁') || findPhrase(items, '未锁定')))
  );
  return { softwareCert, bootloaderUnlocked, failed: softwareCert || bootloaderUnlocked };
}

function keyAuthLoading(items) {
  return Boolean(
    findPhrase(items, '获取吊销列表中') ||
    findPhrase(items, '正在获取吊销列表') ||
    findPhrase(items, '正在获取')
  );
}

function isDesktopScreen(items) {
  if (homeAnchorMatches(items).length >= 1) return true;
  if (findPhrase(items, '密钥认证') || shared.appTargetBox(items)) return true;

  const DESKTOP_MARKERS = [
    '扩展服务', '设备助手', '通讯录', '相机', '图库', '文管理', '文件管理',
    '搜狗输入法', 'QQ音乐', '电话', '铁路12306', '微信', '美团外卖',
    '科音', '伍羊工具箱', 'MOMO陌陌', '高德地图', '支付宝', '抖音',
    '设置', '信息', '短信'
  ];
  const matched = DESKTOP_MARKERS.filter(name => Boolean(findPhrase(items, name)));
  if (matched.length >= 2) return true;

  const hasDate = Boolean(findPhrase(items, '星期') || (findPhrase(items, '月') && findPhrase(items, '日')));
  const hasTime = items.some(item => /^\d{1,2}:\d{2}$/.test(item.text.trim()));
  if (hasDate && hasTime) return true;

  return false;
}

async function ensureHomeScreen(phone, control, worker, directory, state, options) {
  const pollMs = numberOr(options.pollMs, DEFAULT_POLL_MS);

  // 1. 快速检查当前画面：如果已经在桌面，直接就绪（动态适配任意桌面分页）
  state.counter += 1;
  let current = await shared.screenshotAndOcr(phone, worker, directory, state.counter);
  if (isDesktopScreen(current.items)) {
    return current;
  }

  // 2. 如果不在桌面（处于其他应用或设置内），下发 HOME 键回主屏
  console.log('      当前不在桌面，按 HOME 键返回主屏...');
  await sendHome(control);
  await shared.sleep(400);

  // 3. 等待桌面就绪（最多等 4 秒）
  current = await shared.observeUntil(
    phone,
    worker,
    directory,
    state,
    obs => isDesktopScreen(obs.items),
    4000,
    pollMs,
    'ensure-home'
  );

  if (!isDesktopScreen(current.items)) {
    await sendHome(control);
    await shared.sleep(500);
    state.counter += 1;
    current = await shared.screenshotAndOcr(phone, worker, directory, state.counter);
  }

  return current;
}

function keyAuthEvidence(items) {
  const homeLike = homeAnchorMatches(items).length >= 2;
  if (homeLike) return false;
  return Boolean(
    keyAuthLoading(items) ||
    successState(items).ok ||
    failureState(items).failed ||
    findPhrase(items, '密钥认证') ||
    findPhrase(items, '使用软件自带的吊销列表') ||
    findPhrase(items, '硬件根证书') ||
    findPhrase(items, '引导加载程序')
  );
}

async function openKeyAuth(phone, control, worker, directory, state, found, options) {
  return openAppWithRecovery(phone, control, worker, directory, state, found, options, {
    appName: '密钥认证',
    targetName: '根证书及引导锁定状态页面',
    label: 'key-auth',
    targetBox: shared.appTargetBox,
    isTarget: observation => successState(observation.items).ok || failureState(observation.items).failed,
    launchEvidence: observation => keyAuthEvidence(observation.items),
    offsets: [{ y: -35 }, { y: -50 }, { y: 0 }],
    prepare: async observation => {
      const isTarget = successState(observation.items).ok || failureState(observation.items).failed;
      const isLauncher = homeAnchorMatches(observation.items).length >= 2;
      // 只要已进入“密钥认证”且既未完成判定也未退回桌面，就持续等待核验结果出炉，严禁过早下发 BACK 键关闭应用
      if (!isTarget && !isLauncher) {
        return await shared.observeUntil(
          phone,
          worker,
          directory,
          state,
          obs => successState(obs.items).ok || failureState(obs.items).failed || homeAnchorMatches(obs.items).length >= 2,
          options.appTimeoutMs,
          options.pollMs,
          'key-auth-wait-attestation'
        );
      }
      return observation;
    },
  });
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }
  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(targetDeviceId)) {
    throw new Error('请用 YUNMOMO_DEVICE_ID 指定目标云机');
  }
  if (process.env.YUNMOMO_CONFIRM_ENV_CONFIG !== 'YES' && !process.argv.includes('--execute')) {
    throw new Error('脚本4会发送 HOME、滑动和点击事件；确认执行请设置 YUNMOMO_CONFIRM_ENV_CONFIG=YES 或传入 --execute');
  }

  const options = {
    pollMs: numberOr(process.env.YUNMOMO_OCR_POLL_MS, DEFAULT_POLL_MS),
    homeTimeoutMs: numberOr(process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
    appTimeoutMs: numberOr(process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    maxPagesPerDirection: numberOr(process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
  };
  const client = new YunmomoClient({ timeoutMs: 100000 });
  const devices = await client.listDevices({ size: 50000 });
  const target = devices.records.find(record => deviceIdOf(record) === targetDeviceId);
  if (!target) throw new Error('所选设备不在当前账号设备列表中: ' + targetDeviceId);

  const targetName = target.deviceName ?? target.name ?? 'SF';
  console.log(`[准备] 目标设备: ${targetName} (${targetDeviceId}) | 流程: 环境配置v2`);

  const phone = client.device(targetDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const directory = await shared.createOcrDirectory('yunmomo-script4-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let success = false;
  let homeRestored = false;
  let opened = null;
  let initialAnchors = [];
  let finalAnchors = [];
  let finalState = { certificate: false, bootloader: false, ok: false };
  let executionError = null;

  try {
    await control.connect();

    console.log('[1/4] 正在检查并确认主屏幕...');
    const home = await ensureHomeScreen(phone, control, worker, directory, state, options);
    initialAnchors = homeAnchorMatches(home.items);
    console.log(`      主屏幕已就绪（${initialAnchors.length >= 1 ? `锚点: ${initialAnchors.join('、')}` : '已识别到桌面'}）`);

    console.log('[2/4] 正在主屏定位并启动“密钥认证”...');
    const found = await findApp(phone, control, worker, directory, state, home, {
      ...options,
      homeTimeoutMs: 4000,
    });
    opened = await openKeyAuth(phone, control, worker, directory, state, found, options);
    console.log(`      已打开密钥认证页面（点击坐标: ${opened.point.x}, ${opened.point.y}）`);

    finalState = successState(opened.opened.items);
    console.log('[3/4] 正在核验密钥与证书状态...');
    console.log(`      根证书: ${finalState.certificate ? '谷歌硬件根证书 (有效)' : '未检测到硬件根证书 (异常)'}`);
    console.log(`      引导程序: ${finalState.bootloader ? '已锁定 (正常)' : '未锁定 (异常)'}`);

    console.log('[4/4] 退出密钥认证，恢复主屏幕...');
    await sendHome(control);
    await shared.sleep(400);
    const finalHome = await shared.observeUntil(
      phone,
      worker,
      directory,
      state,
      obs => isDesktopScreen(obs.items),
      4000,
      options.pollMs,
      'restore-home'
    );
    finalAnchors = homeAnchorMatches(finalHome.items);
    homeRestored = isDesktopScreen(finalHome.items);
    success = finalState.ok;
    console.log(`      主屏幕恢复${homeRestored ? '完成' : '失败'}`);

    if (!success) {
      const reasons = [];
      if (!finalState.certificate) reasons.push('未检测到谷歌硬件根证书');
      if (!finalState.bootloader) reasons.push('引导加载程序未锁定');
      throw new Error(`环境配置核验失败：${reasons.join('，') || '根证书或引导锁状态异常'}`);
    }
    if (!homeRestored) {
      throw new Error('未能成功恢复桌面状态，主屏锚点不足');
    }

    console.log('[完成] 环境配置核验通过！');
  } catch (err) {
    executionError = err;
    throw err;
  } finally {
    try {
      const outputDir = path.join(PROJECT_ROOT, '.local-output', '环境配置');
      await fs.mkdir(outputDir, { recursive: true });
      const detailedReport = {
        ok: success && homeRestored,
        timestamp: new Date().toISOString(),
        script: 'environment-config-v2',
        targetDeviceId,
        targetDeviceName: targetName,
        ocr: 'RapidOCR 1.2.3 (local WSL worker)',
        initialHomeAnchors: initialAnchors,
        appLocated: Boolean(opened),
        appTap: opened?.point ?? null,
        appTapRetried: opened?.retried ?? false,
        appNavigationRecoveries: state.appNavigationRecoveries ?? [],
        certificateState: finalState.certificate,
        bootloaderState: finalState.bootloader,
        successDetected: success,
        finalHomeAnchors: finalAnchors,
        homeRestored,
        screenshotObservations: state.counter,
        error: executionError ? { message: executionError.message, stack: executionError.stack } : null,
      };
      const reportFile = path.join(outputDir, `env-config-${targetDeviceId}-${Date.now()}.json`);
      const latestFile = path.join(outputDir, 'latest.json');
      const content = JSON.stringify(detailedReport, null, 2);
      await fs.writeFile(reportFile, content, 'utf8');
      await fs.writeFile(latestFile, content, 'utf8');
      console.log('      诊断数据已存入: .local-output/环境配置/latest.json');
    } catch {}

    if (!homeRestored && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
      try {
        await sendHome(control);
        homeRestored = true;
      } catch {
        // Preserve the original failure; cleanup below still runs.
      }
    }
    await worker.close();
    await control.close();
    if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
      await fs.rm(directory, { recursive: true, force: true });
    } else {
      console.log('OCR screenshots kept at ' + directory);
    }
  }
}

openKeyAuth = require('../../automation/timing').timed('workflow.configure-environment.openKeyAuth', openKeyAuth);
main = require('../../automation/timing').timedScript('script.src.workflows.v2.configure-environment', main);

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

// Preserve the old helper exports for compatibility; new callers import automation/screen.
module.exports = { ...shared, main };
