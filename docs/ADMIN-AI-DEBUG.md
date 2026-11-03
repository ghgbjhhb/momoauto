# 管理员 AI 回复调试

页面：管理员后台左侧「AI 调试对话」；路由 `/admin/assistant`。

## 用法

1. 用管理员账号进入新页面。右侧自动显示当前**全局**系统提示词和线上默认供应商/模型。在这行下方的「测试模型」下拉框切换本次调试使用的模型：包括后台已配置的供应商模型及 DeepSeek 官方服务支持的 Flash / Pro 选项。其下新增「思考强度」，按选择的模型动态提供实际支持的档位（含“跟随上游默认”）。**这两个选择只影响测试对话，不更新真实业务的默认模型或推理配置**；供应商 Key 留在服务端，下拉框不接触密钥。
2. 在左侧输入一条“模拟对方发来的消息”，点击“生成回复”；普通轮次显示模型提取的 `reply` 正文。右侧「AI 调用日志 · 对方意图」记录每轮的 `stage`、`summary`、联系方式意向、JSON 格式校验、模型生成的 `reply`、Token 用量，以及最终分流原因。
3. 可以在右侧临时编辑系统提示词，直接再次测试；**仅编辑和测试不会保存或修改真实 AI 设置**。
4. 点击“保存为正式提示词”并在确认框再次确认，才会通过已有 `POST /api/admin/ai-settings` 更新全局提示词。保存请求带配置修订号，过期修订不自动覆盖其他管理员的更新。
5. 当检测到对方有联系方式意向，且我方此前已发句数达到线上 `handoffMinSelfMessages` 门槛，并且后台开启了 `handoffEnabled` 且配置 `handoffSegments`，测试聊天将**代替 AI 生成的 reply**，依次展示后台配置的每一段联系方式话术，段间在 UI 中模拟正式流程的 1.5–3 秒等待。触发后模拟话术已发状态，停止该测试对话继续输入；清空测试聊天可重新开始。
6. “恢复线上提示词”重新读取当前服务端配置；“清空测试聊天”同时清除浏览器标签页内的调试历史、意图日志和意向固化状态，不删真实联系人历史。

## 在 AI 供应商配置中维护多个模型

管理员进入「AI 服务设置 → 编辑供应商」，原来的「模型名称」仍然是该供应商实际自动回复的**默认模型**；下方新增「多个模型 ID（每行一个）」输入框。保存供应商后，所有条目都可以在 AI 调试对话的模型选择器中使用，**无需复制同一套 API Key 或创建重复供应商**。

- 每个供应商最多 80 个模型 ID，自动去重，默认模型一定保留。旧版只有一个模型名称的配置自动兼容。
- 所有可选模型使用该供应商原本的 endpoint、API Key 和模型 ID。调试时如所选模型支持推理档位，会按推理模型要求调整本次请求的输出 Token 上限与超时，不修改保存的 temperature、maxTokens 或 timeoutMs；不影响真实任务使用的默认模型。
- 本次从现有 GPT 网关的只读 `GET /models` 响应实际核对了 21 个模型，其中 8 个为 GPT 系列：`codex/gpt-6.1-sol`、`codex/gpt-6-astra`、`codex/gpt-6.1-terra`、`codex/gpt-6-sol`、`codex/gpt-6-luna`、`codex/gpt-5.6-sol`、`codex/gpt-5.6-terra`、`codex/gpt-5.6-luna`。已将这 8 个模型归入已有的 GPT 供应商配置。
- 不会自动扫描、发送或收费测试这些模型；网关返回 ID 不等同于所有模型均具备 JSON-mode 或聊天调用能力，实际可用性仍需逐个在调试对话中检验。

## 思考强度与上游 Chat Completions 兼容

