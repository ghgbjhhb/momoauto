'use strict';

/**
 * MOMO 消息列表页解析与候选扫描中枢 (Message List Parser & Watcher)
 *
 * 聚合原:
 * 1. contact-layout.js (消息列表卡片提取、系统通知过滤、未读红点/数字解析)
 * 2. message-watch.js (候选扫描、边缘截断卡片过滤、时效性坐标返回)
 * 3. recognition-check.js 中 isMessageListPage 判定
 */

const SYSTEM_CARD_NAMES = new Set([
  '收到的招呼',
  '互动通知',
  '订阅内容',
  '系统消息',
  '官方小秘书',
  '陌陌团队',
  '安全中心',
  '超级抢车位',
  '超及抢车位',
  '陌陌游戏',
  '游戏中心',
  '活动通知',
  '陌陌运动',
  '陌陌微热点',
  '钱包通知',
  '谁看过我',
  '一键AI找人',
  '操作',
  '删除对话',
  '置顶聊天',
  '标为未读',
  '清空聊天记录',
]);

const MATCH_PROMOTION_MARKERS = /语音聊天|视频匹配|立即匹配|碰个球友|蛇蛇大作战|他在等你|配对聊天|配对玩游戏|为你找到.*合拍|合拍[男女]生|买辆专属跑车/;
const CONTACT_TIME_MARKERS = /^(?:昨天|前天|刚刚|\d+分钟前|\d+小时前|\d{1,2}:\d{2}|\d{1,2}-\d{1,2})$/;

// 纯 emoji/符号名判定：名字中不含任何可读字符（中文/假名/谚文/字母/数字）时，
// OCR 无法稳定识别且每次识别结果可能不同，按业务规则跳过自动处理，仅登记供调用方记录日志
const READABLE_NAME_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7afA-Za-z0-9]/;

function hasReadableName(name) {
  return READABLE_NAME_RE.test(String(name ?? ''));
}

function isConfirmedMessageList(pageData) {
  return pageData?.is_momo === true && pageData.page_level === '1级页面' && pageData.sub_page === '消息列表';
}

function isMessageListPage(page, ocr) {
  const items = ocr?.items ?? [];
  const h = ocr?.height ?? 1280;
  const allText = items.map(it => it.text).join(' ');

  // 1. 底栏有一级Tab且顶栏有消息/马上聊，100% 裁定为消息列表
  const hasBottomTabs = items.some(it => it.top > h * 0.82 && /首页|直播|小宇宙|更多/.test(it.text));
  const hasTopMsg = items.some(it => it.top < h * 0.16 && /消息|马上聊/.test(it.text));
  if (hasBottomTabs && hasTopMsg) {
    return true;
  }

  if (page?.is_momo === true && page.page_level === '1级页面' && page.sub_page === '消息列表') {
    return true;
  }

  // 2. 消息列表核心业务条目标记
  const hasMsgListContent = /收到的招呼|互动通知|最近在线|新招呼/.test(allText);
  if (hasBottomTabs && hasMsgListContent) {
    return true;
  }

  return Boolean(page?.is_momo && page?.page_level === '1级页面' && (hasMsgListContent || hasTopMsg));
}

function area(box) {
  if (!Array.isArray(box) || box.length !== 4) return 0;
  const [x1, y1, x2, y2] = box.map(Number);
  return Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2) &&
    x2 > x1 && y2 > y1 ? (x2 - x1) * (y2 - y1) : 0;
}

function overlapRatio(a, b) {
  const overlap = area([
    Math.max(a[0], b[0]), Math.max(a[1], b[1]),
    Math.min(a[2], b[2]), Math.min(a[3], b[3]),
  ]);
  return overlap / Math.min(area(a), area(b) || Infinity);
}

function detectionCenter(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const values = box.map(Number);
  if (values.some(value => !Number.isFinite(value))) return null;
  return { x: (values[0] + values[2]) / 2, y: (values[1] + values[3]) / 2 };
}

