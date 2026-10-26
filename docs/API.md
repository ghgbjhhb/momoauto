# API 参考（0.3.0）

云盘及 VPC 网络管理新增 `client.cloudDisk()`、`client.vpc()`，详见 [管理接口与参数](MANAGEMENT.md)。它们管理云盘文件和已保存的 VPC 线路；手机自身的文件系统、当前代理仍使用 `phone.listFiles()`、`phone.getProxy()/setProxy()`。

所有 deviceId、containerId、udid 都是字符串；19 位设备编号不要转换为 Number。令牌通过构造参数或 YUNMOMO_TOKEN 传入，不要打印 buildWebSocketUrl 返回的原始 URL。

## client / phone

~~~js
const { YunmomoClient } = require('D:/AA-project/自动化');
const client = new YunmomoClient({ token: process.env.YUNMOMO_TOKEN, timeoutMs: 100000 });
const { records, total, raw } = await client.listDevices({ current: 1, size: 100 });
const phone = client.device('目标 deviceId');
const info = await phone.getInfo();
const control = await phone.openControl({ udid: '目标 udid' });
~~~

listDevices 支持 filters；phone.openControl 只创建客户端，不连接。省略 udid 时会查询设备信息，不能解析就报错，不自动选择另一台。`client.openControl({deviceId, udid})` 是同步创建的旧式入口，仍兼容。

后台方法一般返回原始 JSON，不虚构“已经执行成功”的状态。截图/下载返回 `{data: Buffer, contentType, status}`；screenshot 默认 level=2，并检查返回内容是图片。

高清帧使用 `phone.screenshot({ source: 'stream', maxSize: 1280 })`，另返回 `source / width / height / decodedAt`；需要本机 FFmpeg。连接复用，闲置 10 秒关闭，也可显式 `await client.closeScreenshots()`。旧 REST 默认不变，详见 [高清截图](HD-SCREENSHOT.md)。

| 设备方法 | 参数 | 后台字段 |
| --- | --- | --- |
| start / stop / reset | 无 | GET id |
| reboot | containerId | POST id、containerId |
| resetV3 | countryCode | POST id、countryCode |
| countryCodes | 无 | GET id；返回原始 {count, list} 国家代码列表 |
| switchModel | {modelId, modelName, resetData?, countryCode?} | POST id、modelId、modelName、resetData、countryCode；resetData=true 时必须有 countryCode |
| rename | name | GET id、name |
| setDeviceInfo | {devinfo, brand?, marketName?, model?, androidVersion?} | POST deviceId、devinfo JSON 字符串等 |
| randomDeviceInfo / randomFingerprint | 无 | GET id |
| listFiles | path，默认 /sdcard/ | POST id、path；保持原始文件列表返回值 |
| downloadFile | path | POST id、path，二进制结果 |
| playAudio / stopAudio | 云机绝对 MP3 路径 | POST id、act=play/stop、path |
| setProxy | config、version='v1' | id、s5ip、s5port、s5user?、s5pwd?、domainMode?、proxyMode?、expTime? |
| getProxy / stopProxy | version='v1' 或 'legacy' | GET id |
| restartVpc | 无 | GET id |
| uploadGoogleCertificate | data、{fileName, timeoutMs?} | multipart file、重复 deviceList |
| sendFiles | urls、{fileType} | POST devices、urls、fileType |

reset、resetV3、换镜像可能删除数据；方法只在调用时发请求，不做启动时的隐式操作。代理配置与 devinfo 可能有平台特定要求；服务端权限/业务校验仍然生效。

### 普通文件与云盘

`client.uploadCloudFile(Buffer, {fileName, fields?, timeoutMs?})` 使用网页 upload API `/screen/file/scFile/save`；它是云盘上传的低层封装，fields 透传原上传表单字段。当前未实机验证其完整业务字段/返回 URL 形状，不能把它当成“一步上传到手机”。

`client.invoke('previewFile'/'previewTemporaryFile', {uploadPath, name})` 对应 `/file/preview`、`/file/previewTmp`。获取平台可用的下载 URL 后，调用 `phone.sendFiles(urls, {fileType})` 下发。fileType 必须显式给出：源码可确认 auto、install、image；其他值以页面字典为准，不猜测。auto/install 可能安装应用。sendFiles 的返回代表任务提交，不代表传输完成。

