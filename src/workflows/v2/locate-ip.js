'use strict';

// Script 6 (V2): 定位到ip地 / 自定义地点穿越
// 支持两种模式：
// 模式 1 (ip): 打开“虚拟定位”，点击“定位到ip所在地”，确认弹窗后点击“穿越”；
// 模式 2 (search): 打开“虚拟定位”，点击顶部搜索框，输入指定目标地点并检索，点击搜索结果列表项，
//                在地图中心选点气泡弹出后点击确认唤起穿越弹窗，点击“穿越”。
// 完成穿越后核验“穿越成功”并安全返回 Android 主屏幕第一页。
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

function mapSearchBarBox(items, observation) {
  const direct = items.find(it => {
    const t = normalizeText(it.text);
    return (t === '搜索' || t === '搜素') && it.top < (observation.height || 600) * 0.25;
  });
  if (direct) return direct;
  const partial = items.find(it => {
    const t = normalizeText(it.text);
    return (t.includes('搜索') || t.includes('搜素')) && it.top < (observation.height || 600) * 0.25;
  });
  if (partial) return partial;
  return {
    left: Math.round((observation.width || 360) * 0.15),
    top: Math.round((observation.height || 600) * 0.08),
    right: Math.round((observation.width || 360) * 0.85),
    bottom: Math.round((observation.height || 600) * 0.14),
  };
}

function searchPageEvidence(items) {
  const fullText = items.map(item => normalizeText(item.text)).join('');
  return Boolean(
    fullText.includes('详细地址查询') ||
    fullText.includes('输入搜索内容') ||
    fullText.includes('经纬度查询')
  );
}

function searchInputBox(items, observation) {
  const direct = items.find(it => {
    const t = normalizeText(it.text);
    return (t.includes('输入搜索内容') || t.includes('输入搜索') || t.includes('搜索内容')) &&
      it.top < (observation.height || 600) * 0.3;
  });
  if (direct) return direct;
  return {
    left: Math.round((observation.width || 360) * 0.1),
    top: Math.round((observation.height || 600) * 0.12),
    right: Math.round((observation.width || 360) * 0.75),
    bottom: Math.round((observation.height || 600) * 0.18),
  };
}

function searchSubmitButtonBox(items, observation) {
  const direct = items.find(it => {
    const t = normalizeText(it.text);
    return (t === '搜索' || t === '搜素') &&
      it.top < (observation.height || 600) * 0.25 &&
      it.left > (observation.width || 360) * 0.65;
  });
  if (direct) return direct;
  return {
    left: Math.round((observation.width || 360) * 0.8),
    top: Math.round((observation.height || 600) * 0.12),
    right: Math.round((observation.width || 360) * 0.98),
    bottom: Math.round((observation.height || 600) * 0.18),
  };
}

function findSearchResultItem(items, observation, targetAddress) {
  const normTarget = normalizeText(targetAddress);
  const bottomItems = items.filter(it => it.top > (observation.height || 600) * 0.55);
  // 1. 优先匹配包含目标搜索关键词的项
  for (const it of bottomItems) {
    const t = normalizeText(it.text);
    if (t.includes('查看全部') || t.includes('查右全部') || t.includes('条结果') || t.includes('高德地图')) continue;
    if (normTarget.includes(t) || t.includes(normTarget.slice(0, 4))) {
      return it;
    }
  }
  // 2. 若未完整匹配关键词，选取结果卡片第一项有效文字
  for (const it of bottomItems) {
    const t = normalizeText(it.text);
    if (t.includes('查看全部') || t.includes('查右全部') || t.includes('条结果') || t.includes('高德地图')) continue;
    if (it.top < (observation.height || 600) * 0.88) {
      return it;
    }
  }
  return null;
}

