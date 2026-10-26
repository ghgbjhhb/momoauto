'use strict';

/**
 * MOMO 聊天历史对齐与多帧同步中枢 (Chat History Alignment & Multi-Frame Sync)
 *
 * 聚合原:
 * 1. message-merge.js (纯序列对齐、无重叠/多解歧义核验)
 * 2. chat-history.js (视口稳定判定、向上翻页 prepend、向下翻页 append、气泡文本模糊匹配)
 * 3. chat-frame.js (单帧解析提取、补读请求批次下发、相邻帧稳定判定、历史前后向合并)
 */

const { fail, ToolFailure } = require('../runtime');
const {
  isConversationMessage,
  isTimestampText,
  isSystemNoticeText,
  isFollowBannerText,
  isPublishedPostNotice,
  matchCardRegions
} = require('./chat-detail-parser');
const { recognitionData } = require('./recognition-check');

// ====================================================
// 1. 文本与消息规范化与等价性比对
// ====================================================

const textOf = value => String(value ?? '').normalize('NFC').trim();

function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text.normalize('NFC').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();

function isMessageEqual(a, b) {
  if (!a || !b) return false;
  if (a.sender !== b.sender) return false;
  if ((a.type || 'text') !== (b.type || 'text')) return false;
  return normalizeText(a.rawText || a.text) === normalizeText(b.rawText || b.text);
}

function fuzzyTextMatches(first, second) {
  const shorter = first.length <= second.length ? first : second;
  const longer = first.length <= second.length ? second : first;
  if (shorter.length < 6) return false;
  const allowance = Math.min(2, Math.floor(longer.length * .15));
  if (Math.abs(first.length - second.length) > allowance) return false;
  const row = Array.from({ length: second.length + 1 }, (_, i) => i);
  for (let i = 1; i <= first.length; i++) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= second.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (first[i - 1] === second[j - 1] ? 0 : 1));
      diagonal = saved;
    }
  }
  return row[second.length] <= allowance;
}

