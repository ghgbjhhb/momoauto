# 证据与验证边界

核对时间：2026-10-12。来源是用户指定网页的公开前端脚本，不是厂商后端源码。

- 管理页：[云 momo 我的云机](https://cloud.yunmomo.com/#/screen/device/ScDeviceView)
- 控制页：[qk 云机串流](https://qk.yunmomo.com/)
- 控制 bundle：bundle.js，SHA-256 `BDBDDFD275C669E6BBDAF24433ED8CF1A99D9FD129A57F1712AD05D0FFDD6CF9`。
- 管理侧栏：7991.33f90487.js 的 DeviceSideToolbar/ScDeviceIframe；2983.574d7b3e.js 的菜单构造。
- 后台方法：5013.6aba01e6.js；音频/文件：7269.16cd581d.js；文件传输：5818.0ab73389.js；参数/证书/代理各自的公开表单组件。

下载的公开脚本保留在 .research/ 供本机核对，不包含用户登录令牌、不进入 SDK 打包文件。本次未将已登录 Chrome 的 token 写入源码或配置文件。

## 已确认到哪一层

网页使用 `/backend` REST，token 请求头；WebSocket 是 `wss://qk.yunmomo.com/?action=proxy-adb&remote=tcp:8886&udid=...&token=...&deviceId=...`。SDK 按此协议构造控制帧。

qk 模块 6807 的触控编码、2839 的滚动编码、902 的按键编码、6629 的命令编码、362 的视频配置、1843 的设备回包，以及 5567/7177 的上传状态机，是编码/解码与本地回归测试的依据。

| 类型 | 帧布局 |
| --- | --- |
| key 0 | 14 字节：type、action、keycode/repeat/metaState 各 int32BE |
| touch 2 | 29 字节：type、action、pointer 高32位=0、低32位、x/y、width/height、pressure、buttons，最后1字节补零 |
| scroll 3 | 21 字节：type、x/y、width/height、hScroll/vScroll int32BE |
| command 4–8/11 | 单字节命令 |
| clipboard 9 | type、paste、UTF-8 字节长度、文本 |
| screen power 10 | type、布尔值字节，与网页编码一致 |
| video settings 101 | type + 35字节基础设置 + codecOptions/encoderName UTF-8扩展 |
| file push 102 | type、int16 id、state；START 名称/大小，APPEND 字节块；NEW/FINISH/CANCEL 无额外数据 |

`scrcpy_initial` 后包含64字节设备名、显示列表、ScreenInfo、VideoSettings、编码器列表、clientId。`scrcpy_message` 后的 type=0 为剪贴板文本，type=101 为 int16 id + int8 状态码，不能当成视频数据。

网页普通鼠标点击与 SDK 点击在控制帧类型、字段和编码上可使用同一条通道。这不证明两者所有时间采样完全一样，也不证明后端注入方式或 App 收到的 input source、toolType、deviceId 一定相同。

没有直接检验莫云腾 Android 服务端实现，也没有在测试 App 中读取 MotionEvent.getSource()/getToolType()/getDeviceId()/pressure 等字段。因此不能据此保证事件一定标记为物理手指，或者软件完全不能识别自动化。后端品牌相同也不能代替当前版本的实际测量。

## 本地验证

真实登录令牌没有被传入本地 SDK 完成全部联调，上传/代理/参数/证书、复杂原始后台动作的完整业务字段与服务端效果仍须在真实云机上端到端验证。已有网页层动作的验证不能被当作直接 Node WebSocket 的验证。

可运行 `npm run check:live` 检查自己的当前目标设备；如果缺令牌会明确失败，不把模拟结果报告为实机成功。该脚本不发送触控/按键，不执行重置、安装、分享或转移。
