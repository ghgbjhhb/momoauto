# MOMO AI 回复代码审查报告

日期：2026-10-19。范围：助手交付的 AI 回复工具、发送器、增量仓储、4318 路由/页面和 flow-14 接入。

## 结论

**当前不能按“P0～P6 全部完成、可投入自动回复”验收。** 模块划分有可复用价值，但工作流与真实 SDK、打字引擎没有接通，消息幂等、取消、设备互斥和发送后验也没有形成闭环。

本报告列出 16 项问题：P0 0 项，P1 12 项，P2 4 项。P1 表示应在启用真实自动发送前修复，并非声称所有问题已经造成线上事故。

审查只进行了源码阅读、隔离单元测试和模拟依赖复现，没有操作真实手机、调用真实聊天 API、读取真实聊天数据库或修改业务代码。

## 验证方式与证据边界

- 将 `src`、`test`、`test-support`、`package.json` 和 `ws` 依赖复制到临时隔离目录，不复制 `.env.local`、项目 `.runtime`、模型或真实聊天记录。
- 使用 Node.js v24.19.0。交付对应的 112 项测试全部通过，0 失败、0 跳过，隔离复跑约 1 秒。
- 当前工作目录另出现了中枢阶段的页面识别/恢复测试。审查快照全套为 121 项，115 通过、6 失败，失败位于新增的 page-service/page-recovery 测试；**不能将这 6 项直接归因于本次 AI 回复交付**，也不能把旧的“112 全通过”当成当前整个工作目录全绿。
- 其他助手正在继续开发：审查过程中 `device-arbiter.js` 已发生变化，已重新阅读。下文关于仲裁的结论是调用入口尚未统一，不依赖其旧版内部实现。
- 复现使用临时 SQLite、虚拟设备、Mock fetch、Mock 打字器和虚拟 DOM。模拟发送器测试只用于单独检查状态逻辑，不证明真实打字链路可运行。

关键复现结果：

| 检查 | 结果 |
| --- | --- |
| 用真实 SDK 对象执行工作流 draft，数据库使用内存 | `phone.vision is not a function`，未发生网络调用 |
| 按发送器写法构造 ChatInput 后 read | `Cannot read properties of undefined (reading 'check')` |
| 按发送器写法调用 prepareMessages | `Cannot set properties of undefined (setting 'stage')` |
| 目标“小雨滴”，顶栏“小雨滴好友”，score=0.01 | `verified: true` |
| 输入框在中部、下方有键盘文字 | AI reader 将原有草稿和 `QWERTY` 当消息；提供模型 2 边界的原解析器不会 |
| 已处理的旧 peer 消息、已有 uncertain 任务，再运行两次 draft | 新 peer 数为 0，仍调用 API 两次，并额外生成两个 draft_ready 作业 |
| 上述第一次 draft 预先传入已取消的 signal | 仍执行识别与 API 生成 |
| API 错误正文包含虚拟密钥 | 返回的公开错误仍包含该虚拟密钥 |
| API timeout=20ms，响应头立即返回，JSON 正文约 90ms 后返回 | 约 101ms 后仍接受成功结果，未超时 |
| 隔离替换打字器：已有用户草稿、打字后 input_text 为空、屏幕只有原来的“你好” | 仍点击一次发送并返回 own_bubble_observed |
| SDK sendChatMessage 传入真实 ReplyStore 对象，dry-run | 参数快照阶段返回 `INVALID_ARGUMENT: argument must be a plain object` |
| 前端选中 A，手动操作台遗留 B；运行 plan | 提交的 deviceId 是 B；planned 返回后按钮仍 disabled、轮询未终止 |
| CLI main 的 plan 成功返回 | `process.exitCode` 仍被设为 1 |

## 详细问题

以下 Diff 均为**修复契约示意，未应用到代码**。新增适配器、辅助函数和参数需要执行助手按实际接口补齐，不能把这些片段直接当作完整可运行补丁。

### R01 [P1] 主链路使用了不存在或签名不匹配的接口

