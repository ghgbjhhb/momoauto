'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'docs', '代码符号索引.md');
const SYMBOLS_FILE = path.join(ROOT, '.serena', 'cache', 'symbols.json');
const FILE_URL_BASE = 'file:///d:/AA-project/自动化';

const SCAN_DIRS = [
  'src',
  'flows',
  'app',
  'scripts',
  'python_typing',
  'python_workers'
];

const SCANNED_EXTENSIONS = ['.js', '.py', '.ts', '.html', '.css'];
const IGNORED_DIRECTORIES = ['node_modules', '.git', '.runtime', '.local-output', '__pycache__', '.venv-zhtyping', '.research', 'templates'];

function loadSymbols() {
  if (!fs.existsSync(SYMBOLS_FILE)) {
    console.error('[code-indexer] 缺少 Serena 符号导出文件 .serena/cache/symbols.json');
    console.error('[code-indexer] 请先执行: serena project index && npm run index:symbols');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(SYMBOLS_FILE, 'utf8'));
}

function scanDirectory(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.includes(entry.name)) {
        scanDirectory(fullPath, fileList);
      }
    } else if (entry.isFile() && SCANNED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function link(relPath, label, line) {
  const safeLabel = label.replace(/([\[\]])/g, '\\$1');
  return `[\`${safeLabel}\`](${FILE_URL_BASE}/${relPath}${line ? `#L${line}` : ''})`;
}

function rangeLabel(item) {
  if (item.endLine && item.endLine > item.line) return `第 ${item.line}–${item.endLine} 行`;
  return `第 ${item.line} 行`;
}

const symbols = loadSymbols();
const fileEntries = symbols.files || {};

const scannedFiles = [];
for (const scanDir of SCAN_DIRS) {
  scanDirectory(path.join(ROOT, scanDir), scannedFiles);
}

const relPaths = scannedFiles
  .map((file) => path.relative(ROOT, file).replace(/\\/g, '/'))
  .sort();

const cacheUpdatedAt = Math.max(
  0,
  ...Object.values(symbols.languages || {}).map((info) => (info.cacheUpdatedAt || 0) * 1000)
);
const staleFiles = relPaths.filter(
  (relPath) => fs.statSync(path.join(ROOT, relPath)).mtimeMs > cacheUpdatedAt
);

function countFiles(prefix) {
  return relPaths.filter((relPath) => relPath === prefix || relPath.startsWith(`${prefix}/`)).length;
}

const lineCountCache = new Map();
function countLines(relPath) {
  if (!lineCountCache.has(relPath)) {
    lineCountCache.set(relPath, fs.readFileSync(path.join(ROOT, relPath), 'utf8').split(/\r?\n/).length);
  }
  return lineCountCache.get(relPath);
}

const stats = relPaths.reduce((acc, relPath) => {
  const entry = fileEntries[relPath];
  if (!entry) return acc;
  acc.classes += entry.classes.length;
  acc.methods += entry.classes.reduce((sum, cls) => sum + cls.members.length, 0);
  acc.functions += entry.functions.length;
  acc.constants += entry.constants.length;
  if (entry.classes.length || entry.functions.length || entry.constants.length) acc.symbolFiles += 1;
  return acc;
}, { classes: 0, methods: 0, functions: 0, constants: 0, symbolFiles: 0 });

let md = `# 📖 云脉云手机自动化代码符号与架构全景索引

> **生成时间**：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}  
> **符号来源**：Serena 语言服务（LSP）文档符号缓存，覆盖 ${stats.symbolFiles} 个源文件 / ${relPaths.length} 个扫描文件，  
> 解析出 ${stats.classes} 个类与接口、${stats.methods} 个成员方法、${stats.functions} 个函数、${stats.constants} 个模块级常量。  
> **服务默认端口**：\`4318\` (\`http://127.0.0.1:4318/\`)  
> **GPU 识别常驻端口**：\`4329\` (\`http://127.0.0.1:4329/\`)  
> **项目定位**：基于 Yunmomo 云手机平台的高性能自动化控制、YOLO/RapidOCR 本地视觉感知与端到端 RPA 调度中台。
${staleFiles.length && cacheUpdatedAt ? `
> ⚠️ **缓存滞后**：有 ${staleFiles.length} 个源文件的修改时间晚于 Serena 符号缓存，行号可能偏移。  
> 刷新方式：\`serena project index\` → \`npm run index\`。
` : ''}
---