function sameMessage(a, b) {
  const aText = textOf(a.text).replace(/\s+/g, '');
  const bText = textOf(b.text).replace(/\s+/g, '');
  if (!aText || !bText) return false;

  const stripPunctuation = value => value.replace(/[，。！？、,.!?：:；;“”‘’"'…]/g, '');
  const aComparable = stripPunctuation(aText);
  const bComparable = stripPunctuation(bText);
  const shorter = aComparable.length <= bComparable.length ? aComparable : bComparable;
  const longer = aComparable.length <= bComparable.length ? bComparable : aComparable;
  const textMatches = aText.normalize('NFKC') === bText.normalize('NFKC') ||
    (aComparable.length > 0 && aComparable === bComparable) ||
    (shorter.length >= 8 && shorter.length / longer.length >= .8 && longer.includes(shorter)) ||
    fuzzyTextMatches(aComparable, bComparable);
  const senderMatches = a.sender === b.sender || a.sender === 'unknown' || b.sender === 'unknown';
  return textMatches && senderMatches;
}

// ====================================================
// 2. 纯序列对齐 (Pure Sequence Alignment)
// ====================================================

function alignMessageSequences(archivedMessages = [], observedMessages = [], options = {}) {
  const tailWindow = options.tailWindow ?? 30;

  if (!Array.isArray(observedMessages) || observedMessages.length === 0) {
    return {
      status: 'aligned',
      overlapCount: 0,
      matchedAnchorIndex: -1,
      newMessages: [],
      reason: 'No observed messages'
    };
  }

  if (!Array.isArray(archivedMessages) || archivedMessages.length === 0) {
    return {
      status: 'aligned',
      overlapCount: 0,
      matchedAnchorIndex: -1,
      newMessages: [...observedMessages],
      reason: 'Archived history is empty, all observed are new'
    };
  }

  const archiveTail = archivedMessages.slice(-tailWindow);
  const validOverlaps = [];
  const maxPossibleOverlap = Math.min(archiveTail.length, observedMessages.length);

  for (let overlapLen = 1; overlapLen <= maxPossibleOverlap; overlapLen++) {
    const archiveSlice = archiveTail.slice(archiveTail.length - overlapLen);
    const observedSlice = observedMessages.slice(0, overlapLen);

    let match = true;
    for (let i = 0; i < overlapLen; i++) {
      if (!isMessageEqual(archiveSlice[i], observedSlice[i])) {
        match = false;
        break;
      }
    }

    if (match) {
      validOverlaps.push({
        overlapLen,
        newCount: observedMessages.length - overlapLen,
        newMessages: observedMessages.slice(overlapLen)
      });
    }
  }

  if (validOverlaps.length === 0) {
    return {
      status: 'no_overlap',
      overlapCount: 0,
      matchedAnchorIndex: -1,
      newMessages: [],
      reason: 'No overlap found between observed prefix and archive tail (need scroll up)'
    };
  }

  if (validOverlaps.length > 1) {
    const distinctNewCounts = new Set(validOverlaps.map(v => v.newCount));
    if (distinctNewCounts.size > 1) {
      return {
        status: 'ambiguous',
        overlapCount: 0,
        matchedAnchorIndex: -1,
        newMessages: [],
        reason: 'Multiple valid alignment lengths yield conflicting new message counts'
      };
    }
  }

  validOverlaps.sort((a, b) => b.overlapLen - a.overlapLen);
  const best = validOverlaps[0];

  if (best.overlapLen === 1) {
    const singleMsg = observedMessages[0];
    const occurrencesInTail = archiveTail.filter(m => isMessageEqual(m, singleMsg)).length;
    if (occurrencesInTail > 1) {
      return {
        status: 'ambiguous',
        overlapCount: 1,
        matchedAnchorIndex: -1,
        newMessages: [],
        reason: 'Single-item overlap is ambiguous because same message appears multiple times in archive tail'
      };
    }
  }

  return {
    status: 'aligned',
    overlapCount: best.overlapLen,
    matchedAnchorIndex: best.overlapLen - 1,
    newMessages: best.newMessages,
    reason: `Aligned with overlap length ${best.overlapLen}`
  };
}

// ====================================================
// 3. 视口稳定与几何对齐 (Viewport Stability & Geometry)
// ====================================================

function viewportStable(previous, current, height) {
  if (previous.contentSignature && current.contentSignature && previous.contentSignature === current.contentSignature) {
    return true;
  }
  const a = previous.viewport ?? [], b = current.viewport ?? [];
  if (!a.length || a.length !== b.length) return false;
  const epsilon = Math.max(12, height * 0.015);
  return a.every((item, i) => textOf(item.text) === textOf(b[i].text) &&
    item.box.every((v, axis) => Math.abs(v - b[i].box[axis]) <= epsilon));
}

function yOf(message) {
  return Array.isArray(message?.box) && Number.isFinite(message.box[1]) ? message.box[1] : null;
}

function overlapShiftIsConsistent(first, second, height) {
  const shifts = first.map((message, index) => {
    const a = yOf(message), b = yOf(second[index]);
    return a === null || b === null ? null : a - b;
  }).filter(value => value !== null);
  if (!shifts.length) return true;
  const epsilon = Math.max(12, height * 0.04);
  return Math.max(...shifts) - Math.min(...shifts) <= epsilon;
}

function visibleMessages(parsed) {
  return (parsed.messages || []).filter(message => isConversationMessage(message) && !message.isPostCard);
}

function chatMessagesStable(previous, current, height) {
  const first = visibleMessages(previous), second = visibleMessages(current);
  if (!first.length || first.length !== second.length) return false;
  const epsilon = Math.max(8, height * .0125);
  return first.every((message, index) => sameMessage(message, second[index]) &&
    message.sender === second[index].sender &&
    (!message.box || !second[index].box || Math.abs(message.box[1] - second[index].box[1]) <= epsilon));
}

function upwardOverlap(previous, current, height) {
  let best = 0;
  for (let count = 1; count <= Math.min(previous.length, current.length); count++) {
    const head = previous.slice(0, count), tail = current.slice(-count);
    if (!tail.every((message, i) => sameMessage(message, head[i]))) continue;
    if (!overlapShiftIsConsistent(head, tail, height)) continue;
    const shifts = tail.map((message, i) => yOf(message) === null || yOf(head[i]) === null ? 0 : yOf(message) - yOf(head[i]));
    if (Math.min(...shifts) < -Math.max(12, height * .04)) continue;
    best = count;
  }
  return best;
}

function appendChatPage(history, previous, current, height) {
  if (!history.length) {
    const initial = current.map(message => ({ ...message }));
    history.push(...initial);
    return initial;
  }
  if (!current.length) return [];
  if (!previous.length) {
    const initial = current.map(message => ({ ...message }));
    history.push(...initial);
    return initial;
  }
  const candidates = [];
  const epsilon = Math.max(5, height * 0.015);
  for (let count = 1; count <= Math.min(previous.length, current.length); count++) {
    const tail = previous.slice(-count), head = current.slice(0, count);
    if (!tail.every((message, i) => sameMessage(message, head[i]))) continue;
    const shifts = tail.map((message, i) => head[i].box[1] - message.box[1]);
    if (Math.max(...shifts) > height * 0.02 || Math.max(...shifts) - Math.min(...shifts) > epsilon) continue;
    candidates.push(count);
  }
  if (!candidates.length) {
    fail(
      'MOMO_HISTORY_OVERLAP_NOT_FOUND',
      '无法安全拼接相邻的历史聊天页面：前后两页没有找到可确认的重复消息，可能是 OCR 识别不完整、上滑距离过大或页面尚未稳定。',
    );
  }
  const overlap = Math.max(...candidates);
  const page = current.map(message => ({ ...message }));
  const oldTail = history.slice(-overlap);
  page.slice(0, overlap).forEach((message, i) => {
    if (!message.time) message.time = oldTail[i].time ?? '';
    if (!oldTail[i].time && message.time) oldTail[i].time = message.time;
  });
  let time = history[history.length - 1]?.time ?? '';
  for (const message of page.slice(overlap)) {
    if (!message.time) message.time = time;
    time = message.time;
    history.push(message);
  }
  return page;
}

function prependChatPage(history, previous, current, height) {
  if (!current.length) return [];
  if (!history.length || !previous.length) {
    const initial = current.map(message => ({ ...message }));
    history.unshift(...initial);
    return initial;
  }

  const candidates = [];
  const adjacentOverlap = upwardOverlap(previous, current, height);
  if (adjacentOverlap) candidates.push(adjacentOverlap);
  if (!candidates.length && history.length > previous.length) {
    for (let count = previous.length + 1; count <= Math.min(history.length, current.length); count++) {
      const tail = current.slice(-count), head = history.slice(0, count);
      if (!tail.every((message, i) => sameMessage(message, head[i]))) continue;
      if (!overlapShiftIsConsistent(head, tail, height)) continue;
      candidates.push(count);
    }
  }
  if (!candidates.length) {
    fail(
      'MOMO_HISTORY_OVERLAP_NOT_FOUND',
      '无法安全拼接相邻的历史聊天页面：前后两页没有找到可确认的重复消息，可能是 OCR 识别不完整、上滑距离过大或页面尚未稳定。',
    );
  }

  const overlap = Math.max(...candidates);
  const page = current.map(message => ({ ...message }));
  const shared = page.slice(-overlap);
  const sharedHistory = history.slice(0, overlap);
  shared.forEach((message, i) => {
    if (!message.time) message.time = sharedHistory[i]?.time ?? '';
    if (sharedHistory[i] && !sharedHistory[i].time && message.time) sharedHistory[i].time = message.time;
  });

  const older = page.slice(0, page.length - overlap);
  history.unshift(...older);
  return page;
}

// ====================================================
// 4. 多帧几何与卡片解析 (Frame Extraction & Cards)
// ====================================================

const center = box => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
const rect = item => [item.left, item.top, item.right, item.bottom];
const contains = (box, point) => point[0] >= box[0] && point[0] <= box[2] && point[1] >= box[1] && point[1] <= box[3];
const area = box => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);

function coverage(inner, outer) {
  return Math.max(0, Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0])) *
    Math.max(0, Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1])) / Math.max(1, area(inner));
}

