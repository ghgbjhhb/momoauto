# GPU 常驻识别与 OCR

四个入口共用项目级本地服务：消息列表、聊天详情、页面判定、通用/输入法 OCR。模型与对应资料原位保留，设备操作顺序、等待条件和成功判定不变。

前提：Node.js 18+、现有模型目录、Ubuntu WSL 的 `/root/screenparser/venv/bin/python` 及 CUDA 环境。本机为 RTX 3060。通用/输入法 OCR 继续读取原 RapidOCR 1.2.x / PP-OCRv3 实现与资产，优先 `.runtime/ocr/site-packages`，其次 `.local-output/vision-test/site-packages`；缺少原运行库会明确失败，不静默换成 v4。可通过 `YUNMOMO_OCR_SITE_PACKAGES` 指定其 WSL 路径。页面判定保留自己的原实现，二者不会互相替换。

## 启动与停止

在项目根目录执行：

```powershell
npm run recognition:start
npm run recognition:status
npm run recognition:stop
```

第一次启动加载、预热全部四类实例；后续调用复用。网页后台启动时也会后台预热，不阻塞页面打开。已经运行的旧网页后台需要重启才能加载修改后的 Node 代码；刷新网页本身不会重载后台。

服务监听 `127.0.0.1:4329`，只接受带本机随机令牌的请求，拒绝浏览器 Origin；不开放云端调用。私有发现文件为 `.runtime/recognition/service.json`，不要提交、分享或放到静态目录。它不是网页登录 CK。服务不读取云机令牌，不截图、不敲键、不点击手机；仅处理调用方传入的图片。不要与其他服务共用这个端口。

`recognition:stop` 是全局停止，会影响其他正在使用的设备。发生 GPU 致命错误、模型更换或运行参数调整后，应等业务空闲，再停止、重新启动；不自动重放失败任务。常驻服务不随单个脚本退出而停止，也没有新增 Windows 开机自启动。

## 从代码调用

以下代码可在项目根目录的 Node 脚本中运行：

```javascript
const fs = require('node:fs/promises');
const { SharedRecognitionClient } = require('./src');

(async () => {
  const recognition = new SharedRecognitionClient();
  try {
    await recognition.start();
    const image = await fs.readFile('.local-output/phone2-chat-list-20261013-1791900077097/01.jpg');
    const result = await recognition.ocr(image);
    if (result.ok) console.log(result.data.items.length, result.timings);
    else console.error(result.requestId, result.error.code, result.error.stage);
  } finally {
    await recognition.close();
  }
})().catch(error => console.error(error.code, error.stage, error.message));
```

`close()` 只关闭当前借用客户端，不停止公共服务。多个 Node 脚本、网页后台、不同手机工具可共用同一个 Python 进程，不再每个命令各加载一套模型。识别方法如下：

| 入口 | 默认实例数 | 实现与保留行为 |
| --- | ---: | --- |
| `chatList(image, options)` | 2 | 模型 1；原首尾联系人过滤、遮挡处理 |
| `chatDetail(image, options)` | 3 | 模型 2；原控件、标题图像签名 |
| `page(image, options)` | 2 | 原页面规则：YOLO + 按需顶/底栏 OCR；不是另训分类模型 |
| `ocr(image, options)` | 2 | 原 PP-OCRv3；通用整页及输入法候选/草稿识别 |

四个队列默认合计最多 3 个任务运行；每路一个独立实例，不让并发线程同时调用同一个预测器。各入口 FIFO 派发、不同类别轮流调度，完成顺序可能不同；靠唯一 `requestId` 对应结果。每类等待上限 32，四类等待及运行图片合计最多 64 MiB。客户端另有 32 个未完成请求、64 MiB 图片预算；HTTP 接收阶段也有独立数量和字节限制。单图 1 字节至 32 MiB，解码后宽 100–16384、高 200–16384，最多 4000 万像素。

