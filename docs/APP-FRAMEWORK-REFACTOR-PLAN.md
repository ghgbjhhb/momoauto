# 控制台框架重构执行说明

这份文档给执行重构的 AI 用。按阶段原样搬移代码，不重写行为。做完一阶段再进入下一阶段。某一阶段的语法检查或烟测失败时停下来，不要继续后面的阶段，也不要靠改业务脚本来收场。

基准日期：2026-10-30。行号以当天工作区为准。搬移前用编辑器重新定位函数名，不要死盯行号。

## 硬约束

1. 只改控制台壳：`app/` 里的页面脚本，以及 `src/server/`。业务脚本目录整棵不动：`flows/`、`src/workflows/`、`examples/`、`src/tools/`、`src/automation/`、`src/ai/`、`src/brain/`、`src/typing/`、`python_typing/`、`python_workers/`、`models/`。允许在 `src/server/` 里继续 `require` 这些目录里已经在用的模块，禁止修改被 require 的文件。
2. 这是搬移，不是重写。函数体、条件、错误文案、状态码、请求字段、响应字段、Cookie、响应头、环境变量名、子进程参数、正则，都保持原文。看到可以“顺便修好”的地方，记在阶段报告里，不要改。
3. 服务端继续使用 CommonJS。`package.json` 没有 `"type": "module"`。新文件使用 `require` 和 `module.exports`。不要引入 TypeScript、打包器、Vite、Webpack、Express、Fastify。
4. 浏览器脚本继续是传统脚本，没有打包步骤。`src/server/app-server.js` 的 `staticFile` 按 URL 直接读 `app/` 下的文件。不要给 `<script>` 加 `type="module"`。不要把页面改成 ES module import。
5. 不要新增测试文件，不要改 `package.json` 的 `scripts.app`。当前入口是 `node src/server/app-server.js`。`scripts/app-server.js` 保持下面这 5 行，不要收成只剩一行 `require`，也不要把实现写回 `scripts/`。`node scripts/app-server.js` 靠 `launchCli(server.start)` 启动；删掉这一行后，这个入口不会监听端口。直接执行 `node src/server/app-server.js` 时，`src/server/app-server.js` 里的 `require.main === module` 才会成立，并走 `timedScript('service.app.start', start)`。

```js
'use strict';

const server = require('../src/server/app-server');
if (require.main === module) require('../src/automation/runtime').launchCli(server.start);
module.exports = server;
```
6. 不要执行业务脚本，不要点击云机，不要上传证书，不要改代理，不要重置设备，不要调用会改云端数据的接口。烟测只用本机回环上的只读请求和未登录请求。
7. 不要 `git commit`，除非用户在这份文档之外明确要求提交。
8. `parseVpcData` 在 `app-server.js` 顶部被 require，当前函数体内没有调用点。保留这行 require，不要当无用导入删掉。`require('../workflows/add-vpc-network')` 的加载副作用不在本次核实范围内。

## 目标

把三个超大文件拆成按职责放置的文件，外部行为与拆分前一致。

| 现在 | 行数 | 拆完后的样子 |
| --- | ---: | --- |
| `src/server/app-server.js` | 2332 | 只留进程启动、请求入口、按顺序调用路由函数。单文件目标不超过 400 行 |
| `app/app.js` | 3128 | 按加载顺序拆成多个传统脚本，`index.html` 按顺序引用。最后一行是裸调用 `init()` |
| `app/admin.js` | 2411 | 按后台页签拆成多个传统脚本，`admin.html` 按顺序引用。最后一段是 `window.toggleZhencanStatus` 的赋值 |

随后删除已经没有任何页面引用的重复壳。数据库仍是一个 SQLite 连接，方法可以分文件，类上的方法名不改。

## 依赖方向

服务端只允许下面这个方向。禁止路由文件回头 require `app-server.js`。

```text
flows/_common、workflows、automation、auth、sms、ai、brain
        ↑
http.js、context.js、script-catalog.js
        ↑
script-runner.js、routes/*.js
        ↑
src/server/app-server.js
        ↑
scripts/app-server.js
```

`getAuthService()` 和 `getAuthDb()` 已经是单例。路由里继续调用这两个函数，不要再 `new` 一套认证服务或再打开一个 SQLite 文件。

## 必须保持的进程出口

`src/server/app-server.js` 的导出保持为：

```js
module.exports = { start, createServer, SCRIPT_DEFINITIONS };
```

`SCRIPT_DEFINITIONS` 可以改成从 `script-catalog.js` 再导出，引用方拿到的仍是同一个冻结数组。运行时 `require` 这个模块的只有 `scripts/app-server.js`。`package.json` 的 `files` 里列出了 `scripts/app-server.js`，那不是 `require`，不要因此改 `package.json`。

`createServer()` 必须继续：

- 用 `http.createServer`，每个请求包在 `require('../automation/timing').detached(...)` 里。
- 调用 `attachManualControl(server, { allowedRequest, selectedDevice, client, busyDevices, redact, authService })`。这六个字段的含义不变。`busyDevices` 仍是原来的那个 `Set`。
- 把返回的 bridge 放进 `manualBridges`。
- `server.on('close', ...)` 里删除 bridge、关闭 brain、关闭手动连接、关闭截图。
- 设置 `server.closeManual`。

`start()` 必须继续：

- 先 `loadLocalEnv()`。
- 调用 `require('../automation/recognition-service').serviceCommand('start')`，成功和失败的日志文案不变。
- `HOST` 不是 `127.0.0.1`、`localhost`、`::1` 时抛出「测试控制台只允许绑定本机回环地址」。
- 端口来自 `YUNMOMO_APP_PORT`，缺省 `4318`。非法端口仍抛 `YUNMOMO_APP_PORT must be an integer between 1 and 65535`。
- 监听成功日志仍是 `Yunmomo local console: http://` 加 host 和 port。未配置令牌时的提示文案不变。
- 到期回收的 `setInterval(..., 10000).unref()` 今天写在模块顶层，`require` 到 `app-server.js` 就会启动，不在 `start()` 里面。搬到 `context.js` 后仍放在该文件顶层，不要挪进 `start()`。成功日志是 `` `[Sweeper] 云机 ${deviceId} 租期已到期，执行实时切断与回收` ``。失败是 `console.error('[Sweeper Error]', err.message)`。

## 必须保持的内存状态

这些对象继续全进程一份，放进 `src/server/context.js` 导出。不要在路由文件里再各建一份。`sharedOcrWorker` 不在这张表里，它只跟截图路由走，见下文。

| 名字 | 类型 | 用途 |
| --- | --- | --- |
| `runtimeToken` | 可空字符串 | 本进程新导入的云端会话，优先于环境变量和 `.env.local` |
| `localEnv` | 普通对象 | `.env.local` 解析结果 |
| `busyDevices` | `Set` | 正在跑脚本的设备 |
| `busyAccountScripts` | `Set` | 不绑定设备的账号级脚本 |
| `manualBridges` | `Set` | 手动控制桥 |
| `screenshotJobs` | `Map` | 同一设备进行中的截图 Promise |
| `activeScriptRuns` | `Map` | 进行中的脚本运行 |
| `pendingScriptStops` | `Map` | 进程还没起来就收到的停止请求 |
| `completedScriptRuns` | `Map` | 刚结束的运行编号，防止重复提交 |
| `deviceCache` | 可空 | 设备列表短缓存。命中条件在 `listDevices` 内，有效期是 `Date.now() + 2500` 毫秒，不是 3000 |
| `deviceListing` | 可空 | 同一 `client()` 正在进行的那一次列表请求。`listDevices` 返回这只 Promise。清空写在这只 Promise 的 `finally` 里，而且仅当 `deviceListing` 仍指向这一次的 listing 对象时才置空。不要在把 Promise 交出去的同时清空，否则并发调用合并不起来 |
| `sharedClient` | 可空 | 共享 `YunmomoClient` |
| `sharedBrainManager` | 可空 | 共享 `BrainManager` |

常量保持原值：`SCRIPT_STOP_INTENT_TTL_MS = 30000`，`SCRIPT_STOP_INTENT_MAX = 256`，`MAX_BODY_BYTES = 1024 * 1024`，`MAX_OUTPUT_BYTES = 120000`，`CLOUD_DISK_ROOT = <项目根>/storage/cloud-disk`。启动时仍创建 `真参` 和 `头像` 两个子目录，创建失败被空 `catch` 吃掉。