位置：[工作流第 85 行](D:/AA-project/自动化/src/workflows/momo-ai-reply.js:85)、[发送器第 77 行](D:/AA-project/自动化/src/tools/send-chat-message.js:77)、[打字引擎第 45 行](D:/AA-project/自动化/src/typing/chat-input.js:45)、[SDK 包装第 84 行](D:/AA-project/自动化/src/tools/index.js:84)。风险类型：接口集成失败。

设备公开了 `tools()`，没有 `vision()`。ChatInput 需要单个配置对象，发送器却传三个位置参数；prepareMessages 实际需要 `(messages, python, ctx)`，发送器漏掉 ctx。聚焦分支对 clickPlan 的参数和返回值理解也不符合真实接口。

此外，tools.sendChatMessage 会深拷贝 options，而 ReplyStore 是类实例，传入后在进入工具主体前就被拒绝。工作流现在直接调用底层函数，绕过了统一 OperationContext 和工具队列，不能靠“补一个 vision()”解决全部问题。

```diff
- const vision = phone.vision();
- const typing = new ChatInput(control, vision, { python });
- const plans = await prepareMessages([text], { python });
+ const session = createReplyDeviceSession(phone, options);
+ const typing = new ChatInput({ control, ctx, settings, observe, tap, checkControl, recognitionPool });
+ const plans = await prepareMessages([text], python, ctx);
```

应参考现有 sendContact 的正确用法复用观察、手势、ctx 和清理机制；持久化句柄通过内部依赖注入，不混入要求纯对象的可快照公开参数。新增不连接真机、但使用真实 SDK/打字引擎接口的契约测试。

### R02 [P1] 扫描到联系人后，没有点击进入聊天的导航步骤

位置：[工作流第 95 行](D:/AA-project/自动化/src/workflows/momo-ai-reply.js:95)、[第 123 行](D:/AA-project/自动化/src/workflows/momo-ai-reply.js:123)。风险类型：业务链路缺失。

扫描之后直接再次 OCR 并核验聊天，没有调用点击卡片、等待页面跳转的过程，也没有处理完一个联系人后返回列表再定位下一个。正常从消息列表启动时，即使修好 R01，也只会停在列表上验证聊天失败。指定联系人同样只是构造姓名，不会定位到该联系人。

```diff
  for (const candidate of candidates) {
+   const freshCandidate = await locateContactOnMessageList(session, candidate);
+   await enterChatAndAssert(session, freshCandidate);
    verifyChatScreenAndTarget(...);
    // 读取、生成及发送
+   await returnToMessageListAndAssert(session);
  }
```

进入和返回都要有后验断言；候选重排后重新定位，不能复用最开始一批卡片的坐标。

### R03 [P1] 没有按新增游标和已有任务去重，结果未知也会另起新回复

位置：[工作流第 154 行](D:/AA-project/自动化/src/workflows/momo-ai-reply.js:154)、[作业创建第 267 行](D:/AA-project/自动化/src/tools/momo/reply-store.js:267)。风险类型：幂等性、重复回复/重复计费。

触发条件只有“历史最后一条来自 peer”，不检查新增 peer、handledThroughSeq、pending 或既有 send_attempted/uncertain。生成 API 调用完成后才创建随机 ID 作业；相同触发范围没有唯一约束，成功发送后也没有相应推进已处理游标。

实测已经 handledThroughSeq=1、没有新消息且存在 uncertain 作业，连续两次 draft 仍生成两次。旧归档末尾是 peer 时也可能被当作当前新消息。不能只修复“同一次发送不二次点击”，还必须阻止下一次调用新建另一个作业绕过保护。

```diff
- if (lastMsg?.sender === 'peer') {
-   const reply = await generateReply(...);
-   const job = store.createReplyJob(...);
+ const trigger = store.findUnprocessedPeerBatch(conversationId);
+ if (!trigger) return noNewMessages();
+ const job = store.claimOrResumeReplyJob(trigger); // 短事务与唯一意图约束
+ if (job.requiresReconciliation) return reconcileExistingJob(job);
+ if (job.hasReusableDraft) return useExistingDraft(job);
+ const reply = await generateReply(...);
```

