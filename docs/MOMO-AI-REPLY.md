# MOMO AI 自动回复工具 (DeepSeek API 集成)

> 控制台访问地址：`http://127.0.0.1:4318/`。
> 官方接口协议：DeepSeek API (`https://api.deepseek.com/chat/completions`)，默认模型 `deepseek-chat`。

---

## 一、系统定位与架构闭环

本工具为云手机上的 MOMO 会话提供**有界闭环**的自动回复能力。
核心链路如下：

```text
调用方准备好指定联系人的当前聊天页面
  → 读取当前聊天并过滤系统/无关内容
  → 读取最近消息并与已保存聊天记录有序对齐 (message-merge.js)
  → 纯增量消息事务入库 (reply-store.js)
  → 提取完整有序对话历史并注入系统提示词 (context.js)
  → 调用 DeepSeek API 生成口语化回复 (provider.js / reply-service.js)
  → 点击发送前锁定发送意图持久化 (send-chat-message.js)
  → 自然拼音输入、候选字词核验、草稿核验
  → 点击发送并观察己方新气泡确认送达
  → 状态闭环并返回结构化报告
```

### 核心安全原则
1. **调用边界明确**：本脚本只处理调用方指定的一个联系人，直接使用当前已打开聊天；不扫描消息列表、不点击联系人、不做聊天对象身份核验。
2. **不串设备**：设备独立数据库 (`.runtime/momo-data/devices/device-{id}/momo.sqlite`)，独立配置与独立游标。
3. **不丢真实重复发言**：纯序列对齐算法不使用全局去重 Set，保留时间/文本重复的真实消息。
4. **意图先行持久化 (T29)**：点击发送前必须先在 DB 中更新为 `send_attempted`；持久化失败绝对禁止点击。
5. **不盲目自动重发 (T30)**：点击发送后若无法确认己方新气泡，标记为 `uncertain`，禁止自动再次点击。
6. **有界调度**：单次只处理一个联系人，完成后立即返回，不在内部写死循环。

### 2026-10-21：身份、输入与发送证据修复

当前已补充系统提示过滤、换行单字、候选行分离和发送后键盘恢复机制。

- 数据库、回复任务与发送工具统一使用原联系人昵称；顶栏核验仅接受原昵称或完整的 `与{昵称}对话`，禁止子串包含匹配。页面布局和置信度门槛保持不变。
- 草稿必须与预期文字完全一致。候选词消失不能证明文字已经提交；识别不一致时按原次数重识别，耗尽后保留草稿并返回 `INPUT_MISMATCH`，不点击发送。
- 输入法只选择完整文字匹配的候选框，不按合并候选串中的字符比例猜坐标；原有检测回退与逐字回退保留。
- 系统状态条的模糊识别必须匹配完整的两段状态句结构；普通正文仅提及“聊天、连续、火花”等词不会因此被标为系统提示。
- 发送确认要求新增消息归属为 `self`，不再用偏右的文字框覆盖 `peer` 判断。旧消息完全移出可视区时，仍保留 `uncertain` 和禁止自动重发的规则。
- 多行输入 OCR 按实际文本行排序；全图备用识别复用输入框的光标清理结果。OCR 仍可能漏识换行后的单字，此时保护草稿并停止，不凭候选点击推定成功。
- 本次验证限于语法检查和已有截图的离线 GPU 识别；未新增或运行单元测试，未调用回复 API，未操作云机发送消息，不作为完整实机流程通过证明。

### 2026-10-21：逐项验证后的补充修复

- 系统提示在可见消息读取、旧记录导入、已导入记录读取、增量写入及 API 上下文构造处统一过滤。旧数据库不删除记录，已有消息序号和处理游标不重排。
- `input_full_roi` 是可选的完整文字区域，仅供输入 OCR 备用路径使用；快速识别区域、候选区域及模型权重不变。备用路径按实际像素分行识别，仍要求草稿与预期文字完全一致。
- 候选字分割先区分拼音行与候选行，再识别实际候选框；不从合并字符串里猜点击位置。
- 输入法表情推荐动画导致 `input_box` 暂时漏检时，最多重新截图识别三次；原布局、身份与置信度条件不变，其他错误不因此放行。
- 点击发送并确认输入框清空后，若能看到预期己方文字但旧锚点不可见，可在同一聊天页内收起键盘一次。确认仍须旧消息重叠且仅新增一条完全匹配的己方消息，否则保持 `uncertain`，不自动重发。
- 键盘恢复记录到 `sendEvidenceJson.expandedViewport`；只读的不确定任务复核只消费该证据，不新增手机操作。

---

## 二、两种运行模式 (Mode Matrix)

| 模式 | 手机触控/按键 | 写数据库 | 外部 DeepSeek API | 真实输入与发送 | 典型用途 |
| --- | --- | --- | --- | --- | --- |
| **`draft`** | ✅ 读取、识别、模拟输入 | ✅ 保存增量消息与回复任务 | ✅ 调用生成回复 | ✅ 输入并核对，❌ 点击发送 | 测试 AI 回复和输入效果，文字停留在输入框 |
| **`execute`** | ✅ 完整操作 | ✅ 完整事务持久化 | ✅ 调用生成回复 | ✅ 仅全部校验通过后执行 | 真正的全流程端到端自动回复闭环 |

---

## 三、DeepSeek API 配置与密钥安全

### 1. 配置存储与脱敏
- 配置文件存储在 `.runtime/ai-reply/settings.json`（受 `.gitignore` 保护，不提交源码仓库）。
- 读取接口与前端界面**绝对不暴露明文 API Key**，仅返回 `hasApiKey: true` 及脱敏掩码（如 `sk-***cdef`）。
- 每次修改配置时，内部 `revision` 自动递增；保存时进行 `expectedRevision` 并发冲突校验（冲突返回 `409 Conflict`）。

