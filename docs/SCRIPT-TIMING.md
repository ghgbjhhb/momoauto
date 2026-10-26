# 脚本耗时日志

01～14 业务脚本、八步流程、SDK 操作、识别、AI 回复和中枢任务默认记录开始/结束时间与耗时，不改变业务判断、等待策略、重试次数或发送门禁。模型和训练资料不变。

## 立即查看

从项目目录运行：

```powershell
Set-Location 'D:\AA-project\自动化'
npm run timing:report
```

日志位置：`.runtime/timings/YYYY-MM-DD/timing-进程号.jsonl`。日期按 **UTC** 分桶；时间戳末尾的 `Z` 代表 UTC，本地新加坡时间为 UTC+8。同一天不同进程分别写文件，避免多个脚本竞争同一个文件。

网页执行日志显示总耗时、开始/结束时间和 `runId`。复制运行编号后可过滤一次执行：

```powershell
$timingRun = Read-Host '粘贴网页日志中的运行编号'
npm run timing:report -- --run-id $timingRun
```

按设备、数量或某一天筛选：

```powershell
$timingDevice = Read-Host '输入目标设备 ID'
npm run timing:report -- --device-id $timingDevice --limit 50
node scripts/timing-report.js --dir .runtime/timings/2026-10-20 --json
```

尚无日志时命令会说明原因，不会执行手机脚本来制造数据。汇总工具只读日志，不删除文件、不访问云机、不调用 AI。

## 已接入的位置

| 范围 | 记录名 | 口径 |
|---|---|---|
| 网页发起执行 | `script.request` | 从执行接口校验开始，到子进程退出并释放执行锁；失败校验也有记录 |
| 实际子进程 | `script.child` | 文件检查、启动、输出收集、退出；非零退出码记录失败 |
| 01～14 工作流及示例入口 | `script.src.workflows.*`、`script.examples.*` | `main()` 的总耗时，包含其内部等待与清理；帮助/计划模式不等于实际操作成功 |
| 八步流程 | `flow.step`、`script.flows.执行全部` | 单步以及本次批量调用；续跑不把中间人工核对间隔冒充执行耗时 |
| 初始化、定位、输入法等子步骤 | `workflow.*`、`screen.*` | 打开应用、等待状态、确认桌面、定位和初始化等函数边界 |
| SDK 底层工具 | `tool.screenshot`、`tool.click`、`tool.swipe` 等 | 工具调用总耗时，失败及取消也记录；保留原有 `durationMs` 和自定义 logger |
| SDK 工具阶段 | `tool.stage.queue/connect/capture/dispatch/flush` 等 | 每次阶段切换形成一段；阶段名由工具实际路径产生 |
| 主动等待 | `tool.wait`、`automation.wait`、`screen.wait` | 现有等待的真实持续时间；不缩短业务间隔 |
| 网络/手势 | `cloud.*`、`control.tap/swipe/flush/pushFile` 等 | 云端请求（包括响应体读取）和 SDK 动作，不记录 URL、请求体或按键正文 |
| GPU/页面/OCR | `recognition.*`、`recognition.pool.*`、`ocr.recognize`、`page.*` | 预热、排队及识别调用；保留返回的 `queueMs/decodeMs/predictMs/processingMs/totalMs` |
| 分词与打字 | `typing.plan/sharedPlan/run` | 拼音计划和完整打字流程，不记录文本 |
| AI | `workflow.momoAiReply`、`ai.generateReply`、`ai.provider.request` | 回复流程、上下文生成和模型请求；API 运行查询另有 `finishedAt/durationMs` |
| 中枢 | `brain.task.inspect_list/reply/browse/greetings/sweep_list/verify_uncertain` | 单任务执行及清理；适配器返回失败/待确认时不会记为完成 |

业务脚本包装器、对应的 `examples/` 兼容入口和网页调用都覆盖。常驻 Python 工作器由 Node 请求边界计时，GPU 内部耗时取其已有返回值；未修改模型、训练脚本或 Python 标准输出协议。数据库清理、代码索引生成等一次性维护脚本不属于上述手机业务执行链。

## 日志字段

每个步骤写 `start` 和 `end` 两行，JSONL 每行一个对象。

| 字段 | 含义 | 备注 |
|---|---|---|
| `runId` | 一次执行的关联编号 | 从父调用继承；子进程通过专用环境变量传递 |
| `spanId` / `parentSpanId` | 本步骤及父步骤编号 | 用于关联嵌套操作；不是把所有步骤串行求和 |
| `name` | 固定步骤名 | 不拼入昵称、提示词或聊天正文 |
| `pid` | Node 进程号 | 对应当前进程日志文件 |
| `deviceId` | 目标机器 ID | 有可用的数字设备 ID 时记录；账号级脚本可为空 |
| `scriptId/taskId/operationId/order` | 执行定位信息 | 有值且格式有效才记录 |
| `startedAt/finishedAt` | UTC 墙上时间 | `start` 没有结束时间 |
| `durationMs` | 毫秒耗时，保留两位小数 | 使用单调时钟，不受校时、时区切换影响 |
| `status` | 完成、失败、取消、超时、部分完成、待确认等 | `planned/observed/drafted` 不冒充实际发送完成 |
| `errorCode/exitCode` | 安全错误码、子进程退出码 | 没有安全错误码则省略，不写异常原文 |
| `timings` | 识别服务的内部阶段耗时 | 仅复制允许的数字字段，不复制识别文本 |