发送观察终态、己方消息入库和 handled 游标推进需明确恢复协议；API 之前先记录作业。补充“重复 draft”“没有新消息”“旧历史末尾 peer”“uncertain 后重跑”“崩溃后重跑”测试。

### R04 [P1] 取消只是修改网页状态，工作流和打字仍可能继续

位置：[取消路由第 191 行](D:/AA-project/自动化/src/server/ai-reply-routes.js:191)、[工作流第 165 行](D:/AA-project/自动化/src/workflows/momo-ai-reply.js:165)、[发送器第 61 行](D:/AA-project/自动化/src/tools/send-chat-message.js:61)。风险类型：异步生命周期失控。

路由传入 signal，但工作流既不检查，也不传给 generateReply/sendChatMessage；发送器也没有使用其 signal/外部 OperationContext。取消立即报告 cancelled，随后旧异步任务还会覆盖终态。实测预先取消的 signal 也拦不住 draft API 调用。

```diff
- runRecord.abortController.abort();
- runRecord.status = 'cancelled';
+ runRecord.status = 'cancelling';
+ runRecord.abortController.abort();
+ await runRecord.stopped; // 等待禁止新动作、释放按键/触点及任务退出
+ runRecord.status = 'cancelled';
```

全链路传递 signal 和总 deadline，每次实际动作前检查；取消未确认不能解锁交给第二个操作流。补“API 等待时取消”“输入时取消”“点击发送后取消”“迟到回调”测试。

### R05 [P1] AI、旧脚本和手动控制没有共用设备锁

位置：[AI 获取锁第 61 行](D:/AA-project/自动化/src/workflows/momo-ai-reply.js:61)、[旧脚本占用第 302 行](D:/AA-project/自动化/src/server/app-server.js:302)、[手动入口第 25 行](D:/AA-project/自动化/src/server/manual-control.js:25)。风险类型：并发竞争、错发。

AI 使用 defaultArbiter；旧脚本使用 busyDevices；手动控制使用 leases/busyDevices。三者没有互相检查。独立 CLI 是另一个进程，即使 require 同一个文件也不会共享 Map。新仲裁器内部加入 leaseToken/refCount 不等于这些入口已经接入。

```diff
- busyDevices.add(deviceId);
- leases.set(deviceId, manualLease);
- defaultArbiter.acquireDevice(deviceId, aiRunId);
+ // 所有受管入口向同一设备仲裁服务申请权限
+ const lease = await deviceCoordinator.acquire(deviceId, owner);
+ try { await runWithLease(lease); }
+ finally { await deviceCoordinator.releaseAfterStopped(lease); }
```

受管 CLI 经 4318 调度或采用确实跨进程的方案；直接 CLI 若不受管，应显式限制并发并说明。不能只测试单个 Map 内 owner-A/owner-B 的互斥就声称覆盖所有入口。

### R06 [P1] 联系人前缀和极低置信度也能通过“严格对象确认”

位置：[联系人核验第 54 行](D:/AA-project/自动化/src/tools/momo/conversation-reader.js:54)。风险类型：身份误判。

使用 `text === expected || text.startsWith(expected)`，没有最低置信度和候选唯一性校验，缺 score 还默认成 1.0。实测“小雨滴好友”可冒充“小雨滴”，score=0.01 仍返回 verified。

```diff
- return text === expected || text.startsWith(expected);
+ return normalizeTitle(text) === normalizeTitle(expected)
+   && Number.isFinite(it.score) && it.score >= minimumIdentityScore;
```

还需限制为可靠顶栏区域、要求唯一候选。截断或对象无法确认时停止，不做模糊匹配。昵称仍不是稳定账号 ID，不应宣称已经解决同名身份。

### R07 [P1] 读取新消息没有传模型 2 数据，会采到草稿和键盘文字

位置：[会话读取第 79 行](D:/AA-project/自动化/src/tools/momo/conversation-reader.js:79)。风险类型：历史污染、漏合并多行气泡。

