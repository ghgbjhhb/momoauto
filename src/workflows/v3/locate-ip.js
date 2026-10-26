'use strict';

// Script 6: 定位到ip地。打开扩展服务，使用高德定位到 IP 所在地，
// 定位成功后先点击右上角图标，等地图切到定位点，再在附近随机选点，
// 重新识别水滴标记的新位置并点击，确认“穿越到标记位置”后返回 Android 桌面。
//
// The phone is exposed as a video stream, so all text controls are located
// with local RapidOCR. The map icon has no text label; its position is kept
// as a screen-relative point and can be calibrated with environment variables.
const fs = require('node:fs/promises');
const { YunmomoClient } = require('../../index');
const { openAppWithRecovery } = require('../../automation/app-navigation');
const {
  numberOr,
  sleep,
  deviceIdOf,
  findPhrase,
  findStrictPhrase,
  homeAnchorMatches,
  normalizeText,
  RapidOcrWorker,
  screenshotAndOcr,
  observeUntil,
  confirmHome,
  findApp,
  tapBox,
  sendHome,
} = require('../../automation/screen');

const TARGET_DEVICE_ID = '2033060279606353921';
const DEFAULT_POLL_MS = 700;
const DEFAULT_HOME_TIMEOUT_MS = 15000;
const DEFAULT_HOME_SETTLE_MS = 3500;
const DEFAULT_APP_TIMEOUT_MS = 20000;
const DEFAULT_ENTRY_ATTEMPT_TIMEOUT_MS = 8000;
const DEFAULT_AMAP_ENTRY_WAIT_MS = 3000;
const DEFAULT_LOCATION_TIMEOUT_MS = 90000;
const DEFAULT_LOCATION_MIN_WAIT_MS = 2500;
const DEFAULT_LOCATION_STABLE_OBSERVATIONS = 3;
const DEFAULT_AFTER_ICON_WAIT_MS = 800;
const DEFAULT_MAX_PAGES_PER_DIRECTION = 5;
const DEFAULT_LOCATION_ICON_X_RATIO = 0.92;
const DEFAULT_LOCATION_ICON_Y_RATIO = 0.18;
const DEFAULT_MAP_CENTER_X_RATIO = 0.50;
const DEFAULT_MAP_CENTER_Y_RATIO = 0.52;
const DEFAULT_RANDOM_RADIUS_X_RATIO = 0.14;
const DEFAULT_RANDOM_RADIUS_Y_RATIO = 0.10;
const RANDOM_LOCATION_MARKER_SETTLE_MS = 500;
const SCREENSHOT_LEVEL = 2;

function extensionServicesBox(items) {
  return findStrictPhrase(items, '扩展服务') || findPhrase(items, '扩展服务');
}

function extensionServicesReady(items) {
  return Boolean(
    findStrictPhrase(items, '扩展服务设置') ||
    (findStrictPhrase(items, '虚拟定位') && findStrictPhrase(items, '应用超权权限设置'))
  );
}

function extensionServicesChildPage(items) {
  return Boolean(
    findStrictPhrase(items, 'SockS5网络代理') ||
    findPhrase(items, '主机IP') ||
    findPhrase(items, '主机端口')
  );
}

function virtualLocationTitleBox(items) {
  return findStrictPhrase(items, '虚拟定位') || findPhrase(items, '虚拟定位');
}

function amapTabBox(items) {
  const candidates = items
    .filter(item => {
      const text = normalizeText(item.text);
      return text === '高德' || text.startsWith('高德');
    })
    .sort((left, right) => left.top - right.top || left.left - right.left);
  return candidates[0] || findStrictPhrase(items, '高德');
}

function ipLocationButtonBox(items) {
  const direct = (
    findStrictPhrase(items, '定位到ip所在地') ||
    findStrictPhrase(items, '定位到IP所在地') ||
    findStrictPhrase(items, '定位到Ip所在地') ||
    findStrictPhrase(items, '定值到ip所在地') ||
    findStrictPhrase(items, '定值到IP所在地')
  );
  if (direct) return direct;
  const fuzzy = items.find(item => normalizeText(item.text).toLowerCase().includes('ip所在地'));
  return fuzzy ? {
    left: fuzzy.left,
    top: fuzzy.top,
    right: fuzzy.right,
    bottom: fuzzy.bottom,
  } : null;
}