## 🏛️ 一、系统全景架构与模块拓扑 (System Architecture)

\`\`\`mermaid
flowchart TD
    subgraph UI_Console["🖥️ Web 控制台与操作台 (app/ & src/server/)"]
        App["Web 前端 (app/console/ & app/admin/)<br/>• 01~08 步进器状态感知<br/>• 云手机集群画面与编号管理"]
        Workstation["原画工作台 (app/manual-control.js)<br/>• 9:16 真机操控面板<br/>• AI 视觉透视图层 (HUD Overlay)"]
        Server["本地控制台服务 (src/server/app-server.js)<br/>• 默认端口 4318<br/>• REST /api/* 接口网关<br/>• WebSocket 触控中继"]
    end

    subgraph Core_SDK["⚙️ 核心 SDK 与底层协议 (src/)"]
        Client["YunmomoClient (client.js)<br/>• 云机 REST API 封装<br/>• 截图/音频/代理/重置"]
        Control["CloudPhoneControl (control.js)<br/>• WebSocket scrcpy 触控协议<br/>• 键盘/剪贴板/文件推送"]
        Protocol["协议编解码器 (protocol.js)<br/>• scrcpy 二进制帧打包<br/>• Keycode / Touch 序列化"]
        Management["云盘与 VPC 管理 (management.js)<br/>• CloudDisk (文件导入/分发)<br/>• VpcManager (代理池增删改查)"]
        StreamShot["原画抓帧 (stream-screenshot.js)<br/>• 极低延迟视频帧解码<br/>• 1280 高清截图"]
    end

    subgraph Workflows["🚀 01~14 自动化业务流程与消息监听 (src/workflows/ & flows/)"]
        F01["01 导入云盘所有文件 (send-cloud-files.js)"]
        F02["02 上传证书 (upload-certificate.js)"]
        F03["03 设置 VPC 代理 (set-vpc-proxy.js)"]
        F04["04 环境配置 (configure-environment.js)"]
        F05["05 一键生成全部 (generate-all.js)"]
        F06["06 定位到 IP 地 (locate-ip.js)"]
        F07["07 高德初始化 (initialize-gaode.js)"]
        F08["08 输入法初始化 (initialize-input-method.js)"]
        F09["09 改机重置 (change-model-reset.js)"]
        F10["10 增加 VPC 网络 (add-vpc-network.js)"]
        F11["11 MOMO首页养号 (momo-warmup.js)"]
        F12["12 MOMO招呼处理 (momo-greetings.js)"]
        F13["13 MOMO联系人及消息入库 (momo-contact-sync.js)"]
        F14["14 MOMO AI回复 (momo-ai-reply.js)"]
        FWatch["消息列表持续监听 (momo-message-watch.js)"]
        FAll["执行全部 01~08 (flows/执行全部.js)"]
    end

    subgraph Brain_Core["🧠 持续监听与调度中枢 (src/brain/ & src/automation/)"]
        BrainManager["BrainManager (src/brain/manager.js)<br/>• 多设备生命周期总控<br/>• 调度配置与全局状态"]
        DeviceActor["DeviceActor (src/brain/device-actor.js)<br/>• 单设备单串行循环<br/>• 可取消睡眠与事件流"]
        Scheduler["BrainScheduler (src/brain/scheduler.js)<br/>• 0~6 级任务优先级队列<br/>• 单联系人防饥饿公平调度"]
        PageSvc["PageService (src/automation/page-service.js)<br/>• 统一同帧页面/场景/遮挡观测"]
        PageRec["PageRecovery (src/automation/page-recovery.js)<br/>• 单步返回重判与有界上限"]
        BrainStore["BrainStore (src/brain/store.js)<br/>• control.sqlite 调度控制库"]
    end

    subgraph Data_Storage["💾 数据持久化与状态 (SQLite / .runtime/)"]
        MomoDB["MomoDatabase (src/tools/momo/db.js)<br/>• SQLite3 线程安全独立库<br/>• 联系人/消息去重/增量同步"]
    end

    subgraph AI_Engine["🧠 AI大脑与本地视觉感知 (src/ai/ & src/automation/ & python_*)"]
        DeepSeek["DeepSeek API 引擎 (src/ai/)<br/>• 官方 OpenAI 兼容接口<br/>• deepseek-chat 智能会话"]
        OCR["RapidOCR 引擎 (ocr.js & rapidocr_worker.py)<br/>• WSL Python 本地 ONNX 推理<br/>• 控件边界与文字置信度"]
        GPU_Pool["GPU 识别池 (recognition-service.js)<br/>• 端口 4329 常驻 RPC 服务<br/>• YOLO 页面/聊天框/头像检测"]
        TypingEngine["自然拼音打字引擎 (python_typing/ & ws-ime-input.js)<br/>• jieba 分词 + 拼音映射<br/>• 虚拟键盘按键计划生成"]
    end

    App -->|HTTP / API| Server
    Workstation -->|WebSocket /api/control| Server
    Workstation -->|HTTP /api/vision-inspect| Server
    Server --> Client
    Server --> OCR
    Server --> FAll
    FAll --> F01 & F02 & F03 & F04 & F05 & F06 & F07 & F08
    Client --> Control
    Control --> Protocol
    Workflows --> Client
    Workflows --> GPU_Pool
    Workflows --> TypingEngine
    F14 --> DeepSeek
    F13 --> MomoDB
    FWatch --> PageSvc & GPU_Pool
\`\`\`

---

## 📂 二、目录职责与工程分工

| 目录路径 | 源文件数 | 核心职责与关键技术 |
|---|---|---|
| [\`src/\`](file:///d:/AA-project/自动化/src) | ${countFiles('src')} | 云端 REST 客户端、scrcpy 协议帧编解码、WebSocket 实时真机控制器、高清抓帧引擎 |
| [\`src/automation/\`](file:///d:/AA-project/自动化/src/automation) | ${countFiles('src/automation')} | 路径/环境隔离、WSL RapidOCR 桥接、4329 GPU 识别常驻服务、并发锁、页面导航恢复 |
| [\`src/tools/\`](file:///d:/AA-project/自动化/src/tools) | ${countFiles('src/tools')} | 点击/滑动/区域加权采样、MOMO 页面识别、红点候选、聊天详情提取 |
| [\`src/workflows/\`](file:///d:/AA-project/自动化/src/workflows) | ${countFiles('src/workflows')} | 01~16 业务流程实现、MOMO 消息持续监听、参数校验、上游调用、重试熔断 |
| [\`src/brain/\`](file:///d:/AA-project/自动化/src/brain) | ${countFiles('src/brain')} | 多设备监听调度中枢、串行 DeviceActor、优先级任务队列与调度控制库 |
| [\`src/ai/\`](file:///d:/AA-project/自动化/src/ai) | ${countFiles('src/ai')} | DeepSeek 会话配置、上下文拼装与 AI 回复任务执行 |
| [\`src/typing/\`](file:///d:/AA-project/自动化/src/typing) | ${countFiles('src/typing')} | WebSocket 输入法按键注入、聊天消息自然拼音分词输入控制器 |
| [\`src/server/\`](file:///d:/AA-project/自动化/src/server) | ${countFiles('src/server')} | 本地 Web 控制台 HTTP/WS 服务（默认端口 4318）、设备锁、真机触控桥接、视频流代理 |
| [\`app/\`](file:///d:/AA-project/自动化/app) | ${countFiles('app')} | 业务控制台 UI、01~16 全流程状态感知步进器、微型进度条、AI 视觉 HUD 覆盖层 |
| [\`flows/\`](file:///d:/AA-project/自动化/flows) | ${countFiles('flows')} | 中文编号 CLI 执行入口（v2/v3/momo 三套），统一转发至 \`src/workflows/\` |
| [\`python_typing/\`](file:///d:/AA-project/自动化/python_typing) | ${countFiles('python_typing')} | 纯 Python 中文分词、拼音拼写转换、候选词匹配、九宫格/全键盘按键动作生成 |
| [\`python_workers/\`](file:///d:/AA-project/自动化/python_workers) | ${countFiles('python_workers')} | RapidOCR 常驻进程、输入法候选 OCR 进程、分词拼音计划输出管道 |
| [\`scripts/\`](file:///d:/AA-project/自动化/scripts) | ${countFiles('scripts')} | 控制台启动入口、识别常驻服务、4318 穿透、索引生成与 UI 校验脚本 |

---

## 📑 三、核心类与导出符号全览 (Classes & Symbols)

> 以下符号、签名与行号全部来自 Serena 语言服务解析结果；类成员（方法/字段）随类缩进列出。

`;

