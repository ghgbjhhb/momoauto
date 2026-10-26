# MOMO AI 回复与持续监听中枢：修复后复验

日期：2026-10-20。结论：**两个组件均未通过验收，不能据当前修复闭环表认定可持续自动发送。**

本次检查真实实现与调用链，不仅核对交付说明。已有部分修复有效，但关键问题仍停留在“增加了字段、分支或测试”的阶段，没有落实到默认服务入口和真实工具接口。主要后果是：默认任务不能正确分派，发送链被参数校验阻断；即使解除这一阻断，联系人误认、取消失效、重复生成和未决消息误确认仍可能造成错误副作用。

## 1. 范围、方法与证据

范围：`src/workflows/momo-ai-reply.js`、AI provider/context、发送工具及消息仓储；`src/brain/`、统一页面服务/恢复器、设备仲裁器、4318 路由和相关网页控制台。

本次是代码审查和离线契约验收：没有操作真实手机、没有生成或发送真实消息，没有访问真实聊天库、复制真实凭据、修改模型或重启服务。业务源文件未改；新增本报告与独立失败用例。

| 证据 | 实际执行/检查 | 结果与边界 |
| --- | --- | --- |
| E01 | 将当前源码、文档、测试和必要 `ws` 依赖复制到独立临时目录 | 排除 `.env.local`、真实 `.runtime`、模型和虚拟环境；测试只写临时目录 |
| E02 | 运行两个组件已有测试及 remediation-r1～r9 | 69 通过、0 失败；不是全项目套件或实机验收 |
| E03 | 独立增加 9 项验收断言 | 0 通过、9 失败；验证控制逻辑，不测 YOLO/OCR 准确率或 GPU 性能 |
| E04 | 将临时副本和工作目录源码、网页、既有测试及文档逐文件 SHA-256 对照 | 写入本次审查产物前核对 167 个文件，无差异 |
| E05 | Claude Code 独立只读静态复核，再由 Codex 核实代码 | 指定别名 `opus5`；未授权编辑、shell、浏览器、真实设备或业务 API |

实际临时目录：`C:\Users\Administrator\AppData\Local\Temp\momo-recheck-8f7580d79ea249de813d2909e7c1c4b6`。

重要解释：已有 69 项测试为绿，只证明这些测试覆盖的条件成立。新增用例检查了同一接口的失败返回、真实门面依赖、旧帧、低置信身份、嵌套锁释放等条件，不能用已有绿色测试抵消这些反例。

## 2. 阻断验收的问题与修复路径

下列行号对应本次审查时的文件。`Fxx` 指原修复计划，`RCxx` 为本次发现编号；不要把 Claude 报告内自编号当作原计划编号。

### RC01 [P1] 默认注册表与 Actor 的任务名仍不一致

- 位置：`src/brain/device-actor.js:361`；`src/brain/task-adapters.js:158`。
- 触发：默认中枢执行 `browse`、`greetings`、`verify_uncertain`。
- 证据/实际行为：Actor 访问 `taskAdapters[task.type]`，默认导出却是 `runBrowse`、`runGreetings`、`verifyUncertain`。三类任务都会缺少适配器。显式报 `TASK_ADAPTER_MISSING` 比伪造成功好，但并未完成真实接线。
- 修复路径：用一份显式任务类型注册表供 manager/actor/测试共用；不要只给 reply 特判。适配器返回必须检查 `ok/status/outcome`，执行任务不能把 `planned` 或失败标记 completed。
- 验收：默认装配、不注入假适配器，分别执行三类任务，断言进入各真实工具门面且失败不被吞掉。对应 F01、R1/R6。

### RC02 [P1] 真实发送工具门面拒绝 ReplyStore，结果包络也读错

