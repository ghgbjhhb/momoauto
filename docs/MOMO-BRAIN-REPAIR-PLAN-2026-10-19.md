# MOMO 持续监听中枢：代码审查修复执行方案

> 日期：2026-10-19。项目根目录：`D:\AA-project\自动化`。本文交给开发助手实施，是修复要求与验收标准，不是修复完成报告。
>
> 本次只新增本文，不修改业务代码，不启动中枢，不调用聊天 API，不操作手机。2026-10-19 审查时，隔离副本中的原有 134 项测试全部通过，但 20 项补充验证暴露了关键调用链问题；测试数量不等于业务覆盖率。编写本文前核对源码、网页与测试文件，其哈希仍与该审查副本一致。
>
> 执行顺序：R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8 → R9 → R10。前一阶段的安全门禁未通过，不开放下一阶段的真实业务动作。离线纯逻辑开发可以继续，但不能宣称实机已通过。

## 1. 任务边界和交付目标

在既有代码上修复，不推倒重写，不另外开发一套聊天、打字或数据库系统。

必须保留：

- 唯一控制台 `http://127.0.0.1:4318/`；CLI 通过该后台管理中枢，不另起长期控制进程。
- 现有 SDK 截图、点击、滑动、中文输入、GPU 常驻识别和各设备聊天数据库。
- 既有脚本名称、初始化/VPC/改机等业务意图；仅调整接入、互斥、生命周期和错误传播。
- 消息列表模型已有的边缘卡片过滤等配置，不擅自放宽。
- 模型、训练集、标注和对应资料的原位置与内容。

本期不新增：验证码自动处理、自动登录、主动群发、自动拉黑/发送联系方式、额外点赞评论关注、平台限制规避、多租户售卖系统。浏览/招呼仅保留用户明确开启的既有能力，不能以增加随机动作掩盖错误。

最终必须证明：

1. 从默认网页入口实际发现并归档新消息，而不是只能运行注入了替身的局部函数。
2. observe 不调用生成 API、不打字、不发送；draft 不打字、不发送。
3. execute 只向已核验的指定联系人发送；同一批消息不重复生成或发送。
4. 单台设备只有一个受管写操作流；人工接管前旧任务确实停止。
5. 风控、依赖失败、未知发送结果、重启和取消不会被当作正常成功继续推进。
6. 每项交付有源码、断言和实际测试记录，不以注释或交付报告代替实现。

配套资料：[原中枢开发计划](D:/AA-project/自动化/docs/MOMO-BRAIN-IMPLEMENTATION-PLAN.md)、[AI 回复开发计划](D:/AA-project/自动化/docs/MOMO-AI-REPLY-IMPLEMENTATION-PLAN.md)、[AI 回复代码审查](D:/AA-project/自动化/docs/reviews/MOMO-AI-REPLY-CODE-REVIEW-2026-10-19.md)、[工程守则](D:/AA-project/自动化/GEMINI.md)。旧使用文档中的“已全部实现”等结论必须在本次真实验收后更正，不能直接沿用。

## 2. 审查问题到修复阶段的追踪表

编号对应本次代码审查的 19 项问题。表中位置是当前证据入口；实施时重新搜索全部调用方，不依赖行号永久不变。

| 编号 | 证据 / 已知问题 | 修复阶段与做法 | 核心验收 |
| --- | --- | --- | --- |
| F01 | `manager.js` 默认空适配器；Actor 无实现仍 completed；任务名与导出名不同 | R1 显式依赖装配和任务注册表；R6 正规工具接入 | 默认入口使用真实适配器；缺失立即失败；预览不是执行成功 |
| F02 | PageService 不返回消费者读取的 ocrData/listRaw/detailRaw | R2 统一观测契约、原始证据和必需字段 | 同一联系人穿过页面服务后仍能被扫描到，身份核验有证据 |
| F03 | 会话 mode 未下传；runReply 默认 execute；autoReplyEnabled 未检查 | R1 权限矩阵、R6 端到端模式贯穿 | observe/draft/关闭开关的发送和输入调用计数为零 |
| F04 | Actor 持锁，回复以新 runId 再抢同机锁 | R3 父租约借用和动作前校验 | 子任务不再 DEVICE_BUSY，也不能释放父所有权 |
| F05 | 指定 contactName 的候选缺坐标，不进入聊天就核验 | R6 重新定位真实卡片、点击、双层确认 | 联系人重排或点错时不入错库、不生成、不发送 |
| F06 | 网页取旧手动窗 deckDeviceId，不取当前选中设备 | R9 使用统一选中状态和选择变更事件 | 选 B、手动窗曾打开 A，启动/暂停/日志全部指向 B |
| F07 | 截图/模型 ok:false 被当成功，恢复器盲发 Back | R2 失败封闭；R4 按错误类型恢复 | 任一必需依赖失败，Back/tap/send 计数为零 |
| F08 | openControl 未 connect；重复 tools、缺资源回收 | R3 会话资源所有权与连接就绪 | 连接就绪后才允许动作；资源数量长期稳定 |
| F09 | triggerSeq 恒为 0，相同联系人永久命中旧任务 | R5 候选合并与真实增量批次；R6 幂等回复意图 | 相同批次不重复，下一个新批次仍可处理 |
| F10 | 手动/旧脚本锁独立；pause/stop 没贯穿 signal | R3 统一仲裁；R4 取消确认与迟到回调封禁 | 接管前确实释放；取消后迟到 API 不触发输入 |
| F11 | verifyUncertain 只看页面，失败也 verified；未入队 | R7 只读核验与回复作业对账 | 没截图、没目标气泡均不能核验成功，绝不自动重发 |
| F12 | 风控只失败内层；安全浮窗判断盖过验证码 | R2 风险优先；R4 设备级持久阻断 | 后续 tick、重启均不自动绕过阻断 |
| F13 | sweep_list 与 inspect_list 一样，没有滑动覆盖 | R8 有界覆盖片段、真实覆盖记录 | 第二屏联系人被发现，预算耗尽明确 partial |
| F14 | 上下文初始化在 try 外；running 任务重启遗留 | R4 完整生命周期；R7 reconciliation | 初始化失败无永久 running，旧副作用先核验 |
| F15 | updateSchedule 缺省值 0 清空冷却/配额；限频未落库 | R5 PATCH 语义和持久限制 | 只改 dueAt 不改变其他字段，重启不清零 |
| F16 | 配置无范围校验，运行 Actor 不更新 | R1 严格验证；R9 revision 与安全应用 | 非法值拒绝；降权及时生效；升权需显式启动 |
| F17 | 只有固定优先级，巡检饥饿；deadline 不生效 | R5 公平队列、周期合并、过期分类 | 回复后给到期巡检机会，不突发补跑旧 tick |
| F18 | close 未等待 stopAll 就关数据库 | R4 有界异步关闭 | actor 收尾后关库；超时保留 unclean，不误报已停止 |
| F19 | 外部旧帧被重新盖时间/设备/代次 | R2 快照来源和代次验证 | 跨设备、旧连接、过期帧均拒绝，不能换 ID 洗成新图 |