原 parseChatMessages 支持 detailData 的 input_box、back_btn 和 avatars，但新 reader 只传 OCR。键盘展开后仍按屏幕 88% 作为消息底界，草稿和键盘按键会进入历史；缺头像还无法使用原有气泡合并逻辑。已用相同 OCR 在有/无模型 2 输入边界下复现。

```diff
- const parsed = parseChatMessages(ocrData);
+ assertSameSnapshot(ocrData, detailData);
+ const parsed = parseChatMessages(ocrData, detailData);
```

工作流需要传同一帧的 OCR+模型 2 数据，不能各自取图后拼接。补键盘开/关、长气泡换行、两条相同气泡、输入框已有草稿测试。

### R08 [P1] 草稿与发送前文本校验读取了错误字段，并放过所有短消息

位置：[发送器第 95 行](D:/AA-project/自动化/src/tools/send-chat-message.js:95)、[第 128 行](D:/AA-project/自动化/src/tools/send-chat-message.js:128)。风险类型：草稿破坏、发送错误文字。

真实 ChatInput.read 返回 `input_text/candidates`，这里却拼 `items`。已有草稿时 existingDraft 得到空串，于是绕过保护；打字核验又使用 includes，且长度 ≤2 时完全不核验。即便给它同名草稿，也不能在未证明属于当前作业前继续追加。

```diff
- const existingDraft = (initialOcr.items || []).map(i => i.text).join('');
- if (existingDraft && existingDraft !== messageText) fail(...);
- if (!typedText.includes(messageText) && messageText.length > 2) fail(...);
+ if (!typing.isEmpty(initialOcr, frame)) fail('DRAFT_NOT_EMPTY', ...);
+ if (typedOcr.input_text !== messageText) fail('INPUT_MISMATCH', ...);
```

真实的己方作业草稿恢复走独立协议；不能用正文相同代替归属证明。所有字数都必须精确核验。隔离 Mock 测试已复现“原草稿存在、打字后为空”仍进入点击发送。

### R09 [P1] 旧气泡可被当成本次发送成功，缺少新增和可靠己方归属证明

位置：[发送后检查第 179 行](D:/AA-project/自动化/src/tools/send-chat-message.js:179)。风险类型：假成功、状态丢失。

仅查当前 OCR 是否存在等于正文、left>35% 且 top>30% 的文字，没有发送前基线，没有新增匹配，也未用模型 2 的己方头像/气泡归属。屏幕原有同样的“你好”，即使本次没有出现新气泡，也可返回 own_bubble_observed。

```diff
- const selfBubble = items.find(it => it.text === text && it.left > width * .35 && ...);
+ const before = await captureVerifiedConversationTail();
+ await persistSendAttemptThenDispatchOnce();
+ const after = await captureVerifiedConversationTail();
+ const evidence = matchNewOwnBubble(before, after, job);
+ if (!evidence.unique) return persistUncertain(job);
```

应在正确联系人、同一连接代次下比较有序气泡变化，支持多行文本。不确定时保留 send_attempted/uncertain 现场；气泡出现也仅是 UI 观察，不是平台送达凭证，文档“确认送达”表述需修正。

### R10 [P1] 通用脚本卡片的 plan/draft 参数被忽略，始终带 --execute

位置：[flow-14 定义第 140 行](D:/AA-project/自动化/src/server/app-server.js:140)、[启动子进程第 266 行](D:/AA-project/自动化/src/server/app-server.js:266)、[configureScript 第 333 行](D:/AA-project/自动化/src/server/app-server.js:333)。风险类型：模式权限越界。

flow-14 固定 args=['--execute']，配置页虽然列出 mode/maxContacts/contactName，configureScript 却没有 flow-14 分支。工作流 CLI 仅解析 argv，并不读取这些配置。因此通用卡片选择 draft 或 plan 并不会传入对应模式；修好主链路后会以 execute 运行，联系人/人数参数也失效。