- 位置：`src/workflows/momo-ai-reply.js:269`、`:277`；`src/tools/send-chat-message.js:67`；`src/tools/index.js:272`；`src/tools/runtime.js:46`。
- 触发：工作流把 `phone` 和包含 `ReplyStore` 实例的 options 交给 sender。
- 证据/实际行为：转入 `phone.tools().sendChatMessage()` 后，`_run` 对 options 逐项做纯数据 snapshot。类实例不是 plain object，抛出 `INVALID_ARGUMENT`；独立测试即便只请求 plan 也得到 `{ok:false,status:'failed'}`。此外，门面结果是 `{ok,status,data}`，工作流却读 `sendRes.sendState`，而不是检查 `sendRes.ok` 后读 `sendRes.data.sendState`。
- 修复路径：数据库实例从内部依赖/上下文注入，不作为公开可序列化参数传递；保留参数快照保护，不能全局放宽对类实例和循环对象的校验。统一核心工具与门面的结果契约。
- 验收：走真实 CloudPhoneTools 门面（只替换外部 IO），覆盖 plan、成功、部分失败、uncertain；不能仅直接调用 sender 核心函数或 mock 整个 sender。对应 R6/RP31。证据 E03 第 7 项。

### RC03 [P1] 联系人前缀匹配和低置信放行仍可认错人

- 位置：`src/tools/momo/conversation-reader.js:56`、`:72`。
- 触发：目标“小雨滴”，当前顶栏“小雨滴的哥哥”；或姓名完全相同但 OCR 分数为 0.01。
- 证据/实际行为：两种情况均通过验证。代码使用 `text.startsWith(expected)`，也不校验最低分数，缺少分数时还返回 1.0。
- 修复路径：明确、保守的标准化后完全相等；缺失/低置信/截断/多义都不能放行。发送工具最终动作前必须自己重新核验页面及对象，不能只依赖上游旧检查。当前 sender 导入 verifier 却没有调用，`chat_confirmed` 仅为日志名称。
- 验收：前缀、截断、低置信、缺分数、相似姓名和发送前切换联系人时，入库/生成/键盘/发送应全部停止。对应 F05、R6。证据 E03 第 4、5 项。

### RC04 [P1] 模型结构化失败仍被包装成功，恢复器盲目返回

- 位置：`src/automation/page-service.js:210`～`:223`；`src/automation/page-recovery.js:40`。
- 触发：截图接口成功，但 page/OCR/list 返回 `{ok:false,error:{code:'GPU_DOWN'}}`，没有抛异常。
- 证据/实际行为：识别结果只读取 `.data`，未检查 `.ok`，观察返回 `ok:true`；恢复器继续按 Back。独立用例设置 `maxBackSteps:1`，实际按了 **2 次**。另一个用例不提供任何识别服务或预计算证据，仍得到成功观察。
- 修复路径：检查所有必需依赖返回值和数据结构，保留原因/阶段，失败直接 `dependency_failed`，动作计数为零；分别限制“最多几次动作”和“动作后的最后一次观察”，修复 `<=` 边界。
- 验收：截图、page、OCR、detail、list 的抛错和 `ok:false` 两种形式分别覆盖，不能只测截图失败。对应 F07、R2/R4。证据 E03 第 1、2 项。

### RC05 [P1] 子工作流借用父锁后无法释放自己的引用

- 位置：`src/workflows/momo-ai-reply.js:65`、`:73`、`:303`；`src/server/device-arbiter.js:119`～`:159`。
- 触发：Actor 持锁，AI 子工作流通过 token 借锁；子工作流完成或初始化失败。
- 证据/实际行为：借用使 refCount 从 1 变 2，finally 却用子 runId 释放。仲裁器仍记录父 ownerId，runId 也不是 token，因此拒绝释放。独立测试清理后应为 1，实际为 2。
- 修复路径：拥有者句柄与借用句柄分开，释放各自引用并幂等；不能仅换成共享 token 后允许同一句柄重复扣减。所有资源清理完成、旧任务取消确认后才移交所有权。
- 验收：正常结束、初始化失败、两次 release、父先取消、过期句柄都不能泄漏引用或松掉其他持有者的锁。对应 F04/F10、R3。证据 E03 第 6 项。

### RC06 [P1] Actor 的控制连接没有等待就绪，也没有对称回收

