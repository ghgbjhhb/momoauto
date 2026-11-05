# 管理后台：TDesign 风格重构

## 设计依据

- 腾讯 TDesign 设计价值观：https://tdesign.tencent.com/design/values
- 腾讯 TDesign 版式与布局：https://tdesign.tencent.com/design/layout
- TDesign Starter：https://tdesign.tencent.com/starter
- 官方开源 Starter：https://github.com/Tencent/tdesign-vue-next-starter

TDesign 的四项价值观是「包容、多元、进化、连接」。

- **包容**：不同屏幕尺寸有不同合适的导航方式，宽表格仅在表格区域滚动。
- **多元**：保留云机、用户、卡密、资源、接码、AI 和日志各自需要的专有控件。
- **进化**：从原生 HTML 和 JavaScript 逐步升级，统一在设计令牌下迭代视觉，不强制更换业务架构。
- **连接**：跨业务的分组导航、页面标题/说明、快捷入口和一致的账户管理。

参考官方品牌蓝 #0052D9、白色容器、柔和灰阶、细分割线、紧凑的表单与清楚的内容层级。所有颜色集中在 app/tokens.css，用 data-admin-theme=tdesign 仅作用于后台。

这是 TDesign 设计风格的实现，不是安装 TDesign Vue 组件库。原后台使用原生 HTML/JS，为避免破坏业务事件链，没有引入新框架或第三方依赖。

## 信息架构

原来九个平铺入口，改成四个可折叠领域：

| 一级分组 | 页面 | 原路径 |
|---|---|---|
| 设备与资源 | 设备控制台、设备池与分配、资源云盘 | /admin/cluster、/admin/pool、/admin/disk |
| 用户与运营 | 用户管理、卡密与权益、接码平台 | /admin/users、/admin/cards、/admin/sms |
| AI 工作台 | AI 调试对话、模型与供应商 | /admin/assistant、/admin/ai |
| 运行维护 | 系统运行日志 | /admin/logs |

原始九条路由、业务面板和表单 ID 全部保留。一级分组使用原生 HTML details，浏览器原生可访问、键盘可操作。当前页面所在领域自动展开，浏览器前进/后退与原导航行为不变。

页面框架为顶部品牌及账户菜单、左侧四个领域、内容区面包屑与页面标题、AI 调试及运行日志的快捷入口。<=900px 使用同一导航树的侧边抽屉；窄屏宽表格在卡片内滚动。

## 改动范围

- app/admin.html：更新管理员全局页面布局和菜单，不删除业务内容。
- app/admin/base.js：更新标题和导航分组联动，增加移动菜单开合与常用入口导航，保留原功能加载器。
- app/admin-tdesign.css：新的后台视觉层。
- app/tokens.css：限定管理员主题的令牌。
- app/admin.css：删除只给 AI 调试页生效的旧手机导航缩窄特殊规则。

## 验证与限制

实际 Chrome 在 1704、1440、1280、1024、820、390 宽度做布局检查，并且在桌面与 390px 窄屏检查了全部九个页面。四个业务分组和九个路由均保留，未发生页面级横向溢出；宽表格独立滚动。JavaScript 静态语法和 UI token lint 已检查。

由于没有用户登录会话，本次没有调用真实业务管理 API 的写操作，也没有运行真实云机或模型。静态布局验收不等于真实业务的端到端验收。所有服务端处理器和用户版控制台维持原状；管理员静态资源刷新即可生效，不需要因此重启 Node。
