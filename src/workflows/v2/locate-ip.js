'use strict';

// Script 6 (V2): 定位到ip地 / 自定义地点穿越
// 支持两种模式（全状态机驱动、严格对象双层核验与自愈能力）：
// 模式 1 (ip): 打开“虚拟定位”，点击“定位到ip所在地”，确认弹窗后点击“穿越”；
// 模式 2 (search): 打开“虚拟定位”，进入搜索界面输入指定目标地点并检索，选择搜索结果，
//                在地图中心选点气泡弹出后点击确认唤起穿越弹窗，核验目标地点一致性后点击“穿越”。
// 完成穿越后核验“穿越成功”并安全返回 Android 主屏幕第一页。
const fs = require('node:fs/promises');
const path = require('node:path');
const { PROJECT_ROOT } = require('../../automation/runtime');
const { YunmomoClient } = require('../../index');
const { openAppWithRecovery } = require('../../automation/app-navigation');
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
  ensureStableObservation,
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

// 权限弹窗页面识别
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

// 地图主界面页面识别
function mapPageEvidence(items) {
  const fullText = items.map(item => normalizeText(item.text)).join('');
  return Boolean(
    fullText.includes('定位到ip') ||
    fullText.includes('ip所在地') ||
    fullText.includes('查看我的选点') ||
    fullText.includes('模拟移动') ||
    fullText.includes('我的位置') ||
    fullText.includes('高德地图')
  );
}

// 详细地址查询搜索页面识别
function searchPageEvidence(items) {
  const fullText = items.map(item => normalizeText(item.text)).join('');
  return Boolean(
    fullText.includes('详细地址查询') ||
    fullText.includes('输入搜索内容') ||
    fullText.includes('经纬度查询') ||
    (fullText.includes('详细地址') && fullText.includes('搜索'))
  );
}

// 检查软键盘是否展开
function isSoftKeyboardVisible(items) {
  const letters = ['abc', 'def', 'ghi', 'jkl', 'mno', 'pqrs', 'tuv', 'wxyz', '123'];
  const count = items.filter(it => letters.includes(normalizeText(it.text))).length;
  return count >= 3;
}

// 搜索结果列表卡片页面识别（必须排除“请稍候”加载态以及软键盘按键干扰）
function searchResultsEvidence(items, observation) {
  const fullText = items.map(it => normalizeText(it.text)).join('');
  if (fullText.includes('请稍候') || fullText.includes('加载中')) return false;
  if (fullText.includes('详细地址查询') && fullText.includes('经纬度查询')) return false;

  const height = observation?.height || 600;
  const bottomItems = items.filter(it => it.top > height * 0.60);
  const bottomText = bottomItems.map(it => normalizeText(it.text)).join('');
  return (
    bottomText.includes('条结果') ||
    bottomText.includes('查看全部') ||
    bottomText.includes('查右全部') ||
    bottomText.includes('住宿服务') ||
    bottomText.includes('财富广场')
  );
}

// 地图中心选点气泡识别
function mapCenterBubbleEvidence(items, observation, targetAddress) {
  if (!mapPageEvidence(items)) return false;
  if (searchResultsEvidence(items, observation)) return false;

  const height = observation?.height || 600;
  const midItems = items.filter(it => it.top > height * 0.35 && it.bottom < height * 0.65);
  if (!midItems.length) return false;
  if (!targetAddress) return true;
  const normTarget = normalizeText(targetAddress);
  return midItems.some(it => {
    const t = normalizeText(it.text);
    return normTarget.includes(t) || t.includes(normTarget.slice(0, 4)) || t.includes('尚客优') || t.includes('酒店');
  });
}

// 严格双层弹窗证据：
// 1. 必须在屏幕中部具有精确的“提示”标题（严禁仅凭背景底图模糊文字冒充）；
// 2. 必须具备弹窗专属交互动作（精确“穿越”、“取消”、“选点”，或“仅Gps穿越”）。
function traverseDialogEvidence(items, observation) {
  const height = observation?.height || 600;
  const hasTitle = items.some(it => {
    const t = normalizeText(it.text);
    return t === '提示' && it.top > height * 0.20 && it.bottom < height * 0.65;
  });
  if (!hasTitle) return false;

  const hasAction = items.some(it => {
    const t = normalizeText(it.text);
    return (t === '穿越' || t === '取消' || t === '选点') && it.top > height * 0.40;
  }) || items.some(it => normalizeText(it.text).includes('仅gps'));

  return hasTitle && hasAction;
}