- 位置：`src/brain/device-actor.js:223`～`:233`、`:385`；`src/client.js:176`、`:262`。
- 触发：巡检恢复需要 Back，或回复/滑动使用 Actor 传下来的 control。
- 证据/实际行为：`openControl()` 返回构造好的实例，不代表已 connect/ready；Actor 没调用 connect，也没在 finally 关闭自建 control/tools。每次还调用两次 `phone.tools()`。AI 工作流接收外部 control 时也不会连接它。单独工作流虽加了 connect，但吞掉连接错误继续往下走，不能算失败封闭。
- 修复路径：明确每会话资源创建、就绪、借用、所有权和关闭；以真实连接 generation 关联帧，不用 lease epoch 代替连接代次。连接失败禁止动作；调用方传来的资源不得误关。
- 验收：未 ready、connect 失败、重连、任务异常、长时间多轮执行后，动作计数及活动连接/worker 数符合契约。对应 F08、R3/RP14。

### RC07 [P1] 暂停/取消不能阻断已经开始的生成和输入

- 位置：`src/brain/device-actor.js:62`、`:87`；`src/workflows/momo-ai-reply.js:240`、`:269`；`src/server/ai-reply-routes.js:141`、`:193`。
- 触发：生成过程中暂停中枢或取消单次 AI run，之后 API 晚到返回。
- 证据/实际行为：pause 只更新 desiredState；工作流没有向 generateReply、sender 透传 signal，也没有在动作前检查取消。HTTP 取消先写 cancelled，异步完成又无条件覆盖成 completed/failed。stop 等待不响应取消的任务时没有有界退场机制。
- 修复路径：活动任务独立取消域，全链路 signal、等待和动作前 fencing；先 cancelling/stopping，确认清理后再 cancelled/stopped。无法确认停止就隔离，不释放给第二写流；迟到结果不得派发动作或覆盖终态。
- 验收：API 晚到、打字等待、OCR 卡住、正在恢复时分别暂停/停止；确认后 keyboard/send 计数不增长。对应 F10/F18、R4/R9。

### RC08 [P1] 消息摘要不是新消息批次，任务永久去重与重复生成同时存在

- 位置：`src/brain/device-actor.js:254`、`:294`；`src/brain/scheduler.js:160`；`src/brain/store.js:153`；`src/workflows/momo-ai-reply.js:234`～`:257`；`src/tools/momo/reply-store.js:267`。
- 触发 A：同一联系人以后又发“你好”，或新消息前 8 字与上次一样。
- 实际行为 A：候选键用 `lastMessage.slice(0,8)`；全表唯一键使 completed 旧任务被 `INSERT OR IGNORE` 命中，没有可重新认领的新候选。不能仅把所有 completed 任务无条件重跑，那也会重复发送。
- 触发 B：单次 draft/execute 被重复调用，最近历史最后一条仍为 peer，或已有 draft_ready/send_attempted/uncertain 作业。
- 实际行为 B：先调用生成 API，再随机创建新 job；不检查已有批次作业，也不使用 handledThroughSeq。归档末条 peer 被反复当作待回复，未决副作用也缺少禁止再次生成/发送的门禁。
- 修复路径：列表摘要只用于“候选需要复查”；入聊天后以真实序列增量、已处理游标、稳定 inputDigest 决定批次。生成前事务化认领/复用 job，并加批次唯一约束；uncertain 优先只读核验，不能自动重发。成功后事务推进游标与记录己方事件。
- 验收：同批次重复请求只生成一次；不同批次同正文仍处理；未决作业重启不重发；历史导入不触发旧消息回复。对应 F09/F11、R5/R6/R7。证据 E03 第 9 项。

### RC09 [P1] observe 只在上游改了名字，下游仍调用生成 API

- 位置：`src/brain/task-adapters.js:22`；`src/workflows/momo-ai-reply.js:51`、`:240`、`:260`、`:268`。
- 触发：Actor 降权传入 observe，或 autoReplyEnabled 关闭。
- 证据/实际行为：工作流仅 plan 提前返回；observe 仍导航、读取、调用 LLM、创建草稿作业，只是不进入 draft/execute 尾部分支。runReply 默认还保留 execute。非法 mode 也没有入口拒绝。
- 修复路径：枚举校验和能力矩阵落实到工作流及最后动作层；observe 允许采集归档，但生成 API/typing/send/approve/browse 必须为零。draft 可以生成但同批次复用；execute 还须确认当前许可与配置 revision。
- 验收：测试真实默认适配器到工作流，而非只断言 mock 收到 `mode:'observe'`。对应 F03、RP03～RP05。

### RC10 [P1] 消息读取丢弃模型 2 输入框边界，长历史又取错方向

