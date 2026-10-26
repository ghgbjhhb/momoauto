# MOMO 首页刷新与浏览

用途：初始化后的首页基础浏览（初始养号动作），仅刷新动态列表与滑动浏览，不点赞、评论、关注、进入帖子或发送消息。默认只预演，必须显式 `execute:true` 才操作手机；不会自动启动 MOMO，也不会从聊天页盲点切换到首页。

## 调用入口

在项目根目录运行，无凭据、不截图、不启动模型、不触控：

```powershell
node examples/momo-home.js
node examples/momo-home.js --refresh-only
node examples/momo-home.js --cycles 2
```

真实执行前将目标手机停在“动态/附近/发动态”首页，确认当前进程有自己的 `YUNMOMO_TOKEN`，并把已选设备的后台 ID 设置为 `YUNMOMO_DEVICE_ID`。终端命令不会自动按网页顺序选择设备：

```powershell
node examples/momo-home.js --execute --device-id $env:YUNMOMO_DEVICE_ID --cycles 2
```

Ctrl+C 取消，工具会尝试在原连接释放触控，不重放动作。真实 CLI 调用在 `.local-output/momo-home/run-*/` 保存 `report.json` 和最后一张原图；SDK 则直接返回 `data.lastScreenshot.image`，不强制落盘。预演不创建运行记录。截图可能包含个人信息，应按账号归属控制访问。

在现有助手内复用同一设备的 `tools`：

```js
const { YunmomoClient } = require('./src');

async function main() {
  const id = process.env.YUNMOMO_DEVICE_ID;
  if (!id) throw new Error('请先选择设备并设置 YUNMOMO_DEVICE_ID');
  const tools = new YunmomoClient().device(id).tools();
  try {
    const preview = await tools.refreshMomoHome();
    console.log(preview);
    // 用户明确启动真实操作后才调用：
    // await tools.refreshMomoHome({ execute: true });
    // await tools.browseMomoHome({ execute: true, cycles: 2, timeoutMs: 300000 });
  } finally { await tools.close(); }
}
main().catch(error => console.error(error.message));
```

`refreshMomoHome` 只刷新一次；`browseMomoHome` 执行有限轮循环，每轮独立抽取 2～8 次刷新，接着 3～6 次向下浏览。每次浏览前抽取 1000～5000 ms 阅读等待（其中 1~3 秒占 80%，4~5 秒占 20%），滑动前重新截图定位；滑动、识别和稳定等待另计。下一轮从刷新阶段重新开始，默认一轮，不暗中无限运行。每台手机复用一个 tools，各手机可以并行，GPU 识别借用现有常驻队列。

## 刷新和首页确认

使用 SDK 视频源原图 `source:'stream', maxSize:1280, maxAgeMs:0`。同一张图并行送入现有 `page` 与 `chatList` 入口，不另启 YOLO、OCR，不修改 `models/`。页面识别器本身沿用已有 YOLO + 局部 OCR 实现。

必须同时满足：页面识别为 `1级页面/首页`、顶栏含“动态”及“附近/发动态”、至少三个底栏标签；消息列表模型 1 检测到唯一 `tab_home`，以及同一底栏行的至少三个不同 Tab。按钮框需位于底部左侧且几何范围正常，默认连续两帧位置稳定。每次触控后重新确认首页，不把第一次截图一直复用。模型 1 在首页底栏的泛化仍依赖实际版本；缺框、歧义、页面变化直接停止，不猜固定坐标。

刷新主动作默认按 `buttonProbability=.7` 独立抽样：70% 点击首页按钮，30% 下拉刷新；可通过 `mode:'button'` 或 `'pull'` 固定方式。概率是长期分布，不保证每轮恰好符合比例。

浏览后下拉可能只是向列表顶部回滚，因此 `resetBeforePull=true` 时，位置未知或已浏览的首个下拉刷新前，先点击首页按钮复位，再重新确认首页、执行下拉；后续未滚动的连续刷新不重复复位。复位依赖当前版本首页按钮的回顶行为，不是滚动位置测量。复位点击单独计入 `topResetsSent`，不计入 2～8 次刷新主动作，也不参与刷新主动作的 70/30 抽样；实际总点击占比可能高于 70%。调用方已确认列表到顶时可设 `resetBeforePull:false`，否则下拉可能仅回滚。