- **仅管理员调试页**提供档位选择：`跟随上游默认`（完全不发送 `reasoning_effort`），以及后端针对当前模型校验通过的选项。每个模型独立校验，不允许浏览器提交任意档位。选择保留在当前浏览器标签页，换模型时不兼容的档位自动回到默认。
- **GPT 网关（已有 8 个 `codex/gpt-*` 模型）**：通过现有 OpenAI 兼容 `/chat/completions` 发送 `reasoning_effort`。GPT-6.1 Sol 与 GPT-6 Astra 不提供 `none`，其余已核对的型号可选 `none / low / medium / high / xhigh / max`。本次调试请求按官方推理模型格式使用 `max_completion_tokens`（它含推理 Token），不发送不兼容的 `temperature`；正式自动回复没有启用本选项，仍使用自己的既有配置。
- **DeepSeek 官方**：仅 `deepseek-flash`、`deepseek-v4-pro` 提供 `none / low / high / max`；`none` 关闭思考。旧配置模型 `deepseek-chat` 不假设支持新版思考档位，只提供上游默认。DeepSeek 的 OpenAI Chat Completions 接口接受 `reasoning_effort`，无需切换到 Responses API，也不虚构一个额外的 DeepSeek 模型。
- 调试推理模型有独立的输出 Token 与请求超时预算：默认/中/低至少 4096 Token，高/极高至少 8192、最大至少 16384（不思考时至少 1024），超时不少于 120 秒，极高/最大不少于 180 秒。**更强推理可能消耗更多 API Tokens，花费更高、等待更久。** 不适用于真实云机任务。
- 右侧日志显示**本次请求的思考强度**与上游有返回时的 `reasoning_tokens`，不会展示内部推理文本。自建上游网关能否完整透传 `reasoning_effort`，仍需在重启后的真实管理员调试请求里验证；未做付费模型调用，不宣称上游已接受。
- 实现参考：[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[OpenAI 推理模型部署说明](https://developers.openai.com/api/docs/guides/deployment-checklist)、[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)。未新增依赖，也未改变生产设备任务。

## 与正式回复的关系

- 使用现有 `src/ai/reply-service.js` 的 **`generateReply()`**，其系统消息构造由 `src/ai/context.js` 完成，使用生产同样的 JSON 意图契约和字段提取。默认使用当前供应商/模型，测试时可选已配置的其他供应商/模型，由后端读取对应的真实 API 地址和 Key，沿用同一生成路径。
- 下拉模型以服务端白名单为准：配置内所有供应商的模型、以及当 endpoint 确认是 `https://api.deepseek.com` 时额外允许 `deepseek-flash`、`deepseek-v4-pro`。根据 [DeepSeek 官方当前模型与价格](https://api-docs.deepseek.com/quick_start/pricing/) 更新可选项，不盲目提供旧版模型名；原有默认配置若为旧模型则原样显示并保留，不擅自改线上模型。
- 传入的历史被转换为 `peer/self` 格式，对应真实 `MOMO` 的“对方/我方”气泡历史；进度 `selfSentCount` 按测试历史统计。
- **话术触发对齐**：调试 API 用与 `src/workflows/momo-ai-reply.js` 相同的分流条件：`stickyIntent`（本轮或此前有明确意向）、`selfSentCount`、`handoffMinSelfMessages`、话术开启状态、段落列表和“此前已发/待复核”状态。模型本轮返回的 `reply` 一直保留在右侧日志，左侧只显示实际将采用的回复或配置话术。话术仅为浏览器的**模拟连发**，不进行手机输入，也不实际拉黑。
- **差异（不可伪装完全等价）**：真实工作流还会从设备数据库读取已同步的完整聊天、设备/用户提示词覆盖、真实联系人历史的 `stickyIntent`，逐段打字并验证发送回执、写本地聊天数据库、最后尝试拉黑。调试页仅依赖测试窗口内的历史和意向状态，不读真实联系人库，也不会真实发送或拉黑，因此不验证手机交付成功。
- 模型回复并非确定性的：温度和上下文即使一致也可能产生不同措辞。
- 调试仍会调用当前配置的真实 AI 提供商，产生实际 API 用量。

## 安全限制

- 两个调试 API 均校验服务器端管理员身份；只有真实管理员可以读全局提示词与调用模型。
- 调试历史只保存在本标签页 `sessionStorage`，服务器不持久化。关闭标签页后通常即销毁；点击清空立即移除存储，进行中的模型请求会取消，旧响应不会回填。
- 限制最多 60 条历史、模拟对方单条 1200 字、系统提示词最多 **20000 字**，历史加提示词最多 **32000 字**（实际还受 AI 配置的 `contextMaxMessages` 限制）。编辑框会显示实时字数；后端使用同一组限制，长提示词保存正式设置后也可以进入实际 AI 上下文。具体模型提供商仍可能受自己的 Token 上限约束。同一管理员同时只允许一个调试生成请求。
- 不返回 API Key、原始模型 JSON 或联系人/云机数据库内容。
- AI 提示词属于共享配置，更改后新生成的正式 AI 回复可能立即受影响；保存前必须显式二次确认。

## 验证与部署

新接口位于 `src/server/routes/admin-routes.js`，**需要安全重启 Windows Node.js 服务后才生效**。前端静态 HTML、CSS、JS 直接可访问。生产中有真实连接时不得擅自重启。

可执行的无副作用检查：JavaScript 语法、`npm run ui:lint`、浏览器窗口布局、未登录访问新 API 被拒绝（重启后）。管理员真实模型响应需要授权会话及可用 AI Key，在没有上述条件时不能声称已经端到端成功。

## 设计参考

- [LibreChat 权限模型](https://github.com/LibreChat-AI/LibreChat)：调试编辑入口必须受服务器端权限约束，不依赖隐藏按钮。
- [OpenAI Evals 方案](https://developers.openai.com/api/docs/guides/evals)：复用生产对话上下文和提示词进行评估，测试会话与正式任务分离。
