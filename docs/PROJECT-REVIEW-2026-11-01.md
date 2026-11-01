# 云 momo 云手机自动化 · 项目优化审查报告

- **审查日期**：2026-11-01
- **审查方式**：源码静态通读 + 运行时结构核对（`node -e` 加载模块、统计符号、核对 DOM/路由/配置一致性）
- **审查边界**：**未修改任何源码、未触发任何设备动作、未运行任何业务流程**
- **审查范围**：`src/`（143 个 JS）、`app/`（14 个 JS + 3 个 HTML + 6 个 CSS）、`flows/`、`scripts/`、`python_typing/`、`python_workers/`、`docs/`、`package.json`、`.gitignore`

---

## 0. 量化基线（先看事实，再看判断）

| 维度 | 实测值 | 说明 |
|---|---|---|
| 后端 JS | 38,465 行 / 143 文件 | `src/` |
| 前端 | 19,607 行 / 24 文件 | 其中 CSS 10,161 行（6 个文件） |
| 流程入口 | 632 行 / 33 文件 | `flows/` 三层（根 / v2 / v3 / momo） |
| Python | 约 1,300 行 | `python_typing/` + `python_workers/` |
| HTTP 端点 | 64 个 | 分散在 4 个 router + `manual-control` |
| 控制台脚本 | 28 项 | `SCRIPT_DEFINITIONS`，全部 `requiresDevice: true` |
| 前端全局 | 62 个 `window.*` 赋值 | 8 个 classic `<script>` 顺序加载 |
| 静默失败 | 109 处 `catch {}` | `src/` + `app/` |
| 控制台日志 | 390 处 `console.log`（src） | 无分级、无结构化、无 traceId |
| 环境变量 | 100+ 个不同 `process.env.*` 直读 | 无 schema、无默认值表、无校验 |
| 文档 | 23 篇 + 1 个索引（4,752 行 / 529 KB） | 索引为生成物且入库 |
| Git | 175 commits / `.git` 258 MB | `models/` 815 个文件入库（6 个 `.pt` 约 158 MB） |
| 运行时 | `.runtime` 1.7 GB、`logs` 23 MB | 无保留策略 |

**结论先行**：这是一个**工程素养明显高于同类的内部 RPA 工具**——证据链、三态幂等、租约代次、SSRF 防护、视频背压这些"硬骨头"都做了，注释解释的是"为什么"而不是"是什么"。它的问题不在"写得差"，而在**三层结构债**：流程实现被复制成 v2/v3 两套、能力建成了但界面没有入口、执行模型还停留在"同步 HTTP + 浏览器驱动"。

---

## 1. 项目现状评估

### 1.1 分层成熟度

| 层 | 评级 | 依据 |
|---|---|---|
| SDK / 协议层（`src/client.js` `control.js` `protocol.js`） | **A-** | 职责清晰，`index.d.ts` 163 个签名基本同步；`screenshot` 有 stream→rest 降级；错误类型带 code |
| 自动化契约层（`src/automation/*`） | **A-** | `timing.js` 用 AsyncLocalStorage 做 span，`cancellation.js` 统一可取消等待，`page-service` 同帧证据绑定；设计水平高 |
| 业务实现层（`src/workflows/*`） | **B** | 逻辑扎实但**两代复制**，`momo-message-watch.js` 1,109 行单文件多状态机 |
| 服务层（`src/server/*`） | **B-** | 路由/鉴权/锁分层合理，但执行模型同步阻塞、运行态全在内存、事务边界不完整 |
| 前端（`app/*`） | **C+** | 功能密度高、交互细节讲究（输入接管、断线不重放），但 62 个全局变量 + innerHTML 拼接 + 无模块系统 |
| 交付/运维 | **C** | 无进程级异常兜底、无孤儿进程回收、无运行历史、无审计、`engines` 声明错误 |

### 1.2 值得保留、不要"优化掉"的设计

明确写在这里，避免后续重构误伤：

1. **`DeviceArbiter` 的 epoch / leaseToken / refCount 模型**（`src/server/device-arbiter.js`）——支持嵌套租约与借用，是单写互斥的正确骨架。
2. **`timing.js` 的 span 模型**——已有 `runId / spanId / parentSpanId / pid`，天然可对接 OpenTelemetry，不要重写。
3. **`cancellation.js` 的 `waitFor/checkSignal`**——所有长等待都走它，这是可取消性的基础。
4. **`video-stream.js` 的共享上游 + 每观看者背压 + 双心跳**——多网页看同一台设备不重复拉流，设计正确。
5. **`url-guard.js` 的同步 + 异步 DNS 双重 SSRF 校验**——AI endpoint 与短信 endpoint 都过了这道闸。
6. **`GEMINI.md` 的十一条不变量**——这是这个项目最值钱的资产，问题在于**有几条在异常路径上没有落地**（见 A-05）。

### 1.3 五个主要矛盾

| # | 矛盾 | 表现 |
|---|---|---|
| M1 | **能力已建成，界面无入口** | 调度中枢前端脚本根本没被加载；设备管理整页不可达；联系人/消息入库后无处查看 |
| M2 | **契约要求单写，异常路径破窗** | 服务重启后运行中的脚本变脱管进程，内存锁清零，第二写者可进入 |
| M3 | **任务很长，通道很短** | 20 分钟的流程挂在一个 HTTP 请求上，批次状态只活在浏览器内存里 |
| M4 | **同一业务两套代码** | v2/v3 共 11,169 行，7 个步骤已实质分叉（最大 diff 1,519 行） |
| M5 | **数据在，视图不在** | 每设备一个 `momo.sqlite`（contacts/messages/ai_reply_jobs）真实落盘，零查询接口 |

---

## 2. 代码与工程优化（已存在的问题）

### C-01｜v2 / v3 双份实现，已实质分叉　【P1 · 最大的结构性债务】

**现象**

`src/workflows/v2/*` 与 `src/workflows/v3/*` 是同一批 9 个业务步骤的两套完整实现，合计 11,169 行。归一化版本号后逐文件 diff：