```diff
- file: 'flows/14-momoAI回复.js', args: ['--execute']
+ file: 'flows/14-momoAI回复.js', args: []
+ // 启动前：由已校验的 mode 显式构造互斥 argv，默认 plan
+ // 同时转发 --contact 与 --max-contacts，禁止同时出现 --draft/--execute
```

新增真实脚本配置→argv→工作流模式的贯通测试，不能只测专用 AI 路由。

### R11 [P1] 前端从上次手动窗口读取设备 ID，可能操作错误云机

位置：[AI 页面第 121 行](D:/AA-project/自动化/app/ai-reply.js:121)、[手动操作台第 317 行](D:/AA-project/自动化/app/manual-control.js:317)、[设备选择第 282 行](D:/AA-project/自动化/app/app.js:282)。风险类型：设备身份错误。

deckDeviceId 只在打开手动窗口时更新，不等于当前 state.selectedDeviceId。未打开手动窗口时即使选中了设备仍会提示未选择；先手动打开 B，再选择 A，则发送请求仍可能指向 B。虚拟 DOM 已复现选中 A、提交 B。

```diff
- const selectedDeviceId = document.getElementById('deckDeviceId')?.textContent?.trim();
+ const selectedDeviceId = getSelectedDeviceId(); // 当前统一状态，不读展示文字
+ const target = freezeValidatedTarget(selectedDeviceId);
```

请求前显示/绑定本次确定的设备，后端验证该设备属于当前有效云会话；运行中切换选择不能改变已建立的任务目标。

### R12 [P1] API Key 错误脱敏没有生效

位置：[Provider 第 81 行](D:/AA-project/自动化/src/ai/provider.js:81)、[第 96 行](D:/AA-project/自动化/src/ai/provider.js:96)、[公共 redact 第 7 行](D:/AA-project/自动化/src/automation/runtime.js:7)。风险类型：凭证泄露。

Provider 调用 redact(message, [apiKey])，但被导入的 redact 只有一个参数，只处理 token= 与 JWT，不处理 sk- 密钥。上游错误或网络异常包含 Key 时，明文会进入错误并被路由返回。用虚拟 Key 回显错误已验证。

```diff
- const safeBody = redact(errorBody, [apiKey]);
+ const safeBody = redactKnownSecrets(errorBody, [apiKey]);
+ // 公开接口优先返回固定错误摘要，原始上游正文受限记录且需再次脱敏
```

精确字符串替换应避免正则转义漏洞；测试同时覆盖网络错误、401/429/5xx、JSON 解析错误及查询/日志输出，不能只测试 maskApiKey。

### R13 [P2] API 超时只覆盖响应头，正文阶段可能无限等；预取消未处理

位置：[Provider 第 51 行](D:/AA-project/自动化/src/ai/provider.js:51)、[第 85 行](D:/AA-project/自动化/src/ai/provider.js:85)、[第 135 行](D:/AA-project/自动化/src/ai/provider.js:135)。风险类型：资源占用、取消失效。

fetch 返回 Response 后就 clearTimeout，response.text/json 不再受 timeout 约束；外部 signal 若早已 aborted，仅注册监听不会补发已发生的 abort。实测 20ms 配置下接受了约 101ms 后返回的正文。

```diff
- try { response = await fetch(...); }
- finally { clearTimeout(timer); }
- const data = await response.json();
+ signal?.throwIfAborted();
+ try {
+   const response = await fetch(...);
+   const data = await readBodyWithinDeadline(response, controller.signal);
+   return validateResponse(data);
+ } finally { clearTimeout(timer); removeExternalAbortListener(); }
```

同时校验超时数值范围，区分主动取消和超时。不能把接口层 timeout 当作整个回复工作流已有总预算。

### R14 [P2] 终态契约不一致：plan 网页一直等待，成功 CLI 也返回失败

位置：[网页轮询第 176 行](D:/AA-project/自动化/app/ai-reply.js:176)、[CLI 第 271 行](D:/AA-project/自动化/src/workflows/momo-ai-reply.js:271)。风险类型：状态展示和脚本调度错误。

