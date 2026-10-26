# 截图中的按钮 → 接口

`client` 是 YunmomoClient；`phone = client.device(deviceId)`；`control` 是已连接的 CloudPhoneControl；`view` 是可选的 CloudPhoneBrowserView。

## 底部与右侧

| 按钮/分类 | 接口 | 说明 |
| --- | --- | --- |
| 返回、主页、最近任务 | control.back / home / overview | Android 按键 DOWN + UP；最近任务代码 187 |
| 手机：设备控制 | phone.start / stop / reboot / reset / resetV3；phone.screenshot | 重启需要运行中的 containerId；高清截图 level=2 |
| 齿轮：参数设置 | phone.setDeviceInfo / randomDeviceInfo / randomFingerprint | 真机参数 JSON、随机真参、随机指纹；不是普通 Android 设置按钮 |
| 麦克风：音频 | phone.listFiles；phone.playAudio(path) / stopAudio(path) | 选择云机 /sdcard/ 下的 MP3 并播放/停止，不是网页麦克风输入 |
| 铃铛：音量 | control.volumeUp / volumeDown | Android 键码 24 / 25 |
| 编辑：重命名 | phone.rename(name) | 修改后台设备名 |
| 眼睛：尺寸管理 | control.setStreamSize(size)；view.setSize(size) | 前者只改视频参数；后者改网页窗口并触发视频参数变化 |
| 连接：VPC 代理 | phone.getProxy / setProxy / stopProxy | version='legacy' 对应旧版，'v1' 对应新版；phone.restartVpc 重启插件 |
| 上传：谷歌证书 | phone.uploadGoogleCertificate(data, {fileName}) | multipart；支持 .cert/.xml，deviceList 为重复字段 |
| 文件夹：文件管理 | client.uploadCloudFile；phone.sendFiles；phone.listFiles / downloadFile | 网页“文件管理”当前的二级按钮是“上传文件”；SDK 另提供文件列表/下载 |
| 页面中按权限出现的镜像、改机等 | client.invoke(action, 原始payload) | 见 API 文档的后台动作表，复杂字段不自行猜测 |

普通文件上传走“上传到云盘 → 获取可传输 URL → sendFiles”的后台流程。`control.pushFile` 是 qk 独立的 APK 推送通道，不等同于网页文件夹上传；推送确认也不等于 APK 已安装。

设备控制中的分享、取消分享、转移设备、移动分组，以及钛备份、尺寸预设编辑等较复杂的子菜单，可用 `view.openSidebarAction(category, item)` 打开当前网页实际存在的入口。它返回 `dispatched: true` 只表示点击已发出；可能仍停在表单/确认框，不代表后台动作完成。它不会自动分享、转移或确认重置。

## 顶部“…”与刷新

| 页面选项 | 网页接口 | 独立脚本中的对应行为 |
| --- | --- | --- |
| 功能栏开关 | view.setPreferences({showSideToolbar: true/false}) | 纯网页布局，Android 没有这个命令 |
| 自动复制 | view.setPreferences({autoCopy: true/false}) | control.setAutoCopy(callback/false)，把手机剪贴板更新交给回调，不擅自覆盖电脑剪贴板 |
| 自动刷新 | view.setPreferences({autoRefresh: true/false}) | control.setAutoRefresh(true/false)，断线后重连，不重放点击/上传 |
| 刷新图标 | view.refresh() | control.refresh()，重建视频/控制连接，不重启手机 |
| 尺寸滑条 | view.setSize(size) | 240–800、16 像素步长；control.setStreamSize 接受更宽范围的视频上限 |

网页显示层需要调用方传入自己已登录的 Playwright Page；SDK 不连接/窃取 Chrome 登录态。示例：

~~~js
const { CloudPhoneBrowserView } = require('D:/AA-project/自动化');
const view = new CloudPhoneBrowserView(page, { udid: '目标 udid' });
await view.setPreferences({ showSideToolbar: true, autoCopy: true });
await view.setSize(720);
await view.openSidebarAction('文件管理', '上传文件'); // 打开上传对话框，不上传任何文件
~~~

另外补齐的 qk 控制：expandNotifications、expandSettings、collapsePanels、rotate、screenPower、getClipboard、setClipboard、paste、setVideoSettings。`control.expandSettings()` 打开快捷设置栏，与侧栏“参数设置”完全不同。

2026-10-12 已在指定的第三台 SF 上验证当前账号可见的侧栏入口、音量子操作、网页刷新、尺寸和三个偏好开关；不把“打开窗口”视为“业务提交成功”。实际上传、证书安装、改机、代理设置等仍未执行。详见 [实机测试报告](LIVE-TEST-2026-10-12.md)。