| 步骤 | v2 行数 | v3 行数 | diff 行数 |
|---|---|---|---|
| `send-cloud-files` | 193 | 132 | 134 |
| `upload-certificate` | 76 | 67 | 65 |
| `set-vpc-proxy` | 382 | 231 | 477 |
| `configure-environment` | 309 | 127 | 261 |
| `generate-all` | 608 | 334 | 582 |
| `locate-ip` | 950 | 694 | **1,519** |
| `initialize-gaode` | 484 | 356 | 459 |

同时 `flows/v2/_common.js` 与 `flows/v3/_common.js` 各自维护一份 `STEPS` 表、确认变量名、子进程转发逻辑。

**影响**

- 修一个 bug 要改两处；`locate-ip` 已经分叉到 1,519 行差异，事实上是**两个不同产品**。
- `STEPS` 表与 `script-catalog.js` 三处重复描述同一步骤（编号、名称、入口、确认变量），任何新增步骤要改 3 个文件。
- v2 独有 `login-yaya / login-momo / bind-phone / setup-profile / check-home`，v3 独有 `initialize-input-method`，能力矩阵不对称且无文档说明。

**建议（不推翻、只收敛）**

1. 抽出**流程骨架**：`runStep({ step, device, sdk, confirmEnv })` 只保留"选设备→确认→执行→收尾"的模板方法。
2. 把差异收敛为**版本能力表**：`{ v2: { certApi: 'legacy', inputMethod: false, locate: v2Locate }, v3: {...} }`，差异点以策略函数注入，而不是复制文件。
3. `STEPS` 单一来源：`flows/*/_common.js` 只保留 `entry`，编号/名称/确认变量/参数 schema 统一由 `src/server/script-catalog.js` 派生（或反过来）。
4. 先做**只读合并**：v3 为主干，v2 独有步骤作为独立模块挂载，不要求行为完全一致。

**价值**：单点修复、能力矩阵可见、新增第 4 代 SDK 时成本从"复制 11k 行"降到"加一张能力表"。

---

### C-02｜已实现但用户不可达的代码　【P0/P1 · 性价比最高】

这一类是"写了、能跑、但没有入口"，属于纯损失。

| 编号 | 现象 | 证据 | 影响 |
|---|---|---|---|
| C-02a | **调度中枢前端完全未加载**：`app/momo-brain.js` 不被任何 HTML 引用，其依赖的 8 个 DOM id（`brainModeGroup`、`brainAutoReply`、`brainBrowse`、`brainGreetings`、`brainPollInterval`、`brainConfigBadge`、`brainNote`、`btnBrainSaveConfig`）在 `index.html` 中全部不存在 | `app/index.html:438-445` 只加载 logger/video-player/core/devices/scripts/session/manual-control/ai-reply；`app/console/core.js:4` 注释仍把它列为"页面数据逻辑" | **BrainManager + DeviceActor + BrainScheduler + 166 行路由 + 6 个模块（约 1,500 行）后端全部可用，界面零入口**。用户只能 `npm run flow:15` 或 `npm run momo:brain` 从命令行启动 |
| C-02b | **设备管理整页不可达**：`#page-devices` 永远 `hidden` | `app/console/core.js:507-515` 把 `devices` 与 `overview` 合并渲染；`getPageFromUrl()` 只认 tasks/messages/logs/settings；`app/index.html:144` 该 section 恒隐藏 | 页内的**搜索框、设备表格（状态/IP/版本/到期/流程步进器）、"手动操作"、"设为目标"按钮及已绑定的事件**（`devices.js:398-447, 534-550`）全部白写。用户只能在侧栏折叠列表里点名字 |
| C-02c | **联系人 / 消息 / AI 会话无任何视图** | `src/tools/momo/db.js:168,183` 建了 `contacts` / `messages`；`reply-store` 有 `ai_reply_jobs`；64 个端点中**没有**任何查询联系人/消息的接口 | flow-13「联系人及消息入库」跑完，用户无法验证入了什么、无法人工介入、无法看 AI 生成质量。数据在 `.runtime/momo-data/devices/device-*/momo.sqlite` 里，只有 CLI 能看 |
| C-02d | **flow-17 绑定手机未进目录** | `flows/momo/17-momo绑定手机.js` 存在（转发 `login-momo`），`script-catalog.js` 无 `flow-17`，`package.json` 无 `flow:17` | 兼容入口只能手工 `node flows/momo/17-...`，界面上看不到 |
| C-02e | **v2 的 5 个业务流程未进目录** | `src/workflows/v2/{login-yaya,login-momo,bind-phone,setup-profile,check-home}.js`（合计 4,500+ 行）不在 `SCRIPT_DEFINITIONS` | 这些是真实业务能力（丫丫登录、陌陌登录、绑手机、资料设置），控制台完全无法调度 |

**建议**

- C-02a：把 `momo-brain.js` 挂回 `index.html`，在"消息回复"页补一个"自动挂机中枢"区块（模式选择、开关、轮询间隔、状态徽章），DOM id 按现有脚本补齐即可，**后端零改动**。
- C-02b：`setPage('devices')` 不再重定向；侧栏"设备"组展开时进入设备页，`overview` 保留卡片墙。
- C-02c：新增只读接口 `GET /api/momo/contacts?deviceId=&q=`、`GET /api/momo/messages?deviceId=&contactId=&before=`，前端在"消息回复"页加一个会话抽屉。**先只读**，不做写操作。
- C-02d/e：把能安全暴露的（登录类需要验证码/短信，谨慎）补进 catalog，或在文档里明确"仅 CLI"。

**价值**：几乎零后端成本，把已经付过开发费的能力变成可见产品。这是本报告里**投入产出比最高的一组**。

---

### C-03｜死代码与遗留文件　【P2】