浏览手势为手指由下向上拖动，内容向后滚动；下拉刷新为相反方向。路径在识别出的底栏以上、顶栏以下的内容安全区域内，使用现有三点连续滑动和抬手释放逻辑，不点击正文、点赞或评论按钮。

## 检测框内的加权点击

通用方法 `tools.clickRegion(box, options)` 可供后续其他工具复用。`box` 是最新检测得到的 `[left,top,right,bottom]`，右/下边界按排除边界处理；传入同一原图的 `coordinateSpace`，不传浏览器外框尺寸。首页工具会自己传入模型框。

```js
// box 与 imageSize 由调用方本次识别结果提供。
const result = await tools.clickRegion(box, {
  coordinateSpace: imageSize,
  centerFraction: .4, centerProbability: .7, insetPx: 1,
  holdMs: { min: 65, max: 110 }, dryRun: true,
});
```

默认先向内缩 1 个源图像素；以中心为原点，内框宽和高分别取安全框的 40%（约占安全框面积 16%）。70% 概率在内框均匀采样，30% 在内框之外、检测框以内的外环按像素面积均匀采样；外环不再包含内框，避免重复叠加概率。像素取整会令小框的实际比例略有偏差。中心/外环无法分离或内缩后无有效像素时明确失败，不偷偷落到框外。

采样点只生成一次，随后映射到控制尺寸，不附加越框抖动。公开方法只发一次单指点击，默认按住 65～110 ms；现有 `click(x,y,...)` 不变。返回的 `data.target` 含源坐标 `x/y`、`region`、模型 `box`、内缩 `safeBox`、中心 `centerBox`；后两者为包含边界的整数像素框。`data.clicks` 是控制坐标下的实际落点，便于核对。

## 参数

时间单位均为 ms，未知参数、字符串数字和无效区间被拒绝。区间必须是完整 `{min,max}`，整数且 `min <= max`。

| 参数 | 默认值 | 范围 / 说明 |
| --- | --- | --- |
| `execute` / `dryRun` | `false` / 继承 tools | 必须 execute 为 true 且 dryRun 为 false 才触控 |
| `mode` | `random` | random / button / pull |
| `buttonProbability` | `.7` | 0～1；pull 概率为 1 减此值，仅 random 生效 |
| `centerFraction` | `.4` | .01～.99；安全框中心内框的宽、高比例 |
| `centerProbability` | `.7` | 0～1；其余概率属于外环 |
| `insetPx` | `1` | 0～1000；过大导致目标为空则失败 |
| `resetBeforePull` | `true` | 未知/滚动位置先点击首页复位，独立计数 |
| `cycles` | `1` | 1～100，仅 browse；受总超时约束，不自动续跑 |
| `refreshCount` | `{min:2,max:8}` | 端点 1～20，仅 browse，每轮独立抽样 |
| `scrollCount` | `{min:3,max:6}` | 端点 1～20，仅 browse，每轮独立抽样 |
| `scrollIntervalMs` | `{min:1000,max:5000}` | 端点 0～30000，仅 browse，滑动前阅读等待（默认加权：1~3秒占80%，4~5秒占20%） |
| `swipeDurationMs` | `{min:450,max:700}` | 端点 100～3000；另有起止各 40 ms 停留 |
| `confidence` | `.45` | .35～.95；模型 1 的置信度门槛 |
| `stableObservations` | `2` | 2～4 帧 |
| `pollMs` | `250` | 100～2000 |
| `settleMs` | `700` | 100～5000；触控后的界面切换等待 |
| `stepTimeoutMs` | `15000` | 1000～30000；页面确认阶段在观察之间检查预算，单次截图/识别仍受操作总超时控制 |
| `timeoutMs` | 单次刷新 60000，浏览 300000 | 1～300000；显式 tools.timeoutMs 会覆盖方法默认值，排队和模型启动也计入 |
| `signal` | 无 | AbortSignal；关闭 tools 同样取消，不重放动作 |

## 返回和排错