## 3. 先冻结跨模块契约，再写实现

下列代码块是待实现的接口示意，不是现有可运行 API。可以合理合并文件，但字段语义、失败条件和验收要求不能省略。不要为了满足文件数量创建空壳。

### 3.1 运行上下文与设备会话

统一由服务端装配并传入，工作流不再自行创建另一套 tools/control/pool：

```typescript
interface OperationContext {
  deviceId: string;
  accountScope: string;
  sessionId: string;
  taskId: string;
  mode: 'observe' | 'draft' | 'execute';
  configRevision: number;
  authRevision: number;
  signal: AbortSignal;
  deadlineMonoMs: number;
  lease: LeaseHandle;
  session: DeviceSession;
  capabilities: Readonly<Capabilities>;
  checkActive(): void;
  remainingMs(): number;
}
```

- `DeviceSession` 复用一套 client/device/tools/control/recognitionClient，记录哪些资源由自己拥有。共享 GPU 服务不归某个 Actor 关闭。
- lease epoch、任务运行代次、SDK `control._generation` 是三个不同概念，分别记录，不得再用 `lease.epoch` 冒充连接 generation。
- 高清截图流与输入控制若使用不同连接，各自记录 connectionId/generation，通过同一设备、显示屏、鉴权版本和操作会话关联；不能比较两个独立计数器的数值相等就证明同源，也不能把当前输入代次强行盖到旧截图上。
- deviceId 是服务端验证后的稳定 ID，不是网页第几台；accountScope 至少绑定当前后台登录会话版本。尚不能获取 MOMO 稳定账号 ID 时明确记录限制，不冒充已支持同名/改名精确身份。
- 暂不重构为多租户系统，聊天库继续每设备独立；但后台更换云账号或检测到手机账号变化时必须停止旧任务，不在旧范围继续写库。
- `checkActive()` 至少验证 signal、deadline、当前任务代次、配置降权、鉴权版本和租约有效性。每次异步等待返回后，以及实际派发动作前，都重新检查。
- 真实写操作集中经过受管的动作网关。不能只在任务开始检查一次，之后让旧回调直接 control.tap/text/key。

### 3.2 结果契约：执行状态不等于发送成功

```typescript
interface TaskResult {
  ok: boolean;
  status: 'completed' | 'yielded' | 'waiting' | 'blocked'
        | 'uncertain' | 'cancelled' | 'failed';
  outcome: string;
  effect: 'not_started' | 'confirmed' | 'uncertain';
  retry: { policy: 'never' | 'safe_after_delay' | 'verify_first'; at?: number };
  replyJobId?: string;
  checkpoint?: object;
  error?: { code: string; stage: string; retrySafe: boolean };
}
```

统一适配旧返回值中的 `ok/status/data.outcome/execution/sendState`。缺少关键字段返回 `RESULT_CONTRACT_INVALID`，不要用 `{}`、false 或默认 completed 吞掉。

| 真实结果 | 调度落点 | 禁止做法 |
| --- | --- | --- |
| 无新消息且读取可靠 | 本次观察 completed，保留未解决 pending | 清除旧 pending 或声称全列表没消息 |
| draft_ready | 生成任务 completed，消息批次仍未标已回复 | 等同已发送，或下一 tick 重新计费生成 |
| 已确认本次新增己方气泡 | ReplyStore 提交 handled 范围，中枢引用完成 | 用空输入框或历史同文气泡代替确认 |
| rate_limited，即使旧 ok:true | blocked/cooldown，保留原因与范围 | generic completed 后立即再进 |
| send_attempted 后结果未知 | uncertain + verify_first | failed 后从头自动重发 |
| 工具仅 planned | plan 模式下可算规划完成；execute 下视为契约错误 | 把预览当已经浏览、通过或发送 |
| cancelled | 取消请求、清理完成、业务副作用三者分别记录 | 请求取消后立刻显示 stopped |

## 4. R0：基线、隔离和影响面测绘

涉及：现有 `src/brain/`、页面服务、工作流、发送器、路由、网页、CLI、测试与文档。数据库和真实设备属于高风险范围。

执行要求：

1. 重新读取工程守则、本文、原中枢计划和 AI 回复审查；搜索所有 observePage、runMomoAiReplyOnce、sendChatMessage、默认仲裁器和旧锁的调用方。
2. 记录当前文件版本/哈希、修改前测试结果和已有他人改动。不要覆盖其他助手工作，不得假设一定有 Git；无 Git 时用限定文件备份与清单。
3. 先补失败用例，证明 F01～F19 目前哪些失败、哪些已被其他助手修复，再实施。不能为了测试通过把未实现路径 mock 成成功。
4. 测试使用临时配置、临时 SQLite、模拟生成 API 和控制器。先修复现有测试直接改写项目 `.runtime` 配置的问题；模块导入不能创建真实控制库。
5. 离线测试拦截非 loopback 网络，并对子进程继承同样的限制；现有本地 ws 协议测试可以使用 loopback。禁止读取/复制真实聊天库和密钥来当 fixture。
6. 不启动默认单例、不触发 GPU 权重下载、不运行真实 execute、不重启 4318。需要实机验证时另行报告请求用户指定设备和测试会话。
7. 当前审查使用 Node v24.19.0；核对 package.json 的 engines 与实际 node:sqlite 等依赖 API 是否一致，不声称旧 Node 版本已经验证，不为修复顺便大规模升级依赖。

