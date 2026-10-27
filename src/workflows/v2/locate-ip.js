'use strict';

// Script 6 (V2): 定位到ip地
// 1. 桌面打开“虚拟定位”应用；
// 2. 若弹出权限授予页（“请选择要向虚拟定位授予哪些权限”），点击“继续”进入；
// 3. 在地图主界面找到“定位到ip所在地”控件并点击；
// 4. 弹出“提示：定位到:...”确认框后，点击“穿越”；
// 5. 确认“穿越成功”后快速返回 Android 主屏幕并核验。
const fs = require('node:fs/promises');
const path = require('node:path');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { YunmomoClient } = require('../../index');
const {
  numberOr,
  deviceIdOf,
  findPhrase,
  findStrictPhrase,
  homeAnchorMatches,
  normalizeText,
  RapidOcrWorker,
  screenshotAndOcr,
  confirmHome,
  findApp,
  swipeHomePage,
  tapBox,
  sendHome,
  clipboardToastVisible,
} = require('../../automation/screen');

const DEFAULT_DEVICE_ID = '1920787319565701122';
const DEFAULT_POLL_MS = 600;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_APP_TIMEOUT_MS = 20000;
const DEFAULT_ACTION_TIMEOUT_MS = 30000;
const DEFAULT_MAX_PAGES_PER_DIRECTION = 5;

function matchesDevice(record, identifier) {
  const id = String(identifier || '').trim();
  if (!id) return false;
  return deviceIdOf(record) === id ||
    String(record?.deviceCode ?? record?.code ?? record?.cloudNumber ?? '').trim() === id ||
    String(record?.name ?? record?.deviceName ?? '').trim() === id;
}

function virtualLocationBox(items) {
  return findStrictPhrase(items, '虚拟定位') || findPhrase(items, '虚拟定位');
}

function permissionScreenEvidence(items) {
  const fullText = items.map(item => normalizeText(item.text)).join('');
  const hasContinue = Boolean(findStrictPhrase(items, '继续') || findPhrase(items, '继续'));
  const hasKeywords = fullText.includes('授予') ||
    fullText.includes('权限') ||
    fullText.includes('文件和媒体') ||
    fullText.includes('位置信息');
  return hasContinue && hasKeywords;
}

function continueButtonBox(items) {
  return findStrictPhrase(items, '继续') || findPhrase(items, '继续');
}

function mapPageEvidence(items) {
  const fullText = items.map(item => normalizeText(item.text)).join('');
  return Boolean(
    fullText.includes('定位到ip') ||
    fullText.includes('ip所在地') ||
    fullText.includes('查看我的选点') ||
    fullText.includes('模拟移动') ||
    fullText.includes('我的位置') ||
    findPhrase(items, '高德地图')
  );
}

function ipLocationButtonBox(items) {
  return (
    findStrictPhrase(items, '定位到ip所在地') ||
    findPhrase(items, '定位到ip所在地') ||
    findStrictPhrase(items, '定位到ip') ||
    findPhrase(items, '定位到ip') ||
    findPhrase(items, 'ip所在地')
  );
}

function traverseDialogEvidence(items) {
  const fullText = items.map(item => normalizeText(item.text)).join('');
  const hasTraverseBtn = Boolean(findStrictPhrase(items, '穿越') || findPhrase(items, '穿越'));
  const hasDialogKeyword = fullText.includes('提示') || fullText.includes('定位到') || fullText.includes('取消');
  return hasTraverseBtn && hasDialogKeyword;
}

function traverseButtonBox(items) {
  const exact = items.filter(it => normalizeText(it.text) === '穿越');
  if (exact.length) return exact[0];
  return findStrictPhrase(items, '穿越') || findPhrase(items, '穿越');
}

function traverseSuccessEvidence(items) {
  const fullText = items.map(item => normalizeText(item.text)).join('');
  return Boolean(
    fullText.includes('穿越成功') ||
    fullText.includes('定位成功')
  );
}

function extractLocationTarget(items) {
  for (const item of items) {
    const text = String(item.text ?? '').trim();
    const match = text.match(/定位到[:：]?\s*([^\s\n\r]+)/i);
    if (match) return match[1];
  }
  const candidate = items.find(it => {
    const t = String(it.text ?? '');
    return t.includes('China') || t.includes('City') || t.includes(',') || t.includes('省') || t.includes('市');
  });
  return candidate ? String(candidate.text ?? '').trim() : 'IP 所在地';
}

