# 示例与兼容入口

正式业务入口在 [flows](../flows/README.md)，实现位于 `src/workflows`。此目录不再承载正式实现，旧路径保留转发，避免原命令失效。

基础 SDK 示例为 `basic.js`、`control.js`、`capabilities.js`、`management.js`、`live-check.js`；底层工具示例为 `device-tools.js`、`open-momo.js`。

`send-all-cloud-files.js`、`upload-google-certificate.js`、`*-to-first.js`、`change-model-reset.js`、`add-vpc-network.js` 等旧入口不再是修改业务逻辑的位置。固定第一台/第三台的历史入口只用于兼容；新代码使用显式设备 ID。