门禁：有可重复失败的关键回归；测试不会污染真实配置、业务库或手机。

## 5. R1：默认依赖装配、任务注册和权限

涉及：`src/server/app-server.js`、`src/server/momo-brain-routes.js`、`src/server/ai-reply-routes.js`、`src/brain/manager.js`、`task-adapters.js`、`config.js`。

### 5.1 把默认入口真正接通

- 将 Manager 的创建放在服务启动的 composition root，路由接收该实例；避免 require manager 就创建数据库和无鉴权客户端。
- 注入后台当前认证 client 的提供者、共享识别客户端、统一 arbiter、store、clock 和显式适配器注册表。当前后台使用 runtimeToken/localEnv，不能假设新 YunmomoClient() 自动继承网页登录态。
- 鉴权切换前停止相关 Actor，等待清理；新任务使用新 authRevision。旧请求迟到不得继续控制旧设备。
- 所有必要任务启动前进行能力校验。浏览/招呼尚不安全时，将其标记 unavailable 并拒绝开启，不让空实现蒙混过关。
- 任务映射明确列出 inspect_list、sweep_list、reply、verify_uncertain、browse、greetings；禁止动态猜函数名。缺失返回 `TASK_ADAPTER_MISSING`。
- 结果必须经过统一归一化和状态映射，不能再由 generic 分支无条件 completed。

### 5.2 权限矩阵必须落到最后一层动作

| 能力 | plan | observe | draft | execute |
| --- | --- | --- | --- | --- |
| 实际截图/页面导航 | 禁止 | 允许，受租约与恢复策略约束 | 允许 | 允许 |
| 读取、去重与归档消息 | 禁止 | 允许 | 允许 | 允许 |
| 外部生成 API | 禁止 | 禁止 | 允许，受生成预算约束 | 自动回复开关开启且授权后允许 |
| 手机输入/点击发送 | 禁止 | 禁止 | 禁止 | 仅完整前置核验通过后允许 |
| 首页浏览/招呼业务动作 | 禁止 | 禁止 | 禁止 | 对应开关、能力门禁和配额均通过才允许 |

- Brain 的持久模式只接受 observe/draft/execute。原工作流 plan 保留为独立纯规划入口，不创建 Actor、不写业务库、不调用手机/API。
- autoReplyEnabled=false 禁止自动生成并发送链路，但 observe 的消息采集仍正常；用户显式选择 draft 可生成草稿，不会因此暗中打开 execute。
- 不存在“缺少 mode 默认 execute”。不认识的模式拒绝，未授权能力拒绝；适配器、工作流、发送器三层检查，最终权限取当前授权与任务启动授权的交集。
- 保存配置不能隐式升权。运行中关闭自动回复/切换到更低权限必须即时阻断后续写动作；提升到 execute 需要用户明确停止后重新启动并通过配置校验。

门禁：通过默认 HTTP 装配链，而不是专用测试构造器，能得到非空适配器和当前 client；任何只读模式下的真实输入/发送调用数为零。

## 6. R2：统一页面证据与失败封闭

涉及：`src/automation/page-service.js`、识别适配层、调用它的 Actor、reader、sender、recovery。

### 6.1 补齐契约，不复制无用大对象

- `evidence` 返回消费者需要的 `pageRaw/ocrData/listRaw/detailRaw`，每项附 source snapshotId、尺寸、设备范围、控制代次和识别状态。
- 按任务声明 requiredEvidence：列表扫描需要列表和 OCR；聊天核验需要页面、详情和 OCR；不要求每次把四种识别全部跑一遍。
- 成功推理但零检测与依赖失败不同。必需模型失败不能用空数据替代，非必需结果可明确 not_requested，不伪装识别成功。
- 图像字节只放有上限的内存快照缓存。事件、SQLite checkpoint 和 HTTP 状态不包含 Buffer、完整 OCR 和聊天全文，只保存引用及必要摘要。

### 6.2 截图失败不是 unknown 页面

- 检查 screenshot 的 ok、data、image、实际尺寸；识别返回值逐项检查 ok/data/schema。截图调用也传 signal 和剩余 deadline。
- 正常返回 `ok:false` 与抛异常都映射到结构化错误，不凭 OCR 文本存在就填置信度 0.9，也不凭缺尺寸就虚构 720×1280。
- 黑屏、解码失败、连接断开、GPU 不可用、合法可读但页面 unknown 分开。只有最后一种才可能进入有界 Back 恢复。
- 错误包含 provider/stage/原始安全错误码和 retrySafe，不记录 token、私聊全文或 API Key。

### 6.3 快照、坐标和遮挡

- 快照由截图适配器在真实采集时生成身份和时间；复用已有帧必须保留原身份，不能重新盖时间或设备标识。
- 校验 deviceId/accountScope、authRevision、controlGeneration、图像尺寸、动作序号与来源。跨设备或旧连接结果拒绝。
- 动作后立刻使旧目标失效。观察完成到实际派发超过 1000ms 重新核验；输入期间需要新帧时不复用输入前的坐标。
- 模型缩放图、实际图像、控制坐标和浏览器 CSS 坐标区分，明确变换；不得直接把 CSS 坐标当手机坐标。
- 风险/登录/验证码/权限/丢弃草稿等守卫优先于安全浮窗。存在冲突返回阻断或 unknown_overlay，不点关闭叉尝试绕过去。
- 结合 UI 区域、结构和原有模型证据，防止聊天正文提到“登录过期/频繁”被误判为平台守卫；昵称匹配不使用 contains/宽松前缀自动放行。
- 只有一个“设置”等词不能认定桌面；多级 unknown 子页的进展比较要结合结构特征，不能只比较 app/page/scene 字符串。
- 像素相同不等于旧帧或卡死；当前静止页面与被复用/伪造来源的过期截图分别判断，结合实际流连接健康、采集来源和观察记录，不因静态画面不断重连或按返回。