`client.invoke('sendStatus', 原始查询参数)` 可查询传输任务。任务标识字段要以实际返回/页面为准，本版本没有猜造任务 ID 或轮询结果。

### 后台原始动作

`client.invoke(action, payload, {timeoutMs?, signal?, responseType?})` 按已确认的 HTTP 方法和路径发请求，payload 的原始业务字段需由调用方提供。GET 编码为查询参数；POST 编码为 JSON。`phone.invoke` 只额外绑定 id 字段；deviceId/deviceIdList 等字段形状不同的复杂动作建议用 client.invoke。

可用动作全部导出在 `BACKEND_ACTIONS`，或运行 `npm run capabilities`：

~~~text
start stop reboot rename reset resetV3
setDeviceInfo randomDeviceInfo randomFingerprint randomDeviceInfoAsync
setAudio setAudioMute
setProxyLegacy stopProxyLegacy getProxyLegacy setProxy stopProxy getProxy restartVpc
updateResolution updateImage importImage switchModel cleanLock cleanScreenError countryCodes
listFiles downloadFile sendFiles sendStatus previewFile previewTemporaryFile
~~~

例如 updateImage 的前端字段为 deviceId、imageAddr、resolution、width、height、dpi、isSaveData、dns；switchModel 为 id、modelId、modelName、resetData、countryCode。这里保留透传而非给参数补臆测默认值。

`countryCodes` 必须传设备 id：优先用 `phone.countryCodes()`，或 `client.invoke('countryCodes', {id: deviceId})`。不带 id 的真实请求返回 HTTP 500，不能把它当成全局字典接口。

### 改机重置（2026-10-13 核对网页）

`client.listModels()` 读取 `/screen/box/mytBox/getModelList`，返回 `{records, raw}`；每项有 `id/name/androidVersion`。原始列表还包含网页没有展示的版本，独立脚本只选择当前网页的 Android 10、14、16。`phone.switchModel()` 绑定当前设备 `id`，发送网页相同的五个字段；调用本身不会自动选机型或国家。

~~~js
const { prepareChangeModelReset, submitChangeModelReset } = require('../examples/change-model-reset');
const plan = await prepareChangeModelReset(client, '目标设备 ID', { countryCode: 'CN', androidVersion: '16' });
console.log(plan.model, plan.country); // 只读准备：已校验设备、机型与国家
// 明确需要改机并清数据时，调用：await submitChangeModelReset(client, plan);
~~~

国家默认 `CN`，其他国家使用同一个字段提交；机型默认限定 Android 16 内随机。后台实机验证拒绝跨安卓大版本的机型，改机并非升级/降级安卓系统，其他系统版本需要显式指定同版本机型。脚本始终 `resetData: true`；网页说明改机成功后 30 秒自动重置，前端没有另行调用重置接口。接口返回不等于清数据/重启已完成。脚本入口和参数见 `flows/README.md`。

`client.request(relativeBackendPath, options)` 可扩展自己核对过的后台接口。限制在 baseUrl 的 origin 和 /backend 路径内；禁止自动跟随重定向，防止 token 被带给另一个服务。HTTP 错误抛 YunmomoHttpError，status/data 可检查；success=false 也抛业务错误；其他平台特有状态需调用方解释。

## control：视频通道上的手机输入

~~~js
await control.connect({ timeoutMs: 15000 });
try {
  await control.tap(100, 200, { durationMs: 50 });
  await control.longPress(100, 200, { durationMs: 800 });
  await control.swipe({x: 100, y: 500}, {x: 100, y: 100}, {durationMs: 500, steps: 12});
  control.paste('中文内容');
  control.pressKey('ENTER');
} finally { await control.close(); }
~~~

connect 默认同时等待 WebSocket OPEN 与 `scrcpy_initial`，并发送视频配置。只有 OPEN 不代表设备已准备好。`waitForInitial:false` 只用于诊断，不建议用于自动化任务。

screenWidth/screenHeight 跟随初始元数据的 videoSize；坐标是整数，x∈[0,width-1]、y∈[0,height-1]。网页鼠标坐标需要按显示画面与视频尺寸换算。越界直接报错，不默默点击别处。

tap、longPress、swipe 返回 Promise，单个 control 内串行执行。durationMs 为 0–60000，steps 为 1–1000；可传 AbortSignal，取消时尽可能发送 UP。断线失败，不自动补发手势。直接 touch 是低层接口，调用方自行配对 DOWN/UP，不与排队手势混用。

