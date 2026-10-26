'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_FILE = path.join(ROOT, 'docs', '代码符号索引.md');

const SCAN_DIRS = [
  'src',
  'flows',
  'app',
  'scripts',
  'python_typing',
  'python_workers'
];

function scanDirectory(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '.git', '.runtime', '.local-output', '__pycache__', '.venv-zhtyping', '.research', 'templates'].includes(entry.name)) {
        scanDirectory(fullPath, fileList);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.js', '.py', '.ts', '.html', '.css'].includes(ext)) {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

function parseJsFile(filePath, content) {
  const lines = content.split(/\r?\n/);
  const classes = [];
  const functions = [];
  const exports = [];
  const constants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Class definition
    const classMatch = line.match(/^(\s*)(export\s+)?class\s+([A-Za-z0-9_$]+)(\s+extends\s+([A-Za-z0-9_$]+))?/);
    if (classMatch) {
      classes.push({
        name: classMatch[3],
        parent: classMatch[5] || null,
        line: lineNum
      });
      continue;
    }

    // Function definition
    const funcMatch = line.match(/^(\s*)(export\s+)?(async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/);
    if (funcMatch) {
      functions.push({
        name: funcMatch[4],
        async: Boolean(funcMatch[3]),
        params: funcMatch[5].trim(),
        line: lineNum
      });
      continue;
    }

    // Top-level arrow or function variable
    const varFuncMatch = line.match(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(async\s+)?(?:\(([^)]*)\)|([A-Za-z0-9_$]+))\s*=>/);
    if (varFuncMatch) {
      functions.push({
        name: varFuncMatch[1],
        async: Boolean(varFuncMatch[2]),
        params: (varFuncMatch[3] || varFuncMatch[4] || '').trim(),
        line: lineNum
      });
      continue;
    }

    // Significant constants
    const constMatch = line.match(/^const\s+([A-Z0-9_]{3,})\s*=/);
    if (constMatch) {
      constants.push({
        name: constMatch[1],
        line: lineNum
      });
    }

    // Module exports
    const exportMatch = line.match(/module\.exports\s*=\s*(?:\{([^}]+)\}|([A-Za-z0-9_$]+))/);
    if (exportMatch) {
      if (exportMatch[1]) {
        exportMatch[1].split(',').forEach(item => {
          const trimmed = item.trim().split(/\s*:\s*/)[0];
          if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('...')) {
            exports.push({ name: trimmed, line: lineNum });
          }
        });
      } else if (exportMatch[2]) {
        exports.push({ name: exportMatch[2], line: lineNum });
      }
    }
  }

  return { classes, functions, constants, exports, lineCount: lines.length };
}

function parsePyFile(filePath, content) {
  const lines = content.split(/\r?\n/);
  const classes = [];
  const functions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const classMatch = line.match(/^class\s+([A-Za-z0-9_]+)(?:\(([^)]*)\))?:/);
    if (classMatch) {
      classes.push({
        name: classMatch[1],
        parent: classMatch[2] || null,
        line: lineNum
      });
      continue;
    }

    const defMatch = line.match(/^def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
    if (defMatch) {
      functions.push({
        name: defMatch[1],
        params: defMatch[2].trim(),
        returnType: defMatch[3]?.trim() || null,
        line: lineNum
      });
    }
  }

  return { classes, functions, lineCount: lines.length };
}

function generateMarkdownIndex() {
  const allFiles = [];
  for (const scanDir of SCAN_DIRS) {
    scanDirectory(path.join(ROOT, scanDir), allFiles);
  }

  const results = [];
  for (const file of allFiles) {
    const relPath = path.relative(ROOT, file).replace(/\\/g, '/');
    const content = fs.readFileSync(file, 'utf8');
    const ext = path.extname(file).toLowerCase();

    let parsed = null;
    if (ext === '.js' || ext === '.ts') {
      parsed = parseJsFile(file, content);
    } else if (ext === '.py') {
      parsed = parsePyFile(file, content);
    } else {
      parsed = { lineCount: content.split(/\r?\n/).length };
    }

    results.push({
      relPath,
      ext,
      ...parsed
    });
  }

  return results;
}

const parsedFiles = generateMarkdownIndex();

