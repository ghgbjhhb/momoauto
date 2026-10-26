# 底层设备工具

基础输入层：原始截图、坐标点击、检测框加权点击、连续路径滑动。MOMO 应用层：打开应用、发送联系方式、拉黑对方、单次首页刷新、首页循环浏览。通过现有 SDK 调用云手机，不依赖电脑鼠标焦点，不使用 ADB 命令。基础截图/手势不进行页面识别，应用层按各自用途复用模型和文字识别。原有接口和业务脚本保持兼容。专项说明见 [打开 MOMO](OPEN-MOMO.md)、[发送联系方式](SEND-CONTACT.md)、[拉黑对方](BLOCK-PEER.md)、[首页刷新与浏览](MOMO-HOME.md)；后四种组合操作默认只预演，真实执行需显式开启。

## 分类与入口

多台设备需要共享模型 2 时，给 `phone.tools({ recognitionPool })` 传入应用所有者创建的 [GPU 常驻识别池](GPU-RECOGNITION.md)。发送联系方式、拉黑中的聊天控件识别会复用池，`tools.close()` 不关闭借用的公共池。不传此配置时仍使用原按工具会话管理的视觉进程。

| 文件 | 职责 |
| --- | --- |
| `src/tools/index.js` | 公开入口、连接复用、串行队列、生命周期、统一返回值 |
| `src/tools/screenshot.js` | SDK 原始图片、PNG/JPEG 文件头尺寸和容器边界检查、只读重试 |
| `src/tools/click.js` | 点击次数、持续时间、点击间隔的规划 |
| `src/tools/target-sampling.js`、`region-click.js` | 检测框内中心/外环权重采样、范围点击规划 |
| `src/tools/swipe.js` | A→B→C 多点路径、分段时长、中间停顿和插值 |
| `src/tools/coordinates.js` | 截图坐标→控制坐标、偏移、随机抖动、越界校验 |
| `src/tools/gestures.js` | 一次 DOWN、若干 MOVE、一次 UP，异常释放、写入检查 |
| `src/tools/runtime.js` | 参数校验、错误分类、超时和取消 |
| `src/tools/recognition.js`、`vision/recognition_worker.py` | 四类识别（双 YOLO、页面与 OCR）的公共 GPU 常驻池、独立实例、预热及有界并发队列 |
| `src/tools/momo.js` | 打开 MOMO 的有界流程、稳定确认、原图与步骤记录 |
| `src/tools/momo-vision.js`、`vision/momo_worker.py` | 常驻视觉进程、图标模板与用户自训 YOLO 页面锚点判断 |
| `src/tools/send-contact.js`、`chat-layout.js`、`vision/chat_detail_worker.py` | 联系方式分段、模型 2 键盘位置与发送按钮识别、逐条发送进度 |
| `src/typing/chat-input.js` | 复用设备连接的拼音/数字按键、候选选择和草稿核对；本身不发送消息 |
| `src/tools/block-peer.js`、`block-layout.js`、`screen-text.js` | 拉黑流程、模型 2 最上方顶栏头像筛选、设置行与确认弹窗文字识别 |
| `src/tools/momo/home-feed.js`、`momo/home-layout.js` | 首页确认、模型 1 的 tab_home 定位、单次刷新与有限循环浏览 |

```js
const { YunmomoClient } = require('./src');
const client = new YunmomoClient({ token: process.env.YUNMOMO_TOKEN });
// 使用后台 deviceId，不是列表下标、显示名称或“第几号”。同一台设备复用一个 tools。
const tools = client.device('设备的实际ID').tools({
  timeoutMs: 15000,
  connectTimeoutMs: 10000,
  logger: entry => console.log(JSON.stringify(entry))
});

async function run() {
  try {
    const capture = await tools.screenshot();
    if (!capture.ok) return console.error(capture.error);
    const { image, width, height } = capture.data; // image 是原始 Buffer，直接交给后续 YOLO
    const coordinateSpace = { width, height };

    const click = await tools.click(180, 300, {
      coordinateSpace, offset: { x: 0, y: 0 }, jitterPx: 2,
      holdMs: { min: 65, max: 110 }, count: 1
    });
    if (!click.ok) return console.error(click.error, click.execution);

    const swipe = await tools.swipe([
      { x: 180, y: 520 }, { x: 170, y: 340, pauseMs: 50 }, { x: 180, y: 150 }
    ], { coordinateSpace, segmentDurationsMs: [250, 300], stepMs: 16 });
    if (!swipe.ok) console.error(swipe.error, swipe.execution);
  } finally { await tools.close(); }
}
// 坐标仅为说明；实际调用前由当前页面 / YOLO 确定目标，不要盲点固定坐标。
```