text 发送 TYPE_TEXT，中文/输入法场景优先 paste。paste 等价于 setClipboard(text,{paste:true})；setClipboard 默认 paste=false，仅设置剪贴板。pressKey 接受 Android 数字键码或 HOME、BACK、APP_SWITCH、ENTER、A 等名称；keyDown/keyUp 可分别使用。

导航、按键、文本、面板、旋转、视频参数方法同步返回 control，表示帧已加入发送通道，不代表 App 已经完成处理。`await control.flush()` 只确认本地 WebSocket 写出顺序；需要通过截图/界面断言检查真正效果。

getClipboard({timeoutMs=10000, signal?}) 等待剪贴板回包，并串行化并发读取。协议没有请求编号，异步剪贴板变化与请求回包不能绝对区分；业务需要严格一致性时，请减少并发变更。

### 连接、视频与事件

| 方法/事件 | 意义 |
| --- | --- |
| ready / screen-info / initial | 已收到设备初始信息；initial 为原始 Buffer |
| video | 原始 H.264 流数据，不是图片；SDK 不解码 |
| clipboard | 手机剪贴板文本更新 |
| connection-error / protocol-error | 连接/协议错误，错误文本不会附带 token |
| close | {code}；不转发可能包含凭据的远端 reason |
| file-progress / file-response | 推送字节进度 / 协议确认 |
| reconnect-scheduled / reconnect-exhausted | 重连排期 / 连续失败重试耗尽 |
| copy-error | 自动复制回调失败 |

setAutoRefresh(true,{delays:[500,2000,5000,10000,30000]}) 启用有限退避重连；默认关闭。重连重发视频配置，不重放点击、按键、文本、上传。显式 close 停止重连；refresh = close + connect。

setAutoCopy(callback) 接收剪贴板推送；传 false 关闭。回调由调用方实现，SDK 不修改电脑剪贴板。网页 autoCopy 开关是另一层，通过 browserView 操作。

setVideoSettings 接受 bitrate、maxFps、iFrameInterval、bounds、crop、lockedVideoOrientation、sendFrameMeta、codecOptions、encoderName。displayId 由连接绑定；初始默认 bitrate=524288、maxFps=60、iFrameInterval=15、bounds=720×720。

setStreamSize(size) 对齐到 16 的倍数，并发送与网页 size-change 相同的方形上限/视频配置；不修改云机 Android 的物理分辨率，也不直接改变 Chrome 弹窗大小。随后坐标尺寸以新的 screen-info 为准。

### APK 推送

~~~js
const result = await control.pushFile('D:/packages/demo.apk', { chunkSize: 65536, timeoutMs: 10000 });
// 或 pushFile(Buffer, {fileName:'demo.apk'})
~~~

APK 最大 300 MiB，按 NEW→START→APPEND→FINISH 每一步等待设备确认，失败尝试 CANCEL。路径模式当前会将文件读入内存，大文件应留意内存占用。返回 `{id,fileName,bytes,acknowledged:true}` 表示传输确认，不证明安装成功。普通图片/音频/文件用后台传输接口，不走这个 APK 通道。

## browserView：网页选项和全部侧栏入口

需要调用方传入自己管理的已登录 Playwright Page，目标弹窗已打开，按 udid 精确定位，不按“第一台”操作。没有安装/依赖新的 Playwright 包；只有使用这一层时，调用方才需提供页面。

- setPreferences({showSideToolbar?,autoCopy?,autoRefresh?}) 操作“…”菜单并读回开关状态。
- setSize(size) 操作网页尺寸滑条并读回尺寸；240–800，步长16。
- refresh() 点击顶部视频刷新，不执行后台 reboot。
- openSidebarAction(category,item?) 操作 TOOLBAR_ITEMS 中的分类及当前可见二级按钮。账户权限决定可用项；不存在则报错，不绕过权限。

openSidebarAction 返回的是点击已调度，不是业务完成。分享、转移、上传等通常打开表单；重启/重置可能打开确认框。调用方仍需在明确授权的业务脚本中填写、确认并验证结果，本接口不会自动接受这些确认。

本层目前只经过前端结构核对与 mock 测试，尚未完成真实 Chrome/云机逐项联调。
