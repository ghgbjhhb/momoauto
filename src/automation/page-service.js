'use strict';

/**
 * MOMO 统一页面分析服务 (Unified Page Observation Service)
 *
 * 遵循中枢执行计划第 4 节与 R2/B1 门禁：
 * 1. 全局唯一判断入口：所有业务页面判断统一走此服务，禁止各脚本各自猜测。
 * 2. 同帧证据绑定与原始数据回传 (F02)：完整保留 pageRaw, ocrData, listRaw, detailRaw 供上层准确消费。
 * 3. 严格失败封闭 (F07)：截图或识别失败明确返回 ok:false，绝不伪造或猜测未知页面。
 * 4. 关键安全守卫优先 (F12)：人机滑块、登录失效、平台风控等守卫优先级绝对高于 safe_dismissible 浮窗。
 * 5. 帧来源与时效校验 (F19)：校验外部传入快照的 deviceId 与 generation，杜绝旧帧或跨设备混用。
 */

const { randomUUID } = require('node:crypto');
const { isChatPage, isMessageListPage } = require('../tools/momo/recognition-check');
const { classifyGreetingsScreen } = require('../tools/momo/greetings-layout');
const { assessAssistantOverlay, chatLayout } = require('../tools/momo/chat-detail-parser');
const { checkSignal, waitFor } = require('./cancellation');

function classifyApp(pageRaw, ocrItems = []) {
  if (pageRaw?.is_momo === true) return 'momo';

  // 检查是否在 Android 桌面 (Launcher)
  const isLauncher = ocrItems.some(it => {
    const t = it.text.trim();
    return /^(陌陌|MOMO|设置|文件管理|图库|相机|浏览器)$/.test(t);
  }) && !ocrItems.some(it => /关注|推荐|附近|动态|消息|通讯录/.test(it.text));

  if (isLauncher) return 'android_launcher';
  return pageRaw?.app_name || 'unknown';
}

function classifyOverlay(ocrItems = [], detailRaw = null, h = 1280) {
  const allText = ocrItems.map(it => it.text).join(' ');

  // 1. 安全验证/人机滑块 (Captcha) - HIGHEST PRIORITY (F12)
  if (/安全验证|拖动滑块|图形验证码|拖动下方滑块/.test(allText)) {
    return 'captcha';
  }

  // 2. 登录/失效重登 (Login)
  if (/请重新登录|登录已过期|密码登录|验证码登录/.test(allText)) {
    return 'login';
  }

  // 3. 平台限频/风控 (Risk)
  if (/操作过于频繁|请稍后再试|发送过于频繁/.test(allText)) {
    return 'risk';
  }

  // 4. 系统权限弹窗 (Permission)
  if (/是否允许.*访问|定位权限|存储权限|允许|拒绝/.test(allText) && ocrItems.some(it => it.text === '仅在使用中允许')) {
    return 'permission';
  }

  // 5. 退出/二次确认弹窗 (Exit Confirm)
  if (/确定要退出|暂不退出|确认放弃/.test(allText)) {
    return 'exit_confirm';
  }

  // 6. 悬浮助手关闭叉 (Safe Dismissible) - 必须同帧确认面板和面板内的 X
  const assistant = assessAssistantOverlay(detailRaw);
  if (assistant.confirmed) {
    return 'safe_dismissible';
  }
  // 面板存在但没有可靠关闭目标时，阻止所有后续动作；绝不猜坐标。
  if (assistant.blocked) return 'assistant_unconfirmed';

  // 7. 应用版本更新弹窗 (App Update Dialog) - 居中弹窗，右上角带 X 关闭按钮
  const isUpdate = (
    /(?:检测(?:应用市场)?有)?新版本可升级|版本更新|发现新版本|有新版本可升级/.test(allText) &&
    ocrItems.some(it => /立即升级|马上升级|更新内容|修复已知问题|并提升APP性能|请你保持更新/.test(it.text))
  );
  if (isUpdate) {
    return 'app_update';
  }

  // 8. 语音/视频来电悬浮窗 (Incoming Call Overlay) - 屏幕顶部呼叫通知
  const topItems = ocrItems.filter(it => {
    if (!it.text || it.top > h * 0.20) return false;
    if (/活动|快来|送给|订阅|充值|游戏/.test(it.text)) return false;
    return /正打给你|打给你|正在呼叫|呼叫中|等待接听|他正在线|邀(?:请)?(?:你)?(?:进行|发起)?(?:语音|视频)|来自(?:视频|语音)(?:聊天|通话)|(?:视频|语音)(?:通话|聊天|电话)|聊.*(?:分|秒).*红包/.test(it.text);
  });
  const topText = topItems.map(it => it.text).join(' ');
  const hasCall = (
    /正打给你|打给你|来自(?:视频|语音)(?:聊天|通话)|邀(?:请)?(?:你)?(?:进行|发起)?(?:语音|视频)(?:聊天|通话|电话)|正在呼叫你?|发来(?:语音|视频)(?:聊天|通话|电话)|(?:语音|视频)(?:聊天|通话|电话)邀请/.test(topText) ||
    ((/他正在线|正在呼叫|呼叫中|等待接听/.test(topText)) && /(?:语音|视频)(?:聊天|通话|电话)/.test(topText))
  );
  if (hasCall && topItems.length > 0) {
    return 'incoming_call';
  }

  return 'none';
}