- 位置：`src/tools/momo/conversation-reader.js:79`～`:81`；`src/tools/momo/chat-message-parser.js:29`～`:42`；`src/tools/momo/reply-store.js:196`。
- 触发：输入法已打开，草稿/候选栏落入默认 h×0.88 范围；或历史超过 1000 条。
- 证据/实际行为：parseChatMessages 支持 detailData，但 reader 没传，实际输入框边界和头像信息被丢掉；草稿、键盘文字可能被解析为历史。仓储 `ORDER BY seq ASC LIMIT 1000` 返回最早 1000 条，不是最新尾部，增量对齐和生成上下文将忽略后续消息。
- 修复路径：传递同帧模型 2 数据，按真实 input_box 排除键盘/草稿；头像、气泡、系统提示分层。尾部查询先按倒序限量再恢复时间顺序，明确截断状态。
- 验收：键盘开启、已有草稿、连续相同正文和超过 1000 条的历史都要覆盖。对应 R6，以及 AI 原审查未闭环项。

### RC11 [P1] “自己的新气泡”仍可能只是历史同文或其他聊天内容

- 位置：`src/tools/send-chat-message.js:206`；`src/brain/task-adapters.js:123`～`:132`。
- 触发：屏幕本来就有“你好”等相同正文；未决核验时处于另一联系人聊天页。
- 证据/实际行为：仅检查 OCR 同文和 left/top 比例，没有发送前尾部基线、真实己方气泡边界和新增事件判断；核验器也未先确认 `obs.ok`、正确页面及正确联系人。因此旧同文气泡可以使 job 被标为 own_bubble_observed。更新后未完成处理游标与双库任务对账。
- 修复路径：保留发送前后序列证据及所属联系人；仅新增、己方、匹配正文的有序事件可确认。证据不足维持 uncertain，核验失败不改为成功、更不重发。
- 验收：旧同文、对方同文、错会话、OCR 失败、发送后新增气泡、已确认但 brain 库未更新的崩溃窗口。对应 F11、R7。

### RC12 [P1] 4318 保存配置未通知 Actor，且中枢 client 与网页运行 client 分离

- 位置：`src/server/momo-brain-routes.js:44`；`src/brain/manager.js:124`、`:147`；`src/server/app-server.js:182`、`:501`、`:509`。
- 触发：网页运行中关闭自动回复/降权，或切换网页登录会话后启动中枢。
- 证据/实际行为：manager 虽增加 updateConfigAndNotify，HTTP 路由仍直接 saveBrainConfig，活跃 Actor 保留旧配置。默认 manager 在模块 import 时创建 DB 和独立 YunmomoClient；4318 将 sharedClient 传给 AI 路由，却没有注入中枢默认入口，可能继续使用旧/缺失凭据。
- 修复路径：在服务 composition root 显式装配同一运行 client、manager、arbiter，消除导入副作用；配置写入统一经过通知/降权协议，活动任务动作前检查当前 revision；账号切换先安全停止相关任务。
- 验收：通过真实 HTTP handler 测配置保存，不只直调新增 manager 方法。验证运行中降权与 client 重新装配。对应 F01/F16、R1/R9。

### RC13 [P1] 限频只返回一个标志，没有持久冷却和设备级阻断

- 位置：`src/brain/task-adapters.js:57`～`:69`；`src/brain/device-actor.js:370`～`:374`。
- 触发：招呼工具报告 rateLimited，或页面恢复返回验证码/风险守卫。
- 证据/实际行为：适配器只返回标志；Actor 忽略结果并 completed，没有写 cooldownUntil/guard。page 分类的风险优先级已改，但不等于跨 tick/跨重启阻断。招呼适配器即使遇限频仍继续调用页面恢复。
- 补充接线问题：招呼和浏览直接调用底层核心函数，没有 OperationContext，且没有显式 execute。两者默认预览，不能当真正执行成功；不能只为修好此项盲加 execute，必须先过模式/配额/租约门禁。
- 修复路径：真实工具门面返回统一结果；风控立即停止业务动作，持久写入设备守卫、调度冷却和人工恢复条件。可恢复限频与验证码/账号异常区分，禁止后者固定等几分钟后自动继续。
- 验收：连续 tick、服务重启、已有队列和其他低优先级任务均不能绕过阻断。对应 F12/F15、R4/R5/R8。

