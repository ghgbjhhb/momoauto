'use strict';

/**
 * MOMO 聊天详情单帧解析与双层核验中枢 (Chat Detail Single-Frame Parser & Verifier)
 *
 * 聚合原:
 * 1. chat-layout.js (输入框/返回键/发送按钮几何提取与表情避让 ROI 计算)
 * 2. assistant-overlay.js (悬浮助手面板及右上角关闭叉判定，防名片误杀)
 * 3. conversation-reader.js (第一层页面确认 + 第二层顶栏联系人严格对象核验)
 * 4. chat-message-parser.js (气泡提取、时间戳过滤、系统卡片过滤)
 * 5. chat-bubble-ocr.js (未读气泡局部批次补读)
 * 6. send-evidence.js (发送前后气泡证据与己方新气泡确认)
 */

const { ToolFailure, fail } = require('../runtime');

// ====================================================
// 辅助文本比对 (Draft Matching Helpers)
// ====================================================
function normalizeDraftText(text) {
  if (!text) return '';
  return text
    .trim()
    .replace(/\s+/g, '')
    .replace(/[，,]/g, ',')
    .replace(/[。.]/g, '.')
    .replace(/[！!]/g, '!')
    .replace(/[？?]/g, '?')
    .replace(/[：:]/g, ':')
    .replace(/[；;]/g, ';')
    .replace(/[“ ” "]/g, '"')
    .replace(/[‘ ’ ']/g, "'")
    .replace(/—/g, '-')
    .replace(/～/g, '~');
}

function stripTrailingArtifacts(text) {
  if (!text) return '';
  return text.replace(/(?:发送|[\[\]\(\)\|\-_\~^\*·'"])+$/g, '');
}

function stripPunctuation(text) {
  if (!text) return '';
  return text.replace(/[，,。.！!？?：:；;“”"‘’'—~～·\s]/g, '');
}

function draftMatches(actual, expected) {
  if (actual === expected) return true;
  if (!actual && !expected) return true;
  if (!actual || !expected) return false;
  const nActual = normalizeDraftText(actual);
  const nExpected = normalizeDraftText(expected);
  if (nActual === nExpected) return true;
  const cleanActual = stripTrailingArtifacts(nActual);
  const cleanExpected = stripTrailingArtifacts(nExpected);
  if (cleanActual === cleanExpected && cleanExpected.length > 0) return true;
  // 容差匹配：标点/空格差异（如输入法以空格提交或标点转换差异）
  const pActual = stripPunctuation(cleanActual);
  const pExpected = stripPunctuation(cleanExpected);
  if (pActual === pExpected && pExpected.length > 0) return true;
  return false;
}



function isTimestampText(text) {
  if (!text) return false;
  const clean = text.replace(/\s+/g, '');
  if (/^(\d{1,2}[-/.月]\d{1,2}(日)?)?(\d{1,2}:\d{2})([\d.]+[kK]?[mM])?$/.test(clean)) return true;
  if (/^(昨天|前天|刚刚|星期[一二三四五六日天])(\d{1,2}:\d{2})?([\d.]+[kK]?[mM])?$/.test(clean)) return true;
  if (/^\d+\s*小时前$/.test(clean)) return true;
  if (/^(\d{4}-)?\d{1,2}[-/.月]\d{1,2}日?$/.test(clean)) return true;
  if (/^[\d.]+\s*[kK]?[mM]$/.test(clean)) return true;
  if (/^\d{1,2}[-/.月]\d{1,2}.*\d{1,2}:\d{2}/.test(text)) return true;
  return false;
}

function isChatStatusBannerText(text) {
  const clean = (text || '').replace(/\s+/g, '');
  // OCR may turn the tiny spark icon after the day count into punctuation.
  // Keep the entire status sentence anchored; never accept trailing words.
  return /^(?:已)?连续互聊\d+天[，,。.!！?？:：;；"'“”‘’…]{0,3}$/.test(clean) ||
    /^火花标识(?:已)?点(?:亮|壳)$/.test(clean) ||
    /^已连续互聊\d+天.*火花标识.*点亮$/.test(clean) ||
    /^(?:互聊继续)?点亮火花$/.test(clean) ||
    /^(?:点击)?快捷发送$/.test(clean) ||
    /^积火花$/.test(clean);
}

// The same boundary applies to fresh OCR and older archives whose system
// banners were once stored with a peer/self sender. Do not rewrite stored
// sequence numbers or infer notices from keywords inside ordinary messages.
function isConversationMessage(message) {
  const text = message?.rawText ?? message?.text;
  return (message?.sender === 'peer' || message?.sender === 'self') &&
    typeof text === 'string' && text.trim().length > 0 &&
    !message.isTimestamp && !message.isChatStatusBanner && !message.isPostCard &&
    !isTimestampText(text) && !isFollowBannerText(text) && !isChatStatusBannerText(text) &&
    !isSystemNoticeText(text);
}

function isLikelyChatStatusBanner(text, centerX, centerY, itemWidth, width, height) {
  const clean = (text || '').replace(/\s+/g, '');
  // Tolerate OCR errors only in the complete two-part status sentence, e.g.
  // “已廷续豆聊天，化物口点壳”. Ordinary bubbles mentioning "聊天" or "连续"
  // must not become system notices just because their text is centered.
  return centerX > width * 0.22 && centerX < width * 0.78 &&
    centerY > height * 0.11 && centerY < height * 0.90 &&
    itemWidth > width * 0.30 && itemWidth < width * 0.75 &&
    /^(?:已)?[连廷]续[互豆].{0,5}[，,]?[火化].{1,5}点[亮壳]$/.test(clean);
}

function normalizeOcrShortText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?：:；;“”‘’'"「」『』…（）()\[\]<>《》]/g, '');
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1);
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return previous[right.length];
}

// These are fixed UI/system texts, not user-authored conversation.  OCR on
// small Chinese glyphs can drop or substitute one or two characters, so the
// parser compares short templates with a deliberately small edit-distance
// allowance instead of requiring an exact string.
const FOLLOW_NOTICE_TEMPLATES = [
  { target: '是否关注对方', maxDistance: 1, allowSubstring: false },
  { target: '关注', maxDistance: 1, allowSubstring: false },
  { target: '关注对方', maxDistance: 1, allowSubstring: false },
  { target: '关注后可订阅对方动态', maxDistance: 2 },
  { target: '关注对方可接收对方动态更新', maxDistance: 2 },
  { target: '关注对方可接收对方动', maxDistance: 1 },
  { target: '可接收对方动态更新', maxDistance: 1, allowSubstring: false },
  { target: '态更新', maxDistance: 1, allowSubstring: false },
  { target: '关注他升级你们的关系吧', maxDistance: 2 },
  { target: '相互关注', maxDistance: 1, allowSubstring: false },
  { target: '来自关注引导', maxDistance: 2 },
];

const SYSTEM_NOTICE_TEMPLATES = [
  // 加好友/好友申请卡片
  { target: '申请加你为好友', maxDistance: 2 },
  { target: '通过好友申请', maxDistance: 1 },
  { target: '已通过你的好友申请', maxDistance: 2 },
  { target: '向你打招呼', maxDistance: 1 },
  { target: '通过了你的招呼', maxDistance: 2 },
  { target: '通过你的动态发起对话', maxDistance: 2 },
  { target: '成为好友', maxDistance: 1 },
  // 好友卡片中的语音提示
  { target: '好友可发送语音消息', maxDistance: 2 },
  { target: '好友之间可发送语音消息', maxDistance: 2 },
  { target: '可发送语音消息', maxDistance: 2 },
  { target: '可以发送语音消息啦', maxDistance: 2 },
  { target: '语音消息啦', maxDistance: 1 },
  // 安全/骚扰提示
  { target: '如对方消息过于打扰', maxDistance: 2 },
  { target: '若对方发言令你感到不适可以反馈', maxDistance: 3 },
  { target: '请注意财产安全', maxDistance: 1 },
  { target: '去其他平台加他人好友前请仔细甄别对方身份', maxDistance: 3 },
  { target: '你撤回了一条消息', maxDistance: 1 },
  // 火花与互动引导卡片
  { target: '互聊继续点亮火花', maxDistance: 2 },
  { target: '点亮火花', maxDistance: 1 },
  { target: '点击快捷发送', maxDistance: 2 },
  { target: '快捷发送', maxDistance: 1 },
  { target: '积火花', maxDistance: 1 },
  // 其它页面固定文字
  { target: '以下是历史消息', maxDistance: 1 },
  { target: '请输入消息', maxDistance: 1 },
  { target: '通过', maxDistance: 0, allowSubstring: false },
];

function ocrTemplateMatches(text, target, maxDistance = 1, allowSubstring = true) {
  const clean = normalizeOcrShortText(text);
  const expected = normalizeOcrShortText(target);
  if (!clean || !expected) return false;
  if (clean === expected) return true;
  if (allowSubstring && clean.includes(expected)) return true;

  const minLength = Math.max(1, expected.length - maxDistance);
  const maxLength = Math.min(clean.length, expected.length + maxDistance);
  if (!allowSubstring && (clean.length < minLength || clean.length > maxLength)) return false;

  // For a complete short OCR item, compare the whole item.
  if (clean.length <= expected.length + maxDistance &&
      Math.abs(clean.length - expected.length) <= maxDistance &&
      levenshteinDistance(clean, expected) <= maxDistance) {
    return true;
  }

  // A friend-card line can contain a person's name before the fixed template.
  // Compare nearby windows so that "某某申请加你为好友" is still filtered.
  if (!allowSubstring) return false;
  for (let start = 0; start < clean.length; start += 1) {
    for (let length = minLength; length <= maxLength && start + length <= clean.length; length += 1) {
      if (levenshteinDistance(clean.slice(start, start + length), expected) <= maxDistance) return true;
    }
  }
  return false;
}

function matchesOcrTemplateList(text, templates) {
  return templates.some(rule => ocrTemplateMatches(
    text,
    rule.target,
    rule.maxDistance,
    rule.allowSubstring !== false,
  ));
}

function isFollowBannerText(text) {
  return matchesOcrTemplateList(text, FOLLOW_NOTICE_TEMPLATES);
}

function isSystemNoticeText(text) {
  const clean = normalizeOcrShortText(text);
  return isChatStatusBannerText(text) ||
    isPublishedPostNotice(text) ||
    isFollowBannerText(text) ||
    matchesOcrTemplateList(text, SYSTEM_NOTICE_TEMPLATES) ||
    /向你打招呼|通过.*打招呼|通过了你的招呼|成为好友|申请加你为好友|可发送语音消息|通过好友申请|如对方消息过于打扰|请注意财产安全|来自[「【].*[」】]?|点赞的人.*天前|以下是历史消息|已通过你的好友申请|点亮火花|积火花|快捷发送/.test(clean);
}

function isPublishedPostNotice(text) {
  const clean = normalizeOcrShortText(text);
  const target = '发布了动态';

  // OCR 对短系统提示偶尔会漏一个字、错一个字，或带上标点/空格。
  // 只对长度接近且整体接近目标的短文本放宽，避免把普通聊天正文
  // 中提到“发布了动态”的长句误判为帖子提示。
  if (clean.length < target.length - 1 || clean.length > target.length + 1) return false;
  return levenshteinDistance(clean, target) <= 1;
}

function centerInBox(item, box) {
  const x = item.center_x ?? (item.left + item.right) / 2;
  const y = item.center_y ?? (item.top + item.bottom) / 2;
  return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

function matchCardRegions(items, bubbleRegions, width, height, topBoundary, bottomBoundary) {
  // 这是整块系统卡片的布局识别，不是正文关键词黑名单。至少两种模板、
  // 相邻且对齐的卡片行同时成立，才排除其中的照片年龄、动画和介绍文字。
  const features = items.map(item => {
    const text = normalizeOcrShortText(item.text).replace(/^[oO0○·•]+/, '');
    const exact = (target, distance) => ocrTemplateMatches(text, target, distance, false);
    let kind;
    if (exact('相遇成功', 1)) kind = 'title';
    else if (exact('来自敲敲', 1)) kind = 'source';
    else if (/^身高\d{2,3}(?:cm)?.{0,24}$/.test(text)) kind = 'profile';
    else if (exact('他在偷偷关注你', 2) || exact('她在偷偷关注你', 2)) kind = 'follow';
    else if (/^你们[擦檫]肩而过\d+次$/.test(text)) kind = 'encounter';
    else if (exact('互聊继续点亮火花', 2) || exact('点亮火花', 1) || exact('积火花', 1) || exact('点击快捷发送', 2) || exact('快捷发送', 1)) kind = 'spark';
    return kind ? { item, kind } : null;
  }).filter(Boolean);
  const cards = [];
  for (const feature of features) {
    if (!['profile', 'follow', 'encounter'].includes(feature.kind)) continue;
    const body = features.filter(other => ['profile', 'follow', 'encounter'].includes(other.kind) &&
      Math.abs(other.item.top - feature.item.top) < height * .18 &&
      Math.abs(other.item.left - feature.item.left) < width * .08);
    const distinctKinds = new Set(body.map(hit => hit.kind)).size;
    // 小步翻页会短暂只露出卡片最后一行。此时必须同时有“整屏宽、
    // 顶部被裁切的白色卡片 + 左侧项目符号模板”，不能仅凭关键词过滤。
    const clippedWide = bubbleRegions.filter(region => Array.isArray(region.box) &&
      region.box[0] < width * .08 && region.box[2] > width * .92 &&
      region.box[1] <= topBoundary + height * .025 &&
      body.some(hit => centerInBox(hit.item, region.box) && hit.item.left < width * .12 &&
        /^[oO0○·•]/.test(String(hit.item.text).trim())));
    if (distinctKinds < 2 && !clippedWide.length) continue;
    const bodyTop = Math.min(...body.map(hit => hit.item.top));
    const bodyBottom = Math.max(...body.map(hit => hit.item.bottom));
    const header = features.filter(hit => ['title', 'source'].includes(hit.kind) &&
      hit.item.bottom < bodyTop && hit.item.top > bodyTop - height * .22 &&
      Math.abs((hit.item.left + hit.item.right) / 2 - width / 2) < width * .15);
    const wide = bubbleRegions.filter(region => Array.isArray(region.box) &&
      region.box[2] - region.box[0] > width * .75 &&
      body.some(hit => centerInBox(hit.item, region.box)));
    const box = [width * .025,
      Math.max(topBoundary, header.length ? Math.min(...header.map(hit => hit.item.top)) - height * .06 : bodyTop - height * .22),
      width * .975,
      Math.min(bottomBoundary, Math.max(bodyBottom + height * .04, ...wide.map(region => region.box[3]))),
    ];
    if (cards.some(card => Math.abs(card.box[3] - box[3]) < height * .04)) continue;
    cards.push({ type: 'match_card', box, evidence: [...new Set([
      ...[...body, ...header].map(hit => hit.kind), ...(clippedWide.length ? ['clipped_wide_card'] : []),
    ])] });
  }

  // 结构性几何规则：火花引导卡片与居中对称系统大卡片（Centered System Card）
  // 在单聊页面拓扑结构上，人类 peer 气泡必须紧靠左侧头像栏，绝不在屏幕中心水平高度对称展开占满 52%~96%。
  for (const region of bubbleRegions) {
    if (!Array.isArray(region.box) || region.box.length !== 4) continue;
    const [left, top, right, bottom] = region.box;
    const cardW = right - left;
    const cardH = bottom - top;
    if (cardW <= 0 || cardH <= 0) continue;
    const centerX = (left + right) / 2;
    const isCentered = Math.abs(centerX - width / 2) < width * 0.08;
    const isWide = cardW > width * 0.52 && cardW < width * 0.96;
    const isSymmetric = Math.abs(left - (width - right)) < width * 0.08;
    const hasSparkText = features.some(f => f.kind === 'spark' && centerInBox(f.item, region.box));

    if ((isCentered && isWide && isSymmetric && cardH > height * 0.04) || hasSparkText) {
      const box = [
        Math.max(0, left - 4),
        Math.max(topBoundary, top - 4),
        Math.min(width, right + 4),
        Math.min(bottomBoundary, bottom + 4),
      ];
      if (!cards.some(c => Math.abs(c.box[1] - box[1]) < height * 0.04 && Math.abs(c.box[3] - box[3]) < height * 0.04)) {
        cards.push({
          type: 'spark_or_system_card',
          box,
          evidence: hasSparkText ? ['spark_text', 'centered_geometry'] : ['centered_geometry'],
        });
      }
    }
  }

  return cards;
}

function bubbleColorMatch(item, bubbleRegions) {
  if (!Array.isArray(bubbleRegions) || !bubbleRegions.length) return null;
  const left = Number(item.left), top = Number(item.top);
  const right = Number(item.right), bottom = Number(item.bottom);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;

  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const itemArea = (right - left) * (bottom - top);
  let best = null;

  for (const region of bubbleRegions) {
    const box = region?.box;
    if (!Array.isArray(box) || box.length !== 4) continue;
    const [x1, y1, x2, y2] = box.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) continue;
    if (!['peer', 'self'].includes(region.sender)) continue;

    const intersection = Math.max(0, Math.min(right, x2) - Math.max(left, x1)) *
      Math.max(0, Math.min(bottom, y2) - Math.max(top, y1));
    const overlap = intersection / itemArea;
    const centerInside = centerX >= x1 && centerX <= x2 && centerY >= y1 && centerY <= y2;
    // OCR text is expected to be inside the detected fill rectangle. The
    // center check tolerates anti-aliased bubble borders and tiny OCR drift.
    if (!centerInside && overlap < 0.08) continue;

    const score = (centerInside ? 2 : 0) + overlap + (Number(region.confidence) || 0) * 0.01;
    if (!best || score > best.score) best = { ...region, score };
  }
  return best;
}

function parseChatMessages(ocrData, detailData, options = {}) {
  const items = ocrData?.items ?? [];
  const w = ocrData?.width ?? 720;
  const h = ocrData?.height ?? 1280;

  const elements = detailData?.elements ?? {};
  const rawBubbleRegions = detailData?.bubbleRegions ?? [];

  // 1. 确定聊天消息的可视上下安全边界
  const backBtn = elements.back_btn?.box;
  const inputBox = elements.input_box?.box;

  const followBox = elements.top_follow_btn?.box;
  const topBoundary = Math.max(backBtn ? backBtn[3] + h * 0.02 : h * 0.11,
    followBox ? followBox[3] + h * .02 : 0);
  const bottomBoundary = inputBox ? inputBox[1] - h * 0.02 : h * 0.88;
  const excludedCards = matchCardRegions(items, rawBubbleRegions, w, h, topBoundary, bottomBoundary);
  const excluded = item => excludedCards.some(card => centerInBox(item, card.box));
  const bubbleRegions = rawBubbleRegions.filter(region => Array.isArray(region.box) &&
    !excluded({ left: region.box[0], top: region.box[1], right: region.box[2], bottom: region.box[3] }));

  // 2. 提取处于中间聊天流区域内的 OCR 文字块
  const messageItems = items.filter(it => {
    const cy = it.center_y ?? (it.top + it.bottom) / 2;
    return cy > topBoundary && cy < bottomBoundary && !excluded(it);
  });


  // 按垂直坐标自上而下排序
  messageItems.sort((a, b) => a.top - b.top || a.left - b.left);

  const messages = [];
  let currentTimestamp = '';
  let postNoticePending = false;

  for (const item of messageItems) {
    const text = (item.text || '').trim();
    if (!text) continue;

    // 过滤掉关注引导提示条（属于顶部交互组件，不属于聊天消息）
    if (isFollowBannerText(text)) {
      continue;
    }

    const cx = item.center_x ?? (item.left + item.right) / 2;
    const cy = item.center_y ?? (item.top + item.bottom) / 2;
    const itemW = item.right - item.left;

    // 检查是否为时间戳或系统提示。固定模板即使落在左侧，也不能按白色
    // 气泡误判为对方消息；isSystemNoticeText 内部已经包含 OCR 容错。
    const isTimestamp = isTimestampText(text);
    const isChatStatusBanner = isChatStatusBannerText(text) ||
      isLikelyChatStatusBanner(text, cx, cy, itemW, w, h);
    const isSystemNotice = isChatStatusBanner || isSystemNoticeText(text);
    const isCentered = cx > w * 0.20 && cx < w * 0.80 && itemW < w * 0.85;

    // 只有居中的系统提示“发布了动态”才开启帖子卡片上下文，
    // 避免普通聊天正文提到“发布了动态”时误过滤下一条消息。
    if (isPublishedPostNotice(text) && isSystemNotice && isCentered) postNoticePending = true;

    if (isTimestamp) {
      currentTimestamp = text;
      messages.push({
        sender: 'system',
        text,
        time: text,
        isTimestamp: true,
        box: [item.left, item.top, item.right, item.bottom],
        center: [cx, cy],
      });
      continue;
    }

    // “已连续互聊X天 / 火花标识已点亮”是聊天页的状态条，不是聊天消息。
    // 即使 OCR 把状态条拆成两段，也分别标记为 system，后续不会进入可见消息序列。
    if (isChatStatusBanner) {
      messages.push({
        sender: 'system',
        text,
        time: currentTimestamp,
        isTimestamp: false,
        isChatStatusBanner: true,
        box: [item.left, item.top, item.right, item.bottom],
        center: [cx, cy],
      });
      continue;
    }

    if (isSystemNotice) {
      messages.push({
        sender: 'system',
        text,
        time: currentTimestamp,
        isTimestamp: false,
        isSystemNotice: true,
        box: [item.left, item.top, item.right, item.bottom],
        center: [cx, cy],
      });
      continue;
    }

    // 只按气泡填充颜色判定发送方。没有颜色证据就保持 unknown，绝不
    // 回退到头像纵坐标、消息左右位置或其它几何猜测。
    const colorMatch = bubbleColorMatch(item, bubbleRegions);
    const sender = colorMatch?.sender ?? 'unknown';

    const isPostCard = postNoticePending && sender === 'peer';
    postNoticePending = false;

    messages.push({
      sender,
      text,
      isPostCard,
      time: currentTimestamp,
      bubbleId: colorMatch?.id ?? null,
      bubbleColor: colorMatch?.color ?? null,
      bubbleConfidence: colorMatch?.confidence ?? null,
      lineHeight: item.bottom - item.top,
      box: [item.left, item.top, item.right, item.bottom],
      center: [cx, cy],
    });
  }

  // 4. 合并同一气泡的多行文本（同一发送者且纵向紧邻）
  const mergedMessages = [];
  for (const msg of messages) {
    if (!mergedMessages.length) {
      mergedMessages.push(msg);
      continue;
    }
    const prev = mergedMessages[mergedMessages.length - 1];
    const verticalGap = msg.box[1] - prev.box[3];

    // 如果为同一非系统发送者且垂直间距极小，且水平位置重合，判定为同条气泡的换行
    if (
      prev.sender === msg.sender &&
      prev.sender !== 'system' &&
      prev.bubbleId !== null && prev.bubbleId === msg.bubbleId &&
      prev.time === msg.time &&
      verticalGap >= 0 &&
      verticalGap < Math.min(prev.lineHeight, msg.lineHeight) * 0.5 &&
      Math.abs(prev.box[0] - msg.box[0]) < w * 0.2
    ) {
      prev.text += ' ' + msg.text;
      prev.isPostCard = Boolean(prev.isPostCard || msg.isPostCard);
      prev.box[2] = Math.max(prev.box[2], msg.box[2]);
      prev.box[3] = msg.box[3];
    } else {
      mergedMessages.push(msg);
    }
  }

  // 5. 计算当前聊天可见区的纯文本指纹（不含坐标像素，彻底消除滑动回弹抖动误差）
  const textItems = messageItems.map(it => it.text.trim()).filter(Boolean);
  const contentSignature = textItems.join('\n');

  const topText = textItems.length > 0 ? textItems[0] : '';
  const bottomText = textItems.length > 0 ? textItems[textItems.length - 1] : '';

  // 会话起源系统提示（打招呼初始消息、加好友通知、历史消息起始等系统气泡）
  const isTopReachedByKeyword = mergedMessages.some(it =>
    it.sender === 'system' &&
    /(?:向你打招呼|通过.*打招呼|通过了.*招呼|成为好友|已成为好友|申请加你为好友|已通过你的好友申请|以下是历史消息)/.test(it.text)
  );

  const skippedPostCards = mergedMessages.filter(message => message.isPostCard);
  const chatMessages = mergedMessages.filter(message => !message.isPostCard);
  const unreadBubbleRegions = bubbleRegions.filter(region => {
    const [left, top, right, bottom] = region.box;
    // 小块头像色斑、时间字形、输入框和被边界切掉的气泡不做强制文字识别。
    // 此处只筛选重读区域；发送方仍然完全来自原气泡的填充颜色。
    if (region.confidence < .65 || top < topBoundary || bottom > bottomBoundary ||
        bottom - top < h * .055 || right - left < w * .075 || right - left > w * .85) return false;
    return !messageItems.some(item => bubbleColorMatch(item, [region]));
  });

  return {
    messages: chatMessages,
    excludedCards,
    unreadBubbleRegions,
    skippedPostCards: skippedPostCards.length,
    topBoundary,
    bottomBoundary,
    contentSignature,
    topText,
    bottomText,
    isTopReachedByKeyword,
    viewport: messageItems.map(it => ({ text: it.text.trim(), box: [it.left, it.top, it.right, it.bottom] })),
    rawCount: messageItems.length,
  };
}


// ====================================================
// 1. 悬浮助手遮挡判定 (Assistant Overlay Assessment)
// ====================================================

function finiteBox(box, width, height) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) &&
    box[0] >= 0 && box[1] >= 0 && box[2] <= width && box[3] <= height &&
    box[0] < box[2] && box[1] < box[3];
}

function boxesOverlap(first, second) {
  if (!finiteBox(first, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) ||
      !finiteBox(second, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) return false;
  return Math.max(0, Math.min(first[2], second[2]) - Math.max(first[0], second[0])) > 0 &&
    Math.max(0, Math.min(first[3], second[3]) - Math.max(first[1], second[1])) > 0;
}

function pointInBox(x, y, box, padding = 0) {
  return x >= box[0] - padding && x <= box[2] + padding &&
    y >= box[1] - padding && y <= box[3] + padding;
}

function assessAssistantOverlay(detailRaw, dimensions = {}) {
  const width = Number(detailRaw?.width ?? dimensions.width ?? 720);
  const height = Number(detailRaw?.height ?? dimensions.height ?? 1280);
  const elements = detailRaw?.elements ?? {};
  const panel = elements.assistant_panel;
  const closeX = elements.assistant_close_x;
  const hasPanel = Boolean(panel);
  const hasCloseX = Boolean(closeX);
  const candidate = hasPanel || hasCloseX || detailRaw?.is_occluded === true;
  const result = {
    confirmed: false,
    candidate,
    blocked: false,
    hasPanel,
    hasCloseX,
    reason: 'assistant_overlay_not_detected',
    panelBox: panel?.box ?? null,
    closeBox: closeX?.box ?? null,
  };

  if (!hasPanel) {
    result.reason = hasCloseX ? 'close_x_without_assistant_panel' : 'assistant_panel_missing';
    return result;
  }

  // 普通在聊资料卡没有关闭X，不判定为阻断
  if (!hasCloseX) {
    result.blocked = false;
    result.reason = 'assistant_panel_without_close_x_treated_as_in_chat_card';
    return result;
  }

  if (!finiteBox(panel.box, width, height) || !finiteBox(closeX.box, width, height)) {
    result.reason = 'assistant_overlay_box_invalid';
    return result;
  }

  const [px1, py1, px2, py2] = panel.box;
  const [cx1, cy1, cx2, cy2] = closeX.box;
  const closeCenter = [(cx1 + cx2) / 2, (cy1 + cy2) / 2];
  const panelWidth = px2 - px1;
  const panelHeight = py2 - py1;

  if (panelWidth < width * 0.35 || panelHeight < height * 0.08 || py1 < height * 0.18) {
    result.reason = 'assistant_panel_geometry_invalid';
    return result;
  }

  const relativeX = (closeCenter[0] - px1) / panelWidth;
  const relativeY = (closeCenter[1] - py1) / panelHeight;
  if (!pointInBox(closeCenter[0], closeCenter[1], panel.box, Math.max(8, width * 0.02)) ||
      relativeX < 0.65 || relativeX > 1.08 || relativeY < -0.12 || relativeY > 0.45) {
    result.reason = 'assistant_close_x_not_in_panel_header';
    return result;
  }

  if (elements.input_box?.box && pointInBox(closeCenter[0], closeCenter[1], elements.input_box.box, 8)) {
    result.reason = 'assistant_close_x_overlaps_input';
    return result;
  }

  const reportedPanel = detailRaw?.occlusion_info?.panel_box;
  if (reportedPanel && finiteBox(reportedPanel, width, height) && !boxesOverlap(panel.box, reportedPanel)) {
    result.reason = 'assistant_panel_evidence_disagrees';
    return result;
  }

  result.confirmed = true;
  result.blocked = false;
  result.reason = 'assistant_panel_and_close_x_confirmed';
  result.closeCenter = closeCenter;
  return result;
}

// ====================================================
// 2. 聊天详情布局与 ROI 计算 (Chat Layout & Input ROI)
// ====================================================

function chatLayout(view) {
  const { width: w, height: h, elements: el } = view ?? {};
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 100 || h < 200 || !el) {
    fail('VISION_PROTOCOL_ERROR', 'Model 2 returned invalid dimensions or elements');
  }
  const assistant = assessAssistantOverlay(view, { width: w, height: h });
  if (assistant.confirmed) {
    fail('APP_OCCLUDED', 'A chat assistant overlay is blocking the chat');
  }

  function isPlausibleAnchor(det, name) {
    if (det.class !== name) return false;
    const [x1, y1, x2, y2] = det.box ?? [];
    if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return false;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    if (name === 'back_btn') return cy <= h * 0.18 && cx <= w * 0.30;
    if (name === 'input_box') return (cy / h) >= 0.25 && (cy / h) <= 0.93 && (x2 - x1) >= w * 0.25;
    if (name === 'send_btn') return cx >= w * 0.45 && cy >= h * 0.25;
    return true;
  }

  function hasConflictingAnchors(detections) {
    if (detections.length <= 1) return false;
    const maxConf = Math.max(...detections.map(d => d.confidence ?? 0.5));
    const significant = detections.filter(d => (d.confidence ?? 0.5) >= Math.max(0.45, maxConf - 0.20));
    if (significant.length <= 1) return false;

    for (let i = 0; i < significant.length; i++) {
      for (let j = i + 1; j < significant.length; j++) {
        const b1 = significant[i].box, b2 = significant[j].box;
        const x1 = Math.max(b1[0], b2[0]), y1 = Math.max(b1[1], b2[1]);
        const x2 = Math.min(b1[2], b2[2]), y2 = Math.min(b1[3], b2[3]);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const union = (b1[2] - b1[0]) * (b1[3] - b1[1]) + (b2[2] - b2[0]) * (b2[3] - b2[1]) - inter;
        if (union > 0 && (inter / union) < 0.4) return true;
      }
    }
    return false;
  }

  function element(name, required = true) {
    const item = el[name];
    if (!item) { if (required) fail('CHAT_NOT_CONFIRMED', 'Required chat anchor is missing', { anchor: name }); return null; }
    const box = item.box;
    if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) ||
        box[0] < 0 || box[1] < 0 || box[2] > w || box[3] > h || box[0] >= box[2] || box[1] >= box[3]) {
      fail('VISION_PROTOCOL_ERROR', 'Model 2 returned invalid coordinates', { anchor: name });
    }
    const plausible = (view.all_detections ?? []).filter(det => isPlausibleAnchor(det, name));
    if (required && hasConflictingAnchors(plausible)) {
      fail('CHAT_ANCHOR_AMBIGUOUS', 'Multiple chat anchors were detected', { anchor: name });
    }
    return { box, x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 };
  }

  const back = element('back_btn'), input = element('input_box'), rawSend = element('send_btn', false);
  const ratio = input.y / h;
  if (back.y > h * .18 || input.box[2] - input.box[0] < w * .25 || ratio < .25 || ratio > .93) {
    fail('CHAT_NOT_CONFIRMED', 'Model 2 anchors do not match a supported chat layout');
  }
  const keyboard = ratio <= .70 ? 'open' : ratio >= .75 ? 'closed' : 'ambiguous';
  let send = null;
  if (rawSend) {
    const verticalTolerance = Math.max(h * 0.10, (input.box[3] - input.box[1]) * 2.5);
    if (rawSend.x >= input.x && Math.abs(rawSend.y - input.y) <= verticalTolerance) {
      send = rawSend;
    }
  }
  return { width: w, height: h, input, send, keyboard, inputCenterRatio: ratio };
}

function inputRegions(layout, candidateRoi) {
  const { width: w, height: h, input: { box: [x1, y1, x2, y2] } } = layout;
  const boxWidth = x2 - x1;
  // 严格避让输入框最右侧表情笑脸 (😊) 及发送按钮边缘，留足 78~85px 避让宽度
  const rightDeduct = Math.max(w * 0.11, boxWidth * 0.205);
  const input = [
    (x1 + w * .02) / w,
    (y1 + (y2 - y1) * .14) / h,
    (x2 - rightDeduct) / w,
    (y2 - (y2 - y1) * .12) / h
  ];
  const fullDeduct = Math.max(w * 0.115, boxWidth * 0.215);
  const fullInput = [
    input[0],
    (y1 + 2) / h,
    (x2 - fullDeduct) / w,
    (y2 - 2) / h
  ];
  return {
    input_roi: input,
    input_full_roi: fullInput,
    candidate_roi: candidateRoi ?? [0.01, Math.min(.84, y2 / h + .09), .98, Math.min(.94, y2 / h + .20)]
  };
}

// ====================================================
// 3. 双层核验联系人 (Double-Layer Verification)
// ====================================================

function verifyChatScreenAndTarget(ocrData, chatLayoutView, expectedPeerName, options = {}) {
  if (!expectedPeerName || typeof expectedPeerName !== 'string') {
    throw new ToolFailure('INVALID_ARGUMENT', 'expectedPeerName is required for target verification');
  }

  const expected = expectedPeerName.trim();
  const items = ocrData?.items ?? [];
  const w = ocrData?.width ?? 720;
  const h = ocrData?.height ?? 1280;

  // 第一层：页面类型核验 (Layer 1: Chat Screen Layout Verification)
  if (chatLayoutView) {
    try {
      chatLayout(chatLayoutView);
    } catch (err) {
      const chatErr = new ToolFailure('CHAT_UNCONFIRMED', `Page is not a confirmed chat screen: ${err.message}`);
      chatErr.details = err.details;
      throw chatErr;
    }
  } else {
    const hasInputHint = items.some(it => /请输入消息|发送/.test(it.text) && it.top > h * 0.7);
    if (!hasInputHint) {
      throw new ToolFailure('CHAT_UNCONFIRMED', 'Page does not have chat input features; not a confirmed chat page');
    }
  }

  // 第二层：目标身份核验 (Layer 2: Target Identity Verification)
  const topBarItems = items.filter(it => it.top < h * 0.16 && it.left > w * 0.12 && it.right < w * 0.88);
  const matchingTitles = topBarItems.filter(it => {
    const text = it.text.trim();
    if (text === expected || text === `与${expected}对话`) return true;
    const cleanText = text.replace(/^与/, '').replace(/对话$/, '').replace(/[.·。，,、…\s]+$/g, '');
    const cleanExpected = expected.replace(/[.·。，,、…\s]+$/g, '');
    return cleanText && cleanExpected && cleanText === cleanExpected;
  });

  if (matchingTitles.length < 1) {
    const foundTitles = topBarItems.map(i => i.text.trim()).join(', ');
    const err = new ToolFailure('TARGET_MISMATCH', `Target mismatch: expected contact "${expected}", but found topbar text: [${foundTitles}]`);
    err.details = { expected, foundTitles };
    throw err;
  }

  matchingTitles.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const matchedTitle = matchingTitles[0];
  const minConfidence = Math.max(0.5, options?.minScore ?? 0.5);
  if (!Number.isFinite(matchedTitle.score) || matchedTitle.score < minConfidence || matchedTitle.score > 1) {
    const err = new ToolFailure('UNVERIFIED_PEER', `Target confidence too low: score=${matchedTitle.score}, min=${minConfidence}`);
    err.details = { expected, score: matchedTitle.score, minConfidence };
    throw err;
  }

  return {
    verified: true,
    matchedTitle: matchedTitle.text.trim(),
    confidence: matchedTitle.score
  };
}

// ====================================================
// 4. 发送证据与气泡比对 (Send Evidence & New Own Bubble)
// ====================================================

function messageEvidence(observation) {
  const ocr = observation?.evidence?.ocrData || observation?.ocr;
  const detail = observation?.evidence?.detailRaw || observation?.detail;
  return parseChatMessages(ocr, detail).messages
    .filter(isConversationMessage)
    .map(m => ({ sender: m.sender, text: m.text, type: m.type || 'text', box: m.box, center: m.center }));
}

function newOwnBubble(beforeMessages, observation, expectedText, { requireChatPage = true } = {}) {
  if (!observation?.ok || (requireChatPage && observation.page !== 'chat_detail')) return false;
  const observedMessages = messageEvidence(observation);

  const hasFreshSelfBubble = observedMessages.some(m =>
    m.sender === 'self' && draftMatches(m.text, expectedText)
  );
  const existedBefore = Array.isArray(beforeMessages) && beforeMessages.some(m =>
    m.sender === 'self' && draftMatches(m.text, expectedText)
  );

  return Boolean(hasFreshSelfBubble && !existedBefore);
}

// ====================================================
// 5. 局部气泡补读 (Chat Bubble Local OCR Completion)
// ====================================================

async function completeChatBubbleOcr(pool, observation, request = {}, wait = promise => promise) {
  let parsed = parseChatMessages(observation.ocr, observation.detail);
  const candidates = parsed.unreadBubbleRegions;
  const items = [...observation.ocr.items];
  const evidence = [];
  for (let start = 0; start < candidates.length; start += 8) {
    const batch = candidates.slice(start, start + 8);
    const regions = batch.map(region => region.box.map((value, axis) =>
      value / (axis % 2 === 0 ? observation.shot.width : observation.shot.height)));
    const result = await wait(pool.ocr(observation.shot.image, { ...request, regions }));
    const data = result?.data || result;
    if (Array.isArray(data?.items)) items.push(...data.items);
    evidence.push(...batch.map((region, index) => ({
      id: region.id, box: region.box,
      ...(data?.regions?.[index] ?? { unresolved: true, items: 0 }),
    })));
  }
  const ocr = candidates.length ? { ...observation.ocr, items } : observation.ocr;
  if (candidates.length) parsed = parseChatMessages(ocr, observation.detail);
  const unresolvedBubbleRegions = evidence.filter(region => region.unresolved);
  return { ...observation, ocr, parsed, bubbleOcr: evidence, unresolvedBubbleRegions };
}

module.exports = {
  // 布局与遮挡
  finiteBox,
  boxesOverlap,
  pointInBox,
  assessAssistantOverlay,
  chatLayout,
  inputRegions,

  // 双层核验
  verifyChatScreenAndTarget,

  // 消息气泡解析
  parseChatMessages,
  isTimestampText,
  isFollowBannerText,
  isChatStatusBannerText,
  isConversationMessage,
  isSystemNoticeText,
  isPublishedPostNotice,
  matchCardRegions,

  // 证据与补读
  messageEvidence,
  newOwnBubble,
  completeChatBubbleOcr
};
