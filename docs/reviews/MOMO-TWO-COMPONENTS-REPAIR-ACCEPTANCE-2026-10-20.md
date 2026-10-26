# MOMO AI 回复与持续监听中枢：二次修复验收

日期：2026-10-20。原项目：D:\AA-project\自动化。

## 结论与边界

本轮由 Claude Code 先实现，Codex 独立验收。Claude 到达 100 轮上限，退出码 1，未交付完整报告；其修改没有直接进入原项目。Codex 独立反例暴露未修完的路径后接手，补齐实现和正向测试。

最终状态：**本轮修复的离线代码验收通过，生产/实机验收尚未完成**。不能从单元测试数量推断所有云手机页面均识别正确，也不能保证中文输入百分之百准确。

- 整库自动测试：197 项通过，0 失败、0 跳过。
- 不可修改复验：9/9 通过；正常套件通过薄包装加载同一份文件，没有复制后降低断言。
- 原复验文件 SHA256：86794D0CA241E189053010CADBDBC623DB308FE28E12D9D4CE88BE877AD5C248。
- 所有测试在无真实配置、聊天数据库和模型的临时副本中运行；使用假图像、假传输及内存/临时 SQLite。
- 正向发送测试使用真实工具门面、发送核心、页面校验、坐标规划、ReplyStore；仅替换截图/OCR传输和按键工作器。没有真实敲键或向联系人发消息。
- 没有重启 4318、运行后台 Actor、请求真实生成 API，也没有改动 .env.local、真实 .runtime、模型或训练资料。

## RC01～RC16 处理对账

| 编号 | 本轮实现 | 证据/剩余边界 |
|---|---|---|
| RC01 任务名不一致 | Actor 显式映射 reply/browse/greetings/verify_uncertain 到适配器；缺失实现失败 | repair-brain-integration：真实任务名到适配器契约 |
| RC02 门面拒绝 ReplyStore、结果包络误读 | 依赖通过发送专用私有通道传递，普通参数仍快照；工作流读取 data.sendState | 不可变复验 + repair-sender-integration 正向链路 |
| RC03 目标前缀/低置信放行 | 顶栏精确且唯一匹配，分数必须有限且至少 0.8；缺失、NaN、重复标题均拒绝 | 原 9 项复验 + repair-control-contracts |
| RC04 识别失败假成功 | 严查 ok:true、数据和尺寸；截图/识别异常返回失败，恢复器不会失明 Back | repair-page-contract + 原 9 项复验 |
| RC05 借锁引用无法对称释放 | 每次借用独立 referenceId，幂等释放，父引用不受子重复释放影响 | 不可变复验 + supervisor 双重释放用例 |
| RC06 控制未就绪/资源泄漏 | 一个任务复用同一 control/tools，连接就绪后才运行；finally 有界回收 | repair-brain-integration 连接、代次与关闭计数 |
| RC07 暂停/取消不阻断当前动作 | 任务级 AbortController；API 正文、等待和发送各阶段检查；取消显示 cancelling 直到退出确认 | 活动任务暂停 + provider 已取消/正文挂起用例 |
| RC08 摘要冒充批次、重复生成 | 候选按设备/联系人合并；Job 按 seq 范围和输入摘要持久复用；生成前事务认领，草稿复用 | 同批次同 Job、草稿仅一次 API、相同摘要后续仍可入队 |
| RC09 observe 仍调用生成 | plan 纯计划；observe 只导航/读取归档，不调用生成 API；draft 才生成，execute 才发送 | observe 0 API、idle 功能权限门禁测试 |
| RC10 消息边界与历史方向错误 | 解析透传模型 2 输入框边界；历史取最近 1000 条后按 seq 正序 | 键盘/草稿排除、长历史截尾测试 |
| RC11 历史同文当新气泡 | 保存发送前消息序列；同设备、同联系人、新增且唯一己方气泡精确匹配才确认 | 正向确认、错误联系人/历史同文拒绝测试 |
| RC12 HTTP 配置/运行 client 分离 | composition root 注入同一 client；配置路由经过 manager 通知并中断旧配置任务；切换账号须停止活动会话 | 实际配置 handler 测试；连接装配另经代码核对，未做真实账号切换 |
| RC13 限频未持久阻断 | 限频/守卫持久写 device_guard 并暂停，时间到不自动解锁；重建 Actor 的 start 拒绝绕过；显式 resume 才清除 | 持久守卫/新 Actor 测试；真实限频页面未触发 |
| RC14 帧身份不等于时效 | 实时外部帧必需设备、采集时间、真实连接代次；拒绝旧帧/尺寸错；analysisOnly 明确不可用于动作 | 原复验旧帧用例 + page-contract |
| RC15 导航/续扫未闭环 | 每个联系人重新归位并定位；覆盖巡检持久 nextPage，下一片接续；每片单独确认列表顶部 | 连续两片从 0→2→4 并实际回顶测试；未声称完整覆盖所有联系人 |
| RC16 超时与长期资源 | sleep/wake/abort 清理 timer/listener；API 总时限覆盖响应体；停止未确认保持隔离与占用，不假装退出 | 多次 sleep 无监听增长、正文挂起有界超时、连接回收测试 |

