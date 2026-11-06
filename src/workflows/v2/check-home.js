'use strict';

// Check whether the selected cloud phone is currently at the Android desktop / home screen.
// If not, sends HOME key to return to desktop safely and verifies the outcome.
const { YunmomoClient } = require('../../index');
const { formatDeviceLabel } = require('../../automation/runtime');
const shared = require('../../automation/screen');
const { numberOr, deviceIdOf, findPhrase, RapidOcrWorker, sendHome, homeAnchorMatches } = shared;

function isDesktopScreen(items) {
  if (homeAnchorMatches(items).length >= 1) return true;
  if (findPhrase(items, '密钥认证') || shared.appTargetBox(items)) return true;

  const DESKTOP_MARKERS = [
    '扩展服务', '设备助手', '通讯录', '相机', '图库', '文管理', '文件管理',
    '搜狗输入法', 'QQ音乐', '电话', '铁路12306', '微信', '美团外卖',
    '科音', '伍羊工具箱', 'MOMO陌陌', '高德地图', '支付宝', '抖音',
    '设置', '信息', '短信'
  ];
  const matched = DESKTOP_MARKERS.filter(name => Boolean(findPhrase(items, name)));
  if (matched.length >= 2) return true;

  const hasDate = Boolean(findPhrase(items, '星期') || (findPhrase(items, '月') && findPhrase(items, '日')));
  const hasTime = items.some(item => /^\d{1,2}:\d{2}$/.test(item.text.trim()));
  if (hasDate && hasTime) return true;

  return false;
}

async function ensureHomeScreen(phone, control, worker, directory, state, options = {}) {
  const pollMs = numberOr(options.pollMs, 700);

  // 1. 快速检查当前画面
  state.counter += 1;
  let current = await shared.screenshotAndOcr(phone, worker, directory, state.counter);
  if (isDesktopScreen(current.items)) {
    return { observation: current, alreadyHome: true, restored: true };
  }

  // 2. 当前不在桌面，下发 HOME 键回主屏
  console.log('      当前未处于桌面主屏，发送 HOME 键返回桌面...');
  await sendHome(control);
  await shared.sleep(400);

  // 3. 观察等待桌面就绪（最多 4 秒）
  current = await shared.observeUntil(
    phone,
    worker,
    directory,
    state,
    obs => isDesktopScreen(obs.items),
    4000,
    pollMs,
    'ensure-home'
  );

  const restored = isDesktopScreen(current.items);
  if (!restored) {
    // 容错：二次下发 HOME 键
    await sendHome(control);
    await shared.sleep(500);
    state.counter += 1;
    current = await shared.screenshotAndOcr(phone, worker, directory, state.counter);
  }

  return { observation: current, alreadyHome: false, restored: isDesktopScreen(current.items) };
}

async function main() {
  if (!process.env.YUNMOMO_TOKEN) {
    throw new Error('请先设置 YUNMOMO_TOKEN；令牌只通过环境变量传入，不要写入脚本');
  }
  const targetDeviceId = String(process.env.YUNMOMO_DEVICE_ID || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(targetDeviceId)) {
    throw new Error('请用 YUNMOMO_DEVICE_ID 指定目标云机');
  }

  const client = new YunmomoClient({ timeoutMs: 100000 });
  const devices = await client.listDevices({ size: 50000 });
  const target = devices.records.find(record => deviceIdOf(record) === targetDeviceId);
  if (!target) throw new Error('所选设备不在当前账号设备列表中: ' + targetDeviceId);

  const devLabel = (context && context.deviceName) ? context.deviceName : formatDeviceLabel(target);
  console.log(`📱 目标设备: ${devLabel} | 检查桌面`);

  const phone = client.device(targetDeviceId);
  const control = await phone.openControl({ udid: target.udid });
  const directory = await shared.createOcrDirectory('yunmomo-check-home-');
  const worker = new RapidOcrWorker();
  const state = { counter: 0 };

  try {
    await control.connect();
    const result = await ensureHomeScreen(phone, control, worker, directory, state);
    if (result.alreadyHome) {
      console.log('✅ 设备当前已在桌面');
    } else if (result.restored) {
      console.log('🏠 已按 HOME 键返回桌面');
    } else {
      throw new Error('未能成功恢复桌面');
    }
  } finally {
    await worker.close();
    await control.close();
    if (process.env.YUNMOMO_KEEP_OCR_SCREENSHOTS !== '1') {
      await require('node:fs/promises').rm(directory, { recursive: true, force: true });
    }
  }
}

main = require('../../automation/timing').timedScript('script.src.workflows.v2.check-home', main);

if (require.main === module) {
  require('../../automation/runtime').launchCli(main);
}

module.exports = { isDesktopScreen, ensureHomeScreen, main };