function messageListEvidence(ocrData, listData) {
  const items = ocrData?.items ?? [];
  const h = Number(ocrData?.height ?? 1280);
  const topMessage = items.some(item => String(item.text ?? '').trim() === '消息' && item.top < h * 0.18);
  const bottomLabels = new Set(['首页', '直播', '消息', '小宇宙', '更多']);
  const bottomCount = new Set(items
    .filter(item => item.top > h * 0.84 && bottomLabels.has(String(item.text ?? '').trim()))
    .map(item => String(item.text ?? '').trim())).size;
  const hasListText = items.some(item => /互动通知|收到的招呼|最近在线/.test(String(item.text ?? '')));
  const hasListCards = (listData?.chat_cards ?? []).some(card => {
    const box = card?.box;
    return area(box) > 0 && box[1] >= h * 0.14 && box[3] <= h * 0.90;
  });
  const ocrConfirmed = topMessage && bottomCount >= 2 && (hasListText || hasListCards);
  return { listModelConfirmed: hasListCards, ocrConfirmed, confirmed: hasListCards && ocrConfirmed };
}

function unreadBadgeForCard(card, otherElements, width) {
  const [x1, y1, x2, y2] = card.box;
  const candidates = (otherElements ?? [])
    .filter(item => item?.class === 'unread_badge')
    .map(item => ({ item, center: detectionCenter(item.box) }))
    .filter(({ item, center }) => {
      if (!center || !Array.isArray(item.box) || item.box.length !== 4) return false;
      return center.y >= y1 - 6 && center.y <= y2 + 6 && center.x >= width * 0.50 && center.x <= width * 0.98;
    })
    .sort((left, right) => (right.item.confidence ?? 0) - (left.item.confidence ?? 0));

  return candidates[0]?.item ?? null;
}