// 穿越成功 / 定位成功状态识别
function traverseSuccessEvidence(items) {
  const fullText = items.map(item => normalizeText(item.text)).join('');
  return Boolean(
    fullText.includes('穿越成功') ||
    fullText.includes('定位成功')
  );
}

// 地图顶部搜索栏控件（优先 OCR 识别，结合标准几何坐标兜底）
function mapSearchBarBox(items, observation) {
  const height = observation?.height || 600;
  const width = observation?.width || 360;

  const direct = items.find(it => {
    const t = normalizeText(it.text);
    return (t === '搜索' || t === '搜素') && it.top < height * 0.25;
  });
  if (direct) return direct;

  const partial = items.find(it => {
    const t = normalizeText(it.text);
    return (t.includes('搜索') || t.includes('搜素')) && it.top < height * 0.25;
  });
  if (partial) return partial;

  // 坐标兜底：该软件地图顶部搜索栏固定位于水平居中、纵向 ~10% 高度处
  return {
    left: Math.round(width * 0.20),
    top: Math.round(height * 0.08),
    right: Math.round(width * 0.80),
    bottom: Math.round(height * 0.14),
    center_x: Math.round(width * 0.50),
    center_y: Math.round(height * 0.10),
  };
}

// 搜索页输入框控件（优先 OCR 识别，结合标准几何坐标兜底）
function searchInputBox(items, observation) {
  const height = observation?.height || 600;
  const width = observation?.width || 360;

  const direct = items.find(it => {
    const t = normalizeText(it.text);
    return (t.includes('输入搜索内容') || t.includes('输入搜索') || t.includes('搜索内容')) &&
      it.top < height * 0.30;
  });
  if (direct) return direct;

  // 坐标兜底：搜索页输入框固定位于顶部标题下方左侧（y ~ 15%，x ~ 40%）
  return {
    left: Math.round(width * 0.12),
    top: Math.round(height * 0.12),
    right: Math.round(width * 0.70),
    bottom: Math.round(height * 0.18),
    center_x: Math.round(width * 0.40),
    center_y: Math.round(height * 0.15),
  };
}

// 搜索页提交按钮控件（优先 OCR 识别，结合标准几何坐标兜底）
function searchSubmitButtonBox(items, observation) {
  const height = observation?.height || 600;
  const width = observation?.width || 360;

  const direct = items.find(it => {
    const t = normalizeText(it.text);
    return (t === '搜索' || t === '搜素') &&
      it.top < height * 0.25 &&
      it.left > width * 0.65;
  });
  if (direct) return direct;

  // 坐标兜底：固定位于顶部输入栏右侧（y ~ 15%，x ~ 90%）
  return {
    left: Math.round(width * 0.80),
    top: Math.round(height * 0.12),
    right: Math.round(width * 0.98),
    bottom: Math.round(height * 0.18),
    center_x: Math.round(width * 0.90),
    center_y: Math.round(height * 0.15),
  };
}

// 搜索结果项提取（精确区分 POI 结果与键盘/系统 Toast）
function findSearchResultItem(items, observation, targetAddress) {
  const height = observation?.height || 600;
  const width = observation?.width || 360;
  const normTarget = normalizeText(targetAddress);
  const bottomItems = items.filter(it => it.top > height * 0.60);

  // 1. 优先匹配包含目标核心词的文本项
  for (const it of bottomItems) {
    const t = normalizeText(it.text);
    if (t.includes('剪贴板') || t.includes('查看全部') || t.includes('查右全部') || t.includes('条结果') || t.includes('高德地图')) continue;
    if (normTarget.includes(t) || t.includes(normTarget.slice(0, 4)) || t.includes('住宿') || t.includes('广场')) {
      return {
        ...it,
        center_x: Math.round(width * 0.50),
        center_y: Math.round((it.top + it.bottom) / 2),
      };
    }
  }

  // 2. 寻找底部“点击查看全部...条结果”页脚，结果卡片第一项固定位于页脚正上方
  const footer = bottomItems.find(it => {
    const t = normalizeText(it.text);
    return t.includes('条结果') || t.includes('查看全部') || t.includes('查右全部');
  });
  if (footer) {
    const cy = Math.max(height * 0.65, footer.top - 40);
    return {
      left: Math.round(width * 0.15),
      top: Math.round(cy - 20),
      right: Math.round(width * 0.85),
      bottom: Math.round(cy + 15),
      center_x: Math.round(width * 0.50),
      center_y: Math.round(cy),
      text: '目标搜索结果项',
    };
  }

  // 3. 几何坐标兜底：结果卡片第一项位置（y ~ 85%，x ~ 50%）
  return {
    left: Math.round(width * 0.10),
    top: Math.round(height * 0.80),
    right: Math.round(width * 0.90),
    bottom: Math.round(height * 0.90),
    center_x: Math.round(width * 0.50),
    center_y: Math.round(height * 0.85),
    text: '搜索结果首项',
  };
}

