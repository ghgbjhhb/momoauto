# 网页云机视频带宽与画质

## 实际链路

云机 H.264 编码器 → Windows 视频网关 `src/server/video-stream.js` → 已授权浏览器的 WebSocket → 浏览器 WebCodecs 解码。

**Windows 网关协商低画质视频，再转发已经压缩的 H.264**。不进行二次 FFmpeg 解码、模糊、重新编码，避免额外 CPU、延迟和上游带宽浪费。这与“先以原画质传入 Windows，再压缩出站”不同，但更符合节省流量的目标。

## 默认网页视频档位

- 目标分辨率（720×1280 的竖屏）：**432×768**，保留原始宽高比；其他尺寸按较短边 432、较长边 768 的上限等比例缩小，并按 16 像素对齐。
- 目标 H.264 码率：**900,000 bit/s**，旧值为 8,388,608 bit/s。
- 最大帧率：**12 FPS**，旧值为 15 FPS。
- 实际视频大小和带宽依平台编码器、画面变化、关键帧等因素变化。目标码率与旧值相比下降约 89%，**不能当作已经测到的流量节省**。

这套参数只在 `createVideoStreams()` 中设置，同时供 `/api/video` 的浏览预览和 `/api/control` 的手动操作窗口使用，且相同设备/平台身份的观众复用一条上游流。

**脚本自动化截图/OCR 不走此设置**：`src/stream-screenshot.js` 使用独立的截图流参数；`src/tools/screenshot.js` 也仍可使用 REST/独立截图，因此不能降低 OCR 用图的像素质量。

## 验证与部署

1. 修改的是 Windows Node.js 视频网关的配置；**必须在确认没有正在运行的脚本、AI/手动控制及观看者后重启应用服务**。仅刷新浏览器不会让旧 Node.js 进程加载新配置。
2. 用已授权用户打开一台真实云机视频，通过 WebSocket `ready` 包观察 `bitrate`、`maxFps` 和 `bounds`；同时观察 H.264 解码是否正常、画面比例是否正确、触摸是否匹配。
3. 在相同云机、相似画面和相等时间窗口内测量 `/api/video` 或 `/api/control` 的实际 WebSocket 二进制字节数，和旧配置对照；不同画面活动强度无法直接比较。
4. 如出现画面明显不可读或掉帧，调整 `src/server/video-stream.js` 中的 `SETTINGS` 与长短边上限。不要通过压缩服务端 OCR/截图通道提高网页带宽。

## 上游开源参考

- [Genymobile/scrcpy 视频设置文档](https://github.com/Genymobile/scrcpy/blob/master/doc/video.md)：分别控制最高分辨率、视频码率和最高 FPS，并说明尺寸缩小带来的性能收益。
- [noVNC API](https://github.com/novnc/noVNC/blob/master/docs/API.md)：远程桌面按连接协商画质与压缩，不把浏览器 CSS 缩放当作网络压缩。

## 安全约束

不导出平台 Token、原始云机画面或用户截图作为公开调试材料。监控传输量只计算字节数，不保存内容。严禁为了验证而擅自执行云机脚本。
