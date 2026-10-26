'use strict';

// Script 4: open 密钥认证 on the first cloud phone, verify its keybox state,
// then return to the Android home screen. The phone is a video stream, so the
// flow uses local RapidOCR text/coordinates as anchors and the existing
// proxy-ADB control channel for HOME, swipe and tap events.
const fs = require('node:fs/promises');
const { YunmomoClient } = require('../../index');

const DEFAULT_DEVICE_ID = '2033060279606353921';
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

async function openKeyAuth(phone, control, worker, directory, state, found, options) {
  return openAppWithRecovery(phone, control, worker, directory, state, found, options, {
    appName: '密钥认证', targetName: '根证书及引导锁定状态页面', label: 'key-auth',
    targetBox: shared.appTargetBox,
    isTarget: observation => successState(observation.items).ok,
    offsets: [{ y: 0 }, { y: -55 }],
  });
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }
  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID);
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

  const phone = client.device(targetDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const directory = await shared.createOcrDirectory('yunmomo-script4-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let success = false;
  let homeRestored = false;
  try {
    await control.connect();
    const home = await confirmHome(phone, control, worker, directory, state, options);
    const found = await findApp(phone, control, worker, directory, state, home, options);
    const opened = await openKeyAuth(phone, control, worker, directory, state, found, options);
    const finalHome = await confirmHome(phone, control, worker, directory, state, options);
    const finalAnchors = homeAnchorMatches(finalHome.items);
    const finalState = successState(opened.opened.items);
    success = finalState.ok;
    homeRestored = finalAnchors.length >= 2;
    console.log(JSON.stringify({
      ok: success && homeRestored,
      script: 'environment-config',
      targetDeviceId,
      targetDeviceName: target.deviceName ?? target.name ?? 'SF',
      ocr: 'RapidOCR 1.2.3 (local WSL worker)',
      initialHomeAnchors: homeAnchorMatches(home.items),
      appLocated: true,
      appTap: opened.point,
      appTapRetried: opened.retried,
      appNavigationRecoveries: state.appNavigationRecoveries ?? [],
      certificateState: finalState.certificate,
      bootloaderState: finalState.bootloader,
      successDetected: success,
      finalHomeAnchors: finalAnchors,
      homeRestored,
      screenshotObservations: state.counter,
    }, null, 2));
  } finally {
    if (!success && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
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