沿用 SDK 的 `{ok,status,operation,execution,data,error}` 信封。预演为 `planned`，真实完成为 `sent`；`deviceConfirmed` 始终 false。`sent` 表示触控本地写入完成，并重新识别到了首页，不是服务端刷新回执，不保证已加载新内容，也不保证账号状态或规避平台检测。`refreshContentConfirmed` 明确保留为 false。

`data` 记录每轮计划/已发送次数、方法选择和等待值，汇总字段为 `completedCycles`、`refreshesSent`、`buttonRefreshesSent`、`pullRefreshesSent`、`scrollsSent`、`topResetsSent`。触控写入成功后就计数；之后页面确认失败也不会抹掉已发动作。`pendingAction` 可指示异常中断的动作，`history` 最多保留 400 项，`lastObservation` 含最近页面、Tab 框、GPU worker 与计时，`lastScreenshot` 保留最后原图。失败返回 `outcome:'stopped'` 与原有部分进度，不从头自动再刷。

| 错误码 | 含义 / 排查 |
| --- | --- |
| `INVALID_ARGUMENT` | 未知字段、无效概率、次数、区间或类型 |
| `TARGET_REGION_TOO_SMALL` | 检测框过小或内缩过大，不能满足内/外区域采样 |
| `MOMO_HOME_NOT_CONFIRMED` | 不是首页或首页文字锚点不足，先检查最后原图 |
| `MOMO_HOME_BUTTON_NOT_FOUND` / `MOMO_HOME_BUTTON_AMBIGUOUS` | 模型 1 缺少/检出多个首页框，不盲点 |
| `MOMO_HOME_LAYOUT_INVALID` / `MOMO_HOME_UNSTABLE` | 布局不支持或按钮位置不稳定 |
| `MOMO_HOME_RECOGNITION_FAILED` | 识别队列/GPU失败，details 保留 model、causeCode、recognitionStage |
| `VISION_PROTOCOL_ERROR` | 原图与返回尺寸/坐标不匹配 |
| `STALE_TARGET` | 截图目标超过 3 秒，未继续触控，重新取图后由调用者决定是否重试 |
| `SCREEN_CHANGED` / `CONNECTION_CHANGED` / `CONNECTION_LOST` | 分辨率、连接代次或连接状态变化，停止旧坐标操作 |
| `ABORTED` / `TIMEOUT` / `TOOLS_CLOSED` | 用户取消、总预算耗尽或工具会话关闭 |

鉴权、视频流、坐标映射、写入和抬手释放等沿用 [底层工具错误](DEVICE-TOOLS.md#错误定位)。若已有触控尝试，不能据失败结果盲目重跑整轮；先核对最后原图、`execution` 和已发计数。同一设备不要再从其他控制器/浏览器同时触控。

## 分类与验证边界

| 文件 | 归属 |
| --- | --- |
| `src/tools/target-sampling.js` | 通用区域权重采样，不读取页面 |
| `src/tools/region-click.js` | 单次区域点击规划，复用原点击/坐标/释放工具 |
| `src/tools/momo/home-layout.js` | 首页页面、模型 1 Tab 框及安全滑动区域校验 |
| `src/tools/momo/home-feed.js` | MOMO 单次刷新与有限刷新/浏览循环 |
| `examples/momo-home.js` | 默认预演的命令行入口；真实运行才归档最后截图与报告 |

2026-10-18 使用本次两张附带截图作只读识别核对：均返回 `1级页面/首页`，`tab_home` 置信度约 .89～.90，能取得完整检测框。它们包含演示箭头和外部黑边，只用于离线识别校验，不能把图上的像素直接点击到真实手机。语法、模块导入、预演及本地范围/流程核对不等同实机验证；没有操作手机，没有增加测试文件或运行旧测试套件，没有改动模型/训练资料，也没有修改网页文案。

本地单次核对：30000 次采样均在安全框内，中心分支占 69.84%，刷新按钮分支占约 69.96%。内存动作通道分别走 button/pull/random 三种方式，各两轮、固定每轮 2 次刷新和 3 次浏览，计数均为 4 次刷新、6 次浏览；pull 方式额外记录两次回顶。错误页面发送 0 个动作，第一次刷新后取消/第二次写入失败均保留已发 1 次刷新的进度。上述是离线模拟，不代表手机已实际完成这些动作。类型声明通过 Node 语法解析，未运行 TypeScript 语义编译。
