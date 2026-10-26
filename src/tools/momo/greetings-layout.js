'use strict';

/**
 * MOMO 打招呼页面 界面布局与状态解析器 (Strict Finite State Machine Layout Engine)
 * 
 * 严格互斥状态分类 (Mutually Exclusive State Enum)：
 * - card: 未读打招呼卡片弹窗（同时存在合法的“拒绝”与“通过”操作按钮）
 * - empty_or_list: 招呼卡片已触底/处理完毕（进入全部招呼列表页或空态占位页，无操作按钮）
 * - rate_limited: 触发平台频控（“过于频繁”、“稍后再试”）
 * - loading: 页面正在加载卡片或数据中
 * - message_list: 处于 MOMO 消息列表主页（具备底栏导航 Tab）
 * - other_subpage: 其他二级页面（如聊天详情页、个人主页等）
 * - unknown: 无法高置信判定的状态
 */

// 预编译正则，避免高频匹配时重复编译
const RE_RATE_LIMIT = /过于频繁|频繁，请稍后|稍后再试|操作过于频繁/;
const RE_LOADING = /^(?:正在加载|加载中|正在获取|正在获取数据|请稍候)[.。…]*$/;
const RE_EMPTY_STATE = /^(?:暂无(?:新的?|未读)?招呼|暂时没有(?:新的?|未读)?招呼|没有(?:新的?|未读)?招呼|没有更多招呼了?|招呼已全部处理|全部处理完毕|暂无更多招呼|暂无更多|暂无数据|没有任何招呼)[!！.。…]*$/;
const RE_GREETINGS_HEADER = /收到的招呼|全部招呼|打招呼/;
const RE_LIST_FILTER = /全部招呼|疑似骚扰招呼|疑似骚扰/;
const RE_UNREAD_COUNT = /(?:未读招呼|收到的招呼)\s*[（(](\d+)[）)]/;
const RE_STRIP_NON_CHINESE = /^[^\u4e00-\u9fa5]+|[^\u4e00-\u9fa5]+$/g;
const RE_KM = /(\d+(?:\.\d+)?)\s*(?:km|公里)/i;
const RE_METER = /(?:[<＜]?)\s*(\d+)\s*(?:m|米)/i;

function extractDistanceKm(text) {
  if (!text) return null;
  const clean = String(text).trim();
  const kmMatch = clean.match(RE_KM);
  if (kmMatch) {
    const val = parseFloat(kmMatch[1]);
    return Number.isFinite(val) ? val : null;
  }
  const mMatch = clean.match(RE_METER);
  if (mMatch) {
    const val = parseFloat(mMatch[1]);
    return Number.isFinite(val) ? Math.round((val / 1000) * 100) / 100 : null;
  }
  return null;
}

function isApproveButtonText(text) {
  if (!text) return false;
  const clean = text.trim().replace(RE_STRIP_NON_CHINESE, '');
  return clean === '通过';
}

function isRejectButtonText(text) {
  if (!text) return false;
  const clean = text.trim().replace(RE_STRIP_NON_CHINESE, '');
  return clean === '拒绝';
}

function expandButtonBox(textItem, width, height, isApprove) {
  if (!textItem) return null;

  const cx = textItem.center_x ?? (textItem.left + textItem.right) / 2;
  const cy = textItem.center_y ?? (textItem.top + textItem.bottom) / 2;

  // 胶囊按钮标准半宽与半高扩张（约占屏幕宽度的 35%~40%，高度约 7%~8%）
  const itemW = Math.max(0, textItem.right - textItem.left);
  const itemH = Math.max(0, textItem.bottom - textItem.top);
  const halfW = Math.max(itemW / 2 + width * 0.08, width * 0.14);
  const halfH = Math.max(itemH / 2 + height * 0.015, height * 0.025);

  let left = cx - halfW;
  let right = cx + halfW;
  let top = cy - halfH;
  let bottom = cy + halfH;

  // 约束在左半屏（拒绝）或右半屏（通过）安全边距内
  if (isApprove) {
    left = Math.max(width * 0.52, left);
    right = Math.min(width * 0.96, Math.max(left + width * 0.12, right));
  } else {
    left = Math.max(width * 0.05, left);
    right = Math.min(width * 0.48, Math.max(left + width * 0.12, right));
  }

  // 约束在垂直安全区域内（下半屏）
  top = Math.max(height * 0.65, top);
  bottom = Math.min(height * 0.98, Math.max(top + height * 0.03, bottom));

  // 兜底防御：确保严格满足 left < right 且 top < bottom
  if (left >= right) {
    left = isApprove ? Math.round(width * 0.54) : Math.round(width * 0.06);
    right = isApprove ? Math.round(width * 0.94) : Math.round(width * 0.46);
  }
  if (top >= bottom) {
    top = Math.round(height * 0.84);
    bottom = Math.round(height * 0.93);
  }

  return [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)];
}