function mapEvidence(items) {
  return Boolean(
    findStrictPhrase(items, '高德地图') ||
    findPhrase(items, '地图') ||
    findPhrase(items, '北京市') ||
    findPhrase(items, '北京')
  );
}

function mapPageReady(items) {
  return Boolean(
    virtualLocationTitleBox(items) &&
    amapTabBox(items) &&
    ipLocationButtonBox(items)
  );
}

function locationLoading(items) {
  return Boolean(
    findStrictPhrase(items, '请稍候') ||
    findStrictPhrase(items, '请稍后') ||
    findStrictPhrase(items, '正在定位') ||
    findStrictPhrase(items, '定位中') ||
    findStrictPhrase(items, '加载中')
  );
}

async function settleHome(phone, control, worker, directory, state, options) {
  await sendHome(control);
  await sleep(options.homeSettleMs);
  return confirmHome(phone, control, worker, directory, state, options);
}

async function tapExtensionServicesAndWaitReady(
  phone,
  control,
  worker,
  directory,
  state,
  found,
  options,
) {
  return openAppWithRecovery(phone, control, worker, directory, state, found, options, {
    appName: '扩展服务', targetName: '扩展服务设置根页面', label: 'extension-services', targetBox: extensionServicesBox,
    isTarget: observation => extensionServicesReady(observation.items),
    launchEvidence: observation => extensionServicesChildPage(observation.items) || Boolean(virtualLocationTitleBox(observation.items)),
    blockedReason: observation => locationLoading(observation.items) ? '定位仍在加载，停止入口恢复，等待完成后再试' : null,
    launchTimeoutMs: Math.min(options.appTimeoutMs, options.entryAttemptTimeoutMs),
    offsets: [{ y: -50 }, { y: -50, xRatio: -0.025 }, { y: -50, xRatio: 0.025 }, { y: 0 }, { y: -70 }],
  });
}

async function openVirtualLocation(phone, control, worker, directory, state, opened, options) {
  let pageState = opened;
  let box = findStrictPhrase(pageState.items, '虚拟定位') || findPhrase(pageState.items, '虚拟定位');
  if (!box) {
    pageState = await observeUntil(
      phone,
      worker,
      directory,
      state,
      observation => Boolean(
        extensionServicesReady(observation.items) &&
        (findStrictPhrase(observation.items, '虚拟定位') || findPhrase(observation.items, '虚拟定位'))
      ),
      Math.min(options.appTimeoutMs, options.entryAttemptTimeoutMs),
      options.pollMs,
      'virtual-location-entry-ready',
    );
    box = pageState && (
      findStrictPhrase(pageState.items, '虚拟定位') || findPhrase(pageState.items, '虚拟定位')
    );
  }
  if (!box) throw new Error('扩展服务设置页面未识别到“虚拟定位”入口');
  const point = tapBox(control, box, pageState);
  await control.tap(point.x, point.y);
  await control.flush();
  const page = await observeUntil(
    phone,
    worker,
    directory,
    state,
    observation => Boolean(virtualLocationTitleBox(observation.items) && amapTabBox(observation.items)),
    options.appTimeoutMs,
    options.pollMs,
    'virtual-location-ready',
  );
  if (!page || !virtualLocationTitleBox(page.items) || !amapTabBox(page.items)) {
    const detail = page?.text?.slice(0, 600) || 'no OCR observation';
    throw new Error('点击“虚拟定位”后未识别到高德/谷歌选择页：' + detail);
  }
  return { page, point };
}