function classifyPageAndScene(app, pageRaw, ocrData, listRaw, detailRaw) {
  const ocrItems = ocrData?.items || [];
  const w = ocrData?.width || 720;
  const h = ocrData?.height || 1280;

  if (app === 'android_launcher') {
    return { page: 'other', scene: 'launcher' };
  }

  // 1. 优先核验收到的招呼专用界面状态
  const greetingsRes = classifyGreetingsScreen(ocrData, pageRaw, detailRaw);
  const greetingsState = greetingsRes?.state;

  if (greetingsState === 'card') {
    return { page: 'greetings', scene: 'greetings_card' };
  }
  if (greetingsState === 'empty_or_list') {
    return { page: 'greetings', scene: 'greetings_list' };
  }
  if (greetingsState === 'rate_limited') {
    return { page: 'greetings', scene: 'rate_limited' };
  }

  // 2. 消息列表页优先判定（如果有底栏一级Tab且有顶栏消息，绝不能被错判为聊天详情页）
  if (isMessageListPage(pageRaw, { items: ocrItems, height: h }) || greetingsState === 'message_list') {
    return { page: 'message_list', scene: 'normal' };
  }

  // 3. 聊天详情页判定 (需排除底栏导航Tab，支持模型分类 + 语义融合 + YOLO双控件)
  if (isChatPage(pageRaw, { items: ocrItems, height: h }, detailRaw)) {
    let scene = 'normal';
    if (ocrItems.some(it => it.top < h * 0.16 && /设置|聊天信息/.test(it.text))) {
      scene = 'chat_settings';
    }
    return { page: 'chat_detail', scene };
  }

  // 4. 首页动态瀑布流判定
  if (pageRaw?.sub_page === '首页' || greetingsState === 'home_feed' || ocrItems.some(it => /附近动态|关注动态|热门/.test(it.text))) {
    return { page: 'home_feed', scene: 'normal' };
  }

  return { page: 'other', scene: 'unknown' };
}

function detectKeyboardState(page, detailRaw, ocrItems = [], h = 1280) {
  if (page !== 'chat_detail') return 'closed';

  if (detailRaw?.elements?.input_box) {
    try {
      const layout = chatLayout({
        width: detailRaw.width || 720,
        height: detailRaw.height || h,
        elements: detailRaw.elements,
        is_occluded: false
      });
      return layout.keyboard;
    } catch {}
  }

  // OCR 辅助判断：输入框位于屏幕中上部 (<= 0.70h) 则键盘展开
  const inputItem = ocrItems.find(it => /请输入消息/.test(it.text));
  if (inputItem) {
    return (inputItem.top / h) <= 0.70 ? 'open' : 'closed';
  }

  return 'unknown';
}