### 2. 默认参数
```json
{
  "provider": "deepseek",
  "endpoint": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "temperature": 0.7,
  "maxTokens": 150,
  "timeoutMs": 15000,
  "contextMaxMessages": 60,
  "systemPrompt": "你是一个友好自然的真人，正在与朋友在社交App上聊天。回复简短真实、生活化，每次只回复一两句话，严禁出现AI助手或客服腔调。"
}
```

---

## 四、增量去重与数据表设计

在目标设备的 SQLite 数据库中创建专用的 AI 回复表，**完全保留旧版 `contacts` 与 `messages` 表不破坏**：

1. **`ai_conversations`**：本地会话表，绑定 `(deviceId, accountScope, contactName)` 唯一索引，记录 AI 上下文导入状态与 `contextVersion`。
2. **`ai_messages`**：严格自增有序消息表，`UNIQUE(conversationId, seq)`，支持区分 `legacy_import`、`live_observed` 与 `bot_observed`。
3. **`ai_reply_jobs`**：回复任务生命周期表，记录 `state` 状态流转（`pending` → `generating` → `draft_ready` → `send_attempted` → `own_bubble_observed` / `uncertain`）。
4. **`ai_conversation_state`**：兼容性记录表，保存观察位置和发送任务信息；`handledThroughSeq` 不参与单次调用是否回复的判断。

单次 `execute` 调用就是一次明确的“生成并发送”命令；单次 `draft` 调用执行到输入框文字核验完成后返回，不点击发送。两种调用都会读取当前能获得的聊天历史，无论是否识别到新消息、最后一条消息属于哪一方、是否存在旧回复任务，都会创建新的回复任务并调用 API。对齐失败时不再以 `needs_baseline` / `no_new_peer_messages` 拦截本次生成，而是使用已保存历史并叠加当前可见消息作为本次上下文。API 配置错误、设备占用、输入校验失败以及发送结果无法确认仍会如实返回失败或待核验，不伪造成功。

---

## 五、Web 控制台与 REST 接口 (`http://127.0.0.1:4318/`)

在本地控制台已挂载 6 个专用 REST API：

| Method | 路径 | 核心功能 | 请求载荷 / 参数 | 响应样例 |
|---|---|---|---|---|
| **GET** | `/api/ai-reply/settings` | 读取当前脱敏配置 | `?deviceId=...` (可选) | `{ ok: true, settings: { model, hasApiKey, apiKeyMasked, revision } }` |
| **POST** | `/api/ai-reply/settings` | 保存更新配置 | `{ model, apiKey, systemPrompt, expectedRevision }` | `{ ok: true, settings: { revision: 2, ... } }` |
| **POST** | `/api/ai-reply/test` | 纯 API 连通性测试 | `{ apiKey, model, endpoint }` | `{ ok: true, message: "...", response: "连接成功", model: "deepseek-chat" }` |
| **POST** | `/api/ai-reply/run` | 创建异步回复任务 | `{ deviceId, mode: "execute", contactName: "联系人" }` | `{ ok: true, runId: "run_...", status: "running" }` (202 Accepted) |
| **GET** | `/api/ai-reply/runs/:runId` | 轮询任务状态与结果 | 路径参数 `:runId` | `{ ok: true, status: "completed", result: { outcome, contactsProcessed } }` |
| **POST** | `/api/ai-reply/runs/:runId/cancel` | 幂等取消正在运行的任务 | 路径参数 `:runId` | `{ ok: true, status: "cancelled" }` |

---

## 六、CLI 命令行调用

支持直接通过 npm script 执行：

```powershell
# 1. 生成回复并输入到聊天框但不发送 (draft 模式)
$env:YUNMOMO_DEVICE_ID = "2033060279606353921"
npm run flow:14 -- --draft

# 2. 闭环执行自动打字发送 (execute 模式)
npm run flow:14 -- --execute

# 3. 指定联系人；脚本直接使用当前已打开的聊天页面
npm run flow:14 -- --execute --contact "小雨滴"
```

---

## 七、异常状态码与恢复指引

| 状态码 | 含义 | 处理策略 |
|---|---|---|
| `DEVICE_BUSY` | 设备正在被手动控制台或其它脚本占用 | 自动退出或等待当前任务释放，严禁强行抢锁 |
| `TARGET_MISMATCH` | 顶栏昵称与目标联系人不一致 | 立即停止操作，不入库不发送 |
| `CHAT_UNCONFIRMED` | 未确认进入聊天页面（如误触停留在列表） | 终止当前流程，退回消息列表重试 |
| `DRAFT_NOT_EMPTY` | 输入框已有未发送的用户原有内容 | 保护用户草稿，不强行清空，终止发送 |
| `INPUT_MISMATCH` | 打字后输入框内容与回复正文不一致 | 终止发送，防止发送错乱字符 |
| `DATABASE_FAILED` | 点击发送前写入 `send_attempted` 失败 | 绝对禁止点击发送按钮，防止丢失状态追踪 |
| `SEND_NOT_CONFIRMED` | 点击发送后输入框未清空 | 标记为 `uncertain`，禁止自动重新点击 |
| `send_uncertain` | 发送后未在预期时间内观察到己方新气泡 | 标记为 `uncertain`，转入人工核验，绝不自动重发 |
| `API_AUTH_FAILED` | DeepSeek API Key 无效或过期 | 检查 Web 界面配置中的 API Key |
| `API_RATE_LIMITED` | DeepSeek API 429 频控限制 | 自动根据 Retry-After 规避，不盲目死循环重试 |
| `CONTEXT_BUDGET_EXCEEDED`| 历史消息总字数或条数超过模型预算 | 明确报错，不静默截断历史 |
