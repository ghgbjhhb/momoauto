'use strict';

const { fail } = require('../runtime');

// Recognition clients return failure envelopes; Promise.all alone cannot detect them.
function recognitionData(result, model, shot) {
  if (result?.ok !== true || !result.data || typeof result.data !== 'object') {
    fail('MOMO_RECOGNITION_FAILED', '聊天识别服务请求失败，请查看失败模型及具体原因。', {
      model, causeCode: result?.error?.code ?? 'INVALID_RESPONSE',
      causeStage: result?.error?.stage ?? 'protocol',
    });
  }
  const data = result.data;
  if (data.width !== shot.width || data.height !== shot.height ||
      (model === 'ocr' && !Array.isArray(data.items)) ||
      (model === 'chatList' && !Array.isArray(data.chat_cards)) ||
      (model === 'chatDetail' && (!data.elements || !Array.isArray(data.bubbleRegions)))) {
    fail('MOMO_RECOGNITION_PROTOCOL_ERROR', '识别结果的尺寸或内容格式与截图不一致。', { model });
  }
  return data;
}

function isChatPage(page, ocr, detailRaw) {
  const items = ocr?.items ?? [];
  const h = ocr?.height ?? 1280;
  const allText = items.map(it => it.text).join(' ');

  // 0. 严格一票否决：真实的聊天详情页绝对没有底栏5个一级Tab（首页/直播/消息/小宇宙/更多），也没有顶栏“马上聊”！
  const hasBottomTabs = items.some(it => it.top > h * 0.82 && /首页|直播|小宇宙|更多/.test(it.text));
  const hasTopMatchTab = items.some(it => it.top < h * 0.16 && /马上聊/.test(it.text));
  if (hasBottomTabs || hasTopMatchTab) {
    return false;
  }

  // 1. 聊天详情页核心业务特征（如用户实图）：
  // - 顶栏标题带有“与...对话”
  const hasChatTitle = items.some(it => it.top < h * 0.16 && /与.*对话/.test(it.text));
  // - 底栏明确有输入框（“请输入消息”或“按住说话”）
  const hasInputBox = items.some(it => it.top > h * 0.70 && /请输入消息|按住说话|按住 发送/.test(it.text));
  // - 聊天特有上下文标记
  const hasChatContext = /发送语音消息|聊天信息|关注TA|相互关注|是否关注对方|关注后可订阅|发起聊天|聊天设置|打个招呼吧/.test(allText);

  if (hasChatTitle || hasInputBox || (hasChatContext && items.some(it => it.top > h * 0.70))) {
    return true;
  }

  // 2. YOLO detailRaw 双控件核验（已通过前置底栏一票否决）
  if (detailRaw?.elements?.input_box && detailRaw?.elements?.back_btn) {
    return true;
  }

  // 3. 只有在不具有消息列表特征的前提下，才参考单一模型判定
  if (page?.is_momo === true && page.page_level === '2级消息页' && page.sub_page === '聊天详情页') {
    const hasMsgListContent = /收到的招呼|互动通知|最近在线/.test(allText);
    if (!hasMsgListContent) {
      return true;
    }
  }

  return false;
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

module.exports = { recognitionData, isChatPage, isMessageListPage };