### RC14 [P1] 帧的身份字段校验不等于时效校验

- 位置：`src/automation/page-service.js:150`～`:176`、`:267`。
- 触发：外部传入一小时前、deviceId/generation 均匹配的旧图；或缺少来源字段的图。
- 证据/实际行为：没有 capturedAt 年龄检查；deviceId/generation 也只在提供时核对。独立旧帧用例返回 ok:true。连接 generation 与租约 epoch 混用，使“同一数字”不能证明属于当前连接。动作之后也没有对旧目标作废。
- 修复路径：强制帧来源、采集时刻、真实连接代次和尺寸契约；动作后旧证据失效。旧图片可以作离线分析输入，但不得当作可点击的实时观测，应明确不同入口/用途。
- 验收：旧图、缺来源、跨设备、旧连接、重连后同坐标、动作后旧目标全部拒绝用于操作。对应 F19、R2/RP09。证据 E03 第 3 项。

### RC15 [P2] 多联系人循环和多屏巡检尚未形成可重入导航闭环

- 位置：`src/workflows/momo-ai-reply.js:171`～`:290`；`src/brain/device-actor.js:283`～`:317`。
- 触发：maxContacts>1，或覆盖巡检达到下屏。
- 证据/实际行为：AI 每处理完一位联系人没有归位/重新定位下一位，就使用初始列表旧坐标在当前聊天界面继续点击。覆盖循环不检查 obs.ok/页面迁移，结束调用 recoverToAllowedPage(['message_list']) 只能证明页面种类，不能证明回到了列表顶部。
- 修复路径：每位联系人结束/异常后安全归位并重新观察卡片；巡检记录实际滚动进展和覆盖游标，回顶部必须有独立可证明条件，不能把“仍是消息列表”当作“顶部归位”。
- 验收：两位联系人、联系人重排、相同画面未滚动、第二屏联系人、预算耗尽与真实到尾分别覆盖。对应 F05/F13、R6/R8。

### RC16 [P2] 长期运行资源与全局时间预算仍有漏洞

- 位置：`src/brain/device-actor.js:108`～`:123`；`src/ai/provider.js:53`、`:85`、`:129`。
- 触发：Actor 多次自然结束 sleep；API 已返回 headers 但 body 永不结束。
- 证据/实际行为：sleep 完成不移除 abort 监听，15 次后仍有 15 个；wake 也没清理原 timer，旧回调可影响下一轮。provider 在拿到 headers 后 finally 就清除超时计时，随后 response.json()/text() 不再受该超时约束。
- 修复路径：统一一次性完成的 sleep 清理 timer/listener/wake 引用；网络 timeout 覆盖完整响应体及清理期，父 signal 订阅需解除且检查已 aborted。
- 验收：虚拟时钟长跑、反复 wake/abort、只返回 headers、挂住 body 的 fetch 替身均有界结束。对应 R4/RP20。证据 E03 第 8 项。

## 3. 原 F01～F19 的复验状态

“局部成立”只表示指定分支有改进，不表示生产链路/完整验收已经通过。