/**
 * 界面状态判定（严格有限状态机分类器）
 */
function classifyGreetingsScreen(ocrData, pageData, viewData = null) {
  const items = ocrData?.items ?? [];
  const w = ocrData?.width ?? pageData?.width ?? 720;
  const h = ocrData?.height ?? pageData?.height ?? 1280;

  // 1. 检查频控提示
  const rateLimitItem = items.find(it => RE_RATE_LIMIT.test(it.text));
  const hasRateLimitToast = Boolean(rateLimitItem);

  // 2. 检查底部操作按钮（拒绝 / 通过）
  // 必须满足空间约束：拒绝在左半侧 (left < 0.55w)，通过在右半侧 (right > 0.45w)，且都在下部 (top > 0.60h)
  const candidateButtons = [...items].sort((a, b) => b.top - a.top);
  const approveText = candidateButtons.find(it => isApproveButtonText(it.text) && it.top > h * 0.60 && (it.right ?? it.left) > w * 0.45);
  const rejectText = candidateButtons.find(it => isRejectButtonText(it.text) && it.top > h * 0.60 && (it.left ?? 0) < w * 0.55);

  const approveBox = approveText ? expandButtonBox(approveText, w, h, true) : null;
  const rejectBox = rejectText ? expandButtonBox(rejectText, w, h, false) : null;
  const hasCardButtons = Boolean(approveBox && rejectBox);

  // 3. 页面语义特征
  const compactText = item => String(item.text ?? '').replace(/\s+/g, '');
  const hasLoadingIndicator = items.some(it => RE_LOADING.test(compactText(it)));
  const hasExplicitEmptyState = items.some(it => RE_EMPTY_STATE.test(compactText(it)));
  
  // 顶栏打招呼标识（在屏幕顶部 20% 区域具有“收到的招呼”或“全部招呼”）
  const topGreetingsHeader = items.find(it => it.top < h * 0.20 && RE_GREETINGS_HEADER.test(it.text));
  const hasGreetingsSubpageHeader = Boolean(topGreetingsHeader);

  // 底栏 Tab 判定：只有出现“首页|直播|小宇宙|更多”底栏才可能是 1级主页
  const hasBottomTabs = items.some(it => it.top > h * 0.82 && /首页|直播|小宇宙|更多/.test(it.text));
  const isMessageList = hasBottomTabs && (
    (pageData?.sub_page === '消息列表' && pageData?.page_level === '1级页面') ||
    items.some(it => /马上聊/.test(it.text)) ||
    (items.some(it => it.text === '消息' && it.top < h * 0.15))
  );

  // 4. 空态或触底列表终态判定（明确处于打招呼子页面且无卡片弹窗）
  const hasListMarkers = items.some(it => RE_LIST_FILTER.test(it.text));
  const isGreetingsExhausted = !hasCardButtons && !hasLoadingIndicator && !isMessageList && (
    hasExplicitEmptyState ||
    hasListMarkers ||
    hasGreetingsSubpageHeader
  );

  // 5. 提取卡片未读数与卡片上的距离
  let unreadCount = null;
  const unreadMatch = items.map(it => it.text).join(' ').match(RE_UNREAD_COUNT);
  if (unreadMatch) {
    unreadCount = Number(unreadMatch[1]);
  }

  let distanceKm = null;
  let distanceText = null;
  const distanceCandidates = items.filter(it => {
    const km = extractDistanceKm(it.text);
    return km !== null && it.top > h * 0.10 && it.top < h * 0.60;
  });
  if (distanceCandidates.length > 0) {
    distanceCandidates.sort((a, b) => a.top - b.top || a.left - b.left);
    const target = distanceCandidates[0];
    distanceKm = extractDistanceKm(target.text);
    distanceText = target.text.trim();
  }

  // 6. 综合状态判定（严格互斥且完备的有限状态机）
  let state = 'unknown';
  if (hasRateLimitToast) {
    state = 'rate_limited';
  } else if (hasCardButtons) {
    state = 'card';
  } else if (hasLoadingIndicator) {
    state = 'loading';
  } else if (isGreetingsExhausted) {
    state = 'empty_or_list';
  } else if (isMessageList) {
    state = 'message_list';
  } else if (pageData?.is_momo === true && pageData?.sub_page === '首页') {
    state = 'home_feed';
  } else if (pageData?.page_level === '2级页面' || pageData?.page_level === '2级消息页' || pageData?.confidence?.has_input_box) {
    state = 'other_subpage';
  }

  // 7. 返回按钮区域（优先寻找顶栏左侧的“<”返回键或顶栏左侧区域）
  let backButtonBox = [Math.round(w * 0.02), Math.round(h * 0.035), Math.round(w * 0.16), Math.round(h * 0.09)];
  const backItem = items.find(it => (it.text === '<' || it.text === '〈' || it.text === 'く' || it.text === '《') && it.top < h * 0.15 && it.left < w * 0.25);
  if (backItem) {
    const pad = Math.round(w * 0.03);
    backButtonBox = [
      Math.max(0, Math.round(backItem.left - pad)),
      Math.max(0, Math.round(backItem.top - pad)),
      Math.min(w, Math.round(backItem.right + pad)),
      Math.min(h, Math.round(backItem.bottom + pad)),
    ];
  }

  // 8. 消息列表中的“收到的招呼”入口 Box
  let greetingsEntryBox = null;
  const greetingsTextItem = items.find(it => /收到的招呼/.test(it.text) && it.top > h * 0.12 && it.top < h * 0.88);
  if (greetingsTextItem && isMessageList) {
    const pad = Math.round(h * 0.015);
    const top = Math.max(0, greetingsTextItem.top - pad);
    const bottom = Math.min(Math.round(h * 0.88), greetingsTextItem.bottom + pad * 1.5);
    greetingsEntryBox = [Math.round(w * 0.05), Math.round(top), Math.round(w * 0.95), Math.round(bottom)];
  }

  let msgTabBox = null;
  if (viewData?.other_elements) {
    const msgElement = viewData.other_elements.find(it => it.class === 'tab_msg' && it.confidence >= 0.45);
    if (msgElement?.box) msgTabBox = [...msgElement.box];
  }

  // 是否处于打招呼业务页面（包含卡片弹窗与触底列表）
  const isGreetingsPage = (state === 'card' || state === 'empty_or_list' || hasGreetingsSubpageHeader) && !isMessageList && state !== 'home_feed';

  return {
    state,
    width: w,
    height: h,
    isGreetingsPage,
    hasGreetingsSubpageHeader,
    hasRateLimitToast,
    rateLimitText: rateLimitItem?.text ?? null,
    hasCardButtons,
    hasLoadingIndicator,
    hasExplicitEmptyState,
    isGreetingsExhausted,
    approveBox,
    rejectBox,
    distanceKm,
    distanceText,
    backButtonBox,
    greetingsEntryBox,
    msgTabBox,
    unreadCount,
    isMessageList,
  };
}

module.exports = {
  classifyGreetingsScreen,
  expandButtonBox,
  isApproveButtonText,
  isRejectButtonText,
  extractDistanceKm,
};
