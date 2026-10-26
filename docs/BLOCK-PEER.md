# 拉黑对方

对已经打开的 MOMO 单人聊天执行：**模型 2 定位最上方的顶栏头像 → 聊天设置里的“拉黑” → 确认弹窗的“拉黑”**。不会点击消息里的头像，不回桌面、不自动切换联系人，不加入原有 10 个初始化脚本。

默认只预演，真实操作需要 `execute:true`。拉黑会改变联系人关系并停止接收对方消息；调用方必须确认当前聊天对象、设备，并独占该设备操作。模型识别头像位置，不提供对方账号 UID 校验。不要在执行中手动切换聊天或让其他任务控制同一台手机。

成功条件按调用约定：**识别到确认弹窗，完成最后一个“拉黑”按钮的点击与本地写入，就返回成功**。不再等待“解除拉黑”或跳转后的页面；这不是后台生效回执。

## 调用工具

默认借用项目级常驻 GPU 服务，模型 2 和文字 OCR 都复用预热队列。也可用 `phone.tools({ recognitionPool })` 显式借用公共客户端或嵌入式池，详见 [GPU 识别说明](GPU-RECOGNITION.md)。拉黑行/确认弹窗仍用原 PP-OCRv3 算法，成功条件不变；关闭 tools 不停止公共服务或借用池。

项目根目录运行无副作用预演，无需令牌，不截图、不加载模型：

```powershell
node examples/block-peer.js
```

真实执行前先打开目标单人聊天，配置当前有效的 `YUNMOMO_TOKEN` 和后台设备 ID `YUNMOMO_DEVICE_ID`。只有确定要拉黑当前对方时才执行：

```powershell
node examples/block-peer.js --execute --device-id $env:YUNMOMO_DEVICE_ID
```

SDK 在已有工具会话中调用：

```js
const plan = await tools.blockPeer(); // 只返回流程计划
// 当前聊天确认无误后，由调用方显式启动：
const result = await tools.blockPeer({ execute: true });
if (!result.ok) console.error(result.error.code, result.error.stage);
```

`tools` 是 `client.device(deviceId).tools()` 的返回值。同台设备复用一个 tools，结束后调用 `tools.close()`；若调用方也结束高清截图会话，调用 `client.closeScreenshots()`。CLI 已处理这些清理及 Ctrl+C 取消。

## 如何避免点错头像和按钮

1. 通过 SDK 高清流获取整张手机原图，使用模型 2 确认聊天页的返回键和输入框。读取全部 `avatars`，按头像框中心纵坐标从小到大排序，**只考虑第一项**。它必须位于右侧 30% 区域、顶栏范围内，并与返回键同一行，置信度至少 0.28；没有合格的顶栏头像就停止，不改选下一项。连续两次位置、聊天标题图像稳定后点击。
2. 头像点击后，用本地文字识别确认“聊天设置”标题及至少两项设置锚点，然后只定位左侧、下半屏里**完整文字等于“拉黑”**的一行。不是使用截图中的固定像素坐标，也不会把“解除拉黑”当成“拉黑”。默认连续两次位置稳定后才点击。
3. 确认弹窗必须同时识别到拉黑后不接收消息的说明、“是否拉黑”、左边“取消”和右边完整文字“拉黑”。优先识别弹窗，不点击其背后的同名设置项；不确定的弹窗直接等待或报错。确认按钮只点击一次，完成点击与本地写入后返回成功，不再读取后续页面。

若第二步进入聊天设置时已经观察到“解除拉黑 / 取消拉黑 / 移出黑名单”，返回 `already_blocked_ui`，设置 `blockedUiConfirmed=true`，不点击解除操作。

模型 2 仅有统一 `avatar` 等 7 个类别，没有“拉黑菜单 / 拉黑弹窗”类别。因此**头像由模型 2 识别，后两步用原本地 RapidOCR**；不把 OCR 结果冒称为 YOLO 检测。不修改模型、模型资料或训练/标注文件；本工具的业务判断不用模型 1 或 ScreenParser。公共服务会预热其他工具的模型，不能把“本工具不用”理解为整个服务不加载。

只适配当前提供的中文界面结构。前两步点击不算流程成功，必须完成确认弹窗中的最后一次点击。点击或本地写入失败、取消、超时仍返回失败；不能自动再点一次。完成后不验证 App 或后台是否实际生效，也不会把本地写入冒称为设备回执。

## 配置