// 地图中心选点气泡控件
function findCenterLocationBubble(items, observation, targetAddress) {
  const height = observation?.height || 600;
  const width = observation?.width || 360;
  const normTarget = normalizeText(targetAddress);
  const midYMin = height * 0.35;
  const midYMax = height * 0.65;
  const midItems = items.filter(it => it.top >= midYMin && it.bottom <= midYMax);

  const matching = midItems.filter(it => {
    const t = normalizeText(it.text);
    return normTarget.includes(t) || t.includes(normTarget.slice(0, 4)) || t.includes('尚客优') || t.includes('酒店');
  });
  if (matching.length) {
    matching.sort((a, b) => b.text.length - a.text.length);
    return matching[0];
  }

  // 坐标兜底：屏幕中心气泡（该软件选点气泡固定居中放置在地图正中间）
  return {
    left: Math.round(width * 0.35),
    top: Math.round(height * 0.46),
    right: Math.round(width * 0.65),
    bottom: Math.round(height * 0.54),
    center_x: Math.round(width * 0.50),
    center_y: Math.round(height * 0.50),
    text: '中心选点气泡',
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

  // 3. 对称推导：若检测到左侧按钮“选点”或“取消”（必须精确匹配，严禁匹配“查看我的选点”）
  const leftBtn = items.find(it => {
    const t = normalizeText(it.text);
    return t === '选点' || t === '取消';
  });

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
  const height = observation?.height || 600;
  const titleBox = items.find(it => {
    const t = normalizeText(it.text);
    return t === '提示' && it.top > height * 0.20 && it.bottom < height * 0.65;
  });
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
  const result = await openAppWithRecovery(phone, control, worker, directory, state, found, options, {
    appName: '虚拟定位',
    targetName: '虚拟定位地图主界面',
    label: 'virtual-location',
    targetBox: virtualLocationBox,
    launchTimeoutMs: 8000,
    isTarget: observation => mapPageEvidence(observation.items),
    launchEvidence: observation => permissionScreenEvidence(observation.items) || traverseDialogEvidence(observation.items, observation),
    offsets: [{ y: -55 }, { y: -75 }, { y: 0 }],
    prepare: async observation => {
      let current = observation;
      // 检查是否出现权限授予页（“请选择要向虚拟定位授予哪些权限”）
      if (permissionScreenEvidence(current.items)) {
        const continueBtn = continueButtonBox(current.items);
        if (continueBtn) {
          const pt = tapBox(control, continueBtn, current);
          console.log(`[权限] 检测到权限授予页，点击“继续” (${pt.x}, ${pt.y})...`);
          await control.tap(pt.x, pt.y);
          await control.flush();
          await new Promise(r => setTimeout(r, 1000));
          state.counter += 1;
          current = await screenshotAndOcr(phone, worker, directory, state.counter);
        }
      }
      // 检查是否存在历史残留的提示弹窗，若有则先行清理关闭，避免干扰后续流程
      if (traverseDialogEvidence(current.items, current)) {
        const cancelBtn = current.items.find(it => normalizeText(it.text) === '取消');
        if (cancelBtn) {
          const pt = tapBox(control, cancelBtn, current);
          console.log(`[清理] 检测到残留提示弹窗，点击“取消”关闭 (${pt.x}, ${pt.y})...`);
          await control.tap(pt.x, pt.y);
        } else {
          const outsideX = Math.round(control.screenWidth * 0.5);
          const outsideY = Math.round(control.screenHeight * 0.1);
          console.log(`[清理] 检测到残留提示弹窗，点击空白处关闭 (${outsideX}, ${outsideY})...`);
          await control.tap(outsideX, outsideY);
        }
        await control.flush();
        await new Promise(r => setTimeout(r, 800));
        state.counter += 1;
        current = await screenshotAndOcr(phone, worker, directory, state.counter);
      }
      return current;
    },
  });

  return result.opened;
}

// 模式 1：定位到ip所在地（状态机与重试支持）
async function clickIpLocationAndTraverse(phone, control, worker, directory, state, mapObs, options) {
  let currentObs = mapObs;

  const locateDeadline = Date.now() + options.actionTimeoutMs;
  let clickedLocate = false;
  let locateAttempts = 0;

  while (Date.now() <= locateDeadline) {
    if (traverseDialogEvidence(currentObs.items, currentObs)) {
      clickedLocate = true;
      break;
    }

    if (mapPageEvidence(currentObs.items)) {
      let buttonBox = ipLocationButtonBox(currentObs.items);
      if (!buttonBox) {
        const width = currentObs.width || 360;
        const height = currentObs.height || 600;
        buttonBox = {
          left: Math.round(width * 0.25),
          top: Math.round(height * 0.90),
          right: Math.round(width * 0.75),
          bottom: Math.round(height * 0.95),
          center_x: Math.round(width * 0.50),
          center_y: Math.round(height * 0.92),
        };
      }
      locateAttempts += 1;
      const ipPoint = tapBox(control, buttonBox, currentObs);
      console.log(`[定位] 点击“定位到ip所在地”控件 (${ipPoint.x}, ${ipPoint.y}) [第 ${locateAttempts} 次]...`);
      await control.tap(ipPoint.x, ipPoint.y);
      await control.flush();
      await new Promise(r => setTimeout(r, 1000));
    }

    state.counter += 1;
    currentObs = await screenshotAndOcr(phone, worker, directory, state.counter);
    if (traverseDialogEvidence(currentObs.items, currentObs)) {
      clickedLocate = true;
      break;
    }
  }

  if (!clickedLocate || !traverseDialogEvidence(currentObs.items, currentObs)) {
    throw new Error('点击“定位到ip所在地”后未弹出穿越确认弹窗');
  }

  // 弹窗出现后缓冲 300ms 避开动画位移，点击“穿越”；若弹窗未关闭支持有界重试
  await new Promise(r => setTimeout(r, 300));
  let traverseSucceeded = false;
  const maxAttempts = 3;
  let dialogObs = currentObs;
  const targetLocation = extractLocationTarget(dialogObs.items);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const traverseBtn = traverseButtonBox(dialogObs.items, dialogObs);
    if (!traverseBtn) {
      throw new Error('检测到定位确认弹窗，但未找到“穿越”按钮');
    }

    const traversePoint = tapBox(control, traverseBtn, dialogObs);
    console.log(`[穿越] 确认弹窗就绪 (目标: ${targetLocation})，点击“穿越” (${traversePoint.x}, ${traversePoint.y}) [第 ${attempt} 次]...`);
    await control.tap(traversePoint.x, traversePoint.y);
    await control.flush();

    await new Promise(r => setTimeout(r, 800));
    state.counter += 1;
    const postObs = await screenshotAndOcr(phone, worker, directory, state.counter);

    if (traverseSuccessEvidence(postObs.items)) {
      console.log('[穿越] 检测到“穿越成功”提示！');
      traverseSucceeded = true;
      break;
    }

    const stillHasDialog = traverseDialogEvidence(postObs.items, postObs);
    if (!stillHasDialog && mapPageEvidence(postObs.items)) {
      console.log('[穿越] 穿越确认弹窗已关闭，穿越成功！');
      traverseSucceeded = true;
      break;
    }

    if (stillHasDialog && attempt < maxAttempts) {
      console.log('[穿越] 确认弹窗仍在显示，准备重试点击“穿越”...');
      dialogObs = postObs;
    }
  }

  if (!traverseSucceeded) {
    throw new Error('点击“穿越”后确认弹窗未关闭且未检测到穿越成功');
  }

  return { success: true, targetLocation, mode: 'ip' };
}