| 文件 | 状态 | 建议 |
|---|---|---|
| `app/theme-b.css` | 3,059 行，未被任何 HTML/JS 引用 | 删除或归档到 `docs/legacy/` |
| `src/server/auth/captcha.js` | 生成 SVG 验证码的完整模块，`src/server` 内**零引用** | 要么接入注册/登录（见 S-09），要么删除 |
| `flows/_common.js`（根目录） | 8 行，仅导出 `PROJECT_ROOT/redact`，v2/v3 各用自己的 `_common` | 删除 |
| `flows/v2/09-改机重置.js` | 兼容转发到 `reset-data`，catalog 用的是 `09-重置数据.js` | 保留（兼容），但补一句注释说明"未进目录" |
| `src/server/script-runner.js` 的 `busyAccountScripts` 分支 | 28 个脚本全部 `requiresDevice: true`，该分支永不进入 | 保留（前瞻），但补注释；否则读代码的人会以为存在"账号级脚本" |
| `src/server/routes/console-routes.js:488, 519` | `requireAdmin` 之后又判断 `user.role !== 'admin'` | 见 C-04 |

---

### C-04｜权限前置吞掉了后置判断，真参下发功能对普通用户不可用　【P0 · 功能缺陷】

**现象**

`src/server/routes/console-routes.js`：

```
473:  if (!requireAdmin(user, response)) return true;      // 只有管理员能进
...
488:  if (user.role !== 'admin' && !authService.canAccessDevice(user, deviceId)) {  // 永不成立
519:  if (user.role !== 'admin') { ... 配额校验 ... }                              // 永不成立
```

**影响**

1. **普通用户有真参配额，却没有控制台入口**——只能通过 `flow-02.1` 脚本走 `import-real-params.js` 里的配额扣减。产品上"买了真参用不了"，只能解释为"请跑脚本"。
2. 管理员推送真参时**既不校验设备归属，也不校验配额**（`consumeZhencanQuota` 对 admin 直接返回 999999）。单机单参只靠 `markZhencanFileUsed` 的一次性标记兜底。
3. 代码表达了一个不存在的权限模型，后续维护者会误判。

**建议**

- 拆成两个判定：`canAccessDevice(user, deviceId)`（数据面）+ `requireZhencanQuota(user)`（计费面），`requireAdmin` 只用于"目录管理/上传/删除"。
- 真参推送路径改为：校验设备归属 → 校验文件未被使用 → 下发 → 事务内 `markZhencanFileUsed` + `consumeZhencanQuota`。

**价值**：功能闭环 + 计费正确 + 消除误导性死分支。

---

### C-05｜错误处理与日志没有统一层　【P1】

**现象**

- 109 处 `catch {}` 静默吞异常（`src/` + `app/`），其中不少在关键路径（设备列表、代理查询、日志落盘）。
- 390 处 `console.log` 直出，无级别、无模块标签、无 traceId；只有 `appendServerLog` 一个半结构化通道。
- `src/server/http.js:130-139` 的 `errorStatus()` 用**中文错误消息正则**反推 HTTP 状态码：

```js
if (/正在执行脚本|手动控制/.test(error.message)) return 409;
if (/请选择|未知脚本|YUNMOMO_CERT_PATH|请求内容|.../.test(error.message)) return 400;
```

**影响**：改一句提示文案就可能把 409 变成 500；前端靠状态码分支的逻辑随之漂移。

**建议**

1. 引入 `AppError(code, message, { status, details })`，全量替换"抛字符串 + 正则匹配"；`errorStatus` 只做兜底。
2. 轻量 logger（不需要 winston）：`log(level, tag, msg, meta)`，内部复用现有 `appendServerLog` 的分级，输出带 `runId/spanId`（`timing` 已有）。
3. 空 catch 分类处理：**可恢复的**记 `warn` 带 code；**预期的**（如 `ENOENT`）显式注释；**不可恢复的**上抛。

**价值**：错误可定位、状态码稳定、日志可用于排障而不是"再复现一次"。

---

### C-06｜配置分散，无单一事实源　【P1】

**现象**：100+ 个 `process.env.YUNMOMO_*` 在 40+ 文件里直读；`configuredValue()`（`src/server/context.js:90`）只在 server 侧用；工作流全部直读 `process.env`。没有默认值表、没有类型校验、没有文档生成。

**建议**：`src/config/index.js` 集中声明（名称/类型/默认值/取值范围/所属模块），启动时一次性校验并冻结；`npm run config:doc` 生成 `docs/CONFIG.md`。工作流改为 `config.get('YUNMOMO_OCR_POLL_MS')`。

**价值**：新增环境变量不再"改三处文档 + 猜默认值"；错误配置在启动期暴露而不是运行到一半。

---

### C-07｜其它已确认的具体缺陷　【P2】

| 位置 | 问题 | 建议 |
|---|---|---|
| `package.json:engines` | 声明 `node >=18`，但代码用了 `node:sqlite`（`auth/db.js:6`、`brain/store.js:16`，**需 Node ≥22.5**）与 `AbortSignal.any`（`device-actor.js:278`，**需 ≥20.3**）。Node 18/20 上启动即崩 | 改为 `>=22.5`；或换 `better-sqlite3` 兼容旧版 |
| `README.md:13` | 写"Node.js 18+，本机已安装 24"，实测 `v22.22.2` | 同步 |
| `src/automation/timing.js:31` | `metadata()` 只接受 `/^\d{1,40}$/` 的 deviceId，含字母的设备（如 `DEV-API-01`）会被静默丢弃，耗时记录失去设备维度 | 放宽为 `[A-Za-z0-9_-]{1,64}` |
| `src/server/script-catalog.js:9` | 步骤 2.1 生成 `flow-2.1-v2`（未补零），与 `flow-01-v2` 命名不一致；`configureScript` 里要写两个 `startsWith` 兼容 | 统一 ID 规则，保留旧 ID 作别名 |
| `src/server/script-runner.js:165,206` | **双层 spawn**：server → `flows/v3/xx.js` → `src/workflows/v3/xx.js`。多一次 Node 冷启动（约 100 ms）+ 一层 stdout 转发 | 直接 spawn `step.source`，`flows/*` 只保留给人用 |
| `src/server/routes/admin-routes.js:32` | `updateUserStatus` 不校验 status 取值，也不阻止封禁自己/最后一个管理员 | 白名单 `active/banned` + 自我保护 |
| `src/server/routes/admin-routes.js:66` | `revokeCard` 忽略返回值，作废失败也回 `ok: true` | 按 `changes` 返回 404/409 |
| `src/server/http.js:66-93` | 超限时 `reject` 后立刻 `request.destroy()`，随后 `json(response, 400)` 可能写到已销毁的 socket（**需实测确认**是否抛 `ERR_STREAM_DESTROYED`） | 先 `response.end()` 再销毁请求；或改用 `413` |
| `app/console/core.js:604` | `setInterval(renderRecentActivity, 5000)` 在非 overview 页也空转 | 加页面判断 |