工作流 plan 返回 planned，而前端只处理 completed/partial/failed/cancelled；因此按钮一直 disabled、定时器继续运行。工作流返回 `{status,data}`，CLI 却检查 result.ok，undefined 被当成失败，成功 plan 也设置 exitCode=1。两项均已独立复现。

```diff
- if (data.status === 'completed') { ... }
+ if (['planned', 'completed'].includes(data.status)) { finishUi(...); }
- if (!result.ok) process.exitCode = 1;
+ if (result.data?.ok !== true) process.exitCode = 1;
```

最终应固定公共结果结构、枚举和退出码规则，而非在每个入口各猜一套。

### R15 [P2] 测试会改实际配置，而且没有验证报告声称的执行分支

位置：[路由测试第 89 行](D:/AA-project/自动化/test/ai-reply-routes.test.js:89)、[发送器测试](D:/AA-project/自动化/test/send-chat-message.test.js:7)。风险类型：测试隔离、验收证据不足。

路由测试直接调用正式 load/saveSettings，写项目 `.runtime/ai-reply/settings.json`，修改 revision/temperature 且不恢复。所谓发送状态机测试实际只有 4 项：选项、参数、错误参数、dry-run，没有执行一次真实逻辑分支；取消测试仅启动 plan。没有完整工作流测试，因此真实接口错误不影响 112 全绿。

```diff
- const saved = saveSettings(updates, expectedRevision); // 使用固定项目配置路径
+ const configStore = createConfigStore({ file: temporaryTestSettingsPath });
+ const routes = createAiReplyRoutes({ configStore, workflow: controlledWorkflow });
+ // execute 分支使用真实接口契约 + 可控手机/视觉/输入依赖，不用纯空壳替代整条链
```

不应在当前项目目录直接运行未隔离的这组配置测试。优先补覆盖 R01～R14 的失败用例，再恢复“通过测试即满足门禁”的含义。Mock 全通过与实机验收必须分别报告。

### R16 [P2] 历史读取静默限制为最早 1000 条，数据增加后尾部不再可见

位置：[仓储第 196 行](D:/AA-project/自动化/src/tools/momo/reply-store.js:196)。风险类型：历史覆盖和增量对齐错误。

`ORDER BY seq ASC LIMIT 1000` 不是最近 1000 条，而是最早 1000 条。超过上限后用于对齐的“历史尾部”与最后一条消息停留在旧序号，刚追加的消息不能被后续读取，容易进入 needs_baseline 或错误判断。不能用静默 SQL 截断替代显式上下文预算。

```diff
- getConversationMessages(id) { return query('ORDER BY seq ASC LIMIT 1000'); }
+ getConversationTail(id, limit) { return readLatestThenOrderAscending(id, limit); }
+ getConversationHistory(id, budget) { return readAllOrReturnExplicitBudgetExceeded(id, budget); }
```

对齐只读取真实尾部；LLM 上下文根据约定读取全部历史，超预算明确失败或走经授权的摘要策略。补超过 1000 条后继续新增的测试。

## 建议修复顺序与重新验收门槛

1. 暂不启用 execute。先修 R10/R11/R04/R05 的模式、目标设备、取消与设备所有权边界。
2. 修 R01/R02，将真实接口及导航链路接通；从 plan 与 draft 做契约级端到端测试，不使用真实 API 计费。
3. 修 R03/R06/R07，确认正确对象、真实消息边界、唯一新增批次与可恢复作业。
4. 修 R08/R09，把草稿、精确输入、一次派发、发送前后新增气泡和 uncertain 重跑核验做成强制状态机。
5. 修 R12/R13/R14/R16，补密钥错误路径、全阶段 deadline、统一结果和历史覆盖。
6. 修 R15 的测试隔离并增加相应回归；离线通过后，由用户手动启动单个测试联系人实机验收，再考虑接中枢。

交付报告应分别列明：已实现、离线已验证、实机已验证、尚未验证。当前“已完成全部阶段”和“确认送达”的表述应撤回或收窄到有证据的范围。

总体评价：**可保留模块骨架和部分纯函数，但这不是只差实机调参的成品。优先问题是契约集成和状态安全，不是运行速度。**
