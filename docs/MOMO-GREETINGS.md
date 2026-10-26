# MOMO 打招呼页面处理

入口：`flows/12-momo招呼.js`（或 `src/workflows/momo-greetings.js`）；SDK：`tools.processMomoGreetings(options)`。
当前脚本定位为在打招呼页面内直接执行处理的纯操作工具，仅负责三项核心操作：
1. 识别当前页面是否为打招呼页面；
2. 点击“通过”或“拒绝”以完成次数；
3. 点击返回键退出。

## 调用

```powershell
$env:YUNMOMO_DEVICE_ID = '<目标设备ID>'
node src/workflows/momo-greetings.js
# 以下才实际操作手机，需现有登录凭据
node src/workflows/momo-greetings.js --execute
node src/workflows/momo-greetings.js --execute --max-approved 6
```

```javascript
const result = await tools.processMomoGreetings({ execute: true, maxApproved: 6 });
if (!result.ok) {
  console.error(result.error.code, result.error.stage, result.error.details);
} else if (result.data.rateLimited) {
  // 遇到频控，已自动点击返回键退出，上层决定后续重试
}
```

## 状态与执行规则

1. **识别当前页面是否为打招呼页面**：
   - 启动后直接观察当前屏幕。只有检测到底部完整的“通过”与“拒绝”按钮、顶栏打招呼标题或明确的空态标记时，才确认为打招呼页面。
   - 若当前页面不是打招呼页面（如停留在消息列表、首页流或其他聊天详情），在短时确认后抛出 `MOMO_NOT_ON_GREETINGS_PAGE` 错误并立即停止，不盲目下发任何点击或返回手势。
2. **点击“通过”或“拒绝”以完成次数**：
   - 默认通过 90%、拒绝 10%；卡片间拟人阅读等待 1.2–2.5 秒。
   - 按钮点击严格在识别框中心 50% 宽高区域内采样（内缩 1px），确保 100% 命中核心胶囊区，不触发外围或更多按钮。
   - 达到目标次数（默认通过 6 人）或卡片全部处理完毕/触发频率限制后，结束卡片循环。
3. **点击返回键**：
   - 无论达到次数限制、卡片全部处理完毕，还是触发“发送过于频繁”提示，在卡片操作结束后均统一下发一次系统返回键退出打招呼页面。不再冗余核验并停留在消息列表。
4. **频率限制保护**：
   - 识别到频率限制提示后，立即点击返回键退出打招呼页面，终止本次调用。返回 `data.outcome: 'rate_limited'`、`data.rateLimited: true`。

## 参数、预算与结果

- `execute: false` 默认预览，`dryRun` 也会阻止真实执行。
- `maxApproved: 6`（1–50）：单次目标通过次数。
- `approveProbability: 0.9`；未传 `rejectProbability` 时取互补值（0.1）。
- `cardWaitMs: {min: 1200,max: 2500}`；`stepTimeoutMs: 20000`、`settleMs: 800`、`pollMs: 300`。
- `centerFraction` 默认 `.5`、`centerProbability` 默认 `1`、`insetPx` 默认 `1`。
- 常见错误：`MOMO_NOT_ON_GREETINGS_PAGE`、`MOMO_GREETINGS_PAGE_NOT_READY`、`MOMO_GREETINGS_NOT_COMPLETED`、`MOMO_RECOGNITION_FAILED`、`TIMEOUT`、`ABORTED`。

主要实现：`src/tools/momo/greetings.js`、`greetings-layout.js`；CLI：`src/workflows/momo-greetings.js`。