---

## 3. 架构优化建议

### A-01｜分层倒置：业务层反向依赖 server　【P1】

**现象**：5 个非 server 模块 `require('../server/device-arbiter')`——`src/brain/device-actor.js:14`、`src/brain/manager.js:16`、`src/workflows/momo-ai-reply.js:26`、`momo-block-peer.js:18`、`momo-message-watch.js:36`。

**影响**：`src/index.js`（SDK 入口）目前没被污染，但只要有人 `require('./workflows/momo-ai-reply')`，就会把 `src/server/` 拉进依赖图；CLI 与 SDK 使用者会被迫加载服务端代码。分层语义也被破坏（server 应该是"消费者"，不是"基础设施"）。

**建议**：把 `device-arbiter.js` 迁到 `src/automation/device-arbiter.js`，`src/server/` 只做转发导出（保持旧路径可用）。

**价值**：依赖方向回正，SDK 可独立分发。

---

### A-02｜执行模型：同步 HTTP + 浏览器批次，是当前最大的架构瓶颈　【P0】

**现象链**

1. `src/server/routes/execute-routes.js:156` → `await executeScript(...)`
2. `src/server/script-runner.js:205-267` → Promise 只在子进程 `close` 时 resolve
3. `app/console/scripts.js:888` → 前端 `await requestJson('/api/execute')`，**整段流程期间这条请求一直挂着**
4. `app/console/scripts.js:770-788` → 批量执行是 `for` 循环串行 `await`，结果只存在 `state.batchResults`（内存）
5. `app/console/scripts.js:874-885` → 同时每 300 ms 轮询 `/api/execute/output`，每次返回**全量** stdout（上限 120 KB）

**影响**

| 场景 | 后果 |
|---|---|
| 20 分钟的 01-09 全流程 | 一个 HTTP 请求挂 20 分钟；浏览器/隧道任一层中断即失去结果（服务端脚本仍在跑） |
| 关闭标签页 / 刷新 | 批次直接中断，无断点、无记录、无重试 |
| 10 台设备批量 | 严格串行，总耗时 = 求和；无法设置并发度 |
| 长日志 | 300 ms × 120 KB ≈ 400 KB/s 的重复传输，且随日志增长而增长（O(n²)） |
| 想查昨天跑没跑成功 | 无入口（见 A-03） |

**建议（分三步，可独立上线）**

1. **Run 实体 + 异步受理**：`POST /api/execute` 立即返回 `202 {runId}`；新增 `runs` 表（sqlite，与 `management.sqlite` 同库或独立库）：`id/scriptId/deviceId/userId/startedAt/finishedAt/exitCode/status/logPath/summaryJson`。
2. **增量日志通道**：`GET /api/runs/:id/output?cursor=N` 返回 `{cursor, chunk}`，或直接 `SSE /api/runs/:id/stream`（Node 原生，无需依赖）。前端轮询间隔可放宽到 1~2 s。
3. **服务端批次 Job**：`POST /api/jobs {scriptId, deviceIds[], concurrency, onFailure:'stop'|'continue'}`，由服务端顺序/并发驱动，逐台落 `runs`；前端只订阅进度。断点续跑天然成立（已完成的 run 不再重跑）。

**价值**：从"网页开着才能跑"变成"提交后可以关页面"；这是产品能否承接"挂机"场景的分水岭。

---

### A-03｜运行历史没有数据模型，只有日志文件　【P0】

**现象**：`logs/runs/<id>.log` + `logs/runs/<id>.owner`（`script-runner.js:64-83`）是唯一历史；读取接口只有 `GET /api/logs?scriptRunId=`（需已知 ID）；日志页只展示"最近一次"（`app/console/core.js:269-295`）。

**影响**：无法回答"这批跑了几台、哪台失败、失败在哪一步、耗时多少"；`npm run timing:report` 是唯一的聚合手段，且在命令行。

**建议**：与 A-02 的 `runs` 表合并；补 `GET /api/runs?deviceId=&scriptId=&status=&from=&to=&page=`；前端"运行日志"页左侧加运行列表（含状态色、耗时、退出码），右侧展示日志。保留 `logs/runs/*.log` 作为原始证据，加保留策略（如 30 天 / 500 MB）。

---

### A-04｜设备锁有三个来源，事务边界不完整　【P1】

**现象**

- 锁：`busyDevices`（`context.js:28`）+ `defaultArbiter`（`device-arbiter.js`）+ `manualBridges.some(isBusy)`（`script-runner.js:389`）。脚本路径同时写前两者，手动控制只写 arbiter，判断处三者都要查。
- 事务：`authService.redeemCard()`（`auth/service.js:434-455`）先 `markCardUsed`，再 `createAllocation`，**两条独立语句**。若分配抛错（如设备唯一约束、磁盘满），卡密已被消耗且不回滚。

**建议**

1. 统一到 `DeviceArbiter` 一个事实源，`busyDevices` 退化为它的只读视图（或直接删除）。
2. `redeemCard` 用 `BEGIN IMMEDIATE ... COMMIT` 包裹"核销卡密 + 建设备分配 + 记权益 + 写兑换日志"，失败整体回滚；`DatabaseSync` 是同步 API，事务实现成本很低。

**价值**：消除"两张表各说各话"的排查成本；避免真实资损（用户卡密被吞）。

---