async function openAmapAndWaitMap(phone, control, worker, directory, state, page, options) {
  const box = amapTabBox(page.items);
  if (!box) throw new Error('虚拟定位页面未识别到“高德”选项');
  const point = tapBox(control, box, page);
  await control.tap(point.x, point.y);
  await control.flush();
  // Switching the map provider can show its own loading overlay over the
  // IP button. A visible label underneath that overlay is not clickable yet.
  await sleep(options.amapEntryWaitMs);
  let entryStableObservations = 0;
  const entryReady = observation => Boolean(
    mapPageReady(observation.items) && ipLocationButtonBox(observation.items) &&
    !locationLoading(observation.items) && !locationToastVisible(observation.items) &&
    observation.mapVision?.rendered
  );
  const map = await observeUntil(
    phone,
    worker,
    directory,
    state,
    observation => {
      entryStableObservations = entryReady(observation) ? entryStableObservations + 1 : 0;
      return entryStableObservations >= 2;
    },
    options.locationTimeoutMs,
    options.pollMs,
    'amap-map-ready',
  );
  if (!map || !entryReady(map) || entryStableObservations < 2) {
    const detail = map?.text?.slice(0, 700) || 'no OCR observation';
    throw new Error('点击“高德”后地图未加载完成，或定位按钮仍被加载提示遮挡：' + detail);
  }
  return { map, point };
}

function mapDifference(left, right) {
  const a = left?.mapVision?.fingerprint;
  const b = right?.mapVision?.fingerprint;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
}

function locationToastVisible(items) {
  return Boolean(findStrictPhrase(items, '穿越成功') || findStrictPhrase(items, '定位成功'));
}

function randomLocationConfirmationBox(items) {
  const prompt = findStrictPhrase(items, '是否穿越到标记位置');
  if (!prompt) return null;
  const belowPrompt = item => item.top > prompt.bottom && item.right > item.left && item.bottom > item.top;
  const cancels = items.filter(item => normalizeText(item.text) === '取消' && belowPrompt(item));
  const confirms = items.filter(item => normalizeText(item.text) === '穿越' && belowPrompt(item));
  const matches = [];
  for (const cancel of cancels) {
    for (const confirm of confirms) {
      const rowTolerance = Math.max(12, cancel.bottom - cancel.top, confirm.bottom - confirm.top);
      const rowOffset = Math.abs((cancel.top + cancel.bottom - confirm.top - confirm.bottom) / 2);
      if (confirm.left > cancel.right && rowOffset <= rowTolerance) matches.push(confirm);
    }
  }
  // Only the unique right-hand action belonging to this specific dialog is safe.
  return matches.length === 1 ? matches[0] : null;
}

async function waitForLocationComplete(phone, worker, directory, state, map, options, phase = 'ip') {
  const deadline = Date.now() + options.locationTimeoutMs;
  const startedAt = Date.now();
  let last = map;
  let spinnerSeen = false;
  let stableObservations = 0;
  let successToastSeen = false;
  let mapChanged = false;
  let previous = null;
  let confirmationVisible = false;

  while (Date.now() <= deadline) {
    state.counter += 1;
    last = await screenshotAndOcr(phone, worker, directory, state.counter);
    const loading = locationLoading(last.items);
    const toast = locationToastVisible(last.items);
    confirmationVisible = phase === 'random' && Boolean(findStrictPhrase(last.items, '是否穿越到标记位置'));
    successToastSeen ||= toast;
    if (map && mapDifference(map, last) >= 1.5) mapChanged = true;
    const renderedMarker = last.mapVision?.rendered && last.mapVision?.marker;
    const ready = phase === 'ip'
      ? (spinnerSeen || successToastSeen)
      : renderedMarker && (phase !== 'random' || mapChanged || successToastSeen);
    const frameStable = phase === 'ip' || (previous && mapDifference(previous, last) < 2.5);
    if (loading) {
      spinnerSeen = true;
      stableObservations = 0;
    } else if (!toast && !confirmationVisible && ready && frameStable && mapPageReady(last.items) &&
      Date.now() - startedAt >= Math.max(options.locationMinWaitMs, phase === 'recenter' ? 4000 : 0)) {
      stableObservations += 1;
    } else {
      stableObservations = 0;
    }

    // The spinner is transient and can be missed by a 700 ms OCR poll. The
    // minimum wait plus stable map observations prevents returning immediately
    // on the stale frame that was captured just after the click.
    if (
      stableObservations >= options.locationStableObservations &&
      Date.now() - startedAt >= options.locationMinWaitMs
    ) {
      return { observation: last, spinnerSeen, successToastSeen, mapChanged, stableObservations };
    }
    previous = last;
    await sleep(options.pollMs);
  }

  const detail = last?.text?.slice(0, 700) || 'no OCR observation';
  throw new Error(
    `等待定位阶段 ${phase} 完成超时（spinnerSeen=${spinnerSeen}, toastSeen=${successToastSeen}, confirmationVisible=${confirmationVisible}, rendered=${last?.mapVision?.rendered}）：${detail}`,
  );
}