门禁：给定一名合法未读联系人的原始识别，经 observePage 返回后依旧扫描到该人；必需依赖失败时导航/发送计数为零；旧帧和危险遮挡测试全部拒绝动作。

## 7. R3：统一设备所有权和连接资源

涉及：`src/server/device-arbiter.js`、`manual-control.js`、旧 runScript 调度、AI 路由、Manager、Actor、SDK/tools 的受管动作入口。

### 7.1 一个服务端仲裁器

- 4318 中枢、单次 AI 回复、手动操作和旧脚本启动都先向同一 arbiter 申请所有权。busyDevices 可以过渡期作为派生展示，不能仍是独立真相源。
- Actor 管理会话不等于永久占写锁；执行原子任务或恢复片段时持有，空闲等待释放一次。
- 子工作流接收父租约并借用，不用新 runId 再申请陌生锁。runId 只做追踪，不再兼做隐含控制授权。
- 每次 borrow 返回独立引用句柄，release 幂等并只能释放自己的引用；不让重复 finally 或子任务退出清掉父租约。
- 动作网关检查当前租约 token/epoch/引用是否有效，旧会话即使拿着 control 也不能继续操作。
- 隔离设备不等于强制删除锁。旧任务未停止时保持 fencing 和隔离状态，不授予第二个自动执行者。

### 7.2 资源生命周期

- 一台设备会话只创建一套 tools 和 recognitionClient；需要控制时按现有 SDK 语义 connect 并等待 ready，然后才派发输入。
- 连接 generation 改变后清空旧图/目标，重新观察。模型不重新加载，不能把连接重建变成 GPU 冷启动。
- 关闭时只关闭自有 control/tools/截图订阅和识别客户端；共享 GPU 服务及其他设备会话继续工作。
- 旧工具的 `_run` 内部队列不可重入自等待：public façade 在队列外调用，或将已有 ctx 传给内部核心实现，二选一并写测试。不能在一个 `_run` 中 await 排在自己后面的 public 方法。

### 7.3 人工和旧脚本边界

- 打开手动窗先请求 Actor 安全暂停；得到停止动作与释放确认后再授予手动租约。尚在 pausing 时显示真实状态，不抢连接。
- 手动窗口关闭默认保持暂停，需用户恢复。只订阅视频不拥有写权限，不能顺带拿到键盘/触控能力。
- 旧受管子进程由父服务保持设备租约直到进程结束和资源清理；中枢不得把高德/VPC/输入法设置页误当 unknown 按返回。
- 旧进程无法确认退出/停止时隔离，不用超时删锁冒充安全。尚未迁移的独立直连 CLI 要明确列为非受管入口，不能宣称已跨进程强制互斥；必要时由入口拒绝与活跃中枢同机运行。

门禁：同机手动/旧脚本/AI/Actor 无法同时写；子任务借用无 DEVICE_BUSY；重复释放不能松开别人的锁；所有权失效后的迟到回调无法派发动作。

## 8. R4：Actor 状态机、取消、恢复和关闭

涉及：`device-actor.js`、`manager.js`、`page-recovery.js`、工具/API/输入的 signal 与超时传递。

### 8.1 生命周期必须完整包住初始化

- 设备上下文创建、连接、适配器调用、状态映射、持久化和清理全部进入任务 try/catch/finally。
- 初始化失败能落为 failed/waiting/blocked；不留下永久 running。落库失败时阻断派发新动作，保留明确错误。
- 一个 Actor 同时仅一个 loopPromise 和一个 activeTask；重复 start/resume/stop 幂等，不允许 stopping 中重新 start 复用旧 AbortController。
- desiredState 表示请求；actualState 表示真实状态。增加 pausing/stopping，只有清理确认后才显示 paused/stopped。
- sleep 使用单次可取消等待，正常到时、wake、abort 都移除监听器并清理定时器；删除无任务分支与 finally 的双重 release。

### 8.2 取消和超时

- signal 与同一剩余 deadline 贯穿截图、GPU、导航、API 响应体、Python/输入工作进程、逐键输入和发送核验。
- 生成 API 超时覆盖读取响应正文，不是只等到 headers。晚到结果不得进入输入；外部请求无法取消也必须封禁后续动作。
- task timeout 不是使用 Promise.race 后丢弃旧任务。先取消、等待有界清理和输入抬起，再释放。
- 清理未确认时 `TASK_CANCEL_NOT_CONFIRMED` → quarantine/unclean；不开始下一项任务。stop API 返回 202 stopping，查询到真正清理完成才 stopped。
- Manager.close 必须 async：停止接单 → 停止 Actor → 等待/标记 unclean → 关闭自有资源 → 最后关闭 store。失败路径也不得继续访问已关闭数据库。

### 8.3 有界恢复与持久守卫

- 先检查租约/取消/期限/未解决副作用，再观察。合法已知页面使用真实导航边：首页 → 识别底栏消息按钮 → 列表；其他页一次 Back 后重新观察。
- Back 写入完成不等于已经到目标页，必须后验截图确认；不要无等待连续发多个 Back。键盘收起也算一次状态变化，不能误当完全无进展。
- 修复 `<= maxBackSteps` 的边界，最多 8 次就是 8 次；跨函数和外层 tick 共用恢复事件窗口与预算，不能每次归零重新尝试。
- 到桌面立刻停止 Back。允许且有剩余预算时调用现有 openMomo 一次，检查其实际返回状态再重判；该工具当前按 dryRun 控制，不要杜撰它支持 execute 参数。
- 未知/人工草稿、退出丢弃确认、登录、验证码、权限守卫 → needs_review；不自动清空、不确认、不继续循环。
- 风控或限频必须持久化正确作用范围并阻断后续自动业务，不得换浏览/招呼规避；明确冷却到期也先重新观察，不等于无条件恢复许可。
- dependency_failed 是依赖退避，不是 unknown→Back；no_progress/budget_exhausted 达阈值转暂停或人工状态，保留路径，不在下一 tick 从头循环。

门禁：取消后不再派发新动作；风控后后续 tick 为零业务动作；不确定现场不被归位销毁；关闭过程无 closed database 异常。

## 9. R5：持久化、消息批次、冷却和公平调度