### A-05｜进程模型：崩溃/重启后单写不变量被破坏　【P0 · 最需要修的一条】

**现象**

1. `script-runner.js:206-212` 用 `spawn(..., { detached: process.platform !== 'win32' })` 起子进程；Windows 下没有 Job Object 绑定。
2. `busyDevices` / `defaultArbiter.locks` / `activeScriptRuns` **全部是进程内存**。
3. `src/server/app-server.js:144-165` 的 `start()` **没有任何启动期对账**（`grep -r "reconcile|orphan" src/server` 无结果）。
4. 全局没有 `unhandledRejection` / `uncaughtException` 处理（全仓库 grep 为空）。

**失效链**

> 服务被 Ctrl+C / 崩溃 / 重启 → 父进程退出 → **Windows 上子脚本进程继续操作设备** → 新进程内存锁为空 → 用户再点一次脚本或打开手动窗 → 两个写者同时操作同一台云机。

这直接违反 `GEMINI.md` 第 2 条"单设备单写互斥"，而且是最容易发生的一条（改代码就要重启服务）。

**建议**

1. **落盘 run 元数据**：spawn 后立即写 `logs/runs/<id>.json`（`pid`、`deviceId`、`scriptId`、`startedAt`、`pgid`）。
2. **启动期对账**：`start()` 里扫描未标记 `finished` 的 run，用 `process.kill(pid, 0)`（POSIX）/ `tasklist /FI "PID eq <pid>"`（Windows）判断存活；存活的**不杀**，但 `defaultArbiter.quarantineDevice(deviceId, 'orphan run')` 并在 UI 明示"设备被上次会话的脚本占用，请确认后解除"。
3. **进程组约束**：Windows 用 `taskkill /T` 已在停止路径覆盖；启动路径建议用 Job Object（可用 `node-windows` 或直接 `cmd /c start /b` + 记录 PID 树）确保父死子死。
4. **进程级兜底**：`process.on('unhandledRejection')` 记日志 + 标记当前 run 失败（不静默），`uncaughtException` 记日志后**有序退出**（先 `bridge.closeAll()` 释放租约），而不是裸崩。

**价值**：把"偶发的设备状态错乱"从不可解释变为可解释、可恢复。

---

### A-06｜资源上限与降级路径　【P2】

| 资源 | 上限 | 位置 | 现状 |
|---|---|---|---|
| 视频流 | 16 台 | `video-stream.js:28` | 超限抛 `VIDEO_LIMIT`，前端只显示错误 |
| 每设备观看者 | 8 | `video-stream.js:43` | 同上 |
| 高清抓帧 | 16 路 | `stream-screenshot.js:213` | 超限**静默降级**为 REST 截图（`client.js:168-173`） |
| 每路抓帧 | 1 个 ffmpeg 进程 | `stream-screenshot.js:73` | 16 路 = 16 个 ffmpeg |
| 子进程输出 | 120 KB | `context.js:23` | 截断并提示 |

**建议**：50 台规模的账号会持续撞上限。做两件事即可：(1) 宫格视图**只对可视区域**请求截图（IntersectionObserver），(2) 前端把 `VIDEO_LIMIT` 显示为"当前最多同时预览 16 台，其余请在设备页查看"而不是报错。真要扩容再考虑降低宫格码率/分辨率。

---

### A-07｜未来会变成瓶颈的设计（提前准备）

| 设计 | 何时成为瓶颈 | 准备动作 |
|---|---|---|
| 设备锁在进程内存 | 想多开一个服务实例 / 多机部署 | 锁外置（sqlite 行锁或文件锁），或明确写死"单实例"，并在启动时用 PID 文件互斥 |
| 脚本清单硬编码在 `script-catalog.js` | 脚本数量继续增长 / 想按客户定制 | 改为数据驱动（`flows/*.meta.json` 或 DB 表），catalog 只做加载 |
| 只有 `admin/user` 两角色 | 团队协作 / 代理商 | 预留 `permissions` 字段与 `can(user, action, resource)` 抽象 |
| `momo.sqlite` 按设备分库 | 需要跨设备统计/搜索 | 保持分库，但加一个只读的聚合索引表（联系人摘要） |
| 页面分类靠中文正则（`page-service.js:33-99` 约 20 条） | MOMO 改文案即失效 | 见 S-18 的"证据库"方案 |

---

## 4. 功能完善建议

### 4.1 已建成但界面缺失（先做这些，成本最低）

见 **C-02** 的 a~e 五项。这里补充产品视角的判断：

| 功能 | 现状 | 补齐后的产品价值 |
|---|---|---|
| 自动挂机中枢（Brain） | 后端完整，前端孤儿文件 | 这是"长期在线、像真人一样使用"的核心卖点，目前只能命令行启动，等于没有 |
| 设备管理页 | 表格/搜索/步进器全写好，页面不可达 | 多设备账号的基本诉求：一眼看清 10 台各自跑到第几步 |
| 联系人 / 会话 | 数据落盘，无接口无视图 | 用户能验证"入库成功"、能看 AI 回了什么、能人工接管 |
| 登录类流程（v2 5 个） | 实现完整，未进目录 | 新号接入的必经步骤 |

### 4.2 现有功能的缺陷（用户可感知）

| 编号 | 问题 | 位置 | 建议 |
|---|---|---|---|
| F-06 | **断线后无法停止脚本**：`stopRunningScript` 只认 `state.activeRun`；fetch 失败后 `activeRun` 被清空，但服务端还在跑 | `app/console/scripts.js:958-983, 923-930` | 停止按钮以 `/api/runtime-state` 的 `runs` 为准（服务端为唯一事实源），支持"停止其他网页的运行"（带确认） |
| F-07 | **批量任务无并发/无失败策略/无重试** | `scripts.js:770-788` | 见 A-02 第 3 步；先做"失败继续/失败停止"两个选项，成本极低 |
| F-08 | **运行日志无历史列表** | 日志页 | 见 A-03 |
| F-09 | **云盘列表每次全量扫描 3 遍**：`getCloudDiskFiles` 被调用 3 次（当前目录 + 两个计数），每次都 `readdirSync` + 逐文件 `statSync` + 真参 JSON 解析 | `console-routes.js:339-344, 42-98` | 一次扫描返回全部；加 mtime 缓存（5 s） |
| F-10 | **云盘上传走 base64 JSON（上限 50 MB）**，且 `writeFileSync` 同步写 | `console-routes.js:415-431` | 改 `multipart/form-data` 流式落盘；前端加进度条 |
| F-11 | **真参下发对普通用户不可用** | 见 C-04 | 见 C-04 |
| F-12 | **无任何通知**：脚本失败、设备到期、风控熔断都只在页面上一闪 | 全局 | 见 F-14 |