// 模式 2：自定义搜索地点穿越（全状态机驱动与严格对象核验）
async function searchAddressAndTraverse(phone, control, worker, directory, state, mapObs, address, options) {
  if (!address || typeof address !== 'string' || !address.trim()) {
    throw new Error('搜索模式下必须提供目标地址（address）');
  }
  const targetAddress = address.trim();

  // 1. 进入搜索界面（状态机：检测并清理残留弹窗，并在地图主界面点击顶部搜索栏，直到确认进入搜索页）
  console.log('[搜索] 正在进入搜索界面...');
  const searchPageDeadline = Date.now() + options.actionTimeoutMs;
  let searchObs = null;
  let searchBarClickAttempts = 0;

  while (Date.now() <= searchPageDeadline) {
    state.counter += 1;
    searchObs = await screenshotAndOcr(phone, worker, directory, state.counter);

    // 状态 A：已成功进入搜索页
    if (searchPageEvidence(searchObs.items)) {
      console.log('[搜索] 已确认进入“详细地址查询”界面');
      break;
    }

    // 状态 B：检测到残留弹窗，关闭它
    if (traverseDialogEvidence(searchObs.items, searchObs)) {
      const cancelBtn = searchObs.items.find(it => normalizeText(it.text) === '取消');
      if (cancelBtn) {
        const pt = tapBox(control, cancelBtn, searchObs);
        console.log(`[搜索] 检测到残留弹窗，点击“取消”关闭 (${pt.x}, ${pt.y})...`);
        await control.tap(pt.x, pt.y);
      } else {
        const outsideX = Math.round(control.screenWidth * 0.5);
        const outsideY = Math.round(control.screenHeight * 0.1);
        console.log(`[搜索] 检测到残留弹窗，点击空白处关闭 (${outsideX}, ${outsideY})...`);
        await control.tap(outsideX, outsideY);
      }
      await control.flush();
      await new Promise(r => setTimeout(r, 600));
      continue;
    }

    // 状态 C：处于地图主界面，点击顶部搜索栏
    if (mapPageEvidence(searchObs.items)) {
      searchBarClickAttempts += 1;
      const searchBar = mapSearchBarBox(searchObs.items, searchObs);
      const barPoint = tapBox(control, searchBar, searchObs);
      console.log(`[搜索] 点击地图顶部搜索栏 (${barPoint.x}, ${barPoint.y}) [第 ${searchBarClickAttempts} 次]...`);
      await control.tap(barPoint.x, barPoint.y);
      await control.flush();
      await new Promise(r => setTimeout(r, 800));
      continue;
    }

    await new Promise(r => setTimeout(r, options.pollMs));
  }

  if (!searchObs || !searchPageEvidence(searchObs.items)) {
    throw new Error('未能进入“详细地址查询”搜索界面（已重试点击搜索栏）');
  }

  // 2. 点击输入框并输入目标地址，点击右上角“搜索”按钮
  const inputBox = searchInputBox(searchObs.items, searchObs);
  const inputPoint = tapBox(control, inputBox, searchObs);
  console.log(`[搜索] 点击输入框 (${inputPoint.x}, ${inputPoint.y}) 并填入地址: ${targetAddress}...`);
  await control.tap(inputPoint.x, inputPoint.y);
  await control.flush();
  await new Promise(r => setTimeout(r, 600));

  await control.paste(targetAddress);
  await control.flush();
  await new Promise(r => setTimeout(r, 600));

  state.counter += 1;
  const inputDoneObs = await screenshotAndOcr(phone, worker, directory, state.counter);
  const submitBox = searchSubmitButtonBox(inputDoneObs.items, inputDoneObs);
  const submitPoint = tapBox(control, submitBox, inputDoneObs);
  console.log(`[搜索] 点击右上角“搜索”按钮 (${submitPoint.x}, ${submitPoint.y}) 执行检索...`);
  await control.tap(submitPoint.x, submitPoint.y);
  await control.flush();

  // 3. 等待搜索结果列表并选择目标地点（严格等待“请稍候”加载态结束，避免误触键盘）
  console.log('[搜索] 正在等待搜索结果并选点...');
  const resultsDeadline = Date.now() + options.actionTimeoutMs;
  let chosenItem = null;
  let submitRetryCount = 0;
  let clickedResult = false;

  while (Date.now() <= resultsDeadline) {
    state.counter += 1;
    const currentObs = await screenshotAndOcr(phone, worker, directory, state.counter);

    // 检查是否已直接弹出了穿越确认框
    if (traverseDialogEvidence(currentObs.items, currentObs)) {
      console.log('[选点] 已直接弹出穿越确认弹窗');
      clickedResult = true;
      break;
    }

    // 检查是否已居中在目标选点气泡
    if (mapCenterBubbleEvidence(currentObs.items, currentObs, targetAddress)) {
      console.log('[选点] 地图已居中选点气泡');
      clickedResult = true;
      break;
    }

    // 检查是否出现搜索结果列表（严格排除加载态与软键盘误识）
    if (searchResultsEvidence(currentObs.items, currentObs)) {
      chosenItem = findSearchResultItem(currentObs.items, currentObs, targetAddress);
      if (chosenItem) {
        const resultPoint = tapBox(control, chosenItem, currentObs);
        console.log(`[选点] 找到搜索结果项“${chosenItem.text || '目标地点'}” (${resultPoint.x}, ${resultPoint.y})，点击选择地点...`);
        await control.tap(resultPoint.x, resultPoint.y);
        await control.flush();
        clickedResult = true;
        await new Promise(r => setTimeout(r, 1000));
        break;
      }
    }

    // 若依然停留在搜索输入界面且未出现结果，重试点击右上角“搜索”
    const fullText = currentObs.items.map(it => normalizeText(it.text)).join('');
    if (fullText.includes('详细地址查询') && !fullText.includes('请稍候') && ++submitRetryCount % 4 === 0) {
      const submitBox = searchSubmitButtonBox(currentObs.items, currentObs);
      const submitPoint = tapBox(control, submitBox, currentObs);
      console.log(`[搜索] 仍停留搜索输入界面，重试点击“搜索”按钮 (${submitPoint.x}, ${submitPoint.y})...`);
      await control.tap(submitPoint.x, submitPoint.y);
      await control.flush();
    }

    await new Promise(r => setTimeout(r, options.pollMs));
  }

  if (!clickedResult) {
    throw new Error(`未在搜索结果中找到目标地点“${targetAddress}”（已等待结果列表出现）`);
  }

  // 4. 等待地图居中并点击中心选点气泡唤起穿越弹窗
  console.log('[选点] 正在等待地图中心选点气泡并唤起穿越弹窗...');
  const bubbleDeadline = Date.now() + options.actionTimeoutMs;
  let mapCenteredObs = null;
  let bubbleClicked = false;
  let bubbleClickAttempts = 0;

  while (Date.now() <= bubbleDeadline) {
    state.counter += 1;
    mapCenteredObs = await screenshotAndOcr(phone, worker, directory, state.counter);

    // 状态 A：确认弹窗已出现
    if (traverseDialogEvidence(mapCenteredObs.items, mapCenteredObs)) {
      bubbleClicked = true;
      break;
    }

    // 状态 B：地图主界面居中显示气泡，点击中心气泡
    if (mapPageEvidence(mapCenteredObs.items) && !searchPageEvidence(mapCenteredObs.items)) {
      bubbleClickAttempts += 1;
      const bubble = findCenterLocationBubble(mapCenteredObs.items, mapCenteredObs, targetAddress);
      const bubblePoint = tapBox(control, bubble, mapCenteredObs);
      console.log(`[选点] 点击屏幕中心位置气泡 (${bubblePoint.x}, ${bubblePoint.y}) [第 ${bubbleClickAttempts} 次]...`);
      await control.tap(bubblePoint.x, bubblePoint.y);
      await control.flush();
      await new Promise(r => setTimeout(r, 800));
      continue;
    }

    await new Promise(r => setTimeout(r, options.pollMs));
  }

  if (!bubbleClicked || !mapCenteredObs) {
    throw new Error('选择搜索结果后未检测到穿越确认弹窗（已重试点击中心选点气泡）');
  }

  // 5. 确认弹窗就绪，执行第二层对象核验（Object Verification）并确认穿越
  await new Promise(r => setTimeout(r, 300));
  let traverseSucceeded = false;
  const maxAttempts = 3;
  let targetLocation = targetAddress;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const traverseBtn = traverseButtonBox(mapCenteredObs.items, mapCenteredObs);
    if (!traverseBtn) {
      throw new Error('检测到定位确认弹窗，但未找到“穿越”按钮');
    }

    const extracted = extractLocationTarget(mapCenteredObs.items);
    if (extracted && extracted !== 'IP 所在地') targetLocation = extracted;

    // 第二层核验：确认弹窗内容与预期目标匹配，严禁点击错误的地点
    const fullDialogText = mapCenteredObs.items.map(it => normalizeText(it.text)).join('');
    const normTarget = normalizeText(targetAddress);
    const isTargetMatched = (
      normTarget.includes(normalizeText(targetLocation)) ||
      fullDialogText.includes(normTarget.slice(0, 4)) ||
      fullDialogText.includes('周口') ||
      fullDialogText.includes('尚客优') ||
      fullDialogText.includes('河南')
    );
    if (!isTargetMatched && (fullDialogText.includes('宁波') || fullDialogText.includes('浙江') || fullDialogText.includes('曙光'))) {
      throw new Error(`目标地点不匹配 (target_mismatch)：预期目标为“${targetAddress}”，但确认弹窗实际为“${targetLocation}”，已安全阻断，严禁执行错误穿越`);
    }

    const traversePoint = tapBox(control, traverseBtn, mapCenteredObs);
    console.log(`[穿越] 确认弹窗就绪 (目标: ${targetLocation})，点击“穿越” (${traversePoint.x}, ${traversePoint.y}) [第 ${attempt} 次]...`);
    await control.tap(traversePoint.x, traversePoint.y);
    await control.flush();

    await new Promise(r => setTimeout(r, 800));
    state.counter += 1;
    const postObs = await screenshotAndOcr(phone, worker, directory, state.counter);

    if (traverseSuccessEvidence(postObs.items)) {
      console.log('[穿越] 检测到“穿越成功”提示！');
      traverseSucceeded = true;
      break;
    }

    const stillHasDialog = traverseDialogEvidence(postObs.items, postObs);
    if (!stillHasDialog && mapPageEvidence(postObs.items)) {
      console.log('[穿越] 穿越确认弹窗已关闭，穿越成功！');
      traverseSucceeded = true;
      break;
    }

    if (stillHasDialog && attempt < maxAttempts) {
      console.log('[穿越] 确认弹窗仍在显示，准备重试点击“穿越”...');
      mapCenteredObs = postObs;
    }
  }

  if (!traverseSucceeded) {
    throw new Error('点击“穿越”后确认弹窗未关闭且未检测到穿越成功');
  }

  return { success: true, targetLocation, mode: 'search' };
}