涉及：`src/brain/store.js`、`scheduler.js`、`reply-store.js`、`message-watch.js`、必要的迁移与测试。

### 9.1 区分“发现候选”和“确认新消息批次”

- 列表扫描尚不知道真实聊天 seq，禁止继续塞 triggerSeq=0，也禁止改成 Date.now/random 每轮制造新回复任务。
- 同一设备/会话只允许一个活跃候选读取任务，重复列表观察合并。可在现有 reply 任务增加 collect 阶段，不强制另建任务类型。
- 候选读取完成后，利用现有历史尾部对齐和事务得到真正新增 seq，再创建正式回复意图。
- 正式意图按设备/账号范围、conversationId、triggerStartSeq/triggerEndSeq 唯一；草稿缓存额外绑定 inputDigest、上下文和配置版本。
- 配置改动可以使未发送草稿失效，但不能让已经发送的同一消息批次因换 revision 再回复一次。
- 完成一次候选读取不代表该联系人永久处理完。后续新来信允许新 collect；重复触发经过 active 合并和有界复查节流，最终由真实 seq 判断是否需要生成。
- unread 数字不是唯一来源；红点、99+、摘要/排序变化为候选证据，未解析数字标 unknown，不能等同 0。保留原边缘卡片过滤。
- pending 必须在可能清除角标前或进入聊天阶段可靠落库；读取/生成失败后仍从 pending 找回。

### 9.2 正确修改仓储

- updateSchedule 使用真正的 PATCH 语义：只更新传入字段；初次 INSERT 可以有默认值，UPDATE 不把缺省字段写成零。明确传零仍允许合法重置。
- cooldown、配额使用明确范围和窗口键，重启保留；本地尝试数和服务端已确认人数分别记录。
- task claim 使用短事务、状态 CAS、dueAt 与 expiresAt 校验；已有 deadline 分清持久 UTC 过期时间和进程内单调运行 deadline，不能混用两种时钟。
- 周期巡检过期可以合并为一次新观察；用户消息 pending 不因调度 deadline 过期被静默删除，保留/重新安排且有上限。
- 有有效副作用意图的 running/uncertain/yielded 不直接当终态丢弃，交给 R7 对账。
- 活跃任务唯一约束与历史完成记录分开；不要依靠永久 UNIQUE 的旧 completed 阻止所有未来工作。

### 9.3 公平性和积压控制

- 一个联系人处理一个批次后，若列表巡检到期，强制先巡检一次，再选下一回复；紧急取消和未决副作用核验优先于这种公平轮转。
- 单联系人持续来信不能抢占其他已等待联系人；用 lastServed/轮转或等价确定性策略，不仅 ORDER BY priority。
- 同设备同类周期待办合并，错过一百轮只补一次，不把每个 tick 写成独立积压任务。
- 只在无待回复/待核验且最近列表观察足够新鲜时安排空闲任务。设置队列上限、重试上限、失败保留和事件保留策略，满时返回 backpressure，不静默丢消息。
- 共享 GPU/API 故障由 Manager 合并健康探测与退避，不由每个 Actor 重启识别服务。

门禁：旧批次不重复、下一批次可处理；只改 dueAt 不清冷却/配额；回复洪峰下巡检和其他联系人有机会；错过周期不突发补跑。

## 10. R6：接通 AI 单次闭环，先采集，再 draft，最后 execute

涉及：`src/workflows/momo-ai-reply.js`、`src/tools/send-chat-message.js`、`src/tools/momo/conversation-reader.js`、`reply-store.js`、`src/ai/`、`src/typing/chat-input.js` 的既有接口。

### 10.1 先解除真实接口阻断

- 当前 sender 仍有 host.vision()、`new ChatInput(control, vision, ...)`、错误 prepareMessages 调用等不匹配。按实际 `ChatInput({ control, ctx, settings, observe, tap, checkControl, recognitionPool })` 与 `prepareMessages(messages, python, ctx)` 接入，不改成另一套键盘输入。
- public tools.sendChatMessage 与内部核心 sender 的 host/ctx 契约必须统一。不能把 CloudPhoneDevice、CloudPhoneTools 和视觉 session 混为同一种对象；先用真实签名的合同测试验证。
- 工作流接收注入上下文、租约、页面服务、signal 和 deadline；独立调用才获取自有租约，嵌套调用借用父租约。
- 用实际 chatDetail 布局和输入 ROI 读取草稿，按真实 OCR 返回字段取文本；修复短于等于 2 字跳过输入校验等旧问题。

### 10.2 一次执行的明确步骤

1. 校验模式、配置、依赖、待办范围和租约；有未决发送先转核验，不重新生成。
2. 恢复消息列表，重新识别目标卡片。不能只拿 contactName 构造无坐标假候选；列表重排后丢弃旧坐标。
3. 若已在目标聊天也必须用新证据核验页面、对象与草稿；同名/截断无法可靠区分时标 unverified，不猜。
4. 点击后重新观察：聊天页 + 预期对象两层成立才读取并入库。错人不写库、不调 API、不发送。
5. 读取最近消息并用已有时序重叠对齐去重；重复“你好”保留真实重复，不用全局正文 Set。无重叠/歧义保留 pending 并转 baseline/人工处理。
6. 在事务中追加新增消息并形成真实消息批次；检查 handledThroughSeq、已有 reply intent 和人工新发言。observe 到这里停止，不生成、不打字。
7. draft/execute 按完整上下文、网页系统提示词和有效配置调用既有回复服务。历史预算从最近尾部截取，不能先读最早 1000 条再声称带上最新历史。
8. 同输入/上下文/配置的有效草稿复用；API 失败保留 pending 并按错误范围退避。API 返回后重新核验对象、上下文、权限和草稿；不拿旧图继续点。
9. draft 保存草稿返回；execute 再检查自动回复许可、当前为空或严格属于本 job 的草稿，使用已有拼音/候选识别逐键输入。
10. 实际输入文本与预期不一致则停止，不用 includes、短文本豁免或自动清空人工草稿放行。
11. 点击发送前先持久化发送意图及本次核验证据基线；数据库写入失败绝不点发送。
12. 通过新截图确认本次新增己方气泡，并结合输入区状态和消息序列变化；历史已有同文气泡不算这次成功。确认后提交 handled 范围；未知转 R7，不能重发。
13. 只在无未决副作用且草稿安全时归位列表；记录盲区与耗时，再让调度器选择下一任务。