function extractChatContactName(ocr) {
  const w = ocr?.width ?? 720, h = ocr?.height ?? 1280;
  const names = (ocr?.items ?? []).filter(item => item.top < h * .16 && item.left > w * .12 && item.right < w * .9)
    .map(item => normalize(item.text).match(/^与(.{1,80}?)(?:对话|聊天)$/)?.[1]).filter(Boolean);
  return new Set(names).size === 1 ? names[0] : null;
}

function systemText(text) {
  return isTimestampText(text) || isSystemNoticeText(text) || isFollowBannerText(text) ||
    /点击.{0,5}底栏.{0,6}表情|海量表情任意搜|按住说话|对方正在输入|点亮火花|快捷发送|积火花/.test(normalize(text));
}

function parseFrame(ocr, detail) {
  const width = ocr.width, height = ocr.height;
  const items = ocr.items.filter(item => String(item.text ?? '').trim()).slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const elements = detail.elements ?? {};
  const followItems = items.filter(it => (it.top ?? 0) < height * 0.25 && isFollowBannerText(it.text));
  const followBannerBottom = followItems.length ? Math.max(...followItems.map(it => it.bottom ?? 0)) + height * 0.02 : 0;
  let top = Math.max(
    elements.back_btn?.box?.[3] + height * .015 || height * .115,
    elements.top_follow_btn?.box?.[3] + height * .02 || 0,
    followBannerBottom
  );
  const bottom = elements.input_box?.box?.[1] ?? height * .87;
  const regions = (detail.bubbleRegions || []).filter(region => Array.isArray(region.box));
  const cards = matchCardRegions(items, regions, width, height, top, bottom);

  // 关键结构契约：顶部若存在系统卡片/关注弹窗，有效聊天流的顶部必须在其下边缘之下
  const topCards = cards.filter(c => c.box[1] < height * 0.35);
  if (topCards.length) {
    top = Math.max(top, ...topCards.map(c => c.box[3]));
  }

  const ignored = [], messages = [], pending = [], clipped = [];
  const valid = regions.filter(region => {
    const box = region.box;
    if (box[3] <= top || box[1] >= bottom || box[2] - box[0] > width * .88) return false;
    if (cards.some(card => contains(card.box, center(box)))) return false;
    const isCenteredWide = (box[2] - box[0]) > width * 0.52 &&
      Math.abs((box[0] + box[2]) / 2 - width / 2) < width * 0.08 &&
      Math.abs(box[0] - (width - box[2])) < width * 0.08;
    if (isCenteredWide) return false;
    return region.shapeVerified !== false && region.kind !== 'decoration';
  });
  const groups = new Map(valid.map(region => [region.id, []]));
  const notices = [];
  for (const item of items) {
    const box = rect(item), point = center(box);
    if (point[1] <= top || point[1] >= bottom) continue;
    if (cards.some(card => contains(card.box, point))) { ignored.push({ text: item.text, reason: '系统资料卡', box }); continue; }
    const matches = valid.filter(region => contains(region.box, point) && coverage(box, region.box) >= .65)
      .sort((a, b) => area(a.box) - area(b.box));
    const match = matches[0];
    if (!match) {
      const notice = systemText(item.text);
      ignored.push({ text: item.text, reason: notice ? '系统提示' : '文字不在已确认气泡内', box });
      if (notice) notices.push({ text: item.text, box });
      continue;
    }
    if (!match.shapeVerified && systemText(item.text)) { notices.push({ text: item.text, box }); continue; }
    groups.get(match.id).push(item);
  }
  const postNotices = notices.filter(notice => isPublishedPostNotice(notice.text));
  const postRegions = new Set(postNotices.map(notice => valid.filter(region => region.box[1] >= notice.box[3] - 4)
    .sort((a, b) => a.box[1] - b.box[1])[0]?.id).filter(Boolean));
  for (const region of valid) {
    if (postRegions.has(region.id)) { ignored.push({ reason: '动态帖子卡片', box: region.box }); continue; }
    const lines = groups.get(region.id).filter((item, index, all) => !all.slice(0, index).some(old =>
      coverage(rect(item), rect(old)) > .75 && normalize(item.text) === normalize(old.text)));
    const bubbleH = region.box[3] - region.box[1];
    // 物理残缺气泡不变量：真机单行聊天气泡最小高度至少 70px (height * 0.055)。
    // 若气泡高度不足 (如被关注浮层、顶底栏横切成半截) 或边界越界，判定为 clipped，绝不作为完整消息进入 messages
    const isUndersized = bubbleH < height * 0.052;
    const isBoundaryClipped = region.box[1] < top + 6 || region.box[3] > bottom - 6;
    if (isUndersized || isBoundaryClipped) {
      clipped.push({ ...region, text: lines.map(item => item.text).join(' ') }); continue;
    }
    if (!lines.length) {
      if (region.box[3] - region.box[1] >= height * .045 && region.box[2] - region.box[0] >= width * .07)
        pending.push(region);
      continue;
    }
    const sender = region.color === 'pink' ? 'self' : ['white', 'yellow', 'gold'].includes(region.color) ? 'peer' : (region.sender ?? 'unknown');
    const message = { sender, text: lines.map(item => item.text.trim()).join(' '), box: region.box,
      bubbleId: region.id, confidence: Math.min(...lines.map(item => Number(item.score ?? .85))) };
    if (sender === 'unknown') pending.push({ ...region, reason: '气泡发送方颜色未确认', text: message.text });
    else messages.push(message);
  }
  messages.sort((a, b) => a.box[1] - b.box[1]);
  const originNotice = notices.some(notice =>
    /(?:向你|通过.*)打招呼|通过了.*招呼|成为好友|已成为好友|申请加你为好友|已通过你的好友申请|以下是历史消息|没有更多历史消息|到顶了/.test(notice.text)
  );
  const originCard = cards.some(card => {
    const coreKinds = ['profile', 'follow', 'encounter'].filter(kind => card.evidence.includes(kind));
    const hasStructure = coreKinds.length >= 2 || (card.evidence.includes('title') && coreKinds.length >= 1);
    const hasMessages = messages.length > 0;
    return hasStructure && (!hasMessages || messages.some(message => message.box[1] >= card.box[3] - height * .025));
  });
  const origin = originNotice || originCard;
  return { width, height, top, bottom, messages, pending, clipped, ignored, cards, notices, origin,
    contactName: extractChatContactName(ocr) };
}