补充：所有新导航的模型坐标按截图与 SDK 触控尺寸映射，裁剪/旋转比例不一致拒绝动作；首页回消息列表只点击当前帧唯一的底部“消息”入口，缺失或点击无效则明确失败。needs_baseline/needs_review 不再包装成 completed 成功。

补充：发送前检查 Job 的设备/联系人/正文/状态归属；打字期间新消息或控制连接代次变化会保留草稿并拒绝发送。点击前持久化 send_attempted，异常转 uncertain，不自动重发。

## 调用契约与恢复

- 回复模式：plan 不取图/不建业务数据库；observe 可以导航和增量归档，但 0 生成 API；draft 生成并保存、不打字；execute 还需通过每层安全门禁。
- 中枢 execute 仍需 autoReplyEnabled=true 才能真正回复；浏览和招呼分别需要显式开关。默认关闭。
- 已有用户草稿不覆盖。CONTEXT_CHANGED 保留已打字草稿，不继续发送；需人工检查草稿与最新来信。
- 未建立基线、无唯一消息重叠、标题不可信时返回 needs_baseline/needs_review，不猜测新增。
- send_attempted/uncertain 不重发。旧任务没有发送前证据不能自动确认；只读重核验仍必须在正确联系人页面。
- 只有证明新增己方气泡并成功提交 Job 状态，才推进 handledThroughSeq。仅输入框清空不足以成功。
- 重启时 interrupted generating 标记 failed 待复核；运行中的观察/核验任务可重排，可能有副作用的任务进入 needs_review，不盲重播。
- device_guard 记录在 brain_schedules 中，quotaUsed=1 表示人工守卫；cooldownUntil 另记 20 分钟。过期不自动恢复，人工处理页面后用原有“恢复”操作解除。
- 连接清理未被确认则隔离，原租约引用仍保留。不得强行清锁后启动第二个写入者；需先确认旧任务/连接已退出，再处理隔离。
- 回顶证据为顶部系统入口，或下拉至上边界后连续两次新鲜画面稳定。后者是视觉边界推断，不等于手机内部滚动位置 API；冻结视频仍需实机检验。
- 覆盖巡检每片有页数预算，最大续扫索引 20，超界/无进展回到下一周期重新核验；partial 始终真实记录。它不是“已读取所有联系人”的证明。

## 文件分类

生产源文件：

- src/ai/provider.js
- src/automation/cancellation.js、coordinates.js（新增）
- src/automation/page-service.js、page-recovery.js
- src/automation/message-list-navigation.js（新增）
- src/brain/config.js、store.js、scheduler.js、device-actor.js、manager.js、task-adapters.js
- src/server/device-arbiter.js、app-server.js、ai-reply-routes.js、momo-brain-routes.js
- src/tools/index.js、send-chat-message.js
- src/tools/momo/conversation-reader.js、reply-store.js、send-evidence.js（新增）
- src/workflows/momo-ai-reply.js
- app/ai-reply.js、momo-brain.js（只修请求/状态逻辑，未加页面说明或样式）