### 10.3 生成期间和错误语义

- 第一版保留单设备任务所有权等待 API，不并行切到其他联系人操作；记录 messageListBlindMs，不宣称此时仍实时扫描列表。其他设备可以继续。
- API 429 影响对应供应商/配置的生成任务，尊重 Retry-After；平台风控影响设备业务，两者分开。
- 取消贯穿 fetch 和响应体、输入进程与按键；返回迟到结果不得发送。
- no_new_messages、needs_baseline、needs_review、draft_ready、reply_observed、uncertain 分别映射，不只看 report.ok。
- 日志脱敏使用真实实现签名，不能指望给 redact 传一个它不处理的第二参数就能隐藏 API Key。

门禁：真实装配 + 模拟边界可以从列表进入指定会话、追加增量、生成一次、正确输入并核验；任何错对象/未知草稿/取消/失败依赖都停止在发送前。

## 11. R7：不确定性核验、双库对账和重启恢复

涉及：`task-adapters.js`、Manager/Actor 启动流程、BrainStore、ReplyStore、sender。

- verify_uncertain 必须由具体 replyJobId/动作意图驱动，载入期望对象、正文摘要/匹配内容、发送前尾部序列、尝试阶段和证据引用，不是泛泛看当前在哪页。
- “只读核验”禁止打字、点击发送、点击通过；若需要进入目标会话，只有现场安全且没有待保全草稿/不确定输入时才允许受控导航。不能借核验顺便丢失原现场。
- 截图失败、对象不符、没有目标气泡、只看到历史同文气泡均不算成功；有可靠新增己方气泡才提交确认。
- 看不到发送结果不等于未发送。无法区分则 uncertain/needs_review，保持禁重发。只有证据充分的 not_attempted 且满足策略时才可安全重新安排。
- 不能用单一 AI 文本匹配“看起来像”作为物理副作用确认；多源证据仍有歧义就保留歧义。
- 启动真正执行 reconciliation：扫描旧会话、running/uncertain/yielded、ReplyStore pending 和发送事实；导航到一半可重新观察，已尝试发送必须先核验。
- 两个 SQLite 没有跨库原子事务。ReplyStore 作为消息/发送事实源，BrainStore 保存引用并幂等补齐：回复已确认但中枢未 completed 时补记，不再发送；pending 已落库但中枢没入队时补队列。
- 默认 autoResumeAfterRestart=false：恢复记录和展示待处理状态，不自动操作手机。只有用户明确恢复或已授权策略才开始页面核验；重启不能自动解除验证码/风控/隔离。
- unclean 退出保留原因和阶段。不要把所有 running 重置 queued，也不要都标 completed；每类按是否可能有副作用分别处理。

门禁：在“清角标后、生成后、打字后、点击发送后、ReplyStore 提交后”逐个注入崩溃，重启均不丢 pending、不串库、不重复发送。

## 12. R8：真正的覆盖巡检和可让出的空闲任务

### 12.1 覆盖扫描

- inspect_list 是快速片段；sweep_list 必须有独立逻辑，真实识别多屏。每片最多 maxListPagesPerSlice 页并受总时间预算约束。
- 每次滑动后取新帧，保留卡片内容锚点、覆盖范围和游标，不持久复用绝对坐标。来信重排时使旧游标失效并重建。
- 一页没有新联系人不等于到底；需要可靠的列表底部/连续稳定边界证据。预算到顶明确 partial/budget_reached，不报 exhausted。
- 本片结束在安全边界回消息列表顶部/锚点并重判；有到期回复或快巡检则先让出，不一次扫完整个庞大列表。

### 12.2 浏览与招呼

- 当前适配器直接调内部函数，没有 execute/ctx，实际落入 planned。改用受支持的 façade，或显式传合法 ctx 调核心；必须满足 R3 的队列不重入规则。
- 中枢开启时明确传 cycles=1、maxApprovedPerRun、execute 权限、signal 和剩余预算。R6 的只读模式一律不执行这两类动作。
- 在现有工具添加可选 checkpoint/yield 接口，保留旧调用默认业务语义；一次完整手势抬起/卡片后验确认后才可让出。
- 已抽取的本轮刷新/滑动次数和当前进度持久保存，恢复不能重新随机从头执行；不增加额外动作或规避检测策略。
- maxIdleOffListMs 是包含导航和归位的软预算；达到安全点尽快归位，不能用 Promise.race 把仍在滑动的工具扔后台。尚不支持安全让出就保持开关不可用。
- 招呼限频时即使旧返回 ok:true 也落设备阻断/冷却；尝试配额保守计数，确认人数另计。用户仅授权通过时不得按旧默认概率偷偷拒绝。
- 招呼通过后不自动发开场白；动作结果未知时保留核验状态，不重复点旧卡片。

门禁：第二屏真实可发现；覆盖 partial 语义正确；浏览/招呼有待办时可在安全点退出，恢复进度不重复，平台限频不重新进入。

## 13. R9：网页、配置、路由与薄 CLI

涉及：`app/app.js`、`app/momo-brain.js`、必要的 `app/ai-reply.js`、两类路由、`scripts/momo-brain.js`、声明文件和使用文档。