也可调用 `createDeviceTools(phone, options)` 或 `new CloudPhoneTools(phone, options)`。传入已有 `control` 时要求它属于同一 deviceId 且已连接；工具不会关闭借用的连接。工具自己创建的连接按需打开、重复使用，`close()` 才关闭。不自动重连重放手势。构造配置错误会抛异常，操作方法的常规参数/运行错误都通过结果返回。`openMomo()`、`sendContact()`、`blockPeer()` 按需创建的视觉进程也由 `close()` 清理；首页工具借用识别池，不关闭公共 GPU 服务。

## 配置速查

在 `phone.tools(options)` 中配置；时间单位均为毫秒，不接受数字字符串。公开类型定义见 [`src/index.d.ts`](../src/index.d.ts)。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `timeoutMs` | `15000`；openMomo/refreshMomoHome 为 `60000`，sendContact 为 `180000`，blockPeer 为 `90000`，browseMomoHome 为 `300000` | 单次调用总预算，1–300000；若显式配置则各操作都继承，调用时可覆盖 |
| `connectTimeoutMs` | `10000` | 控制连接初始化预算，1–300000，且不能超过该操作剩余总预算 |
| `udid` | 未指定 | 省略时通过设备详情取得；不是 deviceId，勿混用 |
| `control` | 未指定 | 可复用同一设备、已初始化的 `CloudPhoneControl`；所有权仍归调用方 |
| `dryRun` | `false` | 点击、范围点击、滑动及 MOMO 组合操作预演，方法可单独覆盖；sendContact、blockPeer、首页刷新/浏览还要求 execute:true |
| `screenSize` | 未指定 | 预演时的目标控制尺寸；已 ready 的 control 尺寸优先。真实执行以当前 control 为准 |
| `logger` | 未指定 | 同步日志回调，接收操作元数据，不含图片和凭据 |
| `momoVision` | 项目内置路径与 WSL + CUDA | 打开 MOMO、发送联系方式、拉黑对方的视觉环境配置；后两者只加载模型 2，见 [详细配置](OPEN-MOMO.md#配置视觉进程) |

**注意：`dryRun: true` 不拦截 `screenshot()`，截图仍会请求真实设备。** 离线点击、范围点击及滑动需提供 `screenSize`；`openMomo({dryRun:true})` 无需尺寸且不截图、不启动 Python。可直接使用文末的本地预演命令，它不会调用截图接口。sendContact、blockPeer、首页刷新与浏览默认只预演；截图、点击、范围点击、滑动、openMomo 默认真实执行，不要把示例坐标直接用于实际页面。

## 返回规范

```js
{
  ok: true,
  status: 'captured', // 或 sent / planned / opened；失败为 failed
  operation: 'screenshot', // 或 click / clickRegion / swipe / openMomo / sendContact / blockPeer / refreshMomoHome / browseMomoHome
  operationId: '每次调用唯一 UUID', deviceId: '设备ID',
  startedAt: 'ISO 时间', durationMs: 86.4, attempts: 1,
  execution: {
    state: 'not_started', // 手势可为 partial / sent
    framesSent: 0, completedClicks: 0, release: 'not_needed',
    localWriteConfirmed: false, deviceConfirmed: false
  },
  data: { image: Buffer, width: 360, height: 640, format: 'jpeg', /* ... */ },
  error: null
}
```

- `captured`：取得有效格式的图片数据，不代表页面已加载完成。返回原始图片，不额外缩放、压缩或转 Base64；`capturedAt` 是本地取得时间，不是手机截图时间戳。
- `sent`：触控帧与 UP 已提交且 WebSocket **本地写入**完成；不是 Android/App 执行确认，也不是服务端 pong。`deviceConfirmed` 始终为 false。业务层需结合下一张截图/YOLO 判断点击效果。
- `blockPeer` 的流程成功条件为确认弹窗里最后一次“拉黑”点击及本地写入完成：`ok=true`、`status='sent'`、`data.outcome='confirmation_clicked'`；不再等待后续页面或要求 `blockedUiConfirmed=true`。这不是后台生效回执，详见 [拉黑工具状态](BLOCK-PEER.md#状态和错误)。
- `planned`：只计算操作，不连接、不发送；不是执行成功。
- `opened`：仅 openMomo 使用，MOMO 页面通过连续 YOLO 锚点确认；不是 Android 回执，`deviceConfirmed` 仍为 false。完整现场在 `data.lastScreenshot / lastObservation / history`。
- `partial`：至少尝试发送 DOWN，设备是否执行可能不确定；即使 `framesSent=0`，也不建议盲目重试。查看 `completedClicks` 和 `release`（sent / failed / connection_lost）。
- 失败时 `data` 可能保留已规划的实际坐标。`error` 包含 `code / stage / message / details / retrySafe / retryable`；`retrySafe` 只表示本工具没有尝试手势副作用，**不保证页面目标没有变化**。实际重试前重新截图定位。
- 日志只输出操作元数据和错误码，不复制图片、凭据、后台响应或原始异常。`logger` 是同步回调；异常返回 `LOGGER_FAILED` 警告，不把成功动作改成失败；返回 Promise 会提示 `ASYNC_LOGGER_UNSUPPORTED`，不会等待它。需要异步落盘时由调用方维护日志队列。

截图成功时 `data` 的完整字段为 `image / format / mimeType / width / height / bytes / httpStatus / capturedAt`。点击成功或预演的 `data.clicks` 包含每次最终落点和实际抽取的 `holdMs`；滑动的 `data.points / segmentDurationsMs / moveCount` 描述实际规划路径。顶层 `durationMs` 是工具调用耗时，`data.durationMs` 是规划的手势总时长，不是同一个概念。顶层 `attempts` 对截图表示尝试次数；真实手势进入连接阶段后为 1，预演或此前校验失败为 0。

## 截图

`tools.screenshot({ level: 2, attempts: 1, retryDelayMs: 250, maxBytes: 33554432, timeoutMs: 15000, signal })`

需要识别原生高清画面时使用 `tools.screenshot({ source: 'stream', maxSize: 1280 })`。返回 `data.source='stream'` 和 `data.decodedAt`，其余状态、错误与图片字段保持统一。此模式需要本机 FFmpeg，不发送手机输入；旧调用默认仍为 REST，不会自动修改现有业务流程。调用示例、资源释放和错误码见 [高清截图](HD-SCREENSHOT.md)。

`level` 原样传 SDK（1 或 2），工具不承诺接口能超出云机源分辨率。支持 PNG/JPEG；校验格式、尺寸和结束标志，**不做完整像素解码**。错误/空图不伪装成成功。`maxBytes` 限制接收后的返回数据量；当前 SDK 会先读完整 HTTP 响应，这不是网络流式下载内存上限。

默认不重试；可设 `attempts=2..3`，只对网络错误、429、5xx 做有界重试，延迟为 `retryDelayMs × 当前尝试次数`，全部受同一总超时约束。鉴权、权限、无效图片、参数错误不重试。截图只读，截图失败可以安全重取；不要把这一策略用于点击。

## 坐标与点击

`tools.click(x, y, options)` 默认单次左键语义（手机端为单指触控），`holdMs=80`、`count=1`、`intervalMs=100`、`jitterPx=0`。支持 `count=1..3`、固定 `holdMs=500` 或 `{min:65,max:110}`；长按也通过较大 `holdMs` 表达。右键/中键尚未验证，明确拒绝而不假装支持。没有移动电脑系统光标。

默认坐标单位是已初始化控制连接的 `screenWidth/screenHeight`。若识别来自截图，务必传 `coordinateSpace: {width: 截图宽, height: 截图高}`，例如截图 360×640、控制画面 400×720，工具自动换算。坐标允许小数，映射后取整；偏移和抖动单位为**源坐标空间**像素。`offset` 先加到中心；`jitterPx=2` 表示 x/y 分别最多 ±2 像素，在合法边界内采样，返回最终实际坐标。原始坐标或偏移后越界直接失败，不把无效坐标偷偷贴边。

坐标必须对应整张、同方向的手机画面，不是带外框的浏览器截图。裁切图先还原到完整截图；YOLO 的 letterbox 坐标先去 padding 和缩放。宽高比相差超过 5% 会拒绝；小于该阈值也不意味着裁切图自动正确。执行中分辨率变化或连接代次变化会立即停止，不继续用旧坐标。

## 连续滑动

需要检测框内加权点击时调用 `tools.clickRegion([left,top,right,bottom], options)`，默认中心宽/高 40% 的内框取样概率为 70%，其余 30% 只从外环取样，均在内缩后的框内；不修改原 `click()` 的抖动规则。参数、坐标语义和示例见 [范围点击](MOMO-HOME.md#检测框内的加权点击)。

`tools.swipe([{x,y}, {x,y,pauseMs:50}, {x,y}], options)`

全程一次 DOWN→连续 MOVE→最后 UP，经过 B 时不会松手。2–100 个节点；每个节点可指定 `pauseMs`（0–10000ms）。默认移动时间 `durationMs=600`，按各段距离分配；或指定 `segmentDurationsMs=[250,350]`，长度必须等于节点数减一，与 `durationMs` 互斥。

`startHoldMs=40`、`endHoldMs=40` 是起点/终点额外停留，计入总时长；`stepMs=16` 控制 MOVE 采样间隔（4–1000ms，最多4096个 MOVE）。`easing='easeInOut'` 或 `'linear'`。总手势时长最多60000ms；这是事件循环定时，不是硬实时设备。点击的总持续时间也最多60000ms。

## 超时、并发和取消

`timeoutMs` 默认15000，允许1–300000ms，包含排队、连接、操作和本地写入等待；规划手势加25ms余量超过剩余时间会在 DOWN 前返回 `INSUFFICIENT_TIME`，可显式提高超时。失败清理可能额外花费最多约250ms的连接关闭时间（系统调度或底层异常除外）。

同一个 tools 的截图/点击/滑动按调用顺序串行，排队时会保存参数和路径副本，避免调用方后续修改对象导致目标漂移。手势与同一 control 的旧 `tap/swipe` 共用 SDK 触控队列，防止连续路径被插入；不要同时用 `control.touch()` 发原始帧，也不要对同一手机创建多个独立控制器同时操作。

```js
const controller = new AbortController();
const pending = tools.swipe([{x:100,y:500}, {x:100,y:150}], {
  durationMs: 2000, signal: controller.signal
});
controller.abort();
const result = await pending; // error.code === 'ABORTED'，不会排队后又突然执行
```

超时/取消/中途错误会尽力通过**原连接**发送 UP，不会为了松开而自动重连，也不重放动作。断线无法保证手机端收到松开，此时 `release=connection_lost`。`close()` 取消排队及进行中的本工具操作，等待释放并关闭自有连接；关闭后再次调用返回 `TOOLS_CLOSED`。关闭失败以 Promise rejection 报告。

## 错误定位

| 错误码 | 处理方向 |
| --- | --- |
| `INVALID_ARGUMENT` / `UNSUPPORTED_BUTTON` | 检查字段、范围、参数拼写；未知字段也拒绝 |
| `SCREEN_SIZE_REQUIRED` | dry-run 提供 screenSize 或已 ready 的 control |
| `COORDINATE_OUT_OF_BOUNDS` / `COORDINATE_SPACE_MISMATCH` | 检查偏移、截图尺寸、裁切、方向 |
| `AUTH_MISSING` / `AUTH_FAILED` / `PERMISSION_DENIED` | 未配置 token、401、403；不记录 token |
| `DEVICE_NOT_FOUND` / `INVALID_DEVICE_INFO` | 404 或设备信息缺少 udid；404 也可能是服务接口变更，不能只凭它认定设备被删除 |
| `NETWORK_ERROR` / `HTTP_ERROR` / `BACKEND_UNAVAILABLE` / `BACKEND_REJECTED` / `RATE_LIMITED` | 网络、HTTP、5xx、业务拒绝、429，结合 httpStatus 和 stage 排查 |
| `CONNECT_TIMEOUT` / `CONNECT_FAILED` / `NOT_CONNECTED` | 控制连接超时、失败或借用控制器未连接 |
| `EMPTY_IMAGE` / `INVALID_IMAGE` / `UNSUPPORTED_IMAGE_FORMAT` / `IMAGE_TOO_LARGE` | 空数据、图片边界不完整、非 PNG/JPEG、超过 maxBytes |
| `CONNECTION_LOST` / `CONNECTION_CHANGED` / `SCREEN_CHANGED` | 断线、会话变化、分辨率变化；重取画面再决定下一步 |
| `DISPATCH_FAILED` / `WRITE_FAILED` / `RELEASE_FAILED` | 触控发送、本地写入、UP 发送失败；检查 partial，禁止无脑重试 |
| `INSUFFICIENT_TIME` / `TIMEOUT` / `ABORTED` / `TOOLS_CLOSED` | 超时预算不足、总超时、主动取消、会话已关闭 |
| `INTERNAL_ERROR` | 未分类的内部问题，以 operationId、stage、版本定位，不泄露原始异常 |

`stage` 可为 validate / queue / device_info / connect / gesture_queue / map / dispatch / release / flush / capture / retry_wait / decode。现有 SDK 对部分网络/连接错误只提供通用异常，工具不会凭空推断是 token 过期、手机离线还是 DNS 故障；需要结合该阶段查服务端/网络。

### 失败后如何接着处理

1. 先记录 `operationId / deviceId / error.code / error.stage / execution`，不要把 token、整张图片或完整后台响应写入普通日志。
2. 若 `execution.state='partial'` 或 `error.retrySafe=false`，停止自动重试，先重新截图判断是否已经生效，再决定下一步。`release='sent'` 仅说明尝试松手成功发送，不代表业务动作成功。
3. 若 `retrySafe=true`，仍先按错误码处理：参数错误修正参数；鉴权/权限错误处理凭据；坐标/尺寸错误重取画面。只有可重试的网络类错误才考虑有界重试。工具不会自动替调用方重新点击。

例如滑动过程中分辨率改变，失败结果可能包含以下关键字段（其余公共字段省略）：

```js
{
  ok: false,
  status: 'failed',
  operation: 'swipe',
  execution: {
    state: 'partial', framesSent: 3, completedClicks: 0,
    release: 'sent', localWriteConfirmed: false, deviceConfirmed: false
  },
  error: {
    code: 'SCREEN_CHANGED', stage: 'dispatch',
    message: 'Control resolution changed during the operation; obtain a fresh screenshot',
    details: {}, retrySafe: false, retryable: false
  }
}
```

`warnings` 不会自动令 `ok=false`。可能值为 `LOGGER_FAILED`、`ASYNC_LOGGER_UNSUPPORTED`、`CONTROL_CLEANUP_FAILED`；最后一项表示失败后的连接关闭也发生异常，需结合原错误检查连接，不要只看警告覆盖原始原因。

## 本地预演入口

```powershell
node examples/device-tools.js
```

不需要 token，不联网、不敲键、不操作云手机。输出点击和三点滑动的规划。需要只读真实截图时显式运行：

```powershell
node examples/device-tools.js --live --device-id 实际设备ID
```

此命令只截图，不点击/滑动；原图保存为当前目录 `device-tools-capture.jpeg` 或 `.png`，存在同名文件会报错而不覆盖。真实手势由后续调用方根据实际界面明确传入目标。本次交付不新增测试文件、不运行整套旧测试、不改动现有业务脚本。

## 当前验证边界

2026-10-15 已完成 JavaScript 语法和模块导入检查、本地点击/三点滑动规划、既有 PNG/JPEG 原图尺寸读取，以及内存传输上的触控帧预演（双击、多点滑动、中途取消和 UP 释放）。未连接真实云手机验证这层新封装，因此不能把这些本地结果当作真实截图接口可用、手机已执行或 App 已响应的证明。未新增依赖或测试文件。

后续扩展约定：参数、默认值、返回字段或错误码改变时，同步更新本文、对应专项文档和 `src/index.d.ts`。基础截图 / 手势工具不代替业务判断；openMomo 在组合层提供有限的页面视觉确认，也不把模型结果猜成 Android 设备回执。