### 4.3 值得新增的功能（按价值排序）

| 编号 | 功能 | 为什么值得做 | 实现要点 |
|---|---|---|---|
| F-13 | **运行中心（Run Center）** | 所有排障/验收/交付都缺这一块 | A-02 + A-03 的副产品；列表 + 筛选 + 重跑 + 日志 + 截图产物 |
| F-14 | **告警通道** | 挂机场景必须"出事有人知道" | 服务端 `notify(level, title, detail)`，先接企业微信机器人 Webhook（一个 HTTP POST），再做邮件 |
| F-15 | **计划任务（Cron）** | "每天 9 点跑 01-08" 是这类工具的刚需 | 复用 `runs` 表 + 一个 `setInterval` 调度器（10 s tick）；注意与 Brain 的 `pollIntervalMs` 区分（一个是流程，一个是消息） |
| F-16 | **会话工作台（只读 → 可接管）** | 让 AI 回复从"黑盒"变成"可审阅" | `GET /api/momo/contacts`、`/messages`；先只读，再加"人工发送"（走现有 `send-chat-message`） |
| F-17 | **审计日志** | 涉及发卡/封禁/回收/改可见性，出问题要能追 | `audit_logs(actor, action, target, before, after, ip, at)`；管理端只读页 |
| F-18 | **用量与成本看板** | AI token、真参消耗、设备时长都是钱 | `ai_reply_jobs` 已有 usage 字段的话直接聚合；没有就在 provider 返回时落库 |
| F-19 | **设备健康巡检** | 减少"点进去才发现连不上" | 定时 `screenshot` 探活 + 结果写 `streamHealth`；复用现有 2 s 心跳逻辑 |
| F-20 | **结果导出** | 批量跑完要交差 | `GET /api/runs/export.csv`（脚本/设备/状态/耗时/退出码） |

---

## 5. 性能、安全与稳定性

### 5.1 性能

| 编号 | 问题 | 证据 | 建议 | 预期收益 |
|---|---|---|---|---|
| S-01 | **设备列表每 3 s 全量刷新，缓存 2.5 s 必然击穿，每台设备各发一次代理查询** | `session.js:573-575`（3 s 轮询）+ `context.js:196-238`（`Promise.all(records.map(resolveDeviceProxy))`，每台 1~2 次 HTTP）+ `context.js:233`（TTL 2500 ms < 3000 ms） | 代理信息单独缓存 30~60 s；或用 `useIp` 字段优先，代理查询降级为后台刷新 | 50 台设备时从约 20 req/s 降到 <1 req/s，直接降低被平台限流的概率 |
| S-02 | **日志轮询全量重传** | `scripts.js:874-885` + `execute-routes.js:100-109` | 增量 cursor（见 A-02） | 长任务网络占用降 1~2 个数量级 |
| S-03 | **`runtime-state` 1.5 s 轮询 + 每次触发 3 个渲染函数** | `session.js:572, 181-198` | 改为 SSE，或仅在 `runs/manualDevices` 变化时渲染（快照比较） | 空闲 CPU 与 DOM 抖动明显下降 |
| S-04 | **同步文件 IO 在请求路径上** | `console-routes.js:404, 428, 530`（`readFileSync/writeFileSync`）；`ai/config.js:133` 每次 `loadSettings()` 读盘 | 改 `fs/promises` + 流；config 加内存缓存 + mtime 失效 | 避免大文件上传/读取时视频推流卡顿 |
| S-05 | **宫格截图 12 s/台 + 并发 2** | `devices.js:5-6, 389-394` | 仅可视区域截图（IntersectionObserver）；离屏设备降到 30 s | 50 台时从 50 张/12 s 降到个位数 |
| S-06 | **前端 8 个 classic script 串行加载、19.6k 行无压缩** | `index.html:438-445` | 开发期保持分文件，生产用简单的 concat + minify 脚本（无需引入构建框架）；已有 ETag/304，收益主要在首屏 | 首屏可交互时间下降 |

### 5.2 安全

| 编号 | 风险 | 证据 | 建议 |
|---|---|---|---|
| S-07 | **注册接口完全开放**，限流只对"失败"计数，注册成功即清零 | `auth-routes.js:22-37`；`guard.js:98-104` | 加邀请码/卡密校验，或默认关闭注册（`ALLOW_REGISTER=0`）；`registerSuccess` 不清 IP 计数 |
| S-08 | **Cookie 无 `Secure`**，公网穿透（`YUNMOMO_PUBLIC_ORIGINS` 支持 https）时可能明文回传 | `auth-routes.js:30,47` | 按协议动态加 `Secure`；`SameSite=Lax` 保持 |
| S-09 | **验证码模块已实现但未接入** | `auth/captcha.js` 零引用 | 登录失败 3 次后要求图形验证码（现成模块，接入成本低） |
| S-10 | **密码策略不一致**：注册 6 位、改密 8 位 | `auth/service.js:141, 198` | 统一 8 位 + 弱口令黑名单 |
| S-11 | **用户枚举**：注册返回"该邮箱已注册"，登录区分"封禁/密码错" | `auth/service.js:146-148, 178-185` | 注册改中性提示；登录统一"邮箱或密码不正确" |
| S-12 | **JWT 签名比较非恒定时间**；无刷新机制，改密即踢所有设备 | `auth/service.js:122` | 用 `crypto.timingSafeEqual`；后续可加 refresh token（非必须） |
| S-13 | **AI API Key 明文存 `.runtime/ai-reply/settings.json`** | `ai/config.js:17-18` | 至少收紧文件权限（0600，与 `.env.local` 一致）；长期可接 OS 凭据库 |
| S-14 | **`/api/execute` 无速率限制**，单用户可连续起子进程 | `execute-routes.js:149` | 每用户/每设备最小间隔（如 3 s）+ 并发上限（如 2） |