function locationIconPoint(control, options) {
  return {
    x: Math.round(control.screenWidth * options.locationIconXRatio),
    y: Math.round(control.screenHeight * options.locationIconYRatio),
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function randomNearbyLocationPoint(control, options, anchor = null) {
  const width = Number(control.screenWidth) || 360;
  const height = Number(control.screenHeight) || 640;
  const angle = Math.random() * Math.PI * 2;
  const distance = 0.55 + Math.random() * 0.45;
  const centerX = anchor?.x ?? width * options.mapCenterXRatio;
  const centerY = anchor?.y ?? height * options.mapCenterYRatio;
  const x = centerX + Math.cos(angle) * width * options.randomRadiusXRatio * distance;
  const y = centerY + Math.sin(angle) * height * options.randomRadiusYRatio * distance;
  return {
    x: Math.round(clamp(x, width * 0.18, width * 0.82)),
    y: Math.round(clamp(y, height * 0.30, height * 0.75)),
  };
}

function randomLocationMarkerPoint(control, observation) {
  const vision = observation?.mapVision;
  const marker = vision?.selectionMarker;
  if (!vision?.rendered || vision.selectionMarkers?.length !== 1 || !marker ||
      marker.source !== 'opencv-blue-location-pin' ||
      !Number.isFinite(observation.width) || observation.width <= 0 ||
      !Number.isFinite(observation.height) || observation.height <= 0 ||
      !Number.isFinite(marker.x) || marker.x <= 0 || marker.x >= observation.width ||
      !Number.isFinite(marker.y) || marker.y <= 0 || marker.y >= observation.height) return null;
  return {
    x: Math.round(marker.x * control.screenWidth / observation.width),
    y: Math.round(marker.y * control.screenHeight / observation.height),
  };
}

async function waitForRandomLocationMarker(phone, control, worker, directory, state, options, centeredMap) {
  let previous = null;
  let previousPoint = null;
  let stableObservations = 0;
  const oldPoint = randomLocationMarkerPoint(control, centeredMap);
  const tolerance = Math.max(2, control.screenWidth * 0.008);
  const close = (left, right) => left && right && Math.hypot(left.x - right.x, left.y - right.y) <= tolerance;
  const observation = await observeUntil(
    phone, worker, directory, state,
    current => {
      // If the first tap already opened the dialog, do not click through it.
      if (randomLocationConfirmationBox(current.items)) return true;
      const point = randomLocationMarkerPoint(control, current);
      const freshSelection = !oldPoint || !close(point, oldPoint) || mapDifference(centeredMap, current) >= 1.5;
      const ready = point && freshSelection && mapPageReady(current.items) &&
        !locationLoading(current.items) && !locationToastVisible(current.items) &&
        !findStrictPhrase(current.items, '是否穿越到标记位置');
      const stable = ready && previous && close(point, previousPoint) && mapDifference(previous, current) < 2.5;
      stableObservations = stable ? stableObservations + 1 : ready ? 1 : 0;
      previous = ready ? current : null;
      previousPoint = ready ? point : null;
      return stableObservations >= 2;
    },
    options.appTimeoutMs, options.pollMs, 'random-location-marker-ready',
  );
  if (observation && randomLocationConfirmationBox(observation.items)) {
    return { observation, point: null, marker: null, stableObservations: 0 };
  }
  const point = randomLocationMarkerPoint(control, observation);
  if (!point || stableObservations < 2) {
    const count = observation?.mapVision?.selectionMarkers?.length ?? 'unsupported';
    const detail = observation?.text?.slice(0, 700) || 'no OCR observation';
    throw new Error(`随机选点后未识别到唯一且稳定的蓝色水滴标记，未执行第二次点击（markerCount=${count}）：${detail}`);
  }
  return { observation, point, marker: observation.mapVision.selectionMarker, stableObservations };
}

async function tapRandomNearbyLocation(
  phone,
  control,
  worker,
  directory,
  state,
  options,
  centeredMap,
) {
  const marker = centeredMap?.mapVision?.marker;
  if (!centeredMap?.mapVision?.rendered || !marker) throw new Error('地图尚未加载定位标记，禁止在默认北京画面上随机点击');
  const anchor = { x: marker.x * control.screenWidth / centeredMap.width, y: marker.y * control.screenHeight / centeredMap.height };
  const point = randomNearbyLocationPoint(control, options, anchor);
  await control.tap(point.x, point.y);
  await control.flush();
  // Placing a pin can pan the map. The second tap must use a fresh detected
  // pin position, never the original random coordinate or the direction arrow.
  await sleep(RANDOM_LOCATION_MARKER_SETTLE_MS);
  const selected = await waitForRandomLocationMarker(
    phone, control, worker, directory, state, options, centeredMap,
  );
  if (selected.point) {
    await control.tap(selected.point.x, selected.point.y);
    await control.flush();
  }
  const confirmation = selected.point ? await observeUntil(
    phone,
    worker,
    directory,
    state,
    observation => Boolean(randomLocationConfirmationBox(observation.items)),
    options.appTimeoutMs,
    options.pollMs,
    'random-location-confirmation',
  ) : selected.observation;
  // observeUntil returns its last frame on timeout, so validate before clicking.
  const confirmBox = confirmation && randomLocationConfirmationBox(confirmation.items);
  if (!confirmBox) {
    const detail = confirmation?.text?.slice(0, 700) || 'no OCR observation';
    throw new Error('点击随机位置的水滴标记后，未识别到“是否穿越到标记位置”弹窗及唯一的“穿越”按钮，未执行确认：' + detail);
  }
  const confirmationPoint = tapBox(control, confirmBox, confirmation);
  await control.tap(confirmationPoint.x, confirmationPoint.y);
  await control.flush();
  const settled = await waitForLocationComplete(
    phone,
    worker,
    directory,
    state,
    centeredMap,
    options,
    'random',
  );
  return {
    point,
    tapCount: selected.point ? 2 : 1,
    markerTap: selected.point,
    marker: selected.marker,
    markerStableObservations: selected.stableObservations,
    confirmation: { button: '穿越', point: confirmationPoint, clicked: true, dismissed: true },
    settled,
  };
}

async function centerMapOnLocation(
  phone,
  control,
  worker,
  directory,
  state,
  options,
  location,
) {
  const point = locationIconPoint(control, options);
  await control.tap(point.x, point.y);
  await control.flush();
  await sleep(options.afterIconWaitMs);
  const centered = await waitForLocationComplete(phone, worker, directory, state, location, options, 'recenter');
  return { point, centered };
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }
  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || TARGET_DEVICE_ID);
  if (process.env.YUNMOMO_CONFIRM_VIRTUAL_LOCATION !== 'YES' && !process.argv.includes('--execute')) {
    throw new Error(
      '脚本6会修改云机虚拟定位；确认执行请设置 YUNMOMO_CONFIRM_VIRTUAL_LOCATION=YES 或传入 --execute',
    );
  }

  const options = {
    pollMs: numberOr(process.env.YUNMOMO_OCR_POLL_MS, DEFAULT_POLL_MS),
    homeTimeoutMs: numberOr(process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
    homeSettleMs: numberOr(process.env.YUNMOMO_HOME_SETTLE_MS, DEFAULT_HOME_SETTLE_MS),
    appTimeoutMs: numberOr(process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    entryAttemptTimeoutMs: numberOr(
      process.env.YUNMOMO_ENTRY_ATTEMPT_TIMEOUT_MS,
      DEFAULT_ENTRY_ATTEMPT_TIMEOUT_MS,
    ),
    amapEntryWaitMs: Math.max(DEFAULT_AMAP_ENTRY_WAIT_MS, numberOr(process.env.YUNMOMO_AMAP_ENTRY_WAIT_MS, DEFAULT_AMAP_ENTRY_WAIT_MS)),
    locationTimeoutMs: numberOr(process.env.YUNMOMO_LOCATION_TIMEOUT_MS, DEFAULT_LOCATION_TIMEOUT_MS),
    locationMinWaitMs: numberOr(process.env.YUNMOMO_LOCATION_MIN_WAIT_MS, DEFAULT_LOCATION_MIN_WAIT_MS),
    locationStableObservations: numberOr(
      process.env.YUNMOMO_LOCATION_STABLE_OBSERVATIONS,
      DEFAULT_LOCATION_STABLE_OBSERVATIONS,
    ),
    afterIconWaitMs: numberOr(process.env.YUNMOMO_AFTER_LOCATION_ICON_WAIT_MS, DEFAULT_AFTER_ICON_WAIT_MS),
    maxPagesPerDirection: numberOr(process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
    locationIconXRatio: numberOr(
      process.env.YUNMOMO_LOCATION_ICON_X_RATIO,
      DEFAULT_LOCATION_ICON_X_RATIO,
    ),
    locationIconYRatio: numberOr(
      process.env.YUNMOMO_LOCATION_ICON_Y_RATIO,
      DEFAULT_LOCATION_ICON_Y_RATIO,
    ),
    mapCenterXRatio: numberOr(
      process.env.YUNMOMO_MAP_CENTER_X_RATIO,
      DEFAULT_MAP_CENTER_X_RATIO,
    ),
    mapCenterYRatio: numberOr(
      process.env.YUNMOMO_MAP_CENTER_Y_RATIO,
      DEFAULT_MAP_CENTER_Y_RATIO,
    ),
    randomRadiusXRatio: numberOr(
      process.env.YUNMOMO_RANDOM_RADIUS_X_RATIO,
      DEFAULT_RANDOM_RADIUS_X_RATIO,
    ),
    randomRadiusYRatio: numberOr(
      process.env.YUNMOMO_RANDOM_RADIUS_Y_RATIO,
      DEFAULT_RANDOM_RADIUS_Y_RATIO,
    ),
  };
  const client = new YunmomoClient({ timeoutMs: 100000 });
  const devices = await client.listDevices({ size: 50000 });
  const target = devices.records.find(record => deviceIdOf(record) === targetDeviceId);
  if (!target) throw new Error('目标设备不在当前账号设备列表中: ' + targetDeviceId);

  const phone = client.device(targetDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const directory = await require('../../automation/screen').createOcrDirectory('yunmomo-script6-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };
  let success = false;
  try {
    await control.connect();
    const home = await settleHome(phone, control, worker, directory, state, options);
    const found = await findApp(
      phone,
      control,
      worker,
      directory,
      state,
      home,
      options,
      extensionServicesBox,
      '扩展服务',
    );
    const opened = await tapExtensionServicesAndWaitReady(
      phone,
      control,
      worker,
      directory,
      state,
      found,
      options,
    );
    const virtual = await openVirtualLocation(
      phone,
      control,
      worker,
      directory,
      state,
      opened.opened,
      options,
    );
    const amap = await openAmapAndWaitMap(
      phone,
      control,
      worker,
      directory,
      state,
      virtual.page,
      options,
    );
    const ipButton = ipLocationButtonBox(amap.map.items);
    if (!ipButton) throw new Error('高德地图页面未识别到“定位到ip所在地”按钮');
    const ipPoint = tapBox(control, ipButton, amap.map);
    await control.tap(ipPoint.x, ipPoint.y);
    await control.flush();
    const location = await waitForLocationComplete(
      phone,
      worker,
      directory,
      state,
      amap.map,
      options,
    );
    const centered = await centerMapOnLocation(
      phone,
      control,
      worker,
      directory,
      state,
      options,
      location.observation,
    );
    const nearby = await tapRandomNearbyLocation(
      phone,
      control,
      worker,
      directory,
      state,
      options,
      centered.centered.observation,
    );
    const finalHome = await settleHome(phone, control, worker, directory, state, options);
    const finalAnchors = homeAnchorMatches(finalHome.items);
    success = finalAnchors.length >= 2;
    console.log(JSON.stringify({
      ok: success,
      script: '定位到ip地',
      targetDeviceId,
      targetDeviceName: target.deviceName ?? target.name ?? 'SF',
      ocr: 'RapidOCR 1.2.3 (local WSL worker)',
      initialHomeAnchors: homeAnchorMatches(home.items),
      appLocated: true,
      appTap: opened.point,
      appTapRetried: opened.retried,
      appNavigationRecoveries: state.appNavigationRecoveries ?? [],
      virtualLocationTap: virtual.point,
      amapTap: amap.point,
      amapEntryWaitMs: options.amapEntryWaitMs,
      amapEntryLoadingCleared: true,
      ipLocationTap: ipPoint,
      spinnerSeen: location.spinnerSeen,
      locationStableObservations: location.stableObservations,
      ipSuccessToastSeen: location.successToastSeen,
      locationIconTap: centered.point,
      centeredMapText: centered.centered.observation.text,
      centeredMapMarker: centered.centered.observation.mapVision.marker,
      centeredMapRendered: centered.centered.observation.mapVision.rendered,
      randomNearbyLocationTap: nearby.point,
      randomNearbyLocationTapCount: nearby.tapCount,
      randomNearbyMarkerTap: nearby.markerTap,
      randomNearbyMarker: nearby.marker,
      randomNearbyMarkerStableObservations: nearby.markerStableObservations,
      randomLocationConfirmation: nearby.confirmation,
      randomLocationSpinnerSeen: nearby.settled.spinnerSeen,
      randomLocationStableObservations: nearby.settled.stableObservations,
      randomMapChanged: nearby.settled.mapChanged,
      randomSuccessToastSeen: nearby.settled.successToastSeen,
      randomMapText: nearby.settled.observation.text,
      finalHomeAnchors: finalAnchors,
      homeRestored: finalAnchors.length >= 2,
      screenshotObservations: state.counter,
    }, null, 2));
  } finally {
    if (!success && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
      try { await sendHome(control); } catch { /* preserve the original failure */ }
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

settleHome = require('../../automation/timing').timed('workflow.locate-ip.settleHome', settleHome);
tapExtensionServicesAndWaitReady = require('../../automation/timing').timed('workflow.locate-ip.tapExtensionServicesAndWaitReady', tapExtensionServicesAndWaitReady);
openVirtualLocation = require('../../automation/timing').timed('workflow.locate-ip.openVirtualLocation', openVirtualLocation);
openAmapAndWaitMap = require('../../automation/timing').timed('workflow.locate-ip.openAmapAndWaitMap', openAmapAndWaitMap);
waitForLocationComplete = require('../../automation/timing').timed('workflow.locate-ip.waitForLocationComplete', waitForLocationComplete);
waitForRandomLocationMarker = require('../../automation/timing').timed('workflow.locate-ip.waitForRandomLocationMarker', waitForRandomLocationMarker);
tapRandomNearbyLocation = require('../../automation/timing').timed('workflow.locate-ip.tapRandomNearbyLocation', tapRandomNearbyLocation);
centerMapOnLocation = require('../../automation/timing').timed('workflow.locate-ip.centerMapOnLocation', centerMapOnLocation);
main = require('../../automation/timing').timedScript('script.src.workflows.v3.locate-ip', main);

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  extensionServicesBox,
  extensionServicesReady,
  virtualLocationTitleBox,
  amapTabBox,
  ipLocationButtonBox,
  mapEvidence,
  mapPageReady,
  locationLoading,
  locationIconPoint,
  randomNearbyLocationPoint,
  randomLocationConfirmationBox,
};