真实运行复用现有 FFmpeg 高清截图、WSL YOLO/CUDA 和本地 RapidOCR 环境，无新增 npm 依赖。视觉配置仍通过 `phone.tools({momoVision:{...}})`，这里只使用模型 2 的权重和对应解析器。参见 [高清截图](HD-SCREENSHOT.md)、[视觉环境](OPEN-MOMO.md#配置视觉进程) 和 [运行依赖](../requirements/README.md)。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `execute` | `false` | 显式 `true` 才真实执行 |
| `dryRun` | 继承 tools，默认 `false` | 为 `true` 时优先，只预演 |
| `timeoutMs` | `90000` | 整次操作包含排队、初始化、识别及等待的总预算；显式 tools.timeoutMs 会覆盖默认值，允许 1–300000ms |
| `confidence` | `0.35` | 模型 2 检测阈值，0.28–0.95 |
| `minimumScore` | `0.55` | RapidOCR 原始文字分数下限，0.5–1；短词分数与完整句子分数不同，不使用拼音候选模块的分数校正 |
| `pollMs` | `250` | 观察间隔，100–2000ms，不含模型和 OCR 耗时 |
| `stepTimeoutMs` | `15000` | 等聊天设置、等确认弹窗各自的循环预算，1000–30000ms；单次识别仍受总预算约束；最终确认点击后不再等待结果 |
| `stableObservations` | `2` | 连续稳定观察次数，2–4 |
| `signal` | 无 | AbortSignal；取消后不自动续跑或补点 |

点击为 65–105ms 随机按住时间，附加最多 ±1 个源像素抖动。坐标按每次原图尺寸映射到控制通道；取图后超过 3 秒（包括识别与队列等待）或设备分辨率/连接代次变化时停止，不用旧坐标。

## 状态和错误

返回沿用 [底层工具规范](DEVICE-TOOLS.md#返回规范)。`status='planned'` 表示未执行；`ok=true`、`status='sent'`、`outcome='confirmation_clicked'` 和 `confirmationClickSent=true` 表示最后确认点击及本地写入完成，按约定算流程成功。正常点击完成时 `blockedUiConfirmed` 保持 `false`，不能将它当作成功的必需条件；它只用于已经观察到拉黑状态的分支。`execution.deviceConfirmed` 始终为 `false`，不是后端或 Android 回执。

`data` 包含头像实际坐标、三个点击阶段的 `ClickAttempted / ClickSent`、`outcome`、`blockedUiConfirmed`、`history` 和最后一张截图。其中 `ClickAttempted` 是保守的尝试标记，可能包含进入手势队列前后的失败；不能据其为 true 就断言手机执行了点击。

- `outcome='confirmation_clicked'`：最后确认点击与本地写入完成，流程成功，不等待后续页面。
- `outcome='already_blocked_ui'`：进入聊天设置后发现已拉黑，没有点击解除按钮。
- `outcome='unknown_after_confirm'`：已准备尝试确认，但点击或本地写入未完整成功，不能自动重试。
- `outcome='not_started'`：尚未进入最终确认阶段，仍可能已经点开头像或设置项；结合点击标记和 history 判断。

`lastScreenshot` 含私人聊天/个人信息，仅供调用方受控排错；默认工具日志及 CLI 不打印截图、昵称或整包文字识别结果。

| 错误码 | 排查方向 |
| --- | --- |
| `INVALID_ARGUMENT` | 参数类型、范围或未知参数 |
| `CHAT_NOT_CONFIRMED / CHAT_ANCHOR_AMBIGUOUS / APP_OCCLUDED` | 页面不是支持的聊天页或有遮挡，先人工检查 |
| `TOP_AVATAR_NOT_FOUND` | 模型没找到最上方顶栏头像；不会改点消息头像 |
| `TOP_AVATAR_AMBIGUOUS / TOP_AVATAR_UNSTABLE / CHAT_CHANGED` | 顶栏头像歧义、移动或聊天标题变化，停止操作 |
| `BLOCK_MENU_NOT_FOUND / BLOCK_MENU_AMBIGUOUS` | 未确认聊天设置和唯一的拉黑设置项；不会盲点或自动滚动 |
| `BLOCK_DIALOG_NOT_FOUND / BLOCK_DIALOG_AMBIGUOUS` | 确认弹窗信息不足或按钮不唯一 |
| `OCR_FAILED / OCR_PROTOCOL_ERROR` | OCR 服务或返回数据异常；失败 details 中的 causeCode / recognitionStage 保留底层原因。新默认链直接传图片字节，不再写专用 OCR 临时图 |
| `STALE_TARGET / CONNECTION_LOST / CONNECTION_CHANGED / SCREEN_CHANGED` | 目标过期、连接变化或画面尺寸变化，不回放旧动作 |
| `TIMEOUT / ABORTED / TOOLS_CLOSED` | 预算到期、取消或会话关闭；先查点击进度再决定下一步 |

鉴权、模型加载、GPU、截图和触控释放等错误继续沿用现有工具错误码。失败只保留现场，不自动重新点击头像、拉黑行或确认按钮。

## 文件与核对范围

| 文件 | 职责 |
| --- | --- |
| `src/tools/block-peer.js` | 拉黑流程、稳定观察、点击阶段和结果判断 |
| `src/tools/block-layout.js` | 从模型 2 全部头像中筛最上方顶栏头像，区分设置行与弹窗按钮 |
| `src/tools/screen-text.js` | SDK 原图到本地文字识别的适配及私有临时文件清理 |
| `examples/block-peer.js` | 默认无副作用的命令行入口 |
| `src/tools/index.js`、`src/index.d.ts` | SDK 入口、串行队列、类型及统一错误返回 |

2026-10-16 最初对用户提供的三张图片运行本地识别：模型 2 从 4 个检出头像中选中顶栏头像中心 `(374,60.5)`；设置项“拉黑”中心 `(37,632)`；弹窗“拉黑”按钮中心 `(328,434.5)`。这些是 406×726 附件上的实际输出，不是脚本写死的坐标。

同日已按云手机官网卡片顺序在第 4 台设备实跑：模型 2 识别顶栏头像，依次执行头像、设置项和弹窗确认三次点击；用户观察后确认操作没有问题。旧版在点击完成后额外等待“解除拉黑”状态，返回了 `BLOCK_NOT_CONFIRMED`。

本次按用户要求将完成条件改为最后确认点击及本地写入成功，去除该额外等待。只做语法、模块加载及无副作用预演核对，没有新增测试文件、运行测试套件或为此再次操作手机。