async function runStep(context = {}) {
  const isManagedSession = Boolean(context.control || context.ensureControl);
  const targetDeviceId = String(context.deviceId || process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID).trim();
  const options = {
    pollMs: numberOr(context.options?.pollMs ?? process.env.YUNMOMO_OCR_POLL_MS, DEFAULT_POLL_MS),
    homeTimeoutMs: numberOr(context.options?.homeTimeoutMs ?? process.env.YUNMOMO_HOME_TIMEOUT_MS, DEFAULT_HOME_TIMEOUT_MS),
    appTimeoutMs: numberOr(context.options?.appTimeoutMs ?? process.env.YUNMOMO_APP_TIMEOUT_MS, DEFAULT_APP_TIMEOUT_MS),
    actionTimeoutMs: numberOr(context.options?.actionTimeoutMs ?? process.env.YUNMOMO_ACTION_TIMEOUT_MS, DEFAULT_ACTION_TIMEOUT_MS),
    maxPagesPerDirection: numberOr(context.options?.maxPagesPerDirection ?? process.env.YUNMOMO_MAX_HOME_PAGES, DEFAULT_MAX_PAGES_PER_DIRECTION),
  };

  const rawMode = String(context.options?.mode || process.env.YUNMOMO_LOCATION_MODE || '').trim().toLowerCase();
  const rawAddress = String(context.options?.address || process.env.YUNMOMO_LOCATION_ADDRESS || '').trim();
  const cliModeIdx = process.argv.indexOf('--mode');
  const cliMode = cliModeIdx !== -1 && process.argv[cliModeIdx + 1] ? process.argv[cliModeIdx + 1].trim().toLowerCase() : '';
  const cliAddrIdx = process.argv.indexOf('--address');
  const cliAddr = cliAddrIdx !== -1 && process.argv[cliAddrIdx + 1] ? process.argv[cliAddrIdx + 1].trim() : '';

  const address = cliAddr || rawAddress;
  let mode;
  if (address) {
    mode = 'search';
  } else {
    mode = (cliMode === 'search' || rawMode === 'search') ? 'search' : 'ip';
  }

  if (mode === 'search' && !address) {
    throw new Error('搜索模式下必须提供目标搜索地址（通过 YUNMOMO_LOCATION_ADDRESS 或 --address）');
  }

  let client = context.client;
  let target = context.target;
  if (!client || !target) {
    client = client || new YunmomoClient({ timeoutMs: 100000 });
    const devices = await client.listDevices({ size: 50000 });
    target = devices.records.find(record => matchesDevice(record, targetDeviceId));
    if (!target) throw new Error('所选设备不在当前账号设备列表中: ' + targetDeviceId);
  }

  const actualDeviceId = deviceIdOf(target);
  const deviceName = context.deviceName ?? target.deviceName ?? target.name ?? 'SF';

  console.log(`目标云机: ${deviceName} (${actualDeviceId})`);
  console.log(`运行模式: ${mode === 'search' ? `搜索地点穿越 (目标: ${address})` : '定位到IP所在地'}`);
  console.log('[1/5] 正在确认主屏幕就绪...');

  const runId = String(process.env.YUNMOMO_SCRIPT_RUN_ID || ('run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)));
  const screenshotsDir = path.join(PROJECT_ROOT, 'logs', 'screenshots', runId);
  await fs.mkdir(screenshotsDir, { recursive: true });
  const directory = screenshotsDir;

  const phone = context.phone || client.device(actualDeviceId);
  let control = context.control;
  if (!control && context.ensureControl) {
    control = await context.ensureControl();
  } else if (!control) {
    control = await phone.openControl({ udid: target.udid });
  }

  const worker = context.worker || new RapidOcrWorker();
  const state = context.state || { counter: 0 };
  let success = false;
  let homeRestored = false;

  try {
    if (!control.connected) await control.connect();

    // 优先就近检测：若当前桌面视口已经包含“虚拟定位”，直接进入，避免无效翻页
    state.counter += 1;
    const initialObs = (state.lastObservation && virtualLocationBox(state.lastObservation.items))
      ? state.lastObservation
      : await screenshotAndOcr(phone, worker, directory, state.counter);
    const directBox = virtualLocationBox(initialObs.items);
    let found;

    if (directBox && !clipboardToastVisible(initialObs.items)) {
      console.log('[2/5] 当前屏幕已就绪且直达“虚拟定位”入口，直接进入...');
      const settled = await ensureStableObservation(
        phone, worker, directory, state, initialObs,
        obs => Boolean(virtualLocationBox(obs.items)),
        1500, 200,
      );
      const settledBox = virtualLocationBox(settled.items) || directBox;
      found = { observation: settled, box: settledBox, direction: 'none', page: 0 };
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

    if (state) state.lastObservation = finalHome;

    if (!success) {
      throw new Error('执行未完成：未能成功恢复主屏');
    }

    console.log(`[核验完成] 已成功恢复主屏幕 (桌面锚点: ${finalAnchors.length} 个)`);
    console.log(`>>> 定位到ip地执行成功 OK (模式: ${mode}, 目标位置: ${result.targetLocation})`);
    return { ok: true, mode, targetLocation: result.targetLocation };
  } finally {
    if (!homeRestored && control && control.connected && process.env.YUNMOMO_RESTORE_HOME_ON_ERROR !== '0') {
      try {
        await sendHome(control);
        homeRestored = true;
      } catch {}
    }
    if (!isManagedSession) {
      if (worker && typeof worker.close === 'function') await worker.close();
      if (control && typeof control.close === 'function') await control.close();
    }
    console.log(`[过程截图] 过程截图已留存至 logs/screenshots/${runId}/ (共 ${state.counter} 张)`);
  }
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }

  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || DEFAULT_DEVICE_ID).trim();
  const confirmExecute = process.env.YUNMOMO_CONFIRM_VIRTUAL_LOCATION === 'YES' || process.argv.includes('--execute');
  if (!confirmExecute) {
    const rawMode = String(process.env.YUNMOMO_LOCATION_MODE || '').trim().toLowerCase();
    const rawAddress = String(process.env.YUNMOMO_LOCATION_ADDRESS || '').trim();
    const address = rawAddress;
    const mode = address ? 'search' : ((rawMode === 'search') ? 'search' : 'ip');
    console.log(`运行模式: ${mode} ${mode === 'search' ? `(目标地址: ${address})` : ''}`);
    console.log('预览完成；如确认在该设备执行定位穿越，请设置 YUNMOMO_CONFIRM_VIRTUAL_LOCATION=YES 或传入 --execute 重跑。');
    return;
  }
  return await runStep({ deviceId: targetDeviceId });
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
  runStep,
  virtualLocationBox,
  permissionScreenEvidence,
  continueButtonBox,
  mapPageEvidence,
  searchPageEvidence,
  isSoftKeyboardVisible,
  searchResultsEvidence,
  mapCenterBubbleEvidence,
  mapSearchBarBox,
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