**已做得好、无需改动的**：同源 `Origin`/`Host` 校验（`http.js:141-150`）、CSP 与 `frame-ancestors`、`redact` 脱敏、SSRF 双重校验、子进程环境变量在识别服务启动时被清洗（`recognition-service.js:83`）。

### 5.3 稳定性

| 编号 | 问题 | 证据 | 建议 |
|---|---|---|---|
| S-15 | **无进程级异常兜底** | 全仓库无 `unhandledRejection`/`uncaughtException` | 见 A-05 第 4 点 |
| S-16 | **内存表无界增长**：`activeRuns`（AI 回复）只 `set` 不 `delete`，且保存完整 `result` | `ai-reply-routes.js:22,154` | 加 TTL（如 1 h）+ 上限（如 200 条），或落 `runs` 表 |
| S-17 | **`brain_tasks` 只增不减**：完成的旧任务通过改名归档（`_archived_<id>`）保留 | `brain/store.js:161-163` | 定期归档到 `brain_tasks_history` 或按 30 天清理 |
| S-18 | **页面分类器依赖 20+ 条中文正则**，MOMO 改文案即静默失效 | `page-service.js:33-99` | 建"证据库"：把每次真实截图 + OCR + 期望分类落盘（`logs/evidence/`），改分类器后回放比对。**这不是单元测试**，是符合 `GEMINI.md` 的真机证据回归 |
| S-19 | **无健康检查端点** | 只有 `/api/status`（返回 token 状态） | 加 `/healthz`：进程存活、sqlite 可读、识别服务可达、活跃 run 数、视频连接数 |

---

## 6. 长期迭代规划

### 6.1 目标架构（在现有基础上演进，不推倒）

```
┌──────────────────────────────────────────────┐
│ app/  (ESM + 现有 AppStore)                  │
│  pages: overview / devices / tasks / runs    │
│         messages(含 Brain) / logs / settings │
└───────────────┬──────────────────────────────┘
                │ HTTP + SSE
┌───────────────▼──────────────────────────────┐
│ src/server/  路由层（薄）                     │
│  ├─ runs  (Run/Job 实体, 异步受理)            │
│  ├─ auth  (RBAC 预留)                        │
│  └─ routes/*  (只做参数校验 + 调 service)     │
└───────────────┬──────────────────────────────┘
                │
┌───────────────▼──────────────────────────────┐
│ src/core/  (从 src/automation 提升)           │
│  config / logger / errors / timing           │
│  device-arbiter / cancellation / page-service│
└───────────────┬──────────────────────────────┘
                │
┌───────────────▼──────────────────────────────┐
│ src/workflows/  (单代实现 + 版本能力表)        │
│ src/brain/      (调度中枢, 复用 core)         │
│ src/tools/      (设备能力)                    │
└──────────────────────────────────────────────┘
```

关键点：**server 变薄**（只做校验与编排）、**core 变厚**（横切能力集中）、**workflows 收敛为单代**。

### 6.2 三阶段路线

**阶段一：止血与可见（1~2 周）**

- P0 全部：孤儿进程对账（A-05）、Run 实体与异步受理（A-02）、停止以服务端为准（F-06）、真参权限闭环（C-04）、事务边界（A-04）
- C-02a/b 挂回 Brain 前端与设备页（零后端改动，一天内可完成）
- 补 `/healthz`、进程级兜底、`engines` 修正

**阶段二：收敛与提速（3~5 周）**

- v2/v3 收敛为"单代实现 + 能力表"（C-01），先合并 `send-cloud-files / upload-certificate / configure-environment` 三个低风险步骤
- 统一配置层（C-06）、统一错误与日志（C-05）
- 前端 ESM 化，`window.*` 收敛到一个命名空间（C-02 的前置）
- 性能四项：S-01 代理缓存、S-02 增量日志、S-04 异步 IO、S-05 可视区截图

**阶段三：产品化（1~2 月）**

- 运行中心 + 计划任务 + 告警 + 审计（F-13~F-17）
- 会话工作台（F-16），从只读走到"AI 草稿 → 人工确认发送"
- 用量看板（F-18）、设备巡检（F-19）、导出（F-20）
- 安全收口：注册策略、验证码、密码策略、限流（S-07~S-14）

### 6.3 明确不建议做的事

1. **不要迁移技术栈**（不换 Node 框架、不上 React/Vue、不引 TypeScript 全量重写）。当前问题不在框架，换栈只会把 11k 行重复代码复制一遍。
2. **不要引入单元测试框架**（与 `GEMINI.md` 冲突）。替代方案是 S-18 的"真机证据库"。
3. **不要为了"结构好看"拆 `momo-message-watch.js`**。它是状态机，按状态拆文件会比现在更难读；等 C-01 收敛后再评估。
4. **不要动 `models/` 与识别服务**。GPU 常驻池的设计是对的，优化点在调用侧（缓存、去重），不在推理侧。
5. **不要把 `busyDevices` 简单删掉**。先确认 `DeviceArbiter` 覆盖了所有路径（含手动控制、Brain、AI 回复），再删。

---

## 7. 优化优先级总表

### P0（必须解决：正确性 / 数据安全 / 核心可用性）