示例代码用于读取实际日志，不制造示例业务执行：

```powershell
$timingFile = Get-ChildItem '.runtime/timings' -Recurse -File -Filter 'timing-*.jsonl' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($timingFile) {
  Get-Content -LiteralPath $timingFile.FullName |
    ForEach-Object { try { $_ | ConvertFrom-Json -ErrorAction Stop } catch {} } |
    Where-Object event -eq 'end' |
    Select-Object name, status, durationMs, runId, deviceId
}
```

## 如何定位慢的原因

汇总按同名步骤的累计 `totalMs` 降序排列，同时显示次数、失败数、平均、最大值和 P95。失败数包含取消、超时、风控阻断和需要人工确认；计划模式不计为失败。一次失败调用中的已完成子步骤仍保留完成状态，失败发生在哪段可沿父子编号追踪。

先按网页 `runId` 看 `script.request`，再看其中 `script.child`、工作流与工具阶段。排队长看 `queue`，连接长看 `connect`，截图长看 `screenshot/capture`，识别慢比较服务 `totalMs` 与 `predictMs`；大量 `wait` 代表流程本来就在等待，不代表 GPU 慢。

**不能把所有行的耗时相加作为脚本总耗时**：父步骤包含子步骤，识别还可能并行。CLI 包装器也可能嵌套。累计时间用于排序定位，单次总耗时以最外层执行记录为准。

`flows/执行全部.js` 原有 `results.json` 的每次 `attempt` 增加 `durationMs`，Markdown 执行表增加“最近耗时”。该耗时包含执行和原有完成截图/归档；失败时记录到捕获异常为止，后续诊断截图另见底层截图耗时。历史没有耗时的记录仍可续跑，显示 `-`。

网页 API 校验前的请求体接收和网络传输不计入 `script.request`；`main()` 计时也不包含 Node 启动、模块加载及脚本结束后的计时日志刷盘。子进程创建和模块加载会反映在外层 `script.child` 中。常驻服务启动记录不等于全部模型预热完成，预热有独立记录。

## 写盘、错误与配置

默认每 40 ms 异步批量追加，脚本完成及 Node 正常退出前刷新。每个进程最多保留 8192 条待写记录（包括正在写盘的批次），日志慢不会阻塞每个鼠标动作。日志写入失败或缓冲区满时，标准错误输出一次 `TIMING_LOG_WRITE_FAILED_OR_BUFFER_FULL`；业务结果不被日志错误覆盖，后续批次仍尝试写盘。

强制结束进程、断电或调用立即退出可能来不及写完；存在开始但没有结束的步骤记为“未闭合”，不推测耗时或伪装成功。日志日期分桶不是自动清理，文件会继续增长；按日查看/归档，清理前自行确认需要保留的记录。汇总按行读取但为计算精确 P95 保留数值样本，大量历史数据时请用 `--dir` 限定日期。

以下是**启动前的进程环境变量**，修改后重启后台，不是在网页内填写：

```powershell
# 默认打开；需要排除计时影响做对照时关闭。
$env:YUNMOMO_TIMING = '0'
npm run app
```

```powershell
# 恢复计时；不设置自定义目录时使用项目 .runtime/timings。
$env:YUNMOMO_TIMING = '1'
Remove-Item Env:YUNMOMO_TIMING_DIR -ErrorAction SilentlyContinue
npm run app
```

`YUNMOMO_TIMING_DIR` 可改写入目录。`YUNMOMO_TIMING_RUN_ID/PARENT_ID` 仅供父子调用关联，普通用户无需填写。新日志不保存 token、API key、联系方式、聊天正文、图片或第三方原始错误；已有业务 stdout/stderr 的内容规则不变。

## 新工具接入

同步或异步函数使用同一个包装器，保留 `this`、返回对象和原始异常，不改函数参数：

```javascript
const { timed, measure } = require('../automation/timing');

async function readState(device) {
  return measure('custom.readState', { deviceId: device.deviceId }, () => device.info());
}

module.exports = { readState: timed('custom.readState.total', readState,
  device => ({ deviceId: device.deviceId })) };
```

步骤名应为代码中固定名称；不要把用户内容或外部错误拼进名称。新增独立 CLI 用 `launchCli(main)` 或 `timedScript()`，不要把计时摘要写到标准输出（会破坏 JSON 管道）。

## 验证

新增测试在 `test/script-timing.test.js`：同步/异步行为、嵌套并发隔离、失败/取消/超时、敏感字段过滤、重复结束、日志故障/缓冲限制、子进程关联与 JSON stdout、工作流入口覆盖、统计汇总和后端校验失败耗时。完整回归在隔离临时工作区运行，避免现有测试改到真实联系人库或 AI 设置。

```powershell
node --test test/script-timing.test.js
```

测试不执行真实手机动作、不发送消息、不付费调用 AI。离线测试耗时不代表真实云机业务耗时；之后照常运行脚本即可累积真实数据。

2026-10-20 验证：隔离工作区完整回归 **212/212** 通过；185 个 JavaScript 文件语法检查通过。另有常驻服务启动与后续请求隔离测试，确保不同次执行不会继承同一个启动 `runId`。