旧 `RapidOcrWorker.recognize(pathOrBytes)` 保持字段与异常调用方式，默认转接公共 GPU OCR。归档与识别可并行；识别直接用截图字节，保留原截图归档。专用 IME 的 ROI、候选匹配、置信度阈值、输入全文核对不变。显式设置 `YUNMOMO_OCR_LEGACY=1` 才使用原 CPU 工作进程，不会在 GPU 失败时偷偷回退。自定义未知 worker 路径也保留旧进程模式。

手机工具默认借用公共详情/OCR；`phone.tools({ recognitionPool })` 可显式传入公共客户端或嵌入式池。关闭工具不关闭借用池。显式自定义 `momoVision` 仍使用配置的私有视觉进程，不忽略用户选择的 CPU/权重。

打开 MOMO 的图标/模板/双 YOLO 联合判断不替换为 `page`，由附属单路常驻进程保持原算法，默认在四类就绪后预热。其队列单独限制为 32 个请求、64 MiB，最多运行 1 个；它不占上表的核心 3 个执行槽，极端混用时 GPU 可能有核心 3 个加此附属 1 个任务。状态见 `launcherVision`。同一手机动作队列仍串行。

拼音规划也通过服务复用一个 Python/jieba 进程，启动时加载词典。自定义 Python 路径的旧单次调用仍保留；词典内容改变会切换缓存实例，不修改用户词典。

## 请求与返回

四类均支持 `timeoutMs`（默认 30000，1–300000）和 `signal`。两个 YOLO 方法另支持 `confidence`；列表支持 `filterEdgeCards` / `returnAllWithStatus`，默认 true / false。页面方法不覆盖原判定阈值。

OCR 参数：

| 参数 | 说明 |
| --- | --- |
| `mode` | `general`（默认）返回 items、keyboardSwitches、mapVision、elapsed；`ime` 返回 candidates、input_text、input_scores、elapsed_ms |
| `input_roi` / `candidate_roi` | IME 的归一化 `[左,上,右,下]`；必须匹配实际 App/键盘布局；不自动定位 |
| `full_field` | IME 原有全图检测核对输入框 |
| `detected_candidates` | IME 原有全图检测候选策略，避免混用重叠候选 |

例如 `await recognition.ocr(image, { mode: 'ime', input_roi: [0.09, 0.373, 0.81, 0.412], candidate_roi: [0, 0.537, 0.89, 0.597] })`。这些 ROI 是历史浏览器九宫格配置，不可直接假定适用于聊天 App。

成功返回 `{ok:true,status:'recognized',requestId,model,data,error:null,timings,worker}`；失败为 `ok:false,status:'failed',data:null,error:{code,message,stage,details}`。启动/构造/状态查询失败会抛异常，需要处理。

| 时间字段 | 统计范围 |
| --- | --- |
| `queueMs` | 核心池提交至派发；首次自动启动也在其中 |
| `decodeMs` | Python 图片解码 |
| `predictMs` | 模型、后处理及等待本路 GPU 完成 |
| `processingMs` | Python 解码 + 预测 |
| `totalMs` | 调用方墙钟时间，含本地传输、排队、可能的自动启动；不含 SDK 截图网络时间 |

`worker` 返回 Python PID、lane、CUDA 设备；`status()` 是异步接口，返回运行/等待数量、累计计数、最后错误、模型与预热信息，不返回聊天正文或截图。图片结果本身可能含私有聊天内容，应由调用方保护。