| 原项 | 状态 | 本次判断 |
| --- | --- | --- |
| F01 | 未关闭 | 默认适配器对象存在，但三种 task.type 不匹配；服务 client 仍未显式装配 |
| F02 | 局部成立 | evidence 开始返回原始模型结果；无效返回和无证据成功仍需 RC04 |
| F03 | 未关闭 | 上游传 mode，但 observe 下游照样生成，默认 execute 未消除 |
| F04 | 未关闭 | 可借到父锁，但释放不匹配，引用泄漏 |
| F05 | 部分修复 | 已找真实卡片；身份模糊匹配、旧坐标和多联系人导航未闭环 |
| F06 | 部分修复 | 优先获取当前设备有所改进；异步 UI 响应还需绑定选中设备/请求版本验收 |
| F07 | 未关闭 | 截图失败已有拦截；模型 ok:false 仍伪装成功 |
| F08 | 未关闭 | 单次 workflow 加了 connect；Actor 仍未连接和回收，异常仍被吞 |
| F09 | 未关闭 | 恒定 0 换成正文前 8 字，仍不能表示真实批次 |
| F10 | 部分修复 | 手动/旧脚本开始接仲裁；借用、取消、迟到动作与安全移交仍不完整 |
| F11 | 未关闭 | 有 job 查询和核验候选，但默认任务分派不通、历史同文可伪成功 |
| F12 | 部分修复 | 风险分类优先级改善；没有实现所宣称的持久冷却闭环 |
| F13 | 部分修复 | 加了多屏循环、swipe 与 partial；页面/进展/顶部归位断言仍不完整 |
| F14 | 部分修复 | 任务上下文初始化移到 try 内；启动 reconciliation 吞错、遗留 running 对账仍不足 |
| F15 | 局部成立 | updateSchedule 的 PATCH 字段保留已实现；调用方仍未写入限频冷却 |
| F16 | 未关闭 | 新增校验/通知函数，但 HTTP 保存没走通知，入口和运行中降权未贯通 |
| F17 | 部分修复 | 增加 reply 后巡检轮转；未证明未决核验绝对优先、deadline 和积压合并 |
| F18 | 部分修复 | close 确实 await stopAll；仍缺取消不响应时有界关闭与隔离证明 |
| F19 | 未关闭 | 显式跨设备/代次不匹配被拦；旧时间和缺来源仍放行 |

因此 `docs/MOMO-BRAIN.md` 第七节“F01～F19 闭环表”目前不能作为全部修复完成的验收凭证。建议保留原计划，不删除失败断言，把状态改成“局部实现/待端到端验收”，待真实通过后再闭环。

## 4. 独立验收用例与复现

独立用例保存在 `test-support/momo-recheck-acceptance-2026-10-20.cjs`，不混入默认日常测试。**目前预期退出码为 1，这是失败证据，不是修复后的绿色回归套件。**

| 用例 | 应满足的断言 | 本次实际结果 |
| --- | --- | --- |
| 1 识别依赖失败 | observedOk=false、dependency_failed、Back=0 | true、budget_exhausted、Back=2（配置上限为 1） |
| 2 缺少识别服务/证据 | 观察失败 | ok=true |
| 3 一小时前的同设备同代次图 | 拒绝实时使用 | ok=true |
| 4 昵称前缀超集 | TARGET_MISMATCH | 放行 |
| 5 姓名分数 0.01 | 拒绝身份确认 | 放行 |
| 6 子任务异常后释放引用 | 父 refCount=1 | refCount=2 |
| 7 真实门面携带内部 ReplyStore 依赖 | plan 成功且零 IO | failed |
| 8 15 次 sleep 正常结束 | 残留 abort listener=0 | 15 |
| 9 旧候选完成后再次发现相同摘要 | 可复查新的候选，最终由真实消息批次防重复 | 没有可认领任务，旧 completed 项永久命中 |

### 在本次临时副本直接重跑

以下命令已经在该隔离目录执行。目录中的 `.runtime` 是离线测试生成的临时数据，不是真实聊天库。

```powershell
Set-Location -LiteralPath 'C:\Users\Administrator\AppData\Local\Temp\momo-recheck-8f7580d79ea249de813d2909e7c1c4b6'
& 'D:\nodejs\node.exe' --test test-support/momo-recheck-acceptance-2026-10-20.cjs
```

已有测试的同批运行命令（69 项）：

```powershell
$tests = @(
  'test/ai-reply.test.js', 'test/ai-reply-routes.test.js',
  'test/momo-reply-store.test.js', 'test/momo-conversation-reader.test.js',
  'test/send-chat-message.test.js', 'test/device-arbiter.test.js',
  'test/momo-brain-adapters.test.js', 'test/momo-brain-routes.test.js',
  'test/momo-brain-scheduler.test.js', 'test/momo-brain-store.test.js',
  'test/page-service.test.js', 'test/page-recovery.test.js'
) + (1..9 | ForEach-Object { "test/remediation-r$_.test.js" })
& 'D:\nodejs\node.exe' --test @tests
```

需要对以后版本重新验收时，先重新建立无真实配置/数据库的副本，再运行用例；不能在修改后的生产目录直接运行所有测试，并把旧副本结果当新版本结果。

## 5. 继续交给编码助手时的分批顺序

