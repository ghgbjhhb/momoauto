# 发送联系方式

向**已经打开的当前 MOMO 聊天**发送提示语，再把调用方配置的联系方式拆成 `前 3 个字符 → 再 3 个字符 → 剩余全部`。默认仅预演；真实发送必须显式传 `execute:true`。不会打开其他联系人，不会自动回桌面，也不加入原有 10 个初始化脚本。

此操作会真实发送聊天消息。调用方先确认设备和聊天对象，并独占该设备的输入操作。模型 2 只识别页面控件，不能确认对方的账号身份；聊天标题图像变化检查也不是稳定 UID。发送后只确认输入框清空，不保证消息送达或对方收到。

## 调用

默认借用项目级常驻 GPU 服务，模型 2 与拼音候选/草稿 OCR 都复用预热队列，文字识别沿用原 PP-OCRv3 算法。批量设备也可通过 `phone.tools({ recognitionPool })` 显式借用同一个公共客户端或嵌入式池，详见 [GPU 识别说明](GPU-RECOGNITION.md)。关闭当前 tools 不停止公共服务或借用池。

在项目根目录执行，不敲键、不截图、不启动模型：

```powershell
node examples/send-contact.js --contact 123456789
```

输出发送计划：`["1，那你看好了", "123", "456", "789"]`。

真实运行前，手动打开目标云手机的 MOMO 单人聊天页面；环境变量 `YUNMOMO_TOKEN` 使用当前有效登录令牌。以下命令仅在你确定要发送时执行：

```powershell
node examples/send-contact.js --execute --device-id $env:YUNMOMO_DEVICE_ID --contact $env:YUNMOMO_CONTACT
```

两个变量由用户配置，`YUNMOMO_DEVICE_ID` 是后台设备 ID，不是“第几台”。联系方式必须以字符串传入，保留开头的 `0`。不要把真实联系方式和登录令牌提交到版本库。CLI 实际运行只输出进度与错误，不输出聊天截图；预演会显示你提供的联系方式。Ctrl+C 取消后不会重发。

SDK 中直接复用同一台手机的工具会话：

```js
const { YunmomoClient } = require('../src'); // 从 examples/ 下的模块调用

async function sendConfiguredContact() {
  const client = new YunmomoClient();
  const tools = client.device(process.env.YUNMOMO_DEVICE_ID).tools();
  try {
    return await tools.sendContact(process.env.YUNMOMO_CONTACT, { execute: true });
  } finally {
    try { await tools.close(); } finally { await client.closeScreenshots(); }
  }
}
```