| 错误 | 处理 |
| --- | --- |
| `INVALID_ARGUMENT` / `IMAGE_INVALID` | 修正参数或图片，不把错误当“未检测到控件” |
| `QUEUE_FULL` / `QUEUE_BYTES_EXCEEDED` | 降低提交速度、等待容量；不要无界并发 |
| `TIMEOUT` / `ABORTED` | 不自动重放；核对对应 requestId |
| `MODEL_MISSING` / `MODEL_CLASSES_INVALID` / `DEPENDENCY_MISSING` | 核对原模型与运行库 |
| `GPU_UNAVAILABLE` / `GPU_PROVIDER_UNAVAILABLE` | 核对 CUDA、PyTorch、ONNX Runtime GPU；不静默回 CPU |
| `MODEL_LOAD_FAILED` / `MODEL_WARMUP_FAILED` | 查看 stage 和 details 的模型/lane/异常类型 |
| `GPU_OUT_OF_MEMORY` / `GPU_EXECUTION_FAILED` | 停止接收、检查显存或配置，空闲后重启服务 |
| `SERVICE_UNAVAILABLE` / `SERVICE_AUTH_FAILED` / `SERVICE_DISCOVERY_INVALID` / `SERVICE_START_FAILED` | 核对 4329 端口、发现文件与服务状态；当前请求不隐式重试 |
| `PIPE_FAILED` / `WORKER_EXITED` / `WORKER_PROTOCOL_ERROR` / `POOL_CLOSED` | 查看生命周期与进程状态 |
| `WORKER_SHUTDOWN_TIMEOUT` | 未确认退出，检查残留进程再重启 |

已经进入 GPU 的任务不能安全强行中断。超时/取消先返回失败，但通道、核心字节预算保留到实际返回；迟到结果丢弃并增加 `discardedLateResults`，不会误配到下一请求。旧 CPU 工作进程也使用请求 ID，并保留无 ID 自定义 worker 的 FIFO 迟到槽位，避免串单。

通用 OCR 保持原方向分类、min 缩放及阈值。页面 OCR 保持已验证的 max 缩放/关闭方向分类参数。二者检测和识别均检查 CUDA provider；通用方向分类也检查 CUDA。cuDNN 使用 HEURISTIC。ORT 保留 CPU provider 兼容个别算子，解码与后处理仍有 CPU 工作；“GPU 模式”不代表所有计算都在 GPU。

预热覆盖默认 360×640、720×1280，并实际运行文字识别，不只跑空白图。它不保证覆盖未来所有文本长度、批量形状、图像尺寸。首次服务加载仍需数秒，首次陌生形状可能更慢，不应拿单个 GPU 内核时间冒充完整工具耗时。

## 需要自行配置实例时

`createRecognitionPool(options)` 仍提供嵌入式池，由当前 Node 进程拥有，不使用公共 HTTP 服务：

```javascript
const { createRecognitionPool } = require('./src');
const pool = createRecognitionPool({
  workers: { chatList: 2, chatDetail: 3, page: 2, ocr: 2 },
  maxInFlight: 3, maxQueueSize: 32, maxPendingBytes: 64 * 1024 * 1024,
  warmupSizes: [[360, 640], [720, 1280]]
});
// 在异步函数中 await pool.start()；退出时 await pool.close()。
```

每类 1–8 个实例，合计 4–16；全局执行数 1–实例总数；等待上限每类 1–1024。还支持 `runtime`、`distribution`、`pythonPath`、`listWeights`、`detailWeights`、`timeoutMs`、`startupTimeoutMs`、`logger`。只读日志回调不含文字/图片/凭据。不要在已运行公共服务时随意再建多个嵌入式池，显存会叠加。

嵌入式 `status()` 同步；`close({drain:true,timeoutMs:30000})` 默认排空，另有最多 6.5 秒工作进程清理；`drain:false` 不等队列。仅此嵌入式所有者关闭自己的 Python，借用手机工具不得代替所有者关闭池。

## 命令行输入图片

`npm run recognition` 现在默认借用公共服务。ready 后可输入：

```json
{"id":"local-list","model":"chatList","imagePath":"D:/AA-project/自动化/.local-output/phone2-chat-list-20261013-1791900077097/01.jpg"}
{"id":"local-ocr","model":"ocr","imagePath":"D:/AA-project/自动化/.local-output/script4-ocr-test.png"}
{"command":"status"}
{"command":"close"}
```

退出只关闭当前入口，不停止公共服务。不会截图或操作手机。完整优化范围、实测图片、耗时和未验证边界见 [性能记录](PERFORMANCE.md)。
