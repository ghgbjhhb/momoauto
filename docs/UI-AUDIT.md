# UI 现状盘点（重构基线）

> 2026-10-30 · 分支 `ui/refactor` · 数据由 `node scripts/ui-lint.js --legacy` 生成

## 1. 规模

| 文件 | 行数 | 唯一颜色 | 字号 | 阴影 | 圆角 | 规则数 |
|---|---:|---:|---:|---:|---:|---:|
| `app/styles.css` | 1828 | 52 | 11 | 9 | 9 | 234 |
| `app/theme-a.css` | 1756 | 29 | 10 | 10 | 12 | 207 |
| `app/theme-b.css` | 3060 | 54 | 13 | 27 | 10 | 369 |
| 合计 | 6644 | **94** | **13** | **46** | **31** | 810 |

三份样式表不是「基础 + 主题」，是三次完整重写：

- `styles.css` ∩ `theme-a.css` = 165 个选择器重叠
- `styles.css` ∩ `theme-b.css` = 178 个选择器重叠
- `theme-a.css` ∩ `theme-b.css` = 148 个选择器重叠

`theme-b.css` 开头自述「彻底推翻删除旧版暗黑代码，全套精简重构」——这是漂移的机制：每次不满意就整份重写，重写必然重新掷色子和字号。

## 2. 表面清单

`app/` 三个页面共 **161 个唯一 class**。按类型归并后有 11 类表面：

| # | 表面 | 现有实现 | 新体系对应 | 状态 |
|---|---|---|---|---|
| 1 | 按钮 | `action-btn` / `btn-action-sm` / `run-button` / `danger-button` 四套并行 | `.ui-btn` + 4 变体 | 待迁 |
| 2 | 卡片 | `stat-card` / `config-card` / `loading-card` / `card-header` 各自定义 | `.ui-card` | 待迁 |
| 3 | 输入 | `form-input` / `form-field` / `form-group` / `form-label` 四层嵌套 | `.ui-field` + `.ui-input` | 待迁 |
| 4 | 表格 | `admin-table` + `table-container` + `table-toolbar` | `.ui-table` | 待迁 |
| 5 | 徽章 | `badge` 单一类 + `text-green/blue/red` 直接染文字 | `.ui-badge` + 5 变体 | 待迁 |
| 6 | 标签页 | `tab-btn` / `tab-content` / `tab-pane` / `nav-item` | `.ui-tabs` | 待迁 |
| 7 | 模态 | `admin-modal` / `admin-modal-card` | `.ui-modal` | 待迁 |
| 8 | 步骤条 | `pipeline-stepper` 页面私有 | `.ui-steps` | 待迁 |
| 9 | 日志 | `log-level-btn` + 页面内联 | `.ui-log` | 待迁 |
| 10 | 空态 / 加载 | `loading-card` 一处，其余无 | `.ui-empty` / `.ui-skeleton` | 新增 |
| 11 | 设备列表 | 卡片网格 + 页面私有样式 | `.ui-device-row` | 待迁 |

**新体系已覆盖 11/11。** 原提案的组件契约只覆盖 3 类（按钮 / 卡片 / 输入），其余 8 类没有任何约束——那 8 类正是塑料感回流的位置。

## 3. 具体病灶

### 3.1 彩色阴影（塑料感第一主犯）

```
styles.css:435   box-shadow: 0 4px 16px rgba(22, 119, 255, 0.12);
styles.css:913   box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.15);
styles.css:1160  box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.12);
```

蓝色发光让卡片看起来像「贴在屏幕上的塑料片」。新体系只保留 `--shadow-1/2/3`（纯黑低透明度），聚焦环单独定义为 `--focus-ring` 并只用于 `:focus-visible`。

### 3.2 半像素字号

```
styles.css:158   font-size: 13.5px;
styles.css:213   font-size: 13.5px;
styles.css:236   font-size: 12.5px;
```

13.5px 在 1x 屏上会被取整到 13 或 14，不同元素取整结果不同，导致同一行文字基线发毛。全站共 5 种半像素字号。新体系 7 档整数。

### 3.3 字重过载

`700` 出现 18 次、`600` 出现 17 次、`500` 仅 5 次。控制台里 700 用于 13px 正文时，笔画会粘连。新体系只有 400 / 500。

### 3.4 阴影种类失控

三份文件合计 **46 种** `box-shadow` 取值，其中 9 种带蓝色色相。新体系 3 种 + 1 个聚焦环。

### 3.5 间距不在栅格上

`1 / 3 / 5 / 10 / 14` 五种值不在 4 的倍数上（`styles.css` 内 13 种间距取值，5 种离栅格）。视觉节奏散的直接原因。

## 4. lint 违规分布

第一版 lint 只查属性白名单，漏掉了 `border` 简写、`url()` 里的颜色、未定义令牌和内联样式，报出的 1461 项是低估。重写后（颜色改为「任何字面量即违规」，并校验 `var()` 是否存在）基线如下：

| 规则 | 数量 | 说明 |
|---|---:|---|
| `COLOR` | 687 | 硬编码颜色（含 `border` 简写与 `var(..., #fff)` 兜底） |
| `UNDEFINED_TOKEN` | 635 | 引用了不存在的令牌 |
| `SPACING` | 489 | 间距字面量 |
| `FONT_SIZE` | 258 | 字号越界 |
| `INLINE_STYLE` | 257 | 内联样式里的颜色/间距 |
| `RADIUS` | 207 | 圆角越界 |
| `FONT_WEIGHT` | 185 | 字重越界 |
| `HEIGHT` | 102 | 固定高度未令牌化 |
| `IMPORTANT` | 82 | `!important` |
| `MOTION` | 79 | 过渡了非颜色属性 |
| `SHADOW` | 52 | 阴影非令牌 |
| `EMOJI` | 52 | HTML 内 emoji |
| 其余 | 197 | 行高/transform/z-index/effect/gradient 等 |
| **合计** | **3182** | 其中页面 773 项、旧样式表 2409 项 |

新体系：**0**（`tokens.css` + `ui.css` + `style-proof.html`）。

## 5. 迁移顺序与理由

| 顺序 | 页面 | 理由 | 风险 |
|---|---|---|---|
| 1 | `admin.html` | 31 处表格、12 个模态、3 类徽章，表面最全，最容易看出差别 | 后台逻辑多，只改 class 不改数据流 |
| 2 | `index.html` | 主场景，48 个按钮、7 处徽章、步骤条 | 与手动控制窗、视频画布耦合，需单独回归 |
| 3 | `login.html` | 独立、无业务耦合，最后收尾 | 低 |

`manual-control.js` 与 `video-player.js` 涉及画布坐标映射，**不在本轮迁移范围**，只在配色上跟随令牌。

## 6. 不在本轮范围

- 业务逻辑、接口、路由、脚本执行链路一律不动。
- `manual-control` 的触控坐标映射不动。
- 视频画布尺寸计算不动。
- 不引入构建工具、框架、CSS 预处理器。
- 不改 CSP（因此不引入外部字体）。