let md = `# 📖 云脉云手机自动化代码符号与架构全景索引

> **生成时间**：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}  
> **服务默认端口**：\`4318\` (\`http://127.0.0.1:4318/\`)  
> **GPU 识别常驻端口**：\`4329\` (\`http://127.0.0.1:4329/\`)  
> **项目定位**：基于 Yunmomo 云手机平台的高性能自动化控制、YOLO/RapidOCR 本地视觉感知与端到端 RPA 调度中台。

---

## 🏛️ 一、系统全景架构与模块拓扑 (System Architecture)

\`\`\`mermaid
flowchart TD
    subgraph UI_Console["🖥️ Web 控制台与操作台 (app/ & src/server/)"]
        App["Web 前端 (app.js / index.html)<br/>• 01~08 步进器状态感知<br/>• 云手机集群画面与编号管理"]
        Workstation["原画工作台 (manual-control.js)<br/>• 9:16 真机操控面板<br/>• AI 视觉透视图层 (HUD Overlay)"]
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
        DeepSeek["DeepSeek API 引擎 (src/ai/)
• 官方 OpenAI 兼容接口
• deepseek-chat 智能会话"]
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

| 目录路径 | 文件数量 | 核心职责与关键技术 |
|---|---|---|
| [\`src/\`](file:///d:/AA-project/自动化/src) | 核心库 | 云端 REST 客户端、scrcpy 协议帧编解码、WebSocket 实时真机控制器、高清抓帧引擎 |
| [\`src/automation/\`](file:///d:/AA-project/自动化/src/automation) | 自动化引擎 | 路径/环境隔离、WSL RapidOCR 桥接、4329 GPU 识别常驻服务、并发锁、页面导航恢复 |
| [\`src/tools/\`](file:///d:/AA-project/自动化/src/tools) | 工具与视觉算子 | 点击/滑动/区域加权采样、MOMO 页面识别、红点候选、聊天详情提取 |
| [\`src/workflows/\`](file:///d:/AA-project/自动化/src/workflows) | 业务流程实现 | 01~14 业务流程、MOMO 消息持续监听、参数校验、上游调用、重试熔断 |
| [\`src/typing/\`](file:///d:/AA-project/自动化/src/typing) | 2 个模块 | WebSocket 输入法按键注入、聊天消息自然拼音分词输入控制器 |
| [\`src/server/\`](file:///d:/AA-project/自动化/src/server) | 本地服务 | 本地 Web 控制台 HTTP/WS 服务（默认端口 4318）、设备锁、真机触控桥接、视频流代理 |
| [\`app/\`](file:///d:/AA-project/自动化/app) | 5 个前端文件 | 业务控制台 UI、01~08 全流程状态感知步进器、微型进度条、AI 视觉 HUD 覆盖层 |
| [\`flows/\`](file:///d:/AA-project/自动化/flows) | 流程入口 | 01~14 CLI 规范执行入口、\`_common.js\` 串行流水线调度执行器 |
| [\`python_typing/\`](file:///d:/AA-project/自动化/python_typing) | 10 个模块 | 纯 Python 中文分词、拼音拼写转换、候选词匹配、九宫格/全键盘按键动作生成 |
| [\`python_workers/\`](file:///d:/AA-project/自动化/python_workers) | 3 个 Worker | RapidOCR 常驻进程、输入法候选 OCR 进程、分词拼音计划输出管道 |
| [\`docs/\`](file:///d:/AA-project/自动化/docs) | 20 篇文档 | API 接口文档、协议定义、MOMO 自动化规范、性能基准、架构约定 |

---

## 📑 三、核心类与导出符号全览 (Classes & Symbols)

`;

// Group by category
const categories = [
  { name: '1. 核心 SDK 与客户端 (src/client, control, protocol, management)', match: f => f.startsWith('src/') && !f.includes('src/automation') && !f.includes('src/tools') && !f.includes('src/workflows') && !f.includes('src/typing') && !f.includes('src/server') },
  { name: '2. 自动化感知与基础服务 (src/automation/)', match: f => f.startsWith('src/automation/') },
  { name: '3. 视觉算子与工具集 (src/tools/)', match: f => f.startsWith('src/tools/') },
  { name: '4. 业务工作流核心实现 (src/workflows/)', match: f => f.startsWith('src/workflows/') },
  { name: '4.6 持续监听与调度中枢 (src/brain/)', match: f => f.startsWith('src/brain/') },
  { name: '4.5 AI 回复与大模型接入 (src/ai/)', match: f => f.startsWith('src/ai/') },
  { name: '5. 拼音打字与输入法系统 (src/typing/ & python_typing/)', match: f => f.startsWith('src/typing/') || f.startsWith('python_typing/') },
  { name: '6. Web 服务端与前端控制台 (src/server/ & app/)', match: f => f.startsWith('src/server/') || f.startsWith('app/') },
  { name: '7. 流程执行入口 (flows/)', match: f => f.startsWith('flows/') }
];

for (const cat of categories) {
  md += `### ${cat.name}\n\n`;
  const matchedFiles = parsedFiles.filter(f => cat.match(f.relPath));

  for (const file of matchedFiles) {
    md += `#### 📄 [\`${file.relPath}\`](file:///d:/AA-project/自动化/${file.relPath}) (${file.lineCount} 行)\n\n`;

    if (file.classes && file.classes.length > 0) {
      md += `**核心类定义 (Classes)**:\n`;
      for (const cls of file.classes) {
        md += `- [\`${cls.name}\`](file:///d:/AA-project/自动化/${file.relPath}#L${cls.line})${cls.parent ? ` *(继承自 \`${cls.parent}\`)*` : ''} —— 第 ${cls.line} 行\n`;
      }
      md += '\n';
    }

    if (file.functions && file.functions.length > 0) {
      md += `**函数与方法 (Functions)**:\n`;
      for (const fn of file.functions) {
        md += `- [\`${fn.name}(${fn.params})\`](file:///d:/AA-project/自动化/${file.relPath}#L${fn.line})${fn.async ? ' *(async)*' : ''}${fn.returnType ? ` \`-> ${fn.returnType}\`` : ''} —— 第 ${fn.line} 行\n`;
      }
      md += '\n';
    }

    if (file.constants && file.constants.length > 0) {
      md += `**关键配置与枚举常量**:\n`;
      const constList = file.constants.map(c => `[\`${c.name}\`](file:///d:/AA-project/自动化/${file.relPath}#L${c.line})`).join(', ');
      md += `${constList}\n\n`;
    }

    if (file.exports && file.exports.length > 0) {
      md += `**模块导出 (Exports)**: ${file.exports.map(e => `\`${e.name}\``).join(', ')}\n\n`;
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
| **GET** | \`/api/scripts\` | 获取 01~14 流程、MOMO 监听及执行全部定义 | 无 | \`{ ok: true, scripts: Array<ScriptDefinition> }\` |
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

### 3. 本地测试套件
\`\`\`powershell
# 运行完整自动化测试套件（测试数量随源码变化）
npm test
\`\`\`

### 4. 刷新本索引
\`\`\`powershell
node scripts/generate-code-index.js
\`\`\`
`;

fs.writeFileSync(OUTPUT_FILE, md, 'utf8');
console.log(`[code-indexer] Successfully generated: ${OUTPUT_FILE} (${md.length} bytes)`);