/**
 * 核心统一页面观测函数
 *
 * @param {object} session - 包含 deviceId, generation, pool, tools 等上下文
 * @param {object} [options]
 * @param {object} [options.frame] - 可选直接传入已有截图快照，不重复取图
 * @returns {Promise<object>} PageObservation
 */
async function observePageInternal(session, options = {}) {
  checkSignal(options.signal);
  const deviceId = session?.deviceId || 'unknown-device';
  const generation = session?.control?.generation ?? session?.control?._generation ?? session?.generation ?? 1;
  const capturedAt = new Date().toISOString();

  let shot = options.frame || options.shot;

  // 1. 外部传入帧的合法性与时效性校验 (F19)
  if (shot) {
    if (shot.deviceId && shot.deviceId !== deviceId) {
      return {
        ok: false,
        snapshotId: shot.snapshotId || 'mismatched_frame',
        deviceId,
        error: {
          code: 'FRAME_MISMATCH',
          message: `Frame deviceId "${shot.deviceId}" does not match session deviceId "${deviceId}"`
        }
      };
    }
    if (shot.generation !== undefined && shot.generation !== generation) {
      return {
        ok: false,
        snapshotId: shot.snapshotId || 'stale_frame',
        deviceId,
        error: {
          code: 'FRAME_STALE',
          message: `Frame generation "${shot.generation}" does not match session generation "${generation}"`
        }
      };
    }
    if (!options.analysisOnly && (!shot.deviceId || shot.generation === undefined || !shot.capturedAt)) {
      return { ok: false, deviceId, error: { code: 'FRAME_UNBOUND', message: 'External live frames require device, connection generation and capture time' } };
    }
    if (shot.capturedAt) {
      const ageMs = Date.now() - new Date(shot.capturedAt).getTime();
      const maxAgeMs = options.maxFrameAgeMs ?? 10000;
      if (isNaN(ageMs) || ageMs > maxAgeMs || ageMs < -5000) {
        return {
          ok: false,
          snapshotId: shot.snapshotId || 'stale_frame',
          deviceId,
          error: {
            code: 'FRAME_STALE',
            message: `Supplied frame is too old (age: ${ageMs}ms, max: ${maxAgeMs}ms)`
          }
        };
      }
    }
  } else {
    // 2. 自行采集新鲜高清截图并核验失败封闭 (F07)
    if (!session?.tools?.screenshot) {
      return {
        ok: false,
        snapshotId: 'snap_' + randomUUID().replace(/-/g, ''),
        deviceId,
        error: { code: 'NO_SCREENSHOT_PROVIDER', message: 'No screenshot provider found in session' }
      };
    }
    const res = await waitFor(session.tools.screenshot({ source: 'stream', maxSize: 1280, maxAgeMs: 0, signal: options.signal,
      timeoutMs: options.timeoutMs || 15000 }), { signal: options.signal, timeoutMs: options.timeoutMs || 15000 });
    if (!res || res.ok === false || !res.data || !res.data.image) {
      return {
        ok: false,
        snapshotId: 'snap_failed',
        deviceId,
        error: res?.error || { code: 'SCREENSHOT_FAILED', message: 'Screenshot capture failed or returned empty image' }
      };
    }
    shot = res.data;
  }

  const snapshotId = shot.snapshotId || ('snap_' + randomUUID().replace(/-/g, ''));
  if (!shot.image?.length || !Number.isInteger(shot.width) || !Number.isInteger(shot.height) || shot.width < 1 || shot.height < 1) {
    return { ok: false, deviceId, snapshotId, error: { code: 'INVALID_IMAGE', message: 'Screenshot dimensions or pixels are missing' } };
  }

  const pool = session?.pool || session?.recognitionPool;
  let pageRaw = options.pageRaw || null;
  let ocrData = options.ocrData || null;
  let listRaw = options.listRaw || null;
  let detailRaw = options.detailRaw || null;

  if (!pool && !pageRaw && !ocrData) {
    return {
      ok: false,
      snapshotId,
      deviceId,
      error: {
        code: 'NO_RECOGNITION_PROVIDER',
        message: 'No recognition pool or precomputed recognition evidence provided'
      }
    };
  }

  // 3. 按需并发派发视觉模型
  if (pool && shot?.image) {
    const req = { timeoutMs: options.timeoutMs || 15000, signal: options.signal };
    try {
      const [pRes, oRes] = await waitFor(Promise.all([
        pageRaw ? Promise.resolve({ ok: true, data: pageRaw }) : pool.page(shot.image, req),
        ocrData ? Promise.resolve({ ok: true, data: ocrData }) : pool.ocr(shot.image, req)
      ]), { signal: options.signal, timeoutMs: req.timeoutMs });
      if (!oRes || oRes.ok !== true || !oRes.data) {
        return {
          ok: false,
          snapshotId,
          deviceId,
          error: oRes?.error || { code: 'RECOGNITION_FAILED', message: 'OCR model failed' }
        };
      }
      if (!pRes || pRes.ok !== true || !pRes.data) {
        return {
          ok: false,
          snapshotId,
          deviceId,
          error: pRes?.error || { code: 'RECOGNITION_FAILED', message: 'Page classification model failed' }
        };
      }
      pageRaw = pRes.data || {};
      ocrData = oRes.data || {};
      if (!Array.isArray(ocrData.items) || (ocrData.width !== undefined && ocrData.width !== shot.width) ||
          (ocrData.height !== undefined && ocrData.height !== shot.height)) {
        return { ok: false, deviceId, snapshotId, error: { code: 'RECOGNITION_PROTOCOL_ERROR', message: 'OCR coordinates do not match the screenshot' } };
      }

      if (isChatPage(pageRaw) && !detailRaw && typeof pool.chatDetail === 'function') {
        const dRes = await waitFor(pool.chatDetail(shot.image, req), { signal: req.signal, timeoutMs: req.timeoutMs });
        if (!dRes || dRes.ok !== true || !dRes.data) {
          return {
            ok: false,
            snapshotId,
            deviceId,
            error: dRes?.error || { code: 'RECOGNITION_FAILED', message: 'Chat detail model failed' }
          };
        }
        detailRaw = dRes.data || null;
      } else if (isMessageListPage(pageRaw) && !listRaw && typeof pool.chatList === 'function') {
        const lRes = await waitFor(pool.chatList(shot.image, req), { signal: req.signal, timeoutMs: req.timeoutMs });
        if (!lRes || lRes.ok !== true || !lRes.data) {
          return {
            ok: false,
            snapshotId,
            deviceId,
            error: lRes?.error || { code: 'RECOGNITION_FAILED', message: 'Chat list model failed' }
          };
        }
        listRaw = lRes.data || null;
      }
    } catch (err) {
      return {
        ok: false,
        snapshotId,
        deviceId,
        error: { code: options.signal?.aborted ? 'ABORTED' : 'RECOGNITION_FAILED', message: err.message }
      };
    }
  }

  for (const result of [ocrData, listRaw, detailRaw].filter(Boolean)) {
    if ((result.width !== undefined && result.width !== shot.width) || (result.height !== undefined && result.height !== shot.height)) {
      return { ok: false, deviceId, snapshotId, error: { code: 'RECOGNITION_PROTOCOL_ERROR', message: 'Recognition coordinates do not match the screenshot' } };
    }
  }
  const ocrItems = ocrData?.items || [];
  const w = shot?.width || ocrData?.width || 720;
  const h = shot?.height || ocrData?.height || 1280;

  const app = classifyApp(pageRaw, ocrItems);
  const overlay = classifyOverlay(ocrItems, detailRaw, h);
  const { page, scene } = classifyPageAndScene(app, pageRaw, ocrData, listRaw, detailRaw);
  const keyboard = detectKeyboardState(page, detailRaw, ocrItems, h);
  checkSignal(options.signal);

  // 4. 提取核心定位目标
  const targets = {};
  if (detailRaw?.elements?.back_btn) {
    targets.backBtn = detailRaw.elements.back_btn.box;
  } else {
    const backItem = ocrItems.find(it => it.top < h * 0.14 && it.left < w * 0.20 && /返回|</.test(it.text));
    if (backItem) targets.backBtn = [backItem.left, backItem.top, backItem.right, backItem.bottom];
  }

  if (detailRaw?.elements?.input_box) {
    targets.inputBox = detailRaw.elements.input_box.box;
  }
  if (detailRaw?.elements?.send_btn) {
    targets.sendBtn = detailRaw.elements.send_btn.box;
  }
  if (assessAssistantOverlay(detailRaw).confirmed) {
    targets.assistantCloseX = detailRaw.elements.assistant_close_x.box;
  }
  if (overlay === 'app_update') {
    const closeX = Math.round(w * 0.903);
    const closeY = Math.round(h * 0.207);
    const halfBtnW = Math.max(20, Math.round(w * 0.045));
    const halfBtnH = Math.max(20, Math.round(h * 0.025));
    targets.updateCloseX = [
      Math.max(0, closeX - halfBtnW),
      Math.max(0, closeY - halfBtnH),
      Math.min(w, closeX + halfBtnW),
      Math.min(h, closeY + halfBtnH),
    ];
    targets.updateClosePoint = { x: closeX, y: closeY };
  }
  if (overlay === 'incoming_call') {
    const topItems = ocrItems.filter(it => it.top <= h * 0.20 && !/活动|快来|送给|订阅|充值|游戏/.test(it.text));
    const minTop = topItems.length > 0 ? Math.min(...topItems.map(it => it.top)) : Math.round(h * 0.10);
    const maxBottom = topItems.length > 0 ? Math.max(...topItems.map(it => it.bottom)) : Math.round(h * 0.18);
    const centerY = Math.round((minTop + maxBottom) / 2);
    const btnHalfH = Math.max(Math.round(h * 0.025), Math.round((maxBottom - minTop) * 0.45));
    const redLeft = Math.round(w * 0.67);
    const redRight = Math.round(w * 0.76);
    targets.incomingCallReject = [
      redLeft,
      Math.max(0, centerY - btnHalfH),
      redRight,
      Math.min(h, centerY + btnHalfH),
    ];
    targets.incomingCallRejectPoint = { x: Math.round(w * 0.715), y: centerY };
  }

  // 5. 完整回传所有原始证据 (F02)
  return {
    ok: true,
    actionable: !options.analysisOnly,
    snapshotId,
    deviceId,
    capturedAt: shot.capturedAt || capturedAt,
    generation: shot.generation || generation,
    width: w,
    height: h,
    app,
    page,
    scene,
    overlay,
    keyboard,
    confidence: pageRaw?.confidence ?? null,
    evidence: {
      pageRaw,
      ocrData,
      listRaw,
      detailRaw,
      ocrCount: ocrItems.length,
      detailElements: detailRaw?.elements ? Object.keys(detailRaw.elements) : []
    },
    targets,
    error: null
  };
}

async function observePage(session, options = {}) {
  try { return await observePageInternal(session, options); }
  catch (error) {
    return { ok: false, deviceId: session?.deviceId, error: {
      code: options.signal?.aborted ? 'ABORTED' : error.code || 'OBSERVATION_FAILED',
      message: options.signal?.aborted ? 'Observation cancelled' : 'Page observation failed before a valid result was available'
    } };
  }
}

module.exports = {
  observePage: require('./timing').timed('page.observe', observePage, session => ({ deviceId: session?.deviceId })),
  classifyApp,
  classifyOverlay,
  classifyPageAndScene,
  detectKeyboardState
};
