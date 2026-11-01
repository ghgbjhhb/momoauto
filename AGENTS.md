# ZCode 工作区指引

云 momo 云手机自动化：本地网页控制台 + Node.js SDK + 01~14 业务脚本 + OCR/拼音 Python 模块。

## 代码索引（回答代码问题前先查）

- **`docs/代码符号索引.md`** — 全景索引：模块拓扑、目录职责、全部类/函数/导出（带文件与行号）、HTTP/WS 端点、业务链路。**改完代码结构后必须运行 `npm run index` 重新生成。**
- `docs/PROJECT-STRUCTURE.md` — 目录归属与维护约定
- `docs/README.md` — 功能文档总索引
- `flows/README.md` — 01~14 业务脚本清单与执行顺序

找符号：先在索引里 grep 定位文件与行号，再读源码；不要全目录盲搜。

## 目录速查

| 位置 | 职责 |
|---|---|
| `src/index.js` | SDK 公共入口（导入方式不变） |
| `src/tools/` | 截图、点击、滑动、打开 MOMO 等底层工具；`momo/` 为 MOMO 应用能力 |
| `src/automation/` | 公共桌面查找、OCR 进程、路径与命令行输出 |
| `src/workflows/` | 10 个业务脚本的正式实现（新业务代码放这里） |
| `src/server/` | 本地 HTTP 服务和手动控制桥（app-server 已模块化：context/catalog/runner/domain routers） |
| `src/ai/` `src/brain/` | AI 回复（DeepSeek）；MOMO 持续监听调度中枢 |
| `src/typing/` `python_typing/` `python_workers/` | WebSocket 拼音输入与中文分词/OCR 常驻进程 |
| `app/` | 网页界面（admin.js 已模块化为 5 个领域模块；app.js 为 4 个） |
| `flows/` | 中文名称编号的正式执行入口 |

可复用能力放 `src/automation` 或 `src/tools`；正式实现不从 `examples` 导入。

## 常用命令

- `npm run app` — 启动本地控制台（4318 端口）
- `npm run index` — 重新生成代码符号索引（符号取自 Serena LSP 缓存；改动代码结构后先执行 `serena project index` 刷新缓存）
- `npm run flow:NN` — 业务脚本（01~16）；`npm run timing:report` — 慢步骤报告

## GitHub 同步（仓库：https://github.com/ghgbjhhb/momoauto）

### 本机推送更新（每次改完验证通过后执行）

```powershell
Set-Location "d:\AA-project\自动化"
git add .
git commit -m "feat/fix/chore: 描述改了什么"
git push
```

### 另一台电脑首次克隆

```powershell
git clone https://github.com/ghgbjhhb/momoauto.git "d:\AA-project\自动化"
Set-Location "d:\AA-project\自动化"
npm install
# 然后手动配置 .env 文件（凭据不入库）
```

### 另一台电脑拉取最新代码

```powershell
Set-Location "d:\AA-project\自动化"
git pull
```

> **注意**：`.env`、`node_modules/`、`.runtime/`（OCR 模型）不入库，另一台电脑需单独配置。

## 工程守则

完整守则见 **GEMINI.md**，与本文件一致且必须遵守。硬性要点：

- **严禁单元测试与 Mock**；唯一有效验收是真实云机端到端实测
- **证据时效**：任何动作下发后，旧截图/OCR/坐标立即作废；单设备同一时刻只允许一个写操作流
- **三态幂等**：动作结果未知时先做无害状态核验，严禁直接重试
- **每改必验，验毕必提** commit；回退前必须检查 `git status`，禁止盲目 reset/checkout
- 令牌/凭据只走环境变量，不落源码、日志与文档；VPC records 与文件 url 含敏感凭据，禁止直接打印
