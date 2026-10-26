# MOMO 消息列表持续监听框架

## 当前职责

`src/tools/momo/message-list-watcher.js` 提供两种模式：默认只观察，以及显式开启执行的联系人清扫。

1. 通过 `src/automation/page-service.js` 获取同一张新鲜截图上的页面模型、OCR 和消息列表模型结果。
2. 只有同时确认 `app=momo`、`page=message_list`、`scene=normal`、`overlay=none` 时，才进入候选扫描。
3. 复用 `models/识别app页面`、`models/01_消息列表页识别模型`，将 `unread_badge` 与 `chat_card` 按几何位置关联。
4. 红点没有 OCR 数字时，状态为 `unknown`，不会被误判为 `unreadCount=0`。
5. 首次运行默认建立基线，不处理启动前已有的红点；之后新出现或角标/摘要发生变化才触发回调。
6. 每个联系人动作前都重新确认目标页；默认监听器不自行点击、返回或发送消息，只有显式执行清扫才会操作设备。

列表顶部唯一特征已记录为：顶栏“消息”、同时出现的“语音聊天”和“视频匹配”推广卡片、“互动通知”，以及后续“最近在线”分区。缺少任意一项都不确认是首屏。OCR 会先做空格/标点规范化，并允许单字符编辑距离或一个附加字符；这只是同一组顶部特征的识别容错，不会放宽为其他页面特征。

## 红点与未入库联系人清扫模式

当需要处理列表中所有可见和可滚动发现的红点及未入库联系人时，使用显式执行开关：

```powershell
npm run momo:watch -- --device-id <ID> --drain --execute
```

每轮执行的顺序是：

1. 新鲜观测并确认当前是 `momo/message_list/normal` 且没有遮挡层。
2. 先用手指从上往下滑，让列表内容向下滚动并回到列表顶部；再用手指从下往上滑，让列表内容向上滚动，逐屏扫描到列表底部。
3. 识别当前视口全部联系人姓名；红点联系人作为回复候选，数据库中没有成功同步记录的联系人作为入库候选。
4. 每次点击前重新观测并重新定位同名联系人，不复用旧坐标。
5. 点击联系人后重新确认 `momo/chat_detail/normal` 且没有遮挡层。
6. 如果联系人尚未入库，调用现有 `tools.syncMomoContacts({ currentChatOnly: true })`，读取聊天历史并写入设备 SQLite。
7. 如果联系人有红点，调用现有 `runMomoAiReplyOnce()`：识别新增消息、写入 ReplyStore，并生成发送 AI 回复。
8. 通过受限返回流程回到消息列表，再继续扫描；到达底部后向下回到顶部做复核。

`--drain` 不带 `--execute` 时只返回 `EXECUTION_REQUIRED`，不会滑动、点击或进入联系人。扫描有明确预算，默认最多 30 个列表视口、3 轮复核、100 个联系人，可用 `--max-pages`、`--max-rounds`、`--max-contacts` 调整。数据库路径可用 `--db-path` 指定，默认按设备选择 `.runtime/momo-data/devices/.../momo.sqlite`。遇到页面确认失败、关键弹窗、点击失败、入库失败或无法返回列表时会停止并返回失败，不会继续盲操作。

## 启动

```powershell
$env:YUNMOMO_TOKEN = '...'
$env:YUNMOMO_DEVICE_ID = '...'
npm run momo:watch
```

也可以显式设置轮询周期和首次基线策略：

```powershell
npm run momo:watch -- --interval-ms 3000 --baseline skip
npm run momo:watch -- --baseline process --iterations 1
```

默认监听循环和红点清扫循环都通过 `DeviceArbiter` 独占设备，避免与手动控制台或 Brain 同时写入同一台云机。

## 自动回复调用位置

预留入口位于 `src/workflows/momo-message-watch.js` 的 `onUnreadCandidate()`：

```js
await event.withTargetPage(async ({ tools, candidate, observation }) => {
  // 在这里接入后续的进入聊天、读取消息和自动回复流程。
});
```

`withTargetPage()` 会在调用回调前重新截取并确认目标页面，同时重新定位同名未读候选；不能复用事件产生时的旧坐标。具体发送动作仍应继续使用现有的聊天页、联系人和发送证据校验。

红点清扫模式的回复入口是 `onUnreadContact(context)`。默认实现调用现有 `runMomoAiReplyOnce()`，复用当前设备租约和控制通道；该流程会先用 `readAndAlignRecentMessages()` 找出新增聊天消息并写入 ReplyStore，再按现有 AI 回复闭环生成、发送和验证。需要替换回复策略时，可以在 `runMomoMessageWatch()` 传入同名回调；自定义回调仍应先调用 `await context.assertChatDetail()`。

未入库联系人的入口是 `onUnregisteredContact(context)`。默认实现已经调用现有 `tools.syncMomoContacts()` 的当前聊天页模式；如需替换入库策略，可以在 `runMomoMessageWatch()` 传入同名回调。两类条件同时满足时，先执行入库，再执行回复回调，且两次回调之间都会重新确认聊天详情页。