function parseMessageListContacts(ocrData, listData, pageData) {
  const items = ocrData?.items ?? [];
  const w = ocrData?.width ?? 720;
  const h = ocrData?.height ?? 1280;

  const pageModelConfirmed = isConfirmedMessageList(pageData);
  const evidence = messageListEvidence(ocrData, listData);
  const pageIsMessageList = (pageModelConfirmed && (evidence.ocrConfirmed || evidence.listModelConfirmed)) || evidence.confirmed;
  const pageIsMatchTab = pageData?.is_momo === true && pageData.page_level === '1级页面' &&
    /马上聊|匹配/.test(String(pageData.sub_page ?? ''));
  const hasMatchMarkers = items.some(it => MATCH_PROMOTION_MARKERS.test(String(it.text ?? '')));
  const hasMsgListMarkers = items.some(it => /互动通知|收到的招呼|最近在线/.test(String(it.text ?? '')));
  const isOnMatchTab = pageIsMatchTab || (!pageIsMessageList && hasMatchMarkers && !hasMsgListMarkers);
  const matchOverlay = !pageIsMessageList && items.some(it => /立即匹配|语音聊天/.test(String(it.text ?? '')));
  const closeItem = matchOverlay && items.find(it => /^(?:×|✕|x|X|关闭|取消)$/.test(String(it.text ?? '').trim()) &&
    it.left > w * 0.68 && it.top < h * 0.35);
  const matchOverlayCloseBox = closeItem ? [closeItem.left, closeItem.top, closeItem.right, closeItem.bottom] : null;

  let msgTopTabBox = null;
  const topMsgItem = items.find(it => it.text === '消息' && it.top < h * 0.16 && it.left > w * 0.20 && it.left < w * 0.45);
  if (topMsgItem) {
    msgTopTabBox = [Math.round(topMsgItem.left - 10), Math.round(topMsgItem.top - 10), Math.round(topMsgItem.right + 10), Math.round(topMsgItem.bottom + 10)];
  } else {
    msgTopTabBox = [Math.round(w * 0.24), Math.round(h * 0.09), Math.round(w * 0.38), Math.round(h * 0.14)];
  }

  if (!pageIsMessageList || isOnMatchTab) {
    return {
      isOnMatchTab,
      isConfirmedMessageList: pageIsMessageList,
      confirmationMode: pageIsMessageList ? (pageModelConfirmed && evidence.confirmed ? 'page_list_ocr' :
        pageModelConfirmed ? 'page_plus_visual' : 'list_ocr_fallback') : 'unconfirmed',
      pageModelConfirmed,
      listModelConfirmed: evidence.listModelConfirmed,
      ocrConfirmed: evidence.ocrConfirmed,
      msgTopTabBox,
      contacts: [],
      systemEntries: [],
      totalCards: 0,
      rejectedReason: isOnMatchTab ? 'match_tab' : 'page_not_confirmed',
      unreadableNames: [],
      matchOverlay,
      matchOverlayCloseBox,
    };
  }

  const rawCards = listData?.chat_cards ?? [];
  const protectedBlocks = (listData?.other_elements ?? [])
    .filter(item => /recent_block|recommend|promotion|match/i.test(String(item.class ?? '')))
    .map(item => item.box)
    .filter(box => area(box) > 0);

  const validCards = [];
  const unreadableCards = [];

  for (const card of rawCards) {
    const [x1, y1, x2, y2] = card.box;
    if (area(card.box) === 0 || y1 < h * 0.14 || y2 > h * 0.90) continue;
    if (protectedBlocks.some(block => overlapRatio(card.box, block) >= 0.50)) continue;

    const cardItems = items.filter(it => {
      const cy = it.center_y ?? (it.top + it.bottom) / 2;
      return cy >= y1 - 4 && cy <= y2 + 4 && it.left >= x1 - 10 && it.right <= x2 + 10;
    });

    if (!cardItems.length) continue;
    cardItems.sort((a, b) => a.top - b.top);

    const nameItem = cardItems.find(it => {
      const t = it.text.trim();
      return t && it.left < w * 0.73 && it.top < y1 + (y2 - y1) * 0.62 &&
        !CONTACT_TIME_MARKERS.test(t) && !/^[0-9.]+km/.test(t) &&
        !/^(操作|删除对话|置顶聊天|标为未读|去看看|去查看|立即查看|点击查看|查看详情|去玩|马上玩|立即进入|开启|立即开启)$/.test(t);
    });

    if (!nameItem) continue;
    const peerName = nameItem.text.trim();

    const allCardText = cardItems.map(i => i.text).join(' ');
    const isPromotion = MATCH_PROMOTION_MARKERS.test(allCardText);
    const hasContactTime = cardItems.some(item => CONTACT_TIME_MARKERS.test(item.text.trim()));
    const hasDistance = cardItems.some(item => /^[0-9.]+km/.test(item.text.trim()));
    const isSystem = SYSTEM_CARD_NAMES.has(peerName) ||
      /谁看过我|访客|超级抢车位|抢车位|跑车送给|买辆专属跑车|游戏中心|小游戏|删除对话|谨慎操作/.test(peerName) ||
      /看过你|有\d+个新招呼|赞了你的动态|AI.*推荐|为你找到.*合拍|合拍[男女]生|值得聊的用户|买辆专属跑车|专属跑车|删除对话|谨慎操作/.test(allCardText) ||
      /^(操作|删除对话|置顶聊天|标为未读|去看看|去查看|立即查看|点击查看|查看详情|去玩|马上玩)$/.test(peerName);

    let unreadCount = 0;
    const badgeItem = cardItems.find(it => {
      const t = it.text.trim();
      return /^\d{1,3}\+?$/.test(t) && it.left > w * 0.65;
    });
    if (badgeItem) unreadCount = parseInt(badgeItem.text.trim(), 10) || null;
    const ocrUnreadBadge = badgeItem && unreadCount > 0 ? badgeItem : null;
    const modelBadge = unreadBadgeForCard(card, listData?.other_elements, w);
    const unreadEvidence = modelBadge ? {
      type: 'model_badge',
      box: modelBadge.box,
      confidence: modelBadge.confidence ?? null,
    } : ocrUnreadBadge ? {
      type: 'ocr_badge',
      box: [ocrUnreadBadge.left, ocrUnreadBadge.top, ocrUnreadBadge.right, ocrUnreadBadge.bottom],
      confidence: ocrUnreadBadge.score ?? null,
    } : null;
    const unreadState = unreadEvidence ? (ocrUnreadBadge ? 'known' : 'unknown') : 'none';
    if (modelBadge && !ocrUnreadBadge) unreadCount = null;

    // 纯 emoji/符号名联系人：名字不可读，跳过自动处理，仅登记（含未读状态供日志提示）
    if (!hasReadableName(peerName)) {
      unreadableCards.push({ peerName, unread: unreadState !== 'none' });
      continue;
    }

    const previewItem = cardItems.find(it => {
      const t = it.text.trim();
      return (
        it !== nameItem &&
        it !== badgeItem &&
        !CONTACT_TIME_MARKERS.test(t) &&
        !/^[0-9.]+km/.test(t) &&
        !/^(最近在线|刚刚活跃|在线|离线|\d+分钟前|\d+小时前)/.test(t) &&
        !MATCH_PROMOTION_MARKERS.test(t)
      );
    });
    const lastMessage = previewItem ? previewItem.text.trim() : '';

    if (isPromotion && !hasContactTime && !hasDistance) continue;

    validCards.push({
      peerName,
      box: [x1, y1, x2, y2],
      center: card.center ?? [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
      unreadCount,
      hasUnread: unreadState !== 'none',
      unreadState,
      unreadEvidence,
      lastMessage,
      isSystem,
      confidence: card.confidence,
    });
  }

  return {
    isOnMatchTab,
    isConfirmedMessageList: pageIsMessageList,
    confirmationMode: pageIsMessageList ? (pageModelConfirmed && evidence.confirmed ? 'page_list_ocr' :
      pageModelConfirmed ? 'page_plus_visual' : 'list_ocr_fallback') : 'unconfirmed',
    pageModelConfirmed,
    listModelConfirmed: evidence.listModelConfirmed,
    ocrConfirmed: evidence.ocrConfirmed,
    msgTopTabBox,
    contacts: validCards.filter(c => !c.isSystem),
    systemEntries: validCards.filter(c => c.isSystem),
    totalCards: validCards.length,
    unreadableNames: unreadableCards,
    matchOverlay,
    matchOverlayCloseBox,
  };
}

// ====================================================
// 候选扫描与边缘避让 (Candidate Scanning)
// ====================================================

function isEdgeCard(box, screenHeight) {
  if (!Array.isArray(box) || box.length !== 4) return true;
  const [x1, y1, x2, y2] = box;
  const cardHeight = y2 - y1;
  if (cardHeight < 40) return true;

  if (y1 < screenHeight * 0.14) return true;
  if (y2 > screenHeight * 0.92) return true;

  return false;
}

function scanMessageListCandidates(ocrData, listData, pageData, options = {}) {
  const parsed = parseMessageListContacts(ocrData, listData, pageData);
  const screenHeight = ocrData?.height ?? 1280;

  const validCandidates = [];

  for (const card of parsed.contacts) {
    if (card.isSystem || SYSTEM_CARD_NAMES.has(card.peerName)) {
      continue;
    }

    if (isEdgeCard(card.box, screenHeight)) {
      continue;
    }

    if (options.onlyContacts && Array.isArray(options.onlyContacts) && options.onlyContacts.length > 0) {
      if (!options.onlyContacts.includes(card.peerName)) {
        continue;
      }
    }

    const hasUnread = card.hasUnread === true || card.unreadState === 'known' ||
      card.unreadState === 'unknown' || card.unreadCount > 0;

    validCandidates.push({
      peerName: card.peerName,
      box: card.box,
      center: card.center,
      unreadCount: card.unreadCount,
      hasUnread,
      unreadState: card.unreadState ?? (hasUnread ? (card.unreadCount > 0 ? 'known' : 'unknown') : 'none'),
      unreadEvidence: card.unreadEvidence ?? null,
      lastMessage: card.lastMessage,
      confidence: card.confidence ?? 1.0
    });
  }

  return {
    isOnMatchTab: parsed.isOnMatchTab,
    msgTopTabBox: parsed.msgTopTabBox,
    candidates: validCandidates,
    totalFound: validCandidates.length,
    timestamp: Date.now()
  };
}

module.exports = {
  SYSTEM_CARD_NAMES,
  isConfirmedMessageList,
  isMessageListPage,
  messageListEvidence,
  parseMessageListContacts,
  isEdgeCard,
  scanMessageListCandidates,
  hasReadableName,
};