- 网页读取统一 getSelectedDeviceId()/现有 state，并订阅选择变更。手动窗中的 deckDeviceId 只做展示，不作为命令目标。
- 状态/日志异步响应带 deviceId 和请求序号，切换 A→B 后迟到的 A 响应不能覆盖 B。无选中设备拒绝命令，不回退上次目标/默认第一台。
- 配置 POST 明确 scope=global 或 scope=device+deviceId；缺省的旧请求保持兼容但不能意外保存成另一台机器的覆盖配置。所有更新字段白名单、类型、枚举、上下界和组合约束校验，拒绝任意脚本/数据库路径等夹带。
- 配置文件损坏/读取异常返回 CONFIG_INVALID 并禁止真实业务启动，保留原文件和错误；不能静默套默认值、覆盖原配置或清除已持久化的冷却/配额。
- revision 并发冲突返回 409。普通调度参数在下个安全点应用并显示 appliedRevision；降权立即阻断后续写动作；升权要求显式新启动，不偷偷升级活动任务。
- 建议验证初值：pollIntervalMs 500～60000；idleMaxPollIntervalMs 不小于 poll；fullSweepIntervalMs 不小于 poll；maxListPagesPerSlice 1～10；maxBackSteps 1～8；恢复期限 1000～60000ms。其他间隔/配额也设合理有限范围，这些不是平台允许速率保证。
- POST start/pause/resume/stop 返回真实 accepted/pausing/stopping/status，不把异步请求已接收等同任务已完成。重复请求和 requestId 重试不创建第二 Actor。
- 实际状态显示：设备 ID、模式、当前阶段、最近页面、最后巡检、盲区、阻断原因、待核验数、配置版本。只加必要状态，不添加用户禁止的装饰性功能说明小字。
- 配置保存、启动等非 2xx 或 ok:false 必须展示错误；前端轮询不重叠、不自动 start/resume，页面隐藏/关闭不改变后端授权状态。
- 事件 limit 必须有限正整数，after 游标校验；返回脱敏摘要，日志按保留策略清理，不把 checkpoint 里的私人全文直接透出。
- CLI 仍只连 4318，增加请求超时、严格参数检查；HTTP 4xx/5xx/业务 ok:false 退出码非零。状态 planned/partial/cancelled 按文档给出准确语义。

门禁：当前选中 B、旧手动窗 A 时所有命令都只作用 B；配置错误明确拒绝；页面刷新不启动任务；状态不能先于真实停止完成。

## 14. R10：强制验收矩阵

先实现失败用例，再修复到通过。表中的断言需要检查动作、API、入库和状态，不是只检查“函数未抛异常”。至少包含以下场景，并回归原计划 B-T01～B-T48；测试名称不能冒充已覆盖的业务。

| 测试 ID | 场景 | 必须断言 |
| --- | --- | --- |
| RP01 | 默认 4318 装配运行 | 真实 registry/client/arbiter 被使用；无空适配器成功 |
| RP02 | 任务类型缺实现/返回 planned | execute 下失败，业务动作计数为零 |
| RP03 | observe + 关闭自动回复 | 可归档；生成 API、typing、send、approve、browse 全为零 |
| RP04 | draft | 同批次只生成一次；typing/send 为零 |
| RP05 | 非法/缺失模式和运行中降权 | 拒绝/降权阻断，不回落 execute |
| RP06 | 页面原始数据通过统一门面 | 与直接扫描同一合法卡片一致，必需字段齐全 |
| RP07 | 截图 ok:false/空图/尺寸不合法 | 结构化失败；Back/tap/send 为零 |
| RP08 | page/OCR/必需 detail/list ok:false | 不当 unknown 恢复，不假报无消息 |
| RP09 | 旧图/跨设备/旧 generation/动作后旧目标 | 拒绝，不能重新盖时间放行 |
| RP10 | 验证码与助手关闭目标同时出现 | 危险守卫优先，关闭点击为零 |
| RP11 | 正文提到限频/登录、单个“设置” | 不错误熔断、不把聊天当桌面 |
| RP12 | 父租约嵌套回复 | 不报 DEVICE_BUSY；子释放后父仍有效 |
| RP13 | 重复 release/过期句柄/旧回调 | 不松别人的锁，不派发新动作 |
| RP14 | 连接尚未 ready/重连 generation 改变 | 等待/失败；旧坐标不再使用 |
| RP15 | 同机旧脚本/手动/单次 AI/Actor 竞争 | 只有一个受管写流；不同设备可并行 |
| RP16 | 活跃任务期间暂停/停止/人工接管 | 先取消确认再移交，不先显示 stopped |
| RP17 | 晚到 API/输入进程未退出 | 不能发送；未确认停止则隔离，不启动第二任务 |
| RP18 | 初始化失败/状态写入失败 | 无永久 running，无后续盲动作 |
| RP19 | 关闭时任务还在运行 | 等 Actor 清理再关库，无关闭后写库 |
| RP20 | 反复 wake/abort/长虚拟运行 | 定时器/监听器不累积，lease 释放幂等 |
| RP21 | 恢复多级 unknown/键盘收起 | 一次 Back 一次新观察；真实结构进展正确 |
| RP22 | 返回循环/8 次上限/总预算到期 | 上限严格，外层 tick 不重置预算重来 |
| RP23 | 到桌面、打开后又退桌面 | 最多一次受控打开，不桌面循环 |
| RP24 | 未知草稿/丢弃确认/登录/权限/风控 | 保留现场并持久阻断，重启不自动解除 |
| RP25 | 同候选反复出现和后续相同正文新消息 | 活跃任务合并；真实新 seq 不漏，旧批次不重复 |
| RP26 | 红点/99+/数字 OCR 缺失 | unknown 可触发有界复查，不当 unread=0 |
| RP27 | 卡片重排、边缘卡片、同名/截断 | 重定位、保留过滤、身份不确定就不写不发 |
| RP28 | 单改 dueAt/显式清零/重启冷却配额 | PATCH 正确，合法零生效，重启保留限制 |
| RP29 | 回复洪峰/错过大量 tick/过期任务 | 巡检和其他人有机会；周期合并；pending 不静默丢弃 |
| RP30 | 默认工作流完整走真实函数链 | 列表→卡片→对象确认→读取→生成→输入→发送核验可达 |
| RP31 | ChatInput/prepareMessages/工具 façade 合同 | 真实签名匹配；无自排队死锁、无 phone.vision 假接口 |
| RP32 | 连续重复消息/无重叠/歧义/长历史 | 时序对齐正确，近期上下文不丢，歧义不猜 |
| RP33 | 一字/两字/长文本输入不匹配、人工草稿 | 都不发送，不强制清空 |
| RP34 | 发送意图落库失败 | send 点击为零 |
| RP35 | 历史同文气泡/只有输入框清空 | 不确认本次发送，不推进 handled |
| RP36 | 点击发送后断线/核验没截图/找不到气泡 | uncertain 保留，核验不假成功，自动重发为零 |
| RP37 | 各关键阶段崩溃和双库提交中断 | pending 可找回；已发送不重发；未决优先核验 |
| RP38 | autoResumeAfterRestart=false/账号切换 | 启动不自动手机动作；旧账号回调无效 |
| RP39 | 覆盖到第二屏/预算耗尽/列表重排 | 新人被发现，partial 不假报 exhausted |
| RP40 | 浏览/招呼分片让出、恢复、限频 | 进度不重抽，安全边界归位，限频后无替代业务 |
| RP41 | 选 B、旧手动窗 A、迟到响应 A | 请求/配置/日志只指向当前 B |
| RP42 | 配置非法数值、revision 冲突、降权升权 | 明确拒绝/安全应用，不偷偷开启 execute |
| RP43 | HTTP 错误、CLI 超时、负 limit | 前端可见错误，CLI 非零退出，分页有限 |
| RP44 | API 429/响应体超时/共享 GPU 故障 | 正确范围退避，无 API 风暴/模型重复加载 |
| RP45 | 日志与事件检查 | 无令牌、API Key、提示词/聊天全文和原图 Buffer 泄漏 |
| RP46 | 长虚拟运行、休眠唤醒、时钟跳变 | 无积压补跑，队列/事件/内存有界，重核页面 |