不是把 RC01～RC16 一次性丢给模型重写整个系统。按下面顺序，每批保持失败用例、真实契约和可回滚文件清单：

1. **A：默认入口与所有权**：明确注册表、统一 client/arbiter 注入、control connect/ready/close、独立借用句柄；先解除 RC01/05/06/12 的接线问题。
2. **B：证据和权限门禁**：依赖失败封闭、帧代次/时效、精确身份、observe/draft/execute 能力矩阵、取消/fencing。此批完成前禁止进入实机自动发送。
3. **C：单次 AI 与发送**：真实 sender 门面、模型 2 消息边界、历史尾部、生成前作业幂等、发送前目标/草稿检查、发送后新增己方气泡、uncertain 和双库对账。
4. **D：持续调度**：候选复查与真实批次分层、风控持久守卫、覆盖游标/导航、超时/长跑资源、运行中配置降权和网页异步响应归属。
5. **E：完整验收**：原 R10 的 RP01～RP46 加新反例，真实门面与默认 HTTP 装配集成测试；再依次申请观察、draft、指定联系人单次发送和长期运行的实机阶段。离线 mock 成功不能代替实机证据。

每批交付必须说明：改了哪些文件、哪个失败用例先失败后通过、原套件是否回归、哪些未完成、是否有不可取消副作用。不得删除安全断言、改断言接受错误行为，或只更新“已完成”注释。

## 6. Claude Code 调用及模型提示策略

本次按要求传入 **`--model opus5`**。CLI 元数据也记录该别名；它提示过 `unrecognized_model`，但后续请求能够执行。别名究竟由代理映射到哪一个上游，仅凭 CLI 别名不能独立证明；不能据此声称实际调用了 Anthropic Opus 或独立验证了 Gemini 3.8 Flash 路由。

只暴露 Read/Glob/Grep；没有编辑、shell、网络、浏览器、MCP 或手机权限。首次独立审查达到 35 轮上限，没有完整报告；以同一会话追加 3 轮只汇总现有证据，成功退出并返回文本 JSON。该汇总没有满足原严格报告 schema，**未被程序当成结构化验收通过**；Codex 只采用逐项核实后的实质发现。没有合并 Claude 生成的业务代码，也没有把 Claude 口头结论当测试通过。

已查阅 Google 官方 [Gemini 3.8 Flash 模型说明](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) 和 [提示词设计建议](https://ai.google.dev/gemini-api/docs/prompting-strategies)。模型页确认该型号存在；实际代理映射仍是另一件事。提示策略采用以下工程化应用：

- 把禁止实机副作用、所有权和验收条件放在任务开头。
- 一批一个清晰目标、明确可改文件和不可改文件，避免泛泛“全面修好”。
- 以输入/输出契约和具体反例代替“严格遵守”“生产级”等抽象要求。
- 要求实现位置、测试命令、退出码和剩余问题；只读复核不能自称已运行测试。
- 显式预留总结轮次；若达到预算，先交证据和未完成项，不继续扩展任务。
- 结构化输出失败不能自动视作通过，最终由主审运行重要反例和检查实际调用链。

以上是把官方通用建议应用到本项目后的执行约束，不是模型能百分之百服从指令或代码必然正确的保证。

调用前后可见的共享账户余量记录如下；这是整个账户窗口的变化，不能全部归因于这一次 Claude 委派，也不是该模型的单独 token 账单。条形图为 20 格近似值：

```text
Codex 5-hour [##############------] 92% -> 68% remaining (-24 points)
Codex weekly [########------------] 45% -> 41% remaining (-4 points)
Claude/proxy [????????????????????] unavailable
```

## 7. 本次交付及验收门槛

新增：本报告、独立验收证据脚本。未修改业务源文件、网页文案、原修复计划、数据库和模型；未进行真实设备测试。

当前判定：**AI 回复：不通过；持续监听中枢：不通过。** 修复后的复验至少要求：本次 9 个反例转绿且不降低安全语义、原相关测试不回归、补齐未覆盖的 R10 集成验收，最后再有按授权阶段完成的实机证据。

证据链：E01/E04 确认检查对象 → E02 暴露原有覆盖边界 → E03 复现 RC02/03/04/05/08/14/16 → E05 补充独立静态复核 → 第五节分批修复 → 离线验收与实机阶段分开签收。