| 编号 | 问题 | 位置 | 动作 | 价值 |
|---|---|---|---|---|
| A-05 | 重启后脚本变脱管进程，单写互斥破窗 | `script-runner.js:206`、`app-server.js:144` | run 元数据落盘 + 启动对账 + quarantine + 进程兜底 | 消除最危险的设备并发写 |
| A-02 | 同步 HTTP 执行 + 浏览器批次 | `execute-routes.js:156`、`scripts.js:770,888` | 202 受理 + Run 表 + 增量日志 + 服务端批次 | 长任务可关页面、可重试、可并发 |
| A-03 | 无运行历史 | `logs/runs/*` | Run 列表/筛选/详情接口 | 排障、验收、交付的基础 |
| C-04 | 真参下发权限倒置，普通用户不可用 | `console-routes.js:473,488,519` | 拆设备归属 + 配额两层判定 | 功能闭环 + 计费正确 |
| A-04 | 卡密核销与设备分配无事务 | `auth/service.js:434-455` | `BEGIN IMMEDIATE` 包裹 | 避免资损 |
| F-06 | 断线后无法停止脚本 | `scripts.js:958-983` | 停止以服务端 run 为准 | 用户可自救，不必重启服务 |

### P1（优先优化：结构 / 体验 / 风险）

| 编号 | 问题 | 位置 |
|---|---|---|
| C-01 | v2/v3 双份实现（11,169 行，已分叉） | `src/workflows/v2`、`src/workflows/v3` |
| C-02a | Brain 前端未加载，中枢无入口 | `app/momo-brain.js`、`index.html` |
| C-02b | 设备管理页不可达 | `core.js:507`、`index.html:144` |
| C-02c | 联系人/消息无接口无视图 | `tools/momo/db.js`、`console-routes.js` |
| C-05 | 错误码靠中文正则、109 处静默 catch | `http.js:130`、全局 |
| C-06 | 100+ 环境变量散读，无 schema | 全局 |
| A-01 | 业务层反向依赖 `src/server` | 5 处 `device-arbiter` 引用 |
| S-01 | 设备列表每 3 s 全量刷新 + 每台查代理（缓存击穿） | `session.js:573`、`context.js:196-238` |
| S-16 | `activeRuns` 无界增长 | `ai-reply-routes.js:22` |
| S-15 | 无进程级异常兜底 | 全局 |
| S-07/08/10/11 | 注册开放、Cookie 无 Secure、密码策略、用户枚举 | `auth-routes.js`、`service.js` |
| C-07 | `engines` 声明 Node ≥18，实际需 ≥22.5 | `package.json:engines` |

### P2（后续完善：整洁度 / 上限 / 细节）

| 编号 | 问题 | 位置 |
|---|---|---|
| C-03 | 死代码：`theme-b.css` 3,059 行、`auth/captcha.js`、`flows/_common.js` | — |
| C-07 各项 | `flow-2.1-v2` 命名、双层 spawn、`timing` 设备 ID 过滤、admin 无自我保护、DELETE+body | 见 C-07 表 |
| A-06 | 16 路视频/抓帧上限无友好降级 | `video-stream.js:28`、`stream-screenshot.js:213` |
| S-03/04/05/06 | 轮询渲染、同步 IO、宫格截图、前端无压缩 | 见 5.1 |
| S-17/19 | `brain_tasks` 只增不减、无 `/healthz` | `brain/store.js`、`app-server.js` |
| F-09/10 | 云盘 3 次全扫、base64 上传 | `console-routes.js:339,415` |
| D-01 | 文档漂移：`AGENTS.md` 写"10 个脚本/app.js 4 模块"、`flows/README` 写 8 步（实际 9 步）、`docs/APP.md` 描述旧单页 UI、`CHANGELOG` 停在 10-16、`docs` 引用不存在的 `flows/执行全部.js` | `AGENTS.md`、`flows/README.md`、`docs/APP.md`、`CHANGELOG.md` |
| D-02 | `docs/代码符号索引.md` 529 KB 生成物入库，每次改代码产生巨大 diff | 考虑改为构建产物或按模块拆分 |
| D-03 | `docs/FLOW15-REFACTOR-HANDOFF.md` 自述"未做语法检查、未真机实测、未提交"，但 flow-15 已在生产目录中 | 需确认当前版本是否已验收（见附录 A） |
| D-04 | 无 ESLint / Prettier / EditorConfig | 建议只加 `eslint:recommended` + 3 条自定义规则（禁止空 catch、禁止 `console.log`、禁止直接 `process.env`） |

---

## 附录 A：无法从代码确认、需要你确认的事项

| # | 事项 | 为什么无法确认 |
|---|---|---|
| A1 | Windows 上服务退出后子脚本是否真的继续运行 | 属于 OS 行为 + 启动方式相关，需实测（`npm run app` 前台 Ctrl+C vs 关闭终端） |
| A2 | `docs/FLOW15-REFACTOR-HANDOFF.md` 描述的 flow-15 重写是否已真机验收 | 文档自述"未实测"，但代码已在 catalog 中；`git status` 显示 `src/workflows/momo-message-watch.js` 仍有未提交修改 |
| A3 | 管理员推送真参不扣配额是设计还是遗漏 | 代码里 `consumeZhencanQuota` 对 admin 显式返回 999999，但同一路由又写了永远不会执行的扣减分支，意图不明 |
| A4 | 50 台设备规模是否为真实目标 | 决定 A-06 与 S-01 的优先级；若长期 ≤10 台，可降级为 P2 |
| A5 | 是否有多实例部署计划 | 决定设备锁是否需要外置（A-07 第一行） |
| A6 | 公网穿透（`YUNMOMO_PUBLIC_ORIGINS`）是否实际启用 | 决定 S-08（Cookie Secure）与 S-07（开放注册）的紧迫性 |

## 附录 B：本次审查未覆盖

- 未运行任何业务流程，因此**未验证** v2/v3 各步骤的真机行为差异（C-01 的合并风险需实测评估）。
- 未审查 `models/` 训练代码与标注质量。
- 未审查 `python_typing/` 的分词/拼音算法正确性（仅确认接口边界与进程模型）。
- 未做压力测试（并发设备数、长任务内存曲线），S-01/S-05 的收益为静态推断。
- 未审查 `scripts/frp-4318/` 隧道配置的安全性细节。

---

*本报告只做分析与建议，未修改任何源码。所有结论均标注了可核对的文件与行号；标注"需确认"的项请以实测为准。*