测试层次：

1. 合同/单元：纯函数、校验器、结果映射、租约句柄、迁移、虚拟时钟、临时 SQLite。
2. 默认装配集成：实际 routes → manager → actor → registry → workflow → sender；只替换截图/模型/控制/API 等 I/O 边界，不 mock 掉被验收的整段业务。
3. 故障注入：每个 await 前后、数据库 CAS、连接代次变化、取消未确认和进程重启。
4. 离线长周期：虚拟 24 小时与多设备压力，记录峰值队列/事件/句柄/内存和调度延迟，不用真实用户造消息压力。
5. 实机：在用户明确授权后，先单机 observe，再 draft，最后向用户指定测试联系人单条 execute。真实 API 会计费、observe 进入聊天可能清角标，验证前说明。

建议新增/补齐：`test/momo-brain-assembly.test.js`、`momo-brain-lifecycle.test.js`、`momo-brain-reconciliation.test.js`、`momo-ai-reply-workflow.test.js`，并扩展现有 page/arbiter/adapter/store/scheduler/routes/sender 测试。名字允许调整，但覆盖不能省。

离线保护和临时配置隔离完成后，`npm test` 才允许在工作目录直接运行；保护完成前在不含真实 .runtime/.env/聊天库的源码副本执行原有测试。测试报告分别列出 Mock、合同、集成、实机，不能将总数写成“100% 功能覆盖”。

## 15. 数据迁移、性能与回滚

### 15.1 迁移

- 先停止受影响写入并确认会话已收尾，再做一致性 SQLite 备份；使用 SQLite 备份机制或正确处理 WAL，不直接复制一个仍在写的主文件当备份。
- 引入 schema version 和事务迁移；优先增列、加表、建索引及显式 backfill，不删除真实联系人/消息/发送作业。
- 旧 triggerSeq=0 或无关联 replyJobId 的任务不能推断已发送/未发送；迁为待对账或人工复核，不批量重放。
- 旧 running 缺少足够证据时保持不确定；完成记录历史保留，候选活跃唯一性采用新规则，不借改索引悄悄丢数据。
- 测试空库、旧库、迁移失败、重复迁移和恢复备份；方案可以用明确备份恢复作为回滚，不承诺破坏性 down migration 无损。

### 15.2 性能

- 模型和 OCR 继续使用现有常驻 GPU 服务；不要逐任务启动 Python/加载 YOLO 权重来替代现有接口。
- 同帧按需识别、设备连接复用、周期合并、配置缓存和有限事件轮询优先；不删除对象确认、输入核验、发送核验来追求快。
- 报告截图/排队/识别/恢复/API/输入/气泡核验分项耗时及 P50/P95，注明设备、图尺寸、并发和样本数。规划目标不是已测性能承诺。
- 记录 lastMessageListObservedAt、实际盲区、调度延迟和覆盖范围；未取得平台真实到达时间时不伪造精确“消息到达延迟”。

### 15.3 回滚

- 每阶段限定改动文件并保存可恢复版本；保留既有接口薄兼容层，逐个迁移调用方后再删除废弃路径。
- 失败回退先关闭中枢和相关开关、确认旧任务退出，再回退代码/迁移。不能回滚数据库抹掉已真实发生的发送事实。
- 模型、VPC、改机配置和历史聊天数据不是本次清理对象，禁止顺便移动或删除。

## 16. 执行助手的阶段交付格式

每完成 R0～R10 的一个阶段，必须提交以下内容，再决定是否继续：

1. 对应 F 编号、改动文件、旧调用方兼容性和新增契约。
2. 修复前能失败的回归用例、修复后断言结果、实际执行命令和环境。
3. 状态转换与副作用边界：是否可能已输入/已发送、何时允许重试、何时必须人工。
4. 配置/数据库迁移与回滚说明；不涉及则明确写不涉及。
5. 未验证项、仍不可用的能力和进入下一阶段的门槛。

最终交付：

- F01～F19 逐项关闭表；每条链接到实现位置和断言，不接受只写“已优化/已修复”。
- 原 AI 回复审查的阻断问题逐项说明修复或未解决；未解决的 sender/对象确认/幂等问题继续禁止 execute。
- 完整离线回归、默认装配集成、取消/重启/未知副作用测试与稳定性结果。
- 更新准确的 `docs/MOMO-BRAIN.md`、AI 回复文档、类型声明和错误码说明；去掉未验证的“完全实现”“绝对公平”等表述。
- 实机结果单独列设备、用户授权范围、真实时长、模式、成功/失败/未知数；未实测必须写“未实测”。

给执行助手的最终约束：**修的是调用契约、权限、所有权、状态和恢复闭环，不是把更多错误吞掉。任何阶段都不能用空对象、假坐标、无条件 completed、超时强删锁或盲目重发提高表面成功率。**