// Group by category
const categories = [
  { name: '1. 核心 SDK 与客户端 (src/client, control, protocol, management)', match: f => f.startsWith('src/') && !f.includes('src/automation') && !f.includes('src/tools') && !f.includes('src/workflows') && !f.includes('src/typing') && !f.includes('src/server') && !f.includes('src/brain') && !f.includes('src/ai') },
  { name: '2. 自动化感知与基础服务 (src/automation/)', match: f => f.startsWith('src/automation/') },
  { name: '3. 视觉算子与工具集 (src/tools/)', match: f => f.startsWith('src/tools/') },
  { name: '4. 业务工作流核心实现 (src/workflows/)', match: f => f.startsWith('src/workflows/') },
  { name: '4.6 持续监听与调度中枢 (src/brain/)', match: f => f.startsWith('src/brain/') },
  { name: '4.5 AI 回复与大模型接入 (src/ai/)', match: f => f.startsWith('src/ai/') },
  { name: '5. 拼音打字与输入法系统 (src/typing/ & python_typing/ & python_workers/)', match: f => f.startsWith('src/typing/') || f.startsWith('python_typing/') || f.startsWith('python_workers/') },
  { name: '6. Web 服务端与前端控制台 (src/server/ & app/)', match: f => f.startsWith('src/server/') || f.startsWith('app/') },
  { name: '7. 流程执行入口 (flows/)', match: f => f.startsWith('flows/') },
  { name: '8. 启动与运维脚本 (scripts/)', match: f => f.startsWith('scripts/') }
];

