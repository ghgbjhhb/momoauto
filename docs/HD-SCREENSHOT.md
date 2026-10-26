# 高清截图

本文描述独立截图接口：SDK / 工具仍默认 REST，高清识别取图需显式指定 `source: 'stream'`，由 FFmpeg 把 SDK H.264 解码成 PNG。控制台的常规实时显示已改为后端转发 H.264、浏览器直接解码，见 [本地控制台](APP.md)，不再轮询此截图接口。PNG 取图必须先具备 FFmpeg：当前主机 PATH 已有；其他环境可设置 `YUNMOMO_FFMPEG_PATH`。取图不使用浏览器截图、剪贴板、ADB 命令、Root 或 OCR。

## 调用

在已建立的 `client` 和 `phone` 上：

```js
try {
  const shot = await phone.screenshot({ source: 'stream', maxSize: 1280, maxAgeMs: 0 });
  // shot.data 是 PNG 字节；直接交给识别器，使用实际 width / height 换算坐标。
  console.log({ source: shot.source, width: shot.width, height: shot.height });
} finally {
  await client.closeScreenshots();
}
```

统一底层工具接口：

```js
const result = await tools.screenshot({ source: 'stream', maxSize: 1280, maxAgeMs: 0 });
if (!result.ok) throw new Error(result.error.code + ': ' + result.error.message);
// result.data.image 为 PNG；保留 width / height / source / decodedAt。
```

`tools.close()` 释放该工具的输入与识别资源，不负责关闭同一 client 可能被其他调用方复用的视频池；全部使用结束时调用 `client.closeScreenshots()`。长期运行可保持池，空闲会自动释放。

| 参数 | 默认值 | 范围 / 含义 |
| --- | --- | --- |
| `source` | SDK 为 `rest`；控制台固定 `stream` | 不做失败后静默降级 |
| `maxSize` | 1280 | 128–4096，视频长边上限，不对 PNG 插值放大 |
| `bitrate` | 4194304 | 262144–16777216，视频码率，不代表无损源 |
| `maxAgeMs` | 400 | 0–2000，可复用的本机解码帧年龄；0 等下一帧 |
| `timeoutMs` | 15000 | SDK 高清截图 1–300000ms；工具受统一总预算约束 |
| `signal` | 无 | 取消当前等待，不中断其他调用方 |
| `udid` | 查询设备信息 | 仅 SDK 支持显式指定，控制台使用已校验列表记录 |

`level` 仅影响 REST。单个 client 最多 16 个并存的视频配置；每个设备与分辨率 / 码率配置复用一个连接和解码进程。建议固定配置，不为每次截图创建 client。冷启动要连接和初始化解码器，缓存命中或已有流通常更快，不能把缓存命中耗时当作独立采集耗时。

## 静止页与失败

静止页可能不再产生 H.264 包。存在截图等待且超过 650ms 无视频包时，定期仅重新配置视频编码器（码率交替相差 1bit/s），触发新帧；不发 HOME、点击或键盘。取帧超时关闭该会话，下一次调用重新连接，不无限复用失败对象。闲置 10 秒释放；显式关闭会取消未完成截图。

原始视频存在有损压缩，PNG 仅避免再次 JPEG 压缩，不代表源视频无损。`decodedAt` / `capturedAt` 均是本机时间，不是设备采集时间；本地解码帧年龄不包含无法测量的上游缓冲。

| 错误码 | 含义 / 处理 |
| --- | --- |
| `DECODER_NOT_FOUND` | 找不到 FFmpeg；检查 PATH 或配置路径 |
| `DECODER_START_FAILED` / `DECODER_EXITED` | 解码进程启动失败 / 异常退出 |
| `DECODER_WRITE_FAILED` / `DECODER_BACKPRESSURE` | 写入失败 / 超过 2MiB 待解码积压，停止使用旧帧 |
| `DECODER_INVALID_IMAGE` / `DECODED_IMAGE_TOO_LARGE` | PNG 结构或尺寸异常 / 32MiB 缓冲上限 |
| `STREAM_AUTH_FAILED` / `STREAM_DEVICE_NOT_FOUND` | 设备信息查询的鉴权或目标错误；不要盲重试 |
| `STREAM_DEVICE_INFO_INVALID` | 设备信息缺少可用 udid |
| `STREAM_CONNECT_FAILED` / `STREAM_CONNECT_TIMEOUT` | 视频连接失败 / 初始化超时；云端握手拒绝不一定能区分鉴权原因 |
| `STREAM_PROTOCOL_ERROR` / `STREAM_DISCONNECTED` | 视频协议异常 / 连接断开 |
| `STREAM_REFRESH_FAILED` / `STREAM_FRAME_TIMEOUT` | 编码器刷新失败 / 没有及时取得新帧 |
| `STREAM_LIMIT_REACHED` | 单 client 已有 16 个视频配置 |
| `STREAM_CLOSED` / `ABORTED` | 会话已释放 / 调用取消 |

SDK 直接调用抛出 `StreamScreenshotError`，不附带 Token / 原始连接 URL。工具返回统一 `error.code / stage / details`；由工具总预算触发的中止仍返回工具自己的 `TIMEOUT / ABORTED`。

## 本机核对：2026-10-16

- 抓取官网“多控”实际请求：`/stream?role=master&maxSize=720&multi=1`，H.264，初始 404×720、1048576bit/s；该入口把请求长边限制到 800。
- 同一设备旧 REST `level=2` 返回 360×640 JPEG。现有 SDK 视频参数可取得 720×1280，无需更改手机分辨率。
- 修改控制台取帧后，五台设备全部返回 720×1280 PNG；四轮并发核对共 20 次全部 HTTP 200。现场数据见 `.local-output/hd-stream-20261016/live-verification.json`，仅代表本次有限现场，不承诺任意网络环境稳定或识别结果准确。
- 未新增测试脚本，未运行测试套件，也未执行手机业务脚本或发送消息。控制台统一为 `http://127.0.0.1:4318/`；2026-10-18 起 `npm run app` 默认使用此地址，停用旧控制台实例。