入口：`src/tools/index.js` 的 `CloudPhoneTools.sendContact(contact, options)`；类型定义见 [src/index.d.ts](../src/index.d.ts)。错误遵循[设备工具返回规范](DEVICE-TOOLS.md#返回规范)。

## 分段和键盘流程

默认第一条文字严格为 `1，那你看好了`，可通过 `introText` 或 CLI `--intro-text` 修改。联系方式接受 1–64 个非空白、非控制字符；短于 7 个字符时只发送实际存在的分段，不补空消息。按 Unicode 字符分段，不按字节截断。例子：

| 联系方式 | 第一段 | 第二段 | 第三段 |
| --- | --- | --- | --- |
| `123456789` | `123` | `456` | `789` |
| `001234567890` | `001` | `234` | `567890` |
| `12345` | `123` | `45` | 不发送空段 |

实际运行的顺序：

1. 在任何手机输入前准备全部拼音/数字按键，禁止 Enter、Tab 和未知按键。通过高清 SDK 流截图，再用模型 2 识别 `back_btn / input_box / send_btn`；有助手遮挡、重复锚点或页面不符时停止。
2. 根据 `input_box` 中心的纵坐标除以整张手机截图高度判断：`0.25–0.70` 为中部，视为键盘已开，**不再点击输入框**；`0.75–0.93` 为底部，先确认没有旧草稿，点击文字区域，等两次连续识别到中部；两者之间视为不确定并停止。
3. 确认空输入框。输入数字使用定向到这台设备的 SDK 键盘帧；中文使用现有 jieba/pypinyin 按键规划和候选词精确 OCR 选择。不粘贴中文，不依赖电脑浏览器焦点，也不使用 ADB 命令。
4. 每个输入单元核对草稿。候选中找不到整词时，取消本次未提交拼音，核对已输入前缀，再按单字重新找候选；不会盲选第一候选。无法精确匹配、标点映射不符或草稿不一致时停止，**不点击发送**。
5. 每条消息发送前重新识别 `send_btn`，连续两次位置稳定且草稿完全相同才点击一次。禁止复用上一条的发送坐标。
6. 等待两次连续观察到“输入框为空、无激活发送按钮”，才开始下一条。全部完成后停在当前聊天界面。

本工具的页面定位和键盘开关判断**只用用户模型 2**，不用模型 1、ScreenParser 或图标模板；但公共服务会为其他工具同时预热其他模型/专用进程。OCR 仅沿用中文候选及草稿核对，不用于找聊天框或发送按钮。模型解析器从原目录只读加载，不改权重、模型文档、训练数据和标注，也不在模型目录生成 Python 缓存。

## 环境和配置

使用现有高清截图环境、分词环境和输入 OCR 环境，无新增 npm 依赖。真实执行需要 FFmpeg、WSL Ubuntu 的 YOLO/CUDA Python、`.venv-zhtyping/Scripts/python.exe` 和已有 RapidOCR 环境。细节见 [高清截图](HD-SCREENSHOT.md)、[中文输入](CHINESE-TYPING.md) 和 [运行依赖](../requirements/README.md)。默认 CUDA 不可用会明确失败，不悄悄切 CPU。

视觉运行环境复用 `phone.tools({momoVision:{...}})` 配置，见 [打开 MOMO 的环境配置](OPEN-MOMO.md#配置视觉进程)。本工具只使用其中的 `detailWeights`；同目录必须保留匹配的 `predict_chat_detail.py`。进程按工具会话复用，`tools.close()` 关闭。

| 参数 | 默认值 | 约束或含义 |
| --- | --- | --- |
| `execute` | `false` | `true` 才允许真实发送 |
| `dryRun` | 继承 tools，默认 `false` | `true` 优先，仍只预演 |
| `introText` | `1，那你看好了` | 1–80 字符单行提示语 |
| `timeoutMs` | `180000` | 整次操作包括排队、模型启动、输入的预算；显式 tools.timeoutMs 会覆盖默认值；1–300000 |
| `keyIntervalMs` | `55` | 每个按键后的间隔，0–1000ms |
| `settleMs` | `250` | 等待候选和输入结果，50–5000ms |
| `messageIntervalMs` | `400` | 确认上一条清空后的等待，0–10000ms |
| `pollMs` | `250` | 观察间隔，100–2000ms；不含推理/OCR 时间 |
| `keyboardTimeoutMs` | `10000` | 点击输入框后等键盘的循环预算，1000–30000ms |
| `sendTimeoutMs` | `10000` | 找发送按钮、点击后等输入清空各自的循环预算，1000–30000ms |
| `confidence` | `0.35` | 模型 2 检测阈值，0.25–0.95 |
| `minimumScore` | `0.8` | 候选 OCR 最低分，0.7–1 |
| `candidateRoi` | 根据当前输入框位置推算 | 可覆盖归一化 `[left,top,right,bottom]`；默认针对截图中的输入法布局，不承诺适配所有键盘 |
| `emptyLabels` | 空串及“请输入消息”的省略号变体 | 最多 10 个短字符串；仅用于空框占位文本，真实草稿仍严格一致比较 |
| `python` | 当前项目分词虚拟环境 | Windows Python 可执行文件路径 |
| `signal` | 无 | AbortSignal；取消后停止，不自动续发 |

点击使用 65–105ms 随机按住时间；输入框/发送按钮中心附加最多 1 个源像素抖动；候选词点击无抖动。仅接受整张、同方向手机图，使用截图尺寸映射控制坐标；分辨率、连接代次变化或坐标取图后超过 3 秒立即停下，包括控制队列中等待的时间。一次设备只复用一个 tools，运行中不要手动切换聊天、输入或让其他会话控制同一台机。

## 失败后定位

`data.messages` 按顺序记录 `pending / typing / draft_verified / send_attempted / input_cleared`，`completedMessages` 是已经观察到输入清空的条数。`uncertainMessageIndex` 非空时对应一次已经准备点击发送、但没有确认清空的消息；需人工查看，**不能自动从头重跑**。连接或输入失败后可能保留未发送草稿，不清除用户内容。

`data.lastScreenshot / lastObservation / history` 保留最后一帧和步骤，供上层排错；包含私人聊天和联系方式，调用方自行管理存储权限，不应整包打印到公共日志。默认工具日志和 CLI 真实执行日志不输出这些内容。

| 错误码 | 原因及处理 |
| --- | --- |
| `CONTACT_INVALID / INVALID_ARGUMENT` | 联系方式或参数不合法，先修正参数 |
| `AUTH_MISSING / AUTH_FAILED` | 令牌缺失或失效 |
| `TYPING_PLAN_FAILED / TYPING_PLAN_INVALID / UNSUPPORTED_TEXT` | 分词 Python 不可用、规划不一致或字符不能安全按键输入；尚未开始手机输入 |
| `MODEL_NOT_FOUND / MODEL_CLASSES_INVALID / GPU_UNAVAILABLE / VISION_FAILED` | 核对模型 2 路径、对应解析器及 CUDA；不自动替换模型 |
| `CHAT_NOT_CONFIRMED / CHAT_ANCHOR_AMBIGUOUS / APP_OCCLUDED / CHAT_CHANGED` | 页面错误、控件歧义、助手遮挡或标题图像变化；人工检查当前聊天 |
| `INPUT_POSITION_AMBIGUOUS / KEYBOARD_NOT_OPEN` | 输入框不在支持的位置或键盘未正常弹起 |
| `DRAFT_NOT_EMPTY / INPUT_MISMATCH` | 原有草稿或实际输入不符，未获正确草稿时不发送 |
| `OCR_FAILED / OCR_PROTOCOL_ERROR` | 候选/草稿 OCR 服务或返回数据异常，details 的 causeCode / recognitionStage 保留底层原因；新默认链直接传图片字节 |
| `CANDIDATE_NOT_FOUND / CANDIDATE_AMBIGUOUS / CANDIDATE_COORDINATES_INVALID` | 没有唯一且可靠的候选；可检查输入法和 candidateRoi |
| `SEND_BUTTON_NOT_FOUND / SEND_BUTTON_INVALID / STALE_TARGET` | 模型未找到可靠发送位置，或坐标太旧 |
| `SEND_NOT_CONFIRMED` | 发送点击后未确认清空；可能已经发出，不自动补发 |
| `CONNECTION_LOST / CONNECTION_CHANGED / SCREEN_CHANGED / KEY_WRITE_FAILED` | 连接、分辨率或键盘写入异常；不要回放旧动作 |
| `TIMEOUT / ABORTED / TOOLS_CLOSED` | 总预算到期、主动取消或工具关闭；结合进度判断是否已有消息发出 |

截图、鉴权、指针释放和通用错误还沿用 [设备工具](DEVICE-TOOLS.md) 的错误分类。`execution.deviceConfirmed` 始终为 `false`；成功的 `completion='ui_input_cleared'` 仅表示 UI 清空证据，不是消息投递回执。

## 已核对的边界

2026-10-16：SDK 无副作用预演得到四条预期消息；现有分词环境实际生成提示语和三个数字段的按键规划。两张用户附件经模型 2、RTX 3060 实际识别，输入框中心比例分别为 `0.8333`（底部）和 `0.3650`（中部）。这仅验证所给图片上的模型识别及分支，不是完整实机发送验证。

没有向真人聊天发送消息，没有新建测试文件或运行测试套件。真实键盘、发送按钮出现后的识别、特定输入法标点、网络失败及消息发送闭环仍需在用户指定设备和聊天中实机确认。
