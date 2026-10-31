'use strict';

// 一次性诊断探针：验证"脚本自建控制连接的触摸注入是否被云机执行"。
// 流程：截图A -> 手动桥同构 DOWN/UP 点击 -> 截图B -> BACK -> 截图C。
// 只进入观察，不回复任何消息；点击目标为消息列表卡片中心（与 flow-15 故障同构）。

const fs = require('node:fs/promises');
const path = require('node:path');
const { YunmomoClient } = require('../src/index');
const { ACTION } = require('../src/protocol');
const { PROJECT_ROOT, targetDeviceId, redact } = require('../src/automation/runtime');
const { defaultArbiter } = require('../src/server/device-arbiter');

const OUT_DIR = path.join(PROJECT_ROOT, '.local-output', 'touch-probe', `run_${Date.now()}`);
const p = v => path.join(OUT_DIR, v);

async function main() {
  const deviceId = targetDeviceId();
  await fs.mkdir(OUT_DIR, { recursive: true });

  const lease = defaultArbiter.acquireDevice(deviceId, 'touch_probe_' + Date.now(), { returnLease: true });
  if (!lease.ok) throw new Error(`device busy: ${lease.reason}`);

  const client = new YunmomoClient({ token: process.env.YUNMOMO_TOKEN });
  const tools = client.device(deviceId).tools();

  const control = await tools._ensureControl({
    check: () => {},
    remaining: () => 30000,
    wait: v => v,
    execution: {},
  });
  console.log(`control ready=${control.ready} screen=${control.screenWidth}x${control.screenHeight}`);

  const shot = async name => {
    const res = await tools.screenshot({ timeoutMs: 15000 });
    const image = res.data.image;
    const file = p(name);
    await fs.writeFile(file, image);
    console.log(`${name}: ${image.length} bytes (videoSize now ${control.screenWidth}x${control.screenHeight})`);
    return image.length;
  };

  const sizeA = await shot('probe-a.png');

  // 姿势1：与手动控制桥完全同构的纯 DOWN/UP
  const x = Math.round(control.screenWidth * 0.5);
  const y = Math.round(control.screenHeight * 0.658);
  console.log(`[pose1 raw DOWN/UP] tap at (${x}, ${y}), videoSize=${control.screenWidth}x${control.screenHeight}`);
  control.touch(ACTION.DOWN, x, y, { pointerId: 0, pressure: 1, buttons: 1 });
  await new Promise(r => setTimeout(r, 120));
  control.touch(ACTION.UP, x, y, { pointerId: 0, pressure: 0, buttons: 0 });
  await control.flush();

  await new Promise(r => setTimeout(r, 2500));
  const sizeB = await shot('probe-b.png');
  console.log(`pose1 page changed: ${sizeA !== sizeB}`);

  if (sizeA === sizeB) {
    // 姿势2：脚本链路 tools.clickRegion（与 flow-15 同构，截图空间 720x1280）
    const w = 720, h = 1280;
    console.log('[pose2 clickRegion] tap at (360, 842) with coordinateSpace 720x1280');
    await tools.clickRegion([202, 773, 518, 913], { coordinateSpace: { width: w, height: h }, timeoutMs: 20000 })
      .then(r => console.log(`clickRegion sent: ${JSON.stringify(r.data?.point ?? r.point ?? 'ok')}`))
      .catch(e => console.log(`clickRegion failed: ${redact(e.message)}`));
    await new Promise(r => setTimeout(r, 2500));
    const sizeC = await shot('probe-c.png');
    console.log(`pose2 page changed: ${sizeB !== sizeC}`);
    control.back();
    await control.flush();
    await new Promise(r => setTimeout(r, 1200));
    await shot('probe-d.png');
  } else {
    control.back();
    await control.flush();
    await new Promise(r => setTimeout(r, 1200));
    await shot('probe-c.png');
  }

  defaultArbiter.releaseDevice?.(deviceId, lease.leaseToken);
}

main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