for (const cat of categories) {
  md += `### ${cat.name}\n\n`;
  const matchedFiles = relPaths.filter(cat.match);

  for (const relPath of matchedFiles) {
    const entry = fileEntries[relPath];
    const lineCount = entry ? entry.lines : countLines(relPath);
    md += `#### 📄 [\`${relPath}\`](${FILE_URL_BASE}/${relPath}) (${lineCount} 行)\n\n`;

    if (!entry || (!entry.classes.length && !entry.functions.length && !entry.constants.length)) {
      md += /\.(css|html)$/.test(relPath)
        ? `_样式与页面模板，不参与 LSP 符号解析。_\n\n`
        : `_纯转发壳（re-export / CLI 引导），无顶层可执行符号。_\n\n`;
      continue;
    }

    if (entry.classes.length > 0) {
      md += `**类与接口 (Classes)**:\n`;
      for (const cls of entry.classes) {
        md += `- ${link(relPath, cls.name, cls.line)} —— ${rangeLabel(cls)}\n`;
        for (const member of cls.members) {
          md += `  - ${link(relPath, member.decl || member.name, member.line)} — L${member.line}\n`;
        }
      }
      md += '\n';
    }

    if (entry.functions.length > 0) {
      md += `**函数 (Functions)**:\n`;
      for (const fn of entry.functions) {
        md += `- ${link(relPath, fn.decl || fn.name, fn.line)} —— ${rangeLabel(fn)}\n`;
      }
      md += '\n';
    }

    if (entry.constants.length > 0) {
      md += `**模块级常量与状态**:\n`;
      const constList = entry.constants.map(c => `${link(relPath, c.name, c.line)} (第 ${c.line} 行)`);
      md += `${constList.join(' · ')}\n\n`;
    }

    if (entry.exports.length > 0) {
      md += `**模块导出 (Exports)**: ${entry.exports.map(e => `\`${e}\``).join(', ')}\n\n`;
    }
  }
}

md += `---

## 🌐 四、本地 Web 控制台 API 与 WebSocket 路由索引 (HTTP / WS Endpoints)

控制台核心网关位于 [\`src/server/app-server.js\`](file:///d:/AA-project/自动化/src/server/app-server.js)，默认运行在 **\`http://127.0.0.1:4318\`**：

| 协议 / Method | 路由路径 | 核心处理逻辑 | 请求参数 / 数据载荷 | 响应规范 |
|---|---|---|---|---|
| **GET** | \`/api/status\` | 获取本地控制台服务与登录态状态 | 无 | \`{ ok: true, tokenConfigured: boolean, sessionSource: string, host: string }\` |
| **GET** | \`/api/devices\` | 获取当前账号下的云手机列表及在线状态 | 无 | \`{ ok: true, devices: Array<CloudDeviceInfo> }\` |
| **GET** | \`/api/scripts\` | 获取 01~16 流程、MOMO 监听及执行全部定义 | 无 | \`{ ok: true, scripts: Array<ScriptDefinition> }\` |
| **GET** | \`/api/screenshot\` | 高速读取单台云手机的最新高清原画画面 | \`deviceId\` (云机 ID) | 二进制图片流 (\`image/jpeg\` / \`image/png\`) |
| **GET** | \`/api/vision-inspect\` | **AI 视觉识别透视**：调用 RapidOCR 解析当前画面所有文字及坐标 | \`deviceId\` (云机 ID) | \`{ ok: true, width, height, count, items: Array<{text, score, left, top, right, bottom, center_x, center_y}> }\` |
| **POST** | \`/api/execute\` | 执行指定的自动化业务脚本（01~10 或执行全部） | \`{ scriptId, deviceId, options, resetConfirmed }\` | \`{ ok: boolean, exitCode: number, stdout: string, stderr: string }\` |
| **POST** | \`/api/session\` | 保存更新本地浏览器登录 Token 到 \`.env.local\` | \`{ token: string }\` | \`{ ok: true }\` |
| **GET** | \`/api/runtime-state\` | 查询正在运行的脚本、停止请求和设备占用状态 | 无 | \`{ ok: true, runs: Array<ScriptRun> }\` |
| **POST** | \`/api/execute/stop\` / \`/api/scripts/stop\` | 请求停止指定脚本运行 | \`{ scriptRunId, scriptId?, deviceId? }\` | 停止意图与运行状态 |
| **GET/POST** | \`/api/ai-reply/*\` | AI 配置、连通性测试、回复任务和取消 | 见 \`src/server/ai-reply-routes.js\` | 脱敏配置或异步 run 状态 |
| **GET/POST** | \`/api/momo-brain/*\` | Brain 配置、设备启动/暂停/恢复/停止、状态和事件 | 见 \`src/server/momo-brain-routes.js\` | 调度状态与脱敏事件 |
| **WS** | \`/api/control\` | **实时真机触控桥**：双向中继网页触控/滚动/按键到手机 scrcpy 协议 | \`deviceId\` (URL Query) | 客户端发送 JSON 触控包，中继到云端二进制协议 |
| **WS** | \`/api/control-input\` / \`/api/video\` | 手动输入与视频流通道 | \`deviceId\` (URL Query) | 输入确认或 H264 视频帧 |

---

## 🔄 五、业务数据流与执行链路 (Data Flow Sequences)

### 1. 01~08 全流程状态感知步进链路

\`\`\`mermaid
sequenceDiagram
    participant User as 运维人员 (Web UI)
    participant Stepper as Pipeline Stepper (app.js)
    participant Server as App Server (Port 4318)
    participant Runner as flows/_common.js
    participant Workflows as src/workflows/*.js
    participant Cloud as 云脉云手机平台 (REST/WS)

    User->>Stepper: 点击 "执行全流程 (01~08)" 或指定单步
    Stepper->>Stepper: 当前设备步进状态置为 "running" (呼吸蓝灯)
    Stepper->>Server: POST /api/execute { scriptId: "flow-all", deviceId }
    Server->>Runner: spawn flows/执行全部.js --execute
    loop 依次执行步骤 01 至 08
        Runner->>Workflows: 调用具体业务脚本 (如 send-cloud-files)
        Workflows->>Cloud: 调用 REST API / WebSocket 触控指令
        Cloud-->>Workflows: 返回业务处理结果
        Runner-->>Server: 输出进度日志 "[1/8] 成功完成: 导入云盘所有文件"
    end
    Server-->>Stepper: 执行完成响应 { ok: true, stdout: "..." }
    Stepper->>Stepper: 解析执行输出，匹配成功步骤置为 "completed" (翡翠绿勾)
    Stepper->>Stepper: 持久化保存至 localStorage (yunmomo.deviceProgress)
    Stepper-->>User: 界面与设备卡片微型进度条同步亮绿
\`\`\`

### 2. AI 视觉识别与一键触击定位链路

\`\`\`mermaid
sequenceDiagram
    participant User as 操作台用户
    participant Workstation as 手机控制台 (manual-control.js)
    participant Canvas as Vision Overlay Canvas
    participant Server as App Server (Port 4318)
    participant RapidOCR as RapidOCR Worker (WSL Python)
    participant Cloud as 云手机实例

    User->>Workstation: 点击 "AI 视觉透视" 按钮
    Workstation->>Server: GET /api/vision-inspect?deviceId=...
    Server->>Cloud: previewImage(deviceId) 获取最新原画截帧
    Server->>RapidOCR: worker.recognize(tempImage) (ONNX 推理)
    RapidOCR-->>Server: 返回识别文字项 [{ text, score, left, top, right, bottom }]
    Server-->>Workstation: JSON 结果响应
    Workstation->>Canvas: renderVisionOverlay() 投影绘制霓虹矩形框与置信度徽章
    User->>Canvas: 鼠标悬浮在指定文字框上方
    Canvas-->>User: 框体切换高亮亮黄，显示 HUD 遥测气泡 (文字/置信度/坐标)
    User->>Canvas: 点击该文字框
    Workstation->>Cloud: 发送 touch down/up 事件到 (center_x, center_y) 对应归一化坐标
    Cloud-->>Workstation: 真实手机完成该位置控件触击响应
\`\`\`

---

## ⚡ 六、快速开发与调用指引 (Quick Reference)

### 1. 运行本地控制台
\`\`\`powershell
# 启动本地控制台（默认运行在 4318 端口）
npm run app

# 打开浏览器访问
http://127.0.0.1:4318/
\`\`\`

### 2. 命令行执行独立流程
\`\`\`powershell
# 对指定云手机执行 01 导入云盘
$env:YUNMOMO_DEVICE_ID = "2033060279606353921"
npm run flow:01 -- --execute

# 执行全部 01~08 初始化
npm run flow:all -- --execute
\`\`\`

### 3. 刷新本索引
\`\`\`powershell
# 1) 用 Serena 语言服务重建符号缓存（分钟级，只需在代码结构变化后执行）
serena project index

# 2) 导出符号 JSON 并重新生成索引
npm run index
\`\`\`
`;

fs.writeFileSync(OUTPUT_FILE, md, 'utf8');
console.log(`[code-indexer] 符号源: Serena LSP · 文件 ${stats.symbolFiles}/${relPaths.length} · 类 ${stats.classes} · 方法 ${stats.methods} · 函数 ${stats.functions}`);
if (staleFiles.length && cacheUpdatedAt) {
  console.warn(`[code-indexer] 警告：${staleFiles.length} 个文件晚于符号缓存，请重新执行 serena project index`);
}
console.log(`[code-indexer] Successfully generated: ${OUTPUT_FILE} (${md.length} bytes)`);