async function readFrame(pool, observation, request = {}, wait = promise => promise) {
  let parsed = parseFrame(observation.ocr, observation.detail);
  const items = [...observation.ocr.items], reread = [];
  for (let offset = 0; offset < parsed.pending.length; offset += 8) {
    const batch = parsed.pending.slice(offset, offset + 8).filter(region => !region.text);
    if (!batch.length) continue;
    const regions = batch.map(region => region.box.map((v, axis) => Math.max(0, Math.min(1, v / (axis % 2 ? parsed.height : parsed.width)))));
    const result = await wait(pool.ocr(observation.shot.image, { ...request, regions }));
    const data = recognitionData(result, 'ocr', observation.shot);
    items.push(...data.items);
    reread.push(...batch.map((region, index) => ({ ...region, ...(data.regions?.[index] ?? {}), id: region.id })));
  }
  const ocr = { ...observation.ocr, items };
  parsed = parseFrame(ocr, observation.detail);
  const nonText = reread.filter(region => region.kind === 'non_text' || (region.items === 0 && region.unresolved === false));
  parsed.pending = parsed.pending.filter(region => !nonText.some(item => item.id === region.id));
  parsed.ignored.push(...nonText.map(region => ({ reason: '非文字气泡或表情', box: region.box })));
  return { ...observation, ocr, parsed, reread };
}