`activeRuns` 仍从 `ai-reply-routes` 解构，全进程共用导出的那一个 Map。鉴权门和 `POST /api/session` 都读它。不要把这个 Map 搬进 context 再复制一份。相对路径见阶段 4，不要把 `app-server.js` 里的 `./ai-reply-routes` 原样抄进 `routes/`。

`previewImage`、`getOcrWorker`、`inspectVision` 和 `sharedOcrWorker` 只放进 `routes/console-read.js`。`getOcrWorker()` 在工人不存在或 `closed` 时 `new RapidOcrWorker()`。不要在 `context.js` 再导出第二个工人。`screenshotJobs` 留在 `context.js`，`previewImage` 用同一个 `Map`。

## HTTP 行为合同

### 响应与页面

`json()` 的头保持为：`Content-Type: application/json; charset=utf-8`，`Cache-Control: no-store`，再叠加下面的安全头，调用方传入的头最后覆盖。

安全头原文保持为：

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: no-referrer`
- `Content-Security-Policy` 的 11 条指令保持现有字符串，包括 `script-src 'self' 'unsafe-inline'` 和 `style-src 'self' 'unsafe-inline'`。页面依赖内联样式和 `onclick`，收紧 CSP 会直接弄坏后台。

静态文件：

- `GET /` 返回 `app/index.html`。
- `GET /login` 和 `/login/` 返回 `login.html`。
- `GET /admin`、`/admin/`、`/admin/<任意页签>` 都返回 `admin.html`。页签由前端读路径，不要改成按路径返回不同 HTML。
- 路径含 `..` 或反斜杠返回 404，正文 `{ ok:false, error:'页面不存在' }`。
- 解析后的绝对路径必须仍落在 `app/` 目录内，否则 403 `{ ok:false, error:'非法路径' }`。
- 扩展名映射保持 `.css`、`.html`、`.js`、`.json`、`.svg`、`.ico` 现有 MIME。其余用 `application/octet-stream`。
- 静态响应带安全头和 `Cache-Control: no-cache`。

`allowedRequest` 保持：Host 只能是 `127.0.0.1`、`localhost`、`[::1]`，且不能带 userinfo；有 `Origin` 时必须和 Host 同源。失败返回 403 `{ ok:false, error:'仅允许本地控制台同源访问' }`。

`errorStatus` 整函数原样搬到 `http.js`。下面是今天的判断顺序，不要按“显式状态优先”重排，也不要改正则。前端把 401 当成登录失效。403 不能并进 401。改写被正则命中的文案会改掉状态码：

1. `error.status === 400` 时返回 400。
2. 文案匹配 `/正在执行脚本|手动控制/` 时返回 409。这一步在显式 401 和 403 之前。
3. `error.status === 401` 时返回 401。
4. `error.status === 403` 时返回 403。
5. 文案匹配 `/请选择|未知脚本|YUNMOMO_CERT_PATH|请求内容|请求 JSON|浏览器会话令牌|邮箱或密码不正确|卡密|验证码/` 时返回 400。
6. 文案匹配 `/YUNMOMO_TOKEN/` 时返回 401。
7. 其余返回 500。

显式 `error.status` 为 401 或 403 时，不会压过第 2 步的 409。

未处理异常仍返回 `{ ok:false, error:<脱敏后的 message> }`。`StreamScreenshotError` 额外带 `code`。有 `error.timing` 时原样展开。日志前缀 `API UNHANDLED` 和 `API REJECTED` 保持。

每个 `/api/` 请求在 `finish` 时打访问日志。日志行是 `` `${方法} ${authGuard.redact(url)} -> ${状态} (${耗时}ms) ${userTag}` ``。`userTag` 是 `[邮箱]` 或 `[guest]`。

下面两种情况整段跳过，既不写 console，也不写 `appendServerLog`：路径包含 `/api/client-logs` 或 `/api/server-logs`；未登录且状态是 401 或 403，并且路径以 `/api/devices`、`/api/cloud-disk`、`/api/user` 开头。

其余请求：

- 状态大于等于 500：`console.error('[API ERROR] ' + 日志行)`，并且 `appendServerLog('ERROR', 日志行)`。
- 其余状态大于等于 400：`console.warn('[API WARN] ' + 日志行)`，并且 `appendServerLog('WARN', 日志行)`。
- 2xx 和 3xx：只 `console.log('[API] ' + 日志行)`，不调用 `appendServerLog`。

传给 `appendServerLog` 的是上面这条日志行。函数内部还会再加 `[Server LEVEL] <ISO时间>`，不要把这层前缀提前写进日志行。

`redact` 继续先按当前令牌做全字替换，再把 `[?&]token=` 后面的值换成 `<redacted>`。

### Cookie

登录和注册成功时设置：

```text
ym_auth_token=<encodeURIComponent(token)>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800
```

登出和改密成功时清除：

```text
ym_auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0
```

不要改成 `Secure`、`Strict` 或缩短有效期。

### 路由顺序

第一个命中的分支返回。下面的顺序就是今天 `handler` 的顺序。拆成多个 `handleXxx(ctx, request, response, url)` 后，`app-server.js` 必须按这个顺序调用，某个函数返回 `true` 就结束。不要改成“后注册的覆盖先注册的”，也不要按路径字典排序。

1. `POST /api/auth/register`
2. `POST /api/auth/login`
3. `POST /api/auth/change-password`
4. `POST /api/auth/logout`
5. `GET /api/auth/me`
6. `POST /api/client-logs`
7. `GET /api/client-logs`
8. `GET /api/server-logs`
9. `POST /api/server-logs/clear`
10. `GET /api/user/devices`
11. `GET /api/user/assets`
12. `POST /api/user/redeem`
13. `GET /api/admin/users`
14. `POST /api/admin/users/status`
15. `GET /api/admin/cards`
16. `POST /api/admin/cards/generate`
17. `POST /api/admin/cards/revoke`
18. `GET /api/admin/pool`
19. `POST /api/admin/devices/recycle`
20. `GET /api/admin/ai-settings`
21. `POST /api/admin/ai-providers`
22. `POST /api/admin/ai-providers/<id>/set-default`
23. `DELETE /api/admin/ai-providers/<id>`
24. `POST /api/admin/ai-settings`
25. `POST /api/admin/ai-settings/test`
26. 前缀 `/api/admin/sms/` 的整块，块内顺序见下一节
27. 前缀 `/api/admin/scripts/` 的整块
28. 前缀 `/api/momo-brain/` 与 `/api/ai-reply/` 的鉴权门，通过后才调用现有的 `handleMomoBrainRoutes` / `handleAiReplyRoutes`
29. `GET /api/status`
30. `GET /api/runtime-state`
31. `GET /api/execute/output`
32. `GET /api/logs`
33. `GET /api/scripts`
34. `GET /api/devices`
35. `GET /api/vision-inspect`
36. `GET /api/screenshot`
37. `GET /api/cloud-disk/files`
38. `GET /api/cloud-disk/file`、`/api/cloud-disk/preview`、`/api/cloud-disk/download`
39. 其他 `GET /api/*` 返回 404 `{ ok:false, error:'API 不存在' }`
40. `POST /api/session`
41. `POST /api/execute`
42. `POST /api/execute/stop` 和 `POST /api/scripts/stop` 仍走同一个处理函数
43. `POST /api/cloud-disk/upload`，这一支的 JSON 上限是 `50 * 1024 * 1024`，不是默认的 1MiB
44. `POST /api/cloud-disk/delete`
45. `POST /api/cloud-disk/zhencan/toggle-status`
46. `POST /api/cloud-disk/send-to-device`
47. 其余非 GET 返回 405 `{ ok:false, error:'只支持 GET 和 POST' }`
48. 其余 GET 走静态文件

`GET /api/*` 的 404 今天写在第 39 步。它只匹配 GET，所以第 40 步之后的 POST 仍然可达。把 POST 挪到这个 404 前面或后面都可以，只要仍是独立的方法判断。不要写成“凡是 `/api/` 都先 404”。

### 各路由组里不能改的细节

认证组使用 `authGuard.inspect` / `registerFailure` / `registerSuccess`。429 正文保持 `尝试过于频繁，请 N 分钟后再试`，并带 `retryAfterSeconds` 和 `Retry-After` 头。`N` 的计算仍是 `Math.max(1, Math.ceil(waitSeconds / 60))`。

`GET /api/auth/me` 在未登录时返回 200 `{ ok:false, user:null }`，不是 401。已登录时用户对象展开 `zhencanBalance` 和 `ipStatus`。

`GET /api/status` 只返回 `ok`、`tokenConfigured`、`sessionSource`（`local-session`、`environment` 或 `none`）、`host`。不要返回 Cookie 或令牌。

`GET /api/scripts` 返回 `{ ok, scripts, bundles, visibility, isAdmin }`。`scripts` 就是 `SCRIPT_DEFINITIONS` 全量，不要在这里按可见性过滤。过滤在执行时由 `assertScriptVisibleToUser` 做，也在前端渲染时做。

`scriptById` 保持：精确匹配 id；若 id 匹配 `/^flow-0[1-9]$/` 则再找 `id + '-v3'`；仍没有则抛 `未知脚本`。`GET /api/runtime-state` 里现有的 `scriptById(...)?.title` 不要改成空值判断。`scriptById` 找不到时是抛错，可选链不会把抛错变成 `undefined`。

`POST /api/execute` 的成功 JSON 在 `executeScriptMeasured` 的返回值上追加 `runId`、`startedAt`、`finishedAt`、`durationMs`。失败对象挂 `error.timing` 后继续抛。返回字段至少包括 `ok`、`cancelled`、`scriptRunId`、`scriptId`、`title`、`selectedDevice`、`exitCode`、`stdout`、`stderr`、`logFile`。

`stopActiveScript` 整函数原样搬。它有四种返回，路由不能只实现最后一种：

- 非管理员停别人的运行：`{ ok:false, forbidden:true, message:'无权停止其他用户的脚本运行' }`。路由改成 403 `{ ok:false, error: message }`，不要把 `forbidden` 字段原样返回给浏览器。
- 有合法 `scriptRunId`、进程还没登记、且不在 `completedScriptRuns`：`{ ok:true, stopped:true, pending:true, scriptRunId, message:'停止请求已登记，启动中的脚本将直接取消' }`。
- 对不上运行：`{ ok:true, stopped:false, message: scriptRunId ? '当前没有正在执行的脚本' : '停止目标缺失或不唯一，未停止其他脚本' }`。
- 已经停掉：`{ ok:true, stopped:true, scriptRunId, scriptId, deviceId, message:'脚本进程已退出，设备占用已释放' }`。

脚本子进程保持：

- `spawn(process.execPath, [绝对路径, ...script.args], { cwd: 项目根, env: timing.childEnv(env), windowsHide: true, detached: 非 Windows, stdio: ['ignore','pipe','pipe'] })`。
- 日志目录 `logs/runs/<scriptRunId>.log`，文件头和文件尾的分隔线与字段名不变。
- stdout 和 stderr 各自截断到 `MAX_OUTPUT_BYTES`，截断后缀仍是 `\n[输出已截断]`。
- 设备互斥仍同时看 `busyDevices`、`defaultArbiter.isDeviceBusy`、手动桥 `isBusy`。占用文案仍是「该设备正在执行脚本或手动控制，请先关闭操作窗」。
- 传给子进程的环境变量名保持：`YUNMOMO_TOKEN`、`YUNMOMO_USER_ID`、`YUNMOMO_USER_ROLE`、`YUNMOMO_DEVICE_ID`、`YUNMOMO_UDID`、`YUNMOMO_SCRIPT_RUN_ID`、`YUNMOMO_CERT_PATH`、`YUNMOMO_SDK_VERSION`、`YUNMOMO_VERIFY_ONLY`，以及 `configureScript` 里按脚本 id 写入的 `YUNMOMO_REAL_PARAMS_FILE`、`YUNMOMO_VPC_DATA`、`YUNMOMO_PROXY_ACTION`、`YUNMOMO_LOCATION_MODE`、`YUNMOMO_LOCATION_ADDRESS`、`YUNMOMO_COUNTRY_CODE`、`YUNMOMO_ANDROID_VERSION`、`YUNMOMO_MOMO_*`、`YAYA_MODE`、`YAYA_TARGET_TIME`。
- `configureScript` 里每个 `script.id` 分支原样搬到 `script-runner.js`。不要把这些分支改成数据表驱动。`flow-03` 额外允许选项名 `vpcData`。`flow-14` 在缺少联系人或模式不是 `draft`/`execute` 时抛「执行 AI 回复前必须指定联系人，运行模式只能是 draft 或 execute」。`flow-09-v2` 这个分支只写 `YUNMOMO_SDK_VERSION = 'v2'`，不要加国家代码检查。其余 `script.id.startsWith('flow-09')` 才把 `options.countryCode` 缺省成 `CN`、转大写，并用 `/^[A-Z]{2}$/` 校验；不通过抛「国家代码应为CN、US等两位字母」。这一支同时写 `YUNMOMO_COUNTRY_CODE`、`YUNMOMO_ANDROID_VERSION`（缺省 `'16'`）和 `YUNMOMO_SDK_VERSION`（`script.version` 或 `'v3'`）。

可见性分组规则保持在 `assertScriptVisibleToUser`：管理员跳过；`visibility.scripts[id] === false` 拒绝；`category` 为 `v2` 或 `v3` 时组键就是 category，否则组键是 `momo`；`visibility.groups[组键] === false` 拒绝。这和 `app.js` 的 `createVersionSection` 一致，不要在搬移时“统一”成另一套组名。

云盘：

- `safeCloudDiskDir`：只有传入 `'头像'` 才是头像，其他任何值都落在 `真参`。
- 文件名一律 `path.basename` 后再用。
- 列表项字段保持 `name`、`size`、`sizeFormatted`、`mtime`、`ext`、`isImage`、`isText`、`previewInfo`、`zhencanStatus`。排序仍是 `mtime` 降序。大小格式仍是大于 1MiB 用 MB 两位小数，否则用 KB 一位小数。
- 真参预览仍只对 `.txt` 和 `.json` 调用 `extractDeviceInfo`，解析失败忽略。
- `GET` 文件、预览、下载返回原始字节，不是 JSON。响应头还有 `Content-Type`、`Content-Length`、`Cache-Control: public, max-age=3600`。下载额外带 `Content-Disposition: attachment; filename="<encodeURIComponent(name)>"`。不要改成 `no-store`，也不要套 `json()` 的安全头。头像文件本地不存在时的远端回源整段跟着处理函数走，不要按字段清单删掉。
- 下发真参仍调用 `extractDeviceInfo`，缺品牌或型号返回 400。成功后 `markZhencanFileUsed`。非管理员再 `consumeZhencanQuota(user, 1, ...)`。已使用且请求没有 `force` 时返回现有的长错误文案。
- 下发头像仍走 `c.cloudDisk().list` / `upload` / `sendToDevices([deviceId], [fileRecord], { fileType:'auto' })`。
- 其他目录返回 400 `{ ok:false, error:'不支持的目录类别' }`。

截图 `GET /api/screenshot` 继续返回图片字节，响应头只有这几项：`Content-Type`（来自结果，缺省 `image/jpeg`）、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`X-Screenshot-Source`、`X-Image-Width`、`X-Image-Height`、`X-Frame-Decoded-At`。这一支不要套用 `json()` 的安全头。同一 `deviceId` 已有进行中的 `screenshotJobs` 时返回同一个 Promise。`previewImage` 的调用参数保持 `source: 'stream'`、`maxSize: 1280`、`bitrate: 4194304`、`maxAgeMs: 400`、`timeoutMs: 15000`。

`POST /api/session` 仍仅管理员。令牌必须是不含 CR/LF、长度不超过 4096 的非空字符串。有脚本占用、仲裁锁、活动 AI 运行或 brain actor 时拒绝，文案不变。验证方式仍是 `new YunmomoClient({ token, timeoutMs: 12000 }).listDevices({ current:1, size:1 })`。成功后关闭全部手动桥和截图、关闭并清空 brain、`persistToken`、清 `deviceCache`，返回 `{ ok:true, tokenConfigured:true, storage:'local-env' }`。

短信块内部顺序保持：`GET config`、`POST config`、`POST test`、`GET projects`、`POST phone/get`、`POST code/get`、`POST record/status`、`GET records`、`GET logs`、`DELETE logs`、`DELETE records`。记录和日志的搜索词如果等于当前用户邮箱，仍把搜索词清空。这个比较是为了躲开浏览器自动填充。

AI 管理接口里的供应商 id 仍取 `pathname.split('/')[4]`。连通性测试仍先走 `urlGuard.assertSafeOutboundUrl`，`allowLoopback: true`，`allowPrivate` 仅当 `YUNMOMO_AI_ALLOW_PRIVATE` 去空白后等于 `'1'`。测试失败返回 200 且 `ok:false`，不要改成 4xx。

`/api/momo-brain/` 和 `/api/ai-reply/` 前面的鉴权门整段搬进 `routes/automation-gate.js`，不要塞进 `momo-brain-routes.js` 或 `ai-reply-routes.js`。那两个文件已经各自处理业务并返回 `true/false`。门禁要保留的判断：

- 未登录 401 `请先登录`。
- `deviceId` 只来自 JSON 体或查询串，先 trim。`process.env.YUNMOMO_DEVICE_ID` 只在 `actsOnDevice` 为真、并且这个 `deviceId` 为空时，才写进鉴权用的 `targetDevice`。其他路径不要用环境变量补设备号。
- `actsOnDevice` 只看 pathname，不看方法，共 7 条：`/api/momo-brain/start`、`/api/momo-brain/pause`、`/api/momo-brain/resume`、`/api/momo-brain/stop`、`/api/momo-brain/events`、`/api/momo-brain/status`、`/api/ai-reply/run`。
- 全局写仅管理员：`POST /api/momo-brain/config`、`POST /api/ai-reply/settings`、`POST /api/ai-reply/test`。聚合读也仅管理员：`GET /api/momo-brain/status` 和 `GET /api/momo-brain/config` 在原始 `deviceId` 为空时。这里用的是补环境变量之前的 `deviceId`。查询串没有设备号时，即使 `YUNMOMO_DEVICE_ID` 有值，这两支 GET 仍是管理员聚合读。
- `/api/ai-reply/runs/` 用 `pathname.split('/')[4]` 取 runId，再按 `activeRuns` 里的 `deviceId` 做 `canAccessDevice`。无权限文案是 `无该任务的访问权限`。设备无权时的文案是 `无该设备的访问权限`。

客户端日志写入仍把换行压成 ` | `，message 截 500，details 截 2000，避免伪造日志行。

## 脚本清单合同

`SCRIPT_DEFINITIONS` 原样搬到 `src/server/script-catalog.js`。构建方式保持：

- `const { STEPS: STEPS_V2 } = require('../../flows/v2/_common')`
- `const { STEPS: STEPS_V3 } = require('../../flows/v3/_common')`
- V2、V3 用现有的 `map` 生成条目，后面的手写条目（重置、全流程、MOMO 11 到 17、V3 全流程）逐字复制。
- 数组最后仍 `.map(Object.freeze)`，整个数组仍 `Object.freeze`。

禁止做的事：

- 不要改任何一个 `id`、`file`、`args`、`order`、`category`、`version`、`parameters`。
- 不要改参数 `defaultValue`。`flow-16` 和 `flow-17` 里的默认网名、时间、手机号、验证码都是现有行为，原样保留，不要写进新注释，不要替换成占位符。
- 不要改 `flows/v2/_common.js` 或 `flows/v3/_common.js`。
- 不要为了“消除重复”把 `app.js` 里的 `STEPS_META` 改成读这份清单。两套 id 本来就不同：页面进度用 `flow-01-import-cloud-disk` 这类本地 id，服务端执行用 `flow-01-v2`。进度存在 `localStorage` 键 `yunmomo.deviceProgress`，按数字 `order` 存状态。改 id 或改 order 会让用户浏览器里的进度对不上。

## 浏览器全局合同

页面之间靠全局函数协作。拆文件后，下面的赋值必须仍然存在，名字不变。

`index.html` 及其仍保留的预览页，在全部控制台脚本执行完之后必须能访问：

| 全局 | 谁在用 |
| --- | --- |
| `window.byId` | 控制台内部 |
| `window.state` | 控制台内部，也挂在 `YunMomo.state` |
| `window.elements` | 控制台内部的 DOM 代理 |
| `window.YunMomo` | `{ store, state, eventBus, api:{ requestJson, showToast, copyToClipboard } }` |
| `window.copyToClipboard` | 控制台 |
| `window.requestJson` | `ai-reply.js`、`momo-brain.js` 通过页面能力间接使用；必须仍挂到 `YunMomo.api` |
| `window.showToast` | `ai-reply.js`、`momo-brain.js`、`manual-control.js` 所在页面 |
| `window.currentDevice` | 设备与云盘相关调用 |
| `window.externalScriptForDevice` | 运行状态展示 |
| `window.selectDevice` | 设备卡 |
| `window.stopPreview` | 预览 |
| `window.requestAllPreviews` | 预览 |
| `window.getSelectedDeviceId` | `ai-reply.js`、`momo-brain.js` |
| `window.openManualControl` | `app.js` 设备卡调用，定义在 `manual-control.js` |
| `window.closeManualControl` | 手动窗 |
| `window.updatePreviewSize` | 尺寸滑块 |
| `window.CloudVideoPlayer` | 预览和解码，定义在 `video-player.js` |
| `window.AppLogger` | 定义在 `logger.js` |
| `window.alert` / `confirm` / `prompt` | `app.js` 和 `admin.js` 各自覆盖。两个页面不是同时加载的，各自文件里保留自己的覆盖 |

`admin.html` 的 HTML `onclick` 依赖这些全局，拆文件后必须仍挂在 `window` 上：`toggleUserStatus`、`copyCardCode`、`revokeCard`、`recycleDevice`、`selectAdminDiskFile`、`previewAdminDiskFile`、`deleteAdminDiskFile`、`sendAdminDiskFileToDevice`、`editAiProvider`、`setAiDefaultProvider`、`testAiProvider`、`deleteAiProvider`、`toggleLogDetail`、`toggleZhencanStatus`。

`localStorage` 键名一个字都不能改：

- `yunmomo.deviceProgress`
- `yunmomo.activeTab`
- `yunmomo.auth_token`
- `yunmomo.previewWidth`
- `yunmomo.collapse.momo`
- `yunmomo.collapse.v2` 和 `yunmomo.collapse.v3`。这两个键不是写死的字符串，而是 `` `yunmomo.collapse.${versionTag.toLowerCase()}` ``，`versionTag` 分别为 `V2` 和 `V3`
- 以及 `app.js`、`admin.js` 里其余 `localStorage` / `sessionStorage` 的键。动手前把两个文件里的键全部列出来，拆完再对一遍。

`index.html` 里的元素 id 不要改。`elements` 代理用 id 当属性名，例如 `elements.deviceGrid` 就是 `getElementById('deviceGrid')`。改 id 会让代理取到 `null`。

当前 `index.html` 的脚本顺序是：

```html
<script src="/logger.js"></script>
<script src="/video-player.js"></script>
<script src="/app.js"></script>
<script src="/manual-control.js"></script>
<script src="/ai-reply.js"></script>
<script src="/momo-brain.js"></script>
```

拆开 `app.js` 时，新脚本插在 `video-player.js` 和 `manual-control.js` 之间，相对顺序按下面阶段 5 的列表。`logger.js` 必须最先，因为它包装了 `fetch` 和 `WebSocket`。`manual-control.js`、`ai-reply.js`、`momo-brain.js` 必须在控制台脚本之后，因为它们在点击时调用 `showToast` 和 `getSelectedDeviceId`。

`preview-b.html` 的脚本顺序和 `index.html` 相同，包含 `logger.js`。`preview-a.html` 没有 `logger.js`，从 `video-player.js` 开始。阶段 5 只把这两个文件里的 `/app.js` 换成新的 `console/*.js` 序列，不要给 `preview-a.html` 补上 `logger.js`。阶段 7 会删掉这两个预览页。运行时只有 `preview-a.html` 有 `href="/preview-b.html"`，`preview-b.html` 没有指回 `preview-a.html`。`index.html`、`admin.html`、`login.html` 都不指向它们。不要因为找不到反向链接就留下 `preview-b.html`。

不要给这些脚本加 `defer` 或 `async`。现在它们按文档顺序同步执行，后面的文件能在用户点击前看到前面文件挂上的全局。

## 明确不做

- 不把 `STEPS_META` 和服务端脚本 id 对齐。
- 不把 `theme-b.css` 拆开或改视觉。`theme-b.css` 约 2700 行，是 `index.html` 和 `admin.html` 正在引用的样式。
- 不把 HTML 里的内联 `style` 抽成类。那是另一轮视觉重构。
- 不把 `auth/service.js` 的登录、卡密、兑换算法拆开。本次只允许数据库查询函数下沉，服务层方法签名不变。
- 不修改 `src/server/manual-control.js`、`video-stream.js`、`device-arbiter.js`、`ai-reply-routes.js`、`momo-brain-routes.js` 的对外行为。允许 `app-server.js` 改调用方式，但那两个 route 文件的 `handleXxx(req, res, urlObj, bodyJson, fifth)` 签名保持。
- 不修改 `login.html` 里的内联脚本，除非烟测证明静态路径被拆坏。登录页只引用 `logger.js`。
- 不把 `app/cloud-disk.js` 接回 `admin.html`。它的 DOM 合同是 `window.CloudDisk`，和后台页签不是同一套标记。阶段 7 删除这个无人引用的文件，云盘功能以 `admin.js` 里的实现为准。

## 阶段 0：记录基线，不改行为

1. 对下面每个文件执行 `node --check`，全部通过才继续：
   - `src/server/app-server.js`
   - `src/server/ai-reply-routes.js`
   - `src/server/momo-brain-routes.js`
   - `src/server/manual-control.js`
   - `src/server/video-stream.js`
   - `src/server/device-arbiter.js`
   - `src/server/auth/db.js`
   - `src/server/auth/service.js`
   - `src/server/auth/guard.js`
   - `src/server/auth/captcha.js`
   - `src/server/sms/service.js`
   - `src/server/sms/xuanwu-client.js`
   - `scripts/app-server.js`
   - `app` 目录下每个 `.js`
2. 把 `module.exports`、`SCRIPT_DEFINITIONS` 的 id 列表、上面的路由清单抄进阶段笔记。后续每阶段对比这份笔记。
3. 若 4318 已有进程，不要杀它，也不要占用它。烟测用别的端口。

本阶段不产生功能差异。语法检查有失败就停止并把失败文件写进报告，不要为了让检查通过去改业务文件。

## 阶段 1：抽出 HTTP 工具

新建 `src/server/http.js`，从 `app-server.js` 原样移入：

- `SECURITY_HEADERS`
- `json`
- `readJsonBody`
- `staticFile` 及其路径规则
- `errorStatus`
- `allowedRequest`
- `redact`
- `MIME_TYPES`
- `appendServerLog`。它会先拼上 `[Server LEVEL] <ISO时间>` 再调用 `appendLogLine`，整函数搬走，不要改成只转发原文

`staticFile`、`redact`、`appendServerLog` 需要项目根、`activeToken` 或日志路径时，从 `context.js` 读取，不要把这些函数留在 `app-server.js` 再复制一份。

`app-server.js` 改为调用 `http.js`。行为差异应为零。

验收：阶段 0 的全部 `node --check` 仍通过。用下面的烟测命令，把 `PORT` 换成一个没被占用的端口。不要对这个进程发 `/api/execute`。

```powershell
$env:YUNMOMO_APP_PORT = '4391'
node src/server/app-server.js
```

另开一个壳：

```powershell
$base = 'http://127.0.0.1:4391'
(Invoke-WebRequest "$base/" -UseBasicParsing).StatusCode
(Invoke-WebRequest "$base/admin/users" -UseBasicParsing).StatusCode
(Invoke-WebRequest "$base/theme-b.css" -UseBasicParsing).Headers['Content-Type']
(Invoke-WebRequest "$base/api/status" -UseBasicParsing).Content
try { Invoke-WebRequest "$base/api/devices" -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
try { Invoke-WebRequest "$base/api/no-such-route" -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
try { Invoke-WebRequest "$base/api/no-such-route" -Method POST -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

期望：

- `/` 和 `/admin/users` 都是 200，后者的正文仍是 `admin.html` 的内容，不是 JSON。
- `theme-b.css` 的类型含 `text/css`。
- `/api/status` 是 JSON，含 `tokenConfigured` 和 `sessionSource`，不含令牌字符串。
- 未登录 `GET /api/devices` 是 401。
- 未知 `GET /api/no-such-route` 是 404，正文错误是 `API 不存在`。
- 未知 `POST /api/no-such-route` 是 405，正文错误是 `只支持 GET 和 POST`。

测完结束这个临时进程。不要结束用户原来的 4318 进程。

## 阶段 2：抽出运行上下文和脚本清单

新建：

- `src/server/context.js`：上一节的内存状态，以及 `client()`、`listDevices()`、`selectedDevice()`、`extractHost()`、`resolveDeviceProxy()`、`brainManager()`、`activeToken()`、`loadLocalEnv()`、`persistToken()`、`parseLocalEnv()`、`configuredValue()`、`quoteEnvValue()`、`portValue()`、`publicDevice()`、`deviceIdOf()`、`deviceNameOf()`、到期 `setInterval`。`extractHost` 和 `resolveDeviceProxy` 只被 `listDevices` 使用，必须和它进同一个文件。`deviceListing` 也留在这个文件。到期 `setInterval` 放在这个文件顶层。不要把 `previewImage`、`getOcrWorker`、`inspectVision`、`sharedOcrWorker` 放进这个文件。
- `src/server/script-catalog.js`：`SCRIPT_DEFINITIONS` 和 `scriptById`。

`context.js` 禁止 require 任何 `routes/`、`script-runner.js` 或 `http.js`。`http.js` 可以 require `context.js` 来取令牌和项目根。不要两边互相 require。

`client()` 的创建参数、令牌优先级保持：本进程 `runtimeToken`，否则 `YUNMOMO_TOKEN` 环境变量，否则 `.env.local`。现有代码在 `activeToken()` 和 `configuredValue()` 里，搬移时对着函数体抄，不要凭记忆重排优先级。

`listDevices()` 整函数搬走。缓存写的是 `expires: Date.now() + 2500`，不要改成 3000。前端另有 3000 毫秒轮询设备、1500 毫秒轮询运行状态，那是 `app.js` 末尾的两个 `setInterval`，和这份服务端缓存不是同一个数。函数里对空列表回退到 `getActiveAllocatedDeviceIds()`、再逐台 `getDevice` 的分支也原样保留。`client()` 仍是 `new YunmomoClient({ token, timeoutMs: 100000 })`，令牌变了才丢掉旧实例并 `closeScreenshots()`。

验收：再次 `node --check`。重复阶段 1 的烟测。再确认：

```powershell
node -e "const s=require('./src/server/app-server'); const ids=s.SCRIPT_DEFINITIONS.map(x=>x.id); console.log(ids.join('\n')); console.log('count', ids.length)"
```

id 列表和数量必须与阶段 0 笔记一致。`start` 和 `createServer` 仍是函数。

## 阶段 3：抽出脚本运行器

新建 `src/server/script-runner.js`，原样移入：

- `appendOutput`
- `createScriptRunRecord`
- `runOwnerFilePath`、`writeRunOwner`、`readRunOwner`
- `pruneScriptStopState`、`rememberScriptRun`、`settleScriptChild`
- `runTaskkill`、`signalProcessGroup`、`terminateScriptProcess`
- `runScript`、`runScriptMeasured`
- `stopActiveScript`
- `executeScript`、`executeScriptMeasured`
- `invalidOptions`
- `assertScriptVisibleToUser`
- `configureScript`

这个文件 require `script-catalog.js`、`context.js`、`./device-arbiter` 的 `defaultArbiter`、`../automation/timing`。它需要 `manualBridges` 时从 context 取同一个 `Set`。

不要在这个阶段把运行器改成队列或加超时。Windows 上 `taskkill` 和工作组信号的分支原样保留。

验收：`node --check src/server/script-runner.js` 和 `app-server.js`。不要发 `POST /api/execute`。可以用未登录请求确认该路由仍是 401 而不是 404：

```powershell
try { Invoke-WebRequest 'http://127.0.0.1:4391/api/execute' -Method POST -Body '{}' -ContentType 'application/json' -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

期望 401，错误文案 `请先登录`。临时端口上的进程如果已经停了，先按阶段 1 的方式再启动。

## 阶段 4：按路由组拆 handler

新建目录 `src/server/routes/`。每个文件导出一个函数，命中并已写出响应时返回 `true`，未命中返回 `false`。函数签名统一为：

```js
function handleAuthRoutes(ctx, request, response, url) { /* ... */ }
module.exports = { handleAuthRoutes };
```

`ctx` 只放本请求的数据：`user`、`authClientIp`，以及对 `http.js` / `context.js` 函数的引用。不要把 `request` 存进全局。

从 `src/server/app-server.js` 搬进 `src/server/routes/*.js` 时，目录深了一层。不要把原来的 `../` 或 `./` 原样抄进去。

| 原来在 `app-server.js` | 在 `routes/*.js` 里写成 |
| --- | --- |
| `../ai/config`、`../ai/provider` | `../../ai/config`、`../../ai/provider`。仍放在处理函数内部，不要提前到文件顶部 |
| `../automation/url-guard` | `../../automation/url-guard`。只有 AI 连通性测试用 |
| `../automation/ocr` | `../../automation/ocr`。只有 `console-read.js` 用 |
| `../workflows/v2/import-real-params` | `../../workflows/v2/import-real-params`。只有 `cloud-disk.js` 用 |
| `./momo-brain-routes`、`./ai-reply-routes` | `../momo-brain-routes`、`../ai-reply-routes`。`activeRuns` 也从后者解构。`routes/session.js` 用的是同一个 Map |
| `../index`（`YunmomoClient`） | `../../index` |
| `./auth/service`、`./sms/service`、`./auth/guard` | `../auth/service`、`../sms/service`、`../auth/guard` |
| `../brain/manager` | 路由文件里如果要直接引用，写成 `../../brain/manager`。现在只有 `brainManager()` 用到它，优先继续从 `context.js` 取 |

留在 `src/server/` 这一层的文件不要多加 `../`：`script-catalog.js` 仍是 `../../flows/v2/_common` 和 `../../flows/v3/_common`；`script-runner.js` 仍是 `./device-arbiter` 和 `../automation/timing`；`http.js`、`context.js` 里的 `../automation/`、`../brain/manager`、`../index` 与现在 `app-server.js` 相同。`require('../workflows/add-vpc-network')` 只留在 `app-server.js` 顶部，和现在一样。不要删，不要复制到第二个文件，也不要放进 `routes/`。

建议文件和它们承接的序号：

| 文件 | 承接 |
| --- | --- |
| `routes/auth.js` | 1 到 5，以及这些路由用到的 429 帮助函数 |
| `routes/logs.js` | 6 到 9 |
| `routes/user.js` | 10 到 12 |
| `routes/admin-users.js` | 13、14 |
| `routes/admin-cards.js` | 15 到 17 |
| `routes/admin-pool.js` | 18、19。回收设备时仍遍历 `manualBridges` 并调用 `closeDevice` |
| `routes/admin-ai.js` | 20 到 25。继续在函数内部 require，路径是 `../../ai/config` 和 `../../ai/provider`，不要改成文件顶部提前加载，也不要留着 `../ai/config` |
| `routes/admin-sms.js` | 26。内部仍 `getSmsService()` |
| `routes/admin-scripts.js` | 27。仍直接调用 `authService.db` 的可见性和组合方法 |
| `routes/automation-gate.js` | 28。内部再调用现有的 `handleMomoBrainRoutes` 和 `handleAiReplyRoutes` |
| `routes/console-read.js` | 29 到 36，外加 `previewImage`、`getOcrWorker`、`inspectVision` 和 `sharedOcrWorker`。这个文件只处理表里的路径，未命中返回 `false`，不要在这里把剩余的 `GET /api/*` 写成 404 |
| `routes/session.js` | 40 |
| `routes/execute.js` | 41、42。内部调用 script-runner |
| `routes/cloud-disk.js` | 37、38、43 到 46，外加 `safeCloudDiskDir` 和 `getCloudDiskFiles`。分发时先在第 37 步调用它处理 GET；第 39 步才允许返回「API 不存在」。POST 可以在第 43 步再调用同一个函数。如果只在第 43 步调用一次，`GET /api/cloud-disk/files` 会先被第 39 步吃掉 |

`app-server.js` 的 `handler` 留下：访问日志的 `finish` 回调、`allowedRequest`、解析 URL、`currentUser = authService.getUserFromRequest(request)`、按上表顺序调用、未命中时的 405 和静态文件、最外层 `catch`。

`requireAdmin` 今天定义在 `handler` 里面，闭包了本次 `user`。搬到各路由后，每个需要它的文件从 `ctx.user` 判断，状态码和文案仍是 403 `无管理员访问权限`。未登录也是这句 403，不要改成 401。不要改成抛异常再被外层转成 500。现有管理接口和云盘写接口都是先 `requireAdmin`，通过后才 `readJsonBody`。保持这个顺序，未登录时不要先读请求体。

验收：

1. 全部新建路由文件 `node --check`。
2. 重复阶段 1 的 7 个 HTTP 断言。
3. 未登录断言。状态码按下面的表，不要为了统一成 401 去改 `requireAdmin`：
   - `POST /api/auth/change-password` 体 `{}`：401，正文含 `请先登录`
   - `GET /api/auth/me`：200，`user` 为 `null`
   - `GET /api/user/devices`：401
   - `GET /api/scripts`：401
   - `GET /api/runtime-state`：401
   - `POST /api/execute` 体 `{}`：401，正文 `请先登录`
   - `POST /api/cloud-disk/delete` 体 `{}`：403，正文 `无管理员访问权限`。上传、改真参状态、下发到云机这三支未登录同样是 403
4. `GET /api/screenshot` 不带 `deviceId` 时，未登录应是 403 `无权查看此设备画面或该设备已到期回收`。条件是 `!user || !canAccessDevice(...)`，`!user` 会先短路。不要先报缺参数，不要改成 400 或 401。`GET /api/vision-inspect` 在没有 `deviceId` 时先抛 `缺少 deviceId 参数`。这句文案不匹配 `errorStatus` 的 400 正则，现在走 500。不要改成截图那条 403，也不要把这句补进 400 正则。
5. 抽查 `app-server.js` 里不再存在第二份 `SCRIPT_DEFINITIONS` 数组字面量。

本阶段结束时，`handler` 里不应再留下超过一个屏幕的业务分支。若某个路由组搬过去后返回值不稳定，停在这一阶段修返回值，不要进入前端。

## 阶段 5：拆 `app/app.js`

先读完整文件，列出每个顶层函数，再按下面的文件切开。每个新文件第一行是 `'use strict';`。不要包一层 IIFE，否则函数出不了文件。跨文件使用的函数在定义文件末尾赋给 `window`。同一文件内部继续直接调用函数名。

加载顺序，插在 `video-player.js` 之后、`manual-control.js` 之前：

1. `app/console/state.js`  
   文件顶部就是现在 `app.js` 开头对 `window.alert`、`window.confirm`、`window.prompt` 的覆盖。其后是 `escapeHtml`、`createPageId`、`isCurrentUserAdmin`、`isScriptManageMode`、`state` 对象、`byId`、`elements` 代理、`window.byId`、`window.state`、`window.elements`。`YunMomo` 对象可以在这里创建，但 `api.requestJson`、`api.showToast`、`api.copyToClipboard` 先留空，在最后一个控制台文件里赋值。`state` 的字段一个不要少，包括 `deviceProgress` 的初始化读取。
2. `app/console/progress.js`  
   `STEPS_META`、`STATUS_LABELS`、进度读写、迷你步进、流水线渲染。`STEPS_META` 的 8 条原样复制，包含 `order: 2.1`。V2 隐藏 order 8、非 V2 隐藏 order 2.1 的过滤留在原函数里。
3. `app/console/net.js`  
   `requestJson`、`copyToClipboard`、`fallbackCopy`、`showToast`、`showInPageConfirm`。末尾设置 `window.requestJson`、`window.copyToClipboard`、`window.showToast`。
4. `app/console/devices.js`  
   设备卡、网格、预览订阅、`selectDevice`、`currentDevice`、`isOnline`、`shortDeviceId`、`deviceLabel`。末尾设置 `window.currentDevice`、`window.selectDevice`、`window.stopPreview`、`window.requestAllPreviews`、`window.getSelectedDeviceId`。打开手动窗仍调用 `window.openManualControl`，不要把 `manual-control.js` 的函数体搬进来。
5. `app/console/runtime.js`  
   共享运行状态轮询、脚本按钮状态、输出框、`writeOutput`、`cleanScriptLines`。
6. `app/console/scripts.js`  
   脚本卡片、分组、可见性、`renderScripts`、`executeScript`、`executeSingleStep`、`stopRunningScript`、VPC 对话框。分组规则保持：v2、v3、momo、batch。`createVersionSection` 的组键仍由调用方传入 `'v2'` 和 `'v3'`。
7. `app/console/bundles.js`  
   组合卡片、模态框、`executeScriptBundle`、`stopRunningBundle`、保存和删除。
8. `app/console/session.js`  
   登录检查、兑换、改密、退出、页签、`loadStatus`、`init`。文件末尾保持现在的顶层语句，不要改包进 `DOMContentLoaded`：`setInterval(loadSharedRuntimeState, 1500)`、每 3000 毫秒且 `state.tokenConfigured` 时 `loadDevices(true)`、`visibilitychange` 监听、最后裸调用 `init()`。在这些语句之前给 `window.YunMomo.api` 填上三个函数，并设置 `window.externalScriptForDevice`。`init` 内部顺序保持：`initTabs`、`initTerminalTabs`、`initBundleModalEvents`、`checkAuth`、`loadStatus`、`loadScripts`、按需 `loadDevices`、`renderPipelineStepper`、`loadSharedRuntimeState`。

切分规则：

- 原文件中的函数体不要改写。只允许把一个函数从旧文件剪到新文件。
- 原来靠同一文件函数声明提升才能在前面调用的函数，剪到后面的文件之后，前面的文件必须改成运行时调用 `window.xxx`。点击回调属于运行时，只要脚本顺序正确就安全。文件顶层立刻执行的调用必须仍能解析到函数。
- `window.alert` 的覆盖放在 `state.js` 顶部。覆盖函数里写的是 `typeof showToast === 'function'`，不是 `window.showToast`。`showToast` 必须仍是 `net.js` 里的顶层函数名，再赋给 `window.showToast`。只挂到 `window` 上、不留下这个函数名时，拦截后的 alert 只会打 `console.warn`。`session.js` 仍在 `manual-control.js` 之前加载。
- 同一页面上的传统脚本共享全局词法环境。顶层 `const` 和 `let` 每个名字只能出现一次，第二个脚本再声明同名绑定会在页面加载时抛 `SyntaxError`。顶层 `function` 则全页面可见，但只在定义它的脚本执行完之后才能调用。不要把同一份 `state` 再声明一遍。
- `app.js` 里 69 个顶层函数都要进入且只进入一个新文件，一个都不能剩在已删除的 `app.js` 里，也不能复制成两份。跟着函数走的顶层 `let` 也只留一份：`toastTimer` 跟 `showToast`，`sharedStateLoading` 跟 `loadSharedRuntimeState`，`isDevicesLoading` 跟 `loadDevices`，`editingBundleSteps` 跟组合模态框。`window.copyToClipboard = copyToClipboard` 今天写了两次，拆完只在 `net.js` 留一次。
- 拆完后删除 `app/app.js`。不要留一个会和新文件重复声明 `const state` 的壳。
- `preview-b.html` 若还在，只替换其中的 `/app.js`。`preview-a.html` 同样只替换 `/app.js`，不要新增 `/logger.js`。

验收：

1. `app/console/*.js` 全部 `node --check`。浏览器脚本没有 `require` 时，`node --check` 只验证语法，这是对的。
2. `index.html` 不再引用 `/app.js`，并且 8 个新脚本的顺序与上面一致。
3. 临时端口打开 `/`。页面标题仍是 `momo全托管`，文档里仍有 `deviceGrid`、`scriptList`、`pipelineStepper`。
4. 用浏览器工具打开 `http://127.0.0.1:<临时端口>/`。未登录时应进入现有的登录或会话未就绪状态，而不是白屏或控制台报 `showToast is not defined`、`state is not defined`。打开开发者工具，确认没有语法错误。不要登录后去点脚本执行。
5. 若环境里没有浏览器工具，用静态断言代替，并在报告里写明没做浏览器点击：
   - `index.html` 包含按顺序排列的新脚本。
   - 每个 `window.xxx =` 合同都能在 `app/console` 里 grep 到。
   - `STEPS_META` 仍只有一份，内容与拆分前一致。

## 阶段 6：拆 `app/admin.js`

`admin.html` 目前在正文后依次加载 `logger.js` 和 `admin.js`。把 `admin.js` 拆成下面的文件，插在 `logger.js` 之后，保持这个顺序：

1. `app/admin/base.js`：`escapeHtml`、`showToast`、`showConfirm`、`formatDate`、`formatRemaining`、`debounce`、`checkAuth`、`switchTab`、`getTabFromUrl`、`alert`/`confirm`/`prompt` 覆盖、退出登录按钮、修改密码对话框及其监听、`navItems` 的点击监听。`debounce` 必须是这个文件里的 `function debounce`。`sms.js` 的输入监听按函数名调用它，不要写成文件私有的 `const debounce`。改密和退出不要放进 `boot.js`。
2. `app/admin/users.js`：用户列表和 `window.toggleUserStatus`。
3. `app/admin/cards.js`：卡密、`window.copyCardCode`、`window.revokeCard`，以及现有的 `copyToClipboard` 函数。这个函数没有挂到 `window`，不要补挂。
4. `app/admin/pool.js`：设备池、`window.recycleDevice`。
5. `app/admin/logs.js`：系统日志、`window.toggleLogDetail`。
6. `app/admin/disk.js`：后台云盘页签的全部函数，包括 `window.selectAdminDiskFile`、`previewAdminDiskFile`、`deleteAdminDiskFile`、`sendAdminDiskFileToDevice`、`toggleZhencanStatus`。逻辑从现有 `admin.js` 剪出来，不要改用 `app/cloud-disk.js`。
7. `app/admin/ai.js`：供应商表格和模态框，以及四个 `window` 上的 AI 函数。
8. `app/admin/sms.js`：短信配置、记录、日志。
9. `app/admin/boot.js`：只放现在文件末尾这三句，不要改成 `DOMContentLoaded`，不要给 `checkAuth()` 加 `await`，也不要提前到其他文件：

```js
checkAuth();
const initialTab = getTabFromUrl();
switchTab(initialTab, { updateHistory: false });
```

`window.toggleZhencanStatus` 放在 `disk.js`。它今天写在这三句之后。拆开后由脚本顺序提前赋值。`checkAuth` 和 `switchTab` 不会调用它。

`admin.js` 的顶层 `const` 和 `let` 分布在整个文件，不只在最上面。包括 `currentUser`、`currentTab`、`TAB_CONFIG`、第 310 行附近的改密节点、第 2023 行附近的短信节点，以及各页签中间的 DOM 查询和 `addEventListener`。这些不是函数内部变量。拆开后仍放在对应页签文件的顶层，每个名字只声明一次。监听只注册一次，不要在 `boot.js` 里再绑一遍。`popstate` 监听留在 `base.js`。`switchTab` 在运行时调用 `loadUsers`、`loadCards`、`loadPool`、`loadAdminDisk`、`loadAdminAiSettings`、`loadSmsManagement`、`fetchServerLogs` 等后加载文件里的函数，调用保持函数名，不要把函数体搬进 `base.js`。

`admin.html` 里大段 `<style>` 不动。页签 `data-tab` 保持 `cluster`、`users`、`cards`、`pool`、`disk`、`ai`、`logs`、`sms`。对应区块 id 保持 `tab-cluster`、`tab-users`、`tab-cards`、`tab-pool`、`tab-disk`、`tab-logs`、`tab-ai`、`tab-sms`。

删除 `app/admin.js`，避免和拆分文件同时执行两套 `switchTab`。

验收：

1. 新文件 `node --check`。
2. `GET /admin/disk` 仍返回 200 和 `admin.html`。
3. 浏览器打开 `/admin/users`。未登录时应被现有 `checkAuth` 送到登录流程，控制台没有重复声明错误。不要创建用户、不要生成卡密、不要回收设备。
4. grep 确认这 14 个 `window` 函数都还在 `app/admin/` 下，一个不能少：`toggleUserStatus`、`copyCardCode`、`revokeCard`、`recycleDevice`、`selectAdminDiskFile`、`previewAdminDiskFile`、`deleteAdminDiskFile`、`sendAdminDiskFileToDevice`、`editAiProvider`、`setAiDefaultProvider`、`testAiProvider`、`deleteAiProvider`、`toggleLogDetail`、`toggleZhencanStatus`。

## 阶段 7：删除无人引用的重复壳

只有前 6 个阶段都通过之后才做。每一项删除前都要全仓库搜索，搜索范围包含 `app/`、`src/`、`scripts/`、`docs/`。文档里的提及不是运行时引用。运行时引用是 HTML、JS、CSS 的 `href`、`src` 或 `url(`。

可以删除的条件：

| 文件 | 删除条件 |
| --- | --- |
| `app/cloud-disk.js` | 没有任何 HTML 的 script src 指向它，且 `admin/disk.js` 已包含原 `admin.js` 的云盘行为 |
| `app/styles.css` | 没有任何 HTML 或 CSS `@import` 指向它。今天 `index.html` 和 `admin.html` 引用的是 `theme-b.css` |
| `app/preview-a.html` 和 `app/preview-b.html` | 一起删除。运行时只有 `preview-a.html` 指向 `/preview-b.html`，没有反向链接。`index.html`、`admin.html`、`login.html` 都不指向它们。这条单向链接不是留下 `preview-b.html` 的理由 |
| `app/theme-a.css` | 只被 `preview-a.html` 引用，且该预览页已删 |

不要删除 `theme-b.css`、`login.html`、`index.html`、`admin.html`。

如果搜索发现 `package.json` 的 `files` 只包含整个 `app/` 目录，删除这些文件不需要改 `package.json`。

删除后更新 `docs/APP.md` 里「画面与接口」表格的那一行。今天它写成 `app/styles.css` 和 `app/console.css`。`app/console.css` 在 `app/` 目录中不存在。把这一行改成实际入口：`app/index.html`、`app/theme-b.css`、`app/console/` 下的脚本、`app/video-player.js`、`app/manual-control.js`。不要重写 `APP.md` 的其他段落。

在 `docs/README.md` 的「开发维护」下加入本文件的链接，锚文本用「控制台框架重构安排」。如果阶段 7 开始时链接已经在，不要重复加。

验收：再跑阶段 1 的静态烟测。`GET /theme-b.css` 仍是 200。`GET /styles.css` 和 `GET /preview-a.html` 应是 404 JSON `页面不存在`。`GET /` 仍是控制台 HTML。

## 阶段 8：拆数据库查询，保留一个连接

`src/server/auth/db.js` 的 `AuthDatabase` 有 50 个查询方法，再加 `constructor` 和 `initSchema`。下表就是这 50 个，一个不要漏。它们共用一个 `node:sqlite` 的 `DatabaseSync`、一份 `initSchema()` SQL、一个 `sharedDb`。

做法：

1. `initSchema()` 的 SQL 文本留在 `db.js`，不要拆进多个文件各建一次表。
2. 按下面分组把方法体移到新文件。新文件导出普通函数，第一个参数是 `this.db`。
3. `AuthDatabase` 上保留同名方法，方法体只转调新函数。`auth/service.js` 继续写 `this.db.listUsers()` 这种调用，不要改服务层。

分组：

| 新文件 | 方法 |
| --- | --- |
| `auth/db-config.js` | `getConfig`、`setConfig` |
| `auth/db-users.js` | `getUserByEmail`、`getUserById`、`createUser`、`listUsers`、`updateUserStatus`、`updateUserPassword`、`bumpUserTokenVersion`、`countAdmins` |
| `auth/db-cards.js` | `createCards`、`getCardByCode`、`getCardById`、`markCardUsed`、`revokeCard`、`listCards` |
| `auth/db-zhencan.js` | `addZhencanQuota`、`getUserZhencanBalance`、`consumeZhencanQuota`、`getZhencanFileRecord`、`getAllZhencanRecords`、`markZhencanFileUsed`、`setZhencanFileStatus` |
| `auth/db-allocations.js` | `addOrExtendIp`、`getUserIpStatus`、`createRedemptionLog`、`getUserAssets`、`createAllocation`、`getAllocationById`、`getActiveAllocationsForUser`、`getAllActiveAllocations`、`getActiveAllocatedDeviceIds`、`expireAndRecycleDevices`、`recycleAllocationManually` |
| `auth/db-sms.js` | `createSmsRecord`、`updateSmsRecord`、`getSmsRecordById`、`getSmsRecordBySession`、`listSmsRecords`、`clearSmsRecords`、`getSmsStats`、`createSmsCallLog`、`getSmsCallLogById`、`listSmsCallLogs`、`clearSmsCallLogs` |
| `auth/db-script-config.js` | `getScriptVisibility`、`setScriptVisibility`、`getScriptBundles`、`saveScriptBundle`、`deleteScriptBundle` |

禁止打开第二个数据库文件，禁止把 `getAuthDb()` 改成每次 `new AuthDatabase()`。`PRAGMA foreign_keys = ON` 和 `PRAGMA journal_mode = WAL` 仍在构造函数里各执行一次。

抽出的函数第一参数是 `this.db` 之后，函数体里不能再写 `this.getXxx()`。同文件里的互调改成直接调用本文件导出的函数，并把同一个 `db` 传进去。跨文件的互调也这样：

- `createUser`、`updateUserStatus`、`updateUserPassword` 现在返回 `this.getUserById(id)`。
- `getUserAssets` 现在调用 `this.getUserZhencanBalance`、`this.getUserIpStatus`、`this.getActiveAllocationsForUser`。真参余额在 `db-zhencan.js`，另外两个在 `db-allocations.js`。
- `createAllocation` 现在返回 `this.getAllocationById(id)`。
- 短信写入和更新现在返回 `this.getSmsRecordById` 或 `this.getSmsCallLogById`。
- `getScriptVisibility`、`setScriptVisibility`、`getScriptBundles`、`saveScriptBundle`、`deleteScriptBundle` 现在调用 `this.getConfig`、`this.setConfig` 或彼此。配置读写用 `db-config.js` 导出的函数，不要在脚本配置文件里再写一套 SQL。可见性缺省对象的 `groups` 是 `v2`、`v3`、`momo`、`custom` 四个键，值都是 `true`。不要删 `custom`。

SQL 字符串、字段名、默认值原样剪切。`escapeLikePattern`、`normalizeLimit`、`normalizeOffset` 留在 `db.js` 并导出，只有 `listCards` 调用它们。`LIST_DEFAULT_LIMIT` 是 200，`LIST_MAX_LIMIT` 是 1000，两个常量留在 `db.js`。不要把 200 写进短信列表。`listSmsRecords` 和 `listSmsCallLogs` 自己的默认 `limit` 是 50。

验收：`node --check` 覆盖 `src/server/auth/*.js`。不要调用注册、登录、生成卡密或兑换。可以用临时端口确认进程仍能启动，`GET /api/status` 仍返回 JSON。启动会执行 `initDefaultAdmin()` 和 `initSchema()`，这是现有行为，允许发生在本机 `.runtime/auth-system/management.sqlite` 上，但不要删除或替换这个数据库文件。

## 阶段 9：总验收

全部阶段做完后，执行下面的清单。任何一条失败都不要宣称完成。

语法：

```powershell
$files = @()
$files += Get-ChildItem -Path src\server,app,scripts -Recurse -Filter *.js |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' }
foreach ($f in $files) { node --check $f.FullName }
```

结构：

- `src/server/app-server.js` 导出 `start`、`createServer`、`SCRIPT_DEFINITIONS`。
- `scripts/app-server.js` 仍是硬约束第 5 条里的那 5 行，包含 `launchCli(server.start)` 和 `module.exports = server`。
- `package.json` 的 `scripts.app` 仍是 `node src/server/app-server.js`。
- `flows/` 和 `src/workflows/` 相对阶段 0 没有 diff。用 `git diff --stat -- flows src/workflows src/tools src/automation src/ai src/brain` 确认。这些路径应为空。若仓库本来就有用户未提交的修改，只确认本次没有再改它们。
- 全仓库搜索确认没有第二份 `SCRIPT_DEFINITIONS` 大数组，也没有第二份 `STEPS_META`。
- 全仓库搜索确认 `index.html` 不再加载已删除的 `app.js`，`admin.html` 不再加载已删除的 `admin.js`。

HTTP：再跑阶段 1 的 7 个断言，加上阶段 4 的未登录断言。临时端口用完即停。

浏览器：

- 打开 `/`。控制台无红色语法错误。未登录路径与拆分前一致。
- 打开 `/admin/cluster`。页签栏仍在，未登录时走原认证跳转。
- 不点击「执行全流程」「启动调度」「兑换」「生成卡密」「回收」「下发到云机」。

报告里写明：改了哪些文件，每阶段烟测的实际状态码，哪些验证因为没有浏览器或没有登录而没做。不要写“已全面测试”。

## 回滚

这些阶段都是工作区文件搬移，没有数据迁移。回滚方式是用版本管理还原本次改过的 `app/` 和 `src/server/`，以及 `docs/APP.md`、`docs/README.md`。不要还原时覆盖 `.env.local`、`.runtime/`、`storage/`、`logs/`、`models/`。

如果只完成了前几个阶段，停在已通过验收的阶段即可。不要为了“代码看起来更完整”把没验收的阶段一起留下。

## 完成定义

同时满足下面各项，这次重构才算做完：

1. `app-server.js` 不再内嵌路由业务和脚本清单数组，只负责启动、日志、鉴权上下文和按顺序分发。
2. `app.js` 和 `admin.js` 不再作为页面入口存在，它们的函数按上面的文件分开，全局名和加载顺序符合合同。
3. 路由、状态码、错误文案、Cookie、脚本 id、环境变量名、localStorage 键与拆分前一致。
4. 业务脚本目录没有被修改。
5. 阶段 9 的语法检查和 HTTP 断言通过，并在最终回复里逐条写出结果。