function findCenterLocationBubble(items, observation, targetAddress) {
  const normTarget = normalizeText(targetAddress);
  const midYMin = (observation.height || 600) * 0.35;
  const midYMax = (observation.height || 600) * 0.65;
  const midItems = items.filter(it => it.top >= midYMin && it.bottom <= midYMax);
  const matching = midItems.filter(it => {
    const t = normalizeText(it.text);
    return normTarget.includes(t) || t.includes(normTarget.slice(0, 4));
  });
  if (matching.length) {
    matching.sort((a, b) => b.text.length - a.text.length);
    return matching[0];
  }
  // 屏幕中心位置兜底
  return {
    left: Math.round((observation.width || 360) * 0.35),
    top: Math.round((observation.height || 600) * 0.46),
    right: Math.round((observation.width || 360) * 0.65),
    bottom: Math.round((observation.height || 600) * 0.52),
  };
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
  const hasTraverseBtn = Boolean(
    items.some(it => normalizeText(it.text) === '穿越') ||
    findStrictPhrase(items, '选点') ||
    findPhrase(items, '选点') ||
    fullText.includes('仅gps穿越') ||
    fullText.includes('取消')
  );
  const hasDialogKeyword = fullText.includes('提示') || fullText.includes('定位到') || fullText.includes('仅gps');
  return hasTraverseBtn && hasDialogKeyword;
}