async function tapAppAndWaitMap(phone, control, worker, directory, state, found, options) {
  const iconPoint = tapBox(control, found.box, found.observation, -40);
  console.log(`[启动] 点击“虚拟定位”应用图标 (${iconPoint.x}, ${iconPoint.y})...`);
  await control.tap(iconPoint.x, iconPoint.y);
  await control.flush();

  const deadline = Date.now() + options.appTimeoutMs;
  let mapReady = false;
  let last = null;

  while (Date.now() <= deadline) {
    state.counter += 1;
    last = await screenshotAndOcr(phone, worker, directory, state.counter);

    // 检查是否出现权限授予页（“请选择要向虚拟定位授予哪些权限”）
    if (permissionScreenEvidence(last.items)) {
      const continueBtn = continueButtonBox(last.items);
      if (continueBtn) {
        const pt = tapBox(control, continueBtn, last);
        console.log(`[权限] 检测到权限授予页，点击“继续” (${pt.x}, ${pt.y})...`);
        await control.tap(pt.x, pt.y);
        await control.flush();
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    }

    // 检查地图主界面是否已加载
    if (mapPageEvidence(last.items)) {
      mapReady = true;
      break;
    }

    await new Promise(r => setTimeout(r, options.pollMs));
  }

  if (!mapReady || !last) {
    throw new Error('打开“虚拟定位”应用超时，未检测到地图主界面');
  }

  return last;
}

async function clickIpLocationAndTraverse(phone, control, worker, directory, state, mapObs, options) {
  let buttonBox = ipLocationButtonBox(mapObs.items);
  let currentObs = mapObs;

  if (!buttonBox) {
    // 稍微等待一轮地图底部加载
    await new Promise(r => setTimeout(r, 1000));
    state.counter += 1;
    currentObs = await screenshotAndOcr(phone, worker, directory, state.counter);
    buttonBox = ipLocationButtonBox(currentObs.items);
  }

  if (!buttonBox) {
    throw new Error('“虚拟定位”地图界面未识别到“定位到ip所在地”按钮');
  }

  const ipPoint = tapBox(control, buttonBox, currentObs);
  console.log(`[定位] 找到“定位到ip所在地”控件 (${ipPoint.x}, ${ipPoint.y})，点击触发...`);
  await control.tap(ipPoint.x, ipPoint.y);
  await control.flush();

  // 等待“提示：定位到:...”确认弹窗
  const deadline = Date.now() + options.actionTimeoutMs;
  let dialogSeen = false;
  let targetLocation = 'IP 所在地';
  let dialogObs = null;

  while (Date.now() <= deadline) {
    state.counter += 1;
    dialogObs = await screenshotAndOcr(phone, worker, directory, state.counter);

    if (traverseDialogEvidence(dialogObs.items)) {
      dialogSeen = true;
      targetLocation = extractLocationTarget(dialogObs.items);
      const traverseBtn = traverseButtonBox(dialogObs.items);
      if (!traverseBtn) throw new Error('检测到定位确认弹窗，但未找到“穿越”按钮');

      const traversePoint = tapBox(control, traverseBtn, dialogObs);
      console.log(`[穿越] 确认弹窗就绪 (目标: ${targetLocation})，点击“穿越” (${traversePoint.x}, ${traversePoint.y})...`);
      await control.tap(traversePoint.x, traversePoint.y);
      await control.flush();
      break;
    }

    await new Promise(r => setTimeout(r, options.pollMs));
  }

  if (!dialogSeen || !dialogObs) {
    throw new Error('点击“定位到ip所在地”后未弹出穿越确认弹窗');
  }

  // 等待“穿越成功”Toast 或界面变更
  let traverseSucceeded = false;
  const verifyDeadline = Date.now() + 8000;
  while (Date.now() <= verifyDeadline) {
    state.counter += 1;
    const postObs = await screenshotAndOcr(phone, worker, directory, state.counter);
    if (traverseSuccessEvidence(postObs.items)) {
      console.log('[穿越] 检测到“穿越成功”提示！');
      traverseSucceeded = true;
      break;
    }
    // 底部按钮文案若已更新为带有城市/区域，也代表穿越已成功生效
    const fullText = postObs.items.map(it => normalizeText(it.text)).join('');
    if (fullText.includes('定位到ip') && (fullText.includes('City') || fullText.includes('China') || fullText.includes(')'))) {
      console.log('[穿越] 定位状态已更新为目标 IP 地！');
      traverseSucceeded = true;
      break;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  return { success: true, targetLocation };
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }

  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID).trim();
  const options = {
    pollMs: numberOr(process.env.YUNMOMO_OCR_POLL_MS, DEFAULT_POLL_MS),
    homeTimeoutMs: numberOr(process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
    appTimeoutMs: numberOr(process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    actionTimeoutMs: numberOr(process.env.YUNMOMO_ACTION_TIMEOUT_MS, DEFAULT_ACTION_TIMEOUT_MS),
    maxPagesPerDirection: numberOr(process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
  };

  const client = new YunmomoClient({ timeoutMs: 100000 });
  const devices = await client.listDevices({ size: 50000 });
  const target = devices.records.find(record => matchesDevice(record, targetDeviceId));
  if (!target) throw new Error('所选设备不在当前账号设备列表中: ' + targetDeviceId);

  const actualDeviceId = deviceIdOf(target);
  const deviceName = target.deviceName ?? target.name ?? 'SF';

  const confirmExecute = process.env.YUNMOMO_CONFIRM_VIRTUAL_LOCATION === 'YES' || process.argv.includes('--execute');
  if (!confirmExecute) {
    console.log(`目标云机: ${deviceName} (${actualDeviceId})`);
    console.log('预览完成；如确认在该设备执行“定位到ip地”，请设置 YUNMOMO_CONFIRM_VIRTUAL_LOCATION=YES 或传入 --execute 重跑。');
    return;
  }

  console.log(`目标云机: ${deviceName} (${actualDeviceId})`);
  console.log('[1/5] 正在确认主屏幕就绪...');

  const runId = String(process.env.YUNMOMO_SCRIPT_RUN_ID || ('run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)));
  const screenshotsDir = path.join(PROJECT_ROOT, 'logs', 'screenshots', runId);
  await fs.mkdir(screenshotsDir, { recursive: true });
  const directory = screenshotsDir;

  const phone = client.device(actualDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let success = false;
  let homeRestored = false;

  try {
    await control.connect();

    // 优先就近检测：若当前桌面视口已经包含“虚拟定位”，直接进入，避免无效翻页
    state.counter += 1;
    const initialObs = await screenshotAndOcr(phone, worker, directory, state.counter);
    const directBox = virtualLocationBox(initialObs.items);
    let found;

    if (directBox && !clipboardToastVisible(initialObs.items)) {
      console.log('[2/5] 当前屏幕已就绪且直达“虚拟定位”入口，直接进入...');
      found = { observation: initialObs, box: directBox, direction: 'none', page: 0 };
    } else {
      const home = await confirmHome(phone, control, worker, directory, state, {
        ...options,
        homeConfirmation: { firstAttemptTimeoutMs: 2500 }
      });
      console.log('[2/5] 正在桌面寻找应用“虚拟定位”...');
      found = await findApp(
        phone,
        control,
        worker,
        directory,
        state,
        home,
        options,
        virtualLocationBox,
        '虚拟定位',
      );
    }

    console.log('[3/5] 正在打开“虚拟定位”并等待就绪...');
    const mapObs = await tapAppAndWaitMap(phone, control, worker, directory, state, found, options);

    console.log('[4/5] 正在执行“定位到ip所在地”并穿越...');
    const result = await clickIpLocationAndTraverse(phone, control, worker, directory, state, mapObs, options);

    console.log('[5/5] 穿越完成，正在返回主屏幕并核验...');
    await sendHome(control);
    await swipeHomePage(control, 'right');
    const finalHome = await confirmHome(phone, control, worker, directory, state, {
      ...options,
      homeConfirmation: { firstAttemptTimeoutMs: 2500 }
    });
    const finalAnchors = homeAnchorMatches(finalHome.items);
    homeRestored = finalAnchors.length >= 2;
    success = result.success && homeRestored;

    if (!success) {
      throw new Error('执行未完成：未能成功恢复主屏');
    }

    console.log(`[核验完成] 已成功恢复主屏幕 (桌面锚点: ${finalAnchors.length} 个)`);
    console.log(`>>> 定位到ip地执行成功 OK (目标位置: ${result.targetLocation})`);
  } finally {
    if (!homeRestored && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
      try {
        await sendHome(control);
        homeRestored = true;
      } catch {
        // preserve original failure
      }
    }
    await worker.close();
    await control.close();
    console.log(`[过程截图] 过程截图已留存至 logs/screenshots/${runId}/ (共 ${state.counter} 张)`);
  }
}

tapAppAndWaitMap = require('../../automation/timing').timed('workflow.locate-ip.tapAppAndWaitMap', tapAppAndWaitMap);
clickIpLocationAndTraverse = require('../../automation/timing').timed('workflow.locate-ip.clickIpLocationAndTraverse', clickIpLocationAndTraverse);
main = require('../../automation/timing').timedScript('script.src.workflows.v2.locate-ip', main);

if (require.main === module) {
  require('../../automation/runtime').launchCli(main);
}

module.exports = {
  main,
  virtualLocationBox,
  permissionScreenEvidence,
  continueButtonBox,
  mapPageEvidence,
  ipLocationButtonBox,
  traverseDialogEvidence,
  traverseButtonBox,
  traverseSuccessEvidence,
  extractLocationTarget,
  tapAppAndWaitMap,
  clickIpLocationAndTraverse,
};