function stableFrames(first, second, tolerance = .015) {
  if (!first || first.messages.length !== second.messages.length) return false;
  if (first.pending.length || second.pending.length) return false;
  if (first.messages.length) return first.messages.every((message, i) => sameMessage(message, second.messages[i]) &&
    message.sender === second.messages[i].sender && Math.abs(message.box[1] - second.messages[i].box[1]) <= second.height * tolerance);
  if (!first.origin || !second.origin) return false;
  const a = first.notices.filter(n => /招呼|好友|历史消息/.test(n.text));
  const b = second.notices.filter(n => /招呼|好友|历史消息/.test(n.text));
  if (!a.length && !b.length && first.cards.some(card => ['profile', 'follow', 'encounter'].every(kind => card.evidence.includes(kind))))
    return first.cards.some(card => second.cards.some(other => ['profile', 'follow', 'encounter'].every(kind => other.evidence.includes(kind)) &&
      Math.abs(card.box[1] - other.box[1]) <= second.height * tolerance && Math.abs(card.box[3] - other.box[3]) <= second.height * tolerance));
  return a.length > 0 && a.length === b.length && a.every((notice, i) => normalize(notice.text) === normalize(b[i].text) &&
    Math.abs(notice.box[1] - b[i].box[1]) <= second.height * tolerance);
}