新增主审测试：

- test/recheck-acceptance.test.js：加载原封不动的复验文件
- test/repair-codex-acceptance.test.js：API、锁、批次、消息、模式
- test/repair-brain-integration.test.js：默认适配器、连接、暂停、优先级、截止时间
- test/repair-page-contract.test.js：依赖失败与尺寸
- test/repair-sender-integration.test.js：真实门面正向发送、错误对象零动作、打字中新消息
- test/repair-control-contracts.test.js：守卫、重启恢复、HTTP 配置通知、标题、回顶门禁
- test/repair-dashboard.test.js：旧设备响应不能覆盖新设备、操作失败可见
- test/repair-sweep-continuation.test.js：两轮持久续扫并回顶
- test/repair-navigation-contract.test.js：截图/触控尺寸映射，首页通过观测到的消息按钮归位而非退出应用

原测试修正：device-arbiter、page-recovery、page-service、remediation-r1/r2/r4/r6/r7/r8。调整的是假控制未就绪、非法布局、缺少发送前锚点、把检测失败伪装正常等测试前提；没有修改原 9 项验收脚本。

文档：更新 docs/MOMO-BRAIN.md、docs/MOMO-AI-REPLY.md，新增本记录；旧复验报告保留，不覆盖历史不通过结论。

## 测试命令

不要直接在包含生产配置和数据库的根目录跑全库旧测试；部分旧用例会写默认 .runtime。应先使用不含 .env.local、.runtime、模型和训练资料的验证副本。

在验证副本执行：

```powershell
node --test --test-reporter=tap
node --test test-support/momo-recheck-acceptance-2026-10-20.cjs
```

本次副本：C:\Users\Administrator\AppData\Local\Temp\momo-recheck-8f7580d79ea249de813d2909e7c1c4b6。

## 仍需授权完成的实机验收

1. 指定一台设备，先 observe：验证正确页面、联系人、真实新消息与历史对齐；确认 0 API/0 发送。
2. 指定同一联系人 draft：验证历史及系统提示词、真实接口配置和一次生成/草稿复用。
3. 仅在允许发送的测试联系人 execute：验证输入法候选、草稿精确匹配、新消息中断和新增己方气泡。
4. 验证人工暂停/取消、断网/重连、切换设备、列表重排和不同分辨率。
5. 长跑确认 SDK 视频未冻结、回顶推断可靠、资源与队列不持续增长。

当前不应开启无人值守真实群体聊天。尚存产品限制：红点但无 OCR 数字的未读候选不是本轮覆盖范围；重名身份仍依赖人工隔离；全历史补屏和未知媒体消息不自动猜测；API 失败和旧 uncertain 均需复核。

## 委派与用量记录

- Claude 精确传入别名 opus5；没有换模型。CLI 曾提示别名不识别但仍执行，不能据此独立证明代理实际路由至哪家上游。
- 唯一编码轮达到 100 轮后未完成，Codex 接手；没有重复委派“再修一轮”。
- 提示策略沿用前次复验文档的官方资料检索结论：边界前置、明确契约/反例、实际测试、结构化交付；未把模型自报视作验收。
- 可见的是共享 Codex 账户窗口，不是 Claude/proxy 独立账单；期间 5 小时窗口重置，不能把最终余量差当单次消耗。

```text
委派前 5-hour [############--------] 59% remaining
委派后 5-hour [####----------------] 20% remaining
收尾时 5-hour [##############------] 69% remaining（窗口已重置）
委派前 weekly [########------------] 40% remaining
委派后 weekly [#######-------------] 34% remaining
收尾时 weekly [#####---------------] 26% remaining
Claude/proxy   [????????????????????] unavailable
```