function traverseButtonBox(items, observation) {
  // 1. 精确匹配“穿越”（排除“仅Gps穿越”选项）
  const exact = items.filter(it => {
    const t = normalizeText(it.text);
    return t === '穿越' && !t.includes('gps') && !t.includes('仅');
  });
  if (exact.length) return exact[0];

  // 2. 严格短语匹配“穿越”
  const candidate = items.find(it => {
    const t = normalizeText(it.text);
    return t.includes('穿越') && !t.includes('gps') && !t.includes('仅');
  });
  if (candidate) return candidate;

  // 3. 对称推导：若检测到左侧按钮“选点”或“取消”，右侧“穿越”按钮处于水平镜像对称位置
  const leftBtn = items.find(it => {
    const t = normalizeText(it.text);
    return (t === '选点' || t === '取消');
  }) || findStrictPhrase(items, '选点') || findStrictPhrase(items, '取消');

  if (leftBtn && observation) {
    const width = observation.width || 360;
    const leftCx = (leftBtn.left + leftBtn.right) / 2;
    const btnW = leftBtn.right - leftBtn.left;
    const rightCx = width - leftCx;
    return {
      left: Math.round(rightCx - btnW / 2),
      top: leftBtn.top,
      right: Math.round(rightCx + btnW / 2),
      bottom: leftBtn.bottom,
    };
  }

  // 4. 对话框标题推导位置
  const titleBox = items.find(it => normalizeText(it.text) === '提示');
  if (titleBox && observation) {
    const width = observation.width || 360;
    return {
      left: Math.round(width * 0.65),
      top: titleBox.top + 120,
      right: Math.round(width * 0.85),
      bottom: titleBox.top + 155,
    };
  }

  return null;
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
    return t.includes('China') || t.includes('City') || t.includes(',') || t.includes('省') || t.includes('市') || t.includes('店');
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

// 模式 1：定位到ip所在地
async function clickIpLocationAndTraverse(phone, control, worker, directory, state, mapObs, options) {
  let buttonBox = ipLocationButtonBox(mapObs.items);
  let currentObs = mapObs;

  if (!buttonBox) {
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
      const traverseBtn = traverseButtonBox(dialogObs.items, dialogObs);
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
    const fullText = postObs.items.map(it => normalizeText(it.text)).join('');
    if (fullText.includes('定位到ip') && (fullText.includes('City') || fullText.includes('China') || fullText.includes(')'))) {
      console.log('[穿越] 定位状态已更新为目标 IP 地！');
      traverseSucceeded = true;
      break;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  return { success: true, targetLocation, mode: 'ip' };
}

// 模式 2：自定义搜索地点穿越
async function searchAddressAndTraverse(phone, control, worker, directory, state, mapObs, address, options) {
  if (!address || typeof address !== 'string' || !address.trim()) {
    throw new Error('搜索模式下必须提供目标地址（address）');
  }
  const targetAddress = address.trim();

  // 1. 在地图页点击顶部搜索栏
  const searchBar = mapSearchBarBox(mapObs.items, mapObs);
  const barPoint = tapBox(control, searchBar, mapObs);
  console.log(`[搜索] 点击地图顶部搜索栏 (${barPoint.x}, ${barPoint.y})...`);
  await control.tap(barPoint.x, barPoint.y);
  await control.flush();

  // 2. 等待进入“详细地址查询”搜索页
  const searchPageDeadline = Date.now() + options.actionTimeoutMs;
  let searchObs = null;
  while (Date.now() <= searchPageDeadline) {
    state.counter += 1;
    searchObs = await screenshotAndOcr(phone, worker, directory, state.counter);
    if (searchPageEvidence(searchObs.items)) {
      break;
    }
    await new Promise(r => setTimeout(r, options.pollMs));
  }
  if (!searchObs || !searchPageEvidence(searchObs.items)) {
    throw new Error('未能进入“详细地址查询”搜索界面');
  }

  // 3. 点击输入框并输入目标地址
  const inputBox = searchInputBox(searchObs.items, searchObs);
  const inputPoint = tapBox(control, inputBox, searchObs);
  console.log(`[搜索] 点击输入框 (${inputPoint.x}, ${inputPoint.y}) 并填入地址: ${targetAddress}...`);
  await control.tap(inputPoint.x, inputPoint.y);
  await control.flush();
  await new Promise(r => setTimeout(r, 600));

  await control.paste(targetAddress);
  await control.flush();
  await new Promise(r => setTimeout(r, 600));

  // 4. 点击右上角“搜索”按钮触发查询
  state.counter += 1;
  const inputDoneObs = await screenshotAndOcr(phone, worker, directory, state.counter);
  const submitBox = searchSubmitButtonBox(inputDoneObs.items, inputDoneObs);
  const submitPoint = tapBox(control, submitBox, inputDoneObs);
  console.log(`[搜索] 点击“搜索”按钮 (${submitPoint.x}, ${submitPoint.y}) 执行检索...`);
  await control.tap(submitPoint.x, submitPoint.y);
  await control.flush();

  // 5. 等待搜索结果列表并点击目标地点
  const resultsDeadline = Date.now() + options.actionTimeoutMs;
  let resultsObs = null;
  let chosenItem = null;
  while (Date.now() <= resultsDeadline) {
    state.counter += 1;
    resultsObs = await screenshotAndOcr(phone, worker, directory, state.counter);
    chosenItem = findSearchResultItem(resultsObs.items, resultsObs, targetAddress);
    if (chosenItem) {
      break;
    }
    await new Promise(r => setTimeout(r, options.pollMs));
  }
  if (!chosenItem || !resultsObs) {
    throw new Error(`未在搜索结果中找到目标地点“${targetAddress}”`);
  }

  const resultPoint = tapBox(control, chosenItem, resultsObs);
  console.log(`[选点] 找到搜索结果项“${chosenItem.text}” (${resultPoint.x}, ${resultPoint.y})，点击选择地点...`);
  await control.tap(resultPoint.x, resultPoint.y);
  await control.flush();

  // 6. 等待地图恢复并居中显示该地点气泡，点击中心位置气泡唤起穿越弹窗
  const bubbleDeadline = Date.now() + options.actionTimeoutMs;
  let mapCenteredObs = null;
  let bubbleClicked = false;
  while (Date.now() <= bubbleDeadline) {
    state.counter += 1;
    mapCenteredObs = await screenshotAndOcr(phone, worker, directory, state.counter);

    // 检查是否已直接弹出了穿越确认框（某些版本点击结果直接弹框）
    if (traverseDialogEvidence(mapCenteredObs.items)) {
      bubbleClicked = true;
      break;
    }

    // 地图主界面已加载且搜索列表已消失
    if (mapPageEvidence(mapCenteredObs.items) && !searchPageEvidence(mapCenteredObs.items)) {
      const bubble = findCenterLocationBubble(mapCenteredObs.items, mapCenteredObs, targetAddress);
      const bubblePoint = tapBox(control, bubble, mapCenteredObs);
      console.log(`[选点] 地图已定位，点击屏幕中心气泡 (${bubblePoint.x}, ${bubblePoint.y}) 唤起确认...`);
      await control.tap(bubblePoint.x, bubblePoint.y);
      await control.flush();
      bubbleClicked = true;
      break;
    }
    await new Promise(r => setTimeout(r, options.pollMs));
  }

  if (!bubbleClicked) {
    throw new Error('选择搜索结果后未检测到地图中心定位气泡');
  }

  // 7. 等待“提示”确认弹窗并点击“穿越”
  const dialogDeadline = Date.now() + options.actionTimeoutMs;
  let dialogSeen = false;
  let dialogObs = null;
  let targetLocation = targetAddress;

  while (Date.now() <= dialogDeadline) {
    state.counter += 1;
    dialogObs = await screenshotAndOcr(phone, worker, directory, state.counter);

    if (traverseDialogEvidence(dialogObs.items)) {
      dialogSeen = true;
      const extracted = extractLocationTarget(dialogObs.items);
      if (extracted && extracted !== 'IP 所在地') targetLocation = extracted;

      const traverseBtn = traverseButtonBox(dialogObs.items, dialogObs);
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
    throw new Error('点击中心气泡后未弹出穿越确认弹窗');
  }

  // 8. 等待“穿越成功”Toast 或界面变更
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
    if (!traverseDialogEvidence(postObs.items) && mapPageEvidence(postObs.items)) {
      console.log('[穿越] 穿越弹窗已关闭，穿越成功！');
      traverseSucceeded = true;
      break;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  return { success: true, targetLocation, mode: 'search' };
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

  const rawMode = String(process.env.YUNMOMO_LOCATION_MODE || '').trim().toLowerCase();
  const rawAddress = String(process.env.YUNMOMO_LOCATION_ADDRESS || '').trim();

  // 支持 CLI 传参 --mode <ip|search> 以及 --address <地点>
  const cliModeIdx = process.argv.indexOf('--mode');
  const cliMode = cliModeIdx !== -1 && process.argv[cliModeIdx + 1] ? process.argv[cliModeIdx + 1].trim().toLowerCase() : '';
  const cliAddrIdx = process.argv.indexOf('--address');
  const cliAddr = cliAddrIdx !== -1 && process.argv[cliAddrIdx + 1] ? process.argv[cliAddrIdx + 1].trim() : '';

  const address = cliAddr || rawAddress;
  const mode = cliMode || (address && rawMode !== 'ip' ? 'search' : (rawMode || 'ip'));

  if (mode === 'search' && !address) {
    throw new Error('搜索模式下必须提供目标搜索地址（通过 YUNMOMO_LOCATION_ADDRESS 或 --address）');
  }

  const client = new YunmomoClient({ timeoutMs: 100000 });
  const devices = await client.listDevices({ size: 50000 });
  const target = devices.records.find(record => matchesDevice(record, targetDeviceId));
  if (!target) throw new Error('所选设备不在当前账号设备列表中: ' + targetDeviceId);

  const actualDeviceId = deviceIdOf(target);
  const deviceName = target.deviceName ?? target.name ?? 'SF';

  const confirmExecute = process.env.YUNMOMO_CONFIRM_VIRTUAL_LOCATION === 'YES' || process.argv.includes('--execute');
  if (!confirmExecute) {
    console.log(`目标云机: ${deviceName} (${actualDeviceId})`);
    console.log(`运行模式: ${mode} ${mode === 'search' ? `(目标地址: ${address})` : ''}`);
    console.log('预览完成；如确认在该设备执行定位穿越，请设置 YUNMOMO_CONFIRM_VIRTUAL_LOCATION=YES 或传入 --execute 重跑。');
    return;
  }

  console.log(`目标云机: ${deviceName} (${actualDeviceId})`);
  console.log(`运行模式: ${mode === 'search' ? `搜索地点穿越 (目标: ${address})` : '定位到IP所在地'}`);
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

    let result;
    if (mode === 'search') {
      console.log(`[4/5] 正在执行“搜索地点并穿越” (目标地址: ${address})...`);
      result = await searchAddressAndTraverse(phone, control, worker, directory, state, mapObs, address, options);
    } else {
      console.log('[4/5] 正在执行“定位到ip所在地”并穿越...');
      result = await clickIpLocationAndTraverse(phone, control, worker, directory, state, mapObs, options);
    }

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
    console.log(`>>> 定位到ip地执行成功 OK (模式: ${mode}, 目标位置: ${result.targetLocation})`);
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
searchAddressAndTraverse = require('../../automation/timing').timed('workflow.locate-ip.searchAddressAndTraverse', searchAddressAndTraverse);
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
  mapSearchBarBox,
  searchPageEvidence,
  searchInputBox,
  searchSubmitButtonBox,
  findSearchResultItem,
  findCenterLocationBubble,
  ipLocationButtonBox,
  traverseDialogEvidence,
  traverseButtonBox,
  traverseSuccessEvidence,
  extractLocationTarget,
  tapAppAndWaitMap,
  clickIpLocationAndTraverse,
  searchAddressAndTraverse,
};