function mergeOlder(history, previous, current, height) {
  if (!current.length) return { ok: false, reason: 'no_text' };
  const candidates = [];
  for (let count = 1; count <= Math.min(previous.length, current.length); count++) {
    const oldHead = previous.slice(0, count), newTail = current.slice(-count);
    if (!oldHead.every((message, i) => sameMessage(message, newTail[i]) && message.sender === newTail[i].sender)) continue;
    const shifts = newTail.map((message, i) => message.box[1] - oldHead[i].box[1]);
    if (Math.min(...shifts) < -height * .04 || Math.max(...shifts) - Math.min(...shifts) > height * .05) continue;
    candidates.push(count);
  }
  if (!candidates.length) return { ok: false, reason: 'no_overlap' };
  const overlap = Math.max(...candidates), added = current.slice(0, -overlap).map(message => ({ ...message }));
  history.unshift(...added);
  return { ok: true, overlap, added: added.length };
}

function mergeNewer(history, previous, current, height) {
  if (!current.length) return { ok: false, reason: 'no_text' };
  const candidates = [];
  for (let count = 1; count <= Math.min(previous.length, current.length); count++) {
    const oldTail = previous.slice(-count), newHead = current.slice(0, count);
    if (!oldTail.every((message, i) => sameMessage(message, newHead[i]) && message.sender === newHead[i].sender)) continue;
    const shifts = newHead.map((message, i) => message.box[1] - oldTail[i].box[1]);
    if (Math.max(...shifts) > height * .04 || Math.max(...shifts) - Math.min(...shifts) > height * .05) continue;
    candidates.push(count);
  }
  if (!candidates.length) return { ok: false, reason: 'no_overlap' };
  const overlap = Math.max(...candidates), added = current.slice(overlap).map(message => ({ ...message }));
  history.push(...added);
  return { ok: true, overlap, added: added.length };
}

module.exports = {
  // 文本规范与相等性
  normalizeText,
  normalize,
  isMessageEqual,
  sameMessage,
  fuzzyTextMatches,

  // 纯序列对齐
  alignMessageSequences,

  // 视口与页面对齐
  viewportStable,
  visibleMessages,
  chatMessagesStable,
  upwardOverlap,
  appendChatPage,
  prependChatPage,

  // 帧解析与合并
  parseFrame,
  readFrame,
  stableFrames,
  mergeOlder,
  mergeNewer,
  extractChatContactName,
  coverage
};
