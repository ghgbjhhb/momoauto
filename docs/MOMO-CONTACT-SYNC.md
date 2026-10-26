# MOMO 联系人及消息入库

脚本只处理已经打开的某个聊天页，联系人姓名必填。它先确认聊天标题，再读取当前消息，确认已到最新位置，向历史顶部逐页采集并拼接，最后一次性保存。它不会打开联系人列表、切换联系人或点头像。

## 怎么运行

网页“13 MOMO联系人及消息入库”只需填写联系人姓名并运行。也可在命令行运行：

```powershell
$env:YUNMOMO_DEVICE_ID = '<云机 ID>'
node flows/13-momo联系人及消息入库.js --execute --contact-name "小飞"
```

真实执行前，要先在手机上打开这个联系人的聊天页。SDK 调用示例：

```javascript
const result = await tools.syncMomoContacts({ execute: true, contactName: '小飞' });
```

姓名是必填项，且必须和可读的聊天标题一致。默认预览不会操作手机或写数据库；只有显式执行才会采集。

## 采集过程

1. 对当前画面截图，并用标题、聊天页控件及聊天页识别确认联系人和页面。
2. 只有同时识别到 AI 助手面板和面板内关闭按钮，才点击关闭；只有一个 X 时不点击。
3. 按粉色/白色气泡及其轮廓识别我方/对方气泡，再把 OCR 文字映射到气泡。未确认的文字重读原截图；仍读不清时停止入库并保留现场。
4. 过滤时间戳、关注/招呼提示、资料卡和非文字表情。动画不作为消息、稳定性或翻页依据。
5. 先确认最新消息位置，再从最新处向历史顶部读取。每次只按相邻画面的气泡文字、发送方、位置和顺序拼接重叠部分；无法衔接就重读或停止，不猜缺失内容。
6. 只有顶部也经稳定复核后才提交联系人和消息。保存的聊天记录字段只有发送方和文字，时间及气泡坐标不作为消息内容。

完整采集需要同时确认最新端和历史顶部。报告中的 `bottomConfirmed` / `topConfirmed` 分别说明两端是否经过复核；只有两端确认后才会完成写库。没有读到任何聊天文字且没有明确历史起点时停止，避免把空画面当作成功。

## 截图和失败现场

执行时会在 `.local-output/momo-sync/run-<编号>/` 保存每一次截图，以及对应的 OCR、气泡、过滤原因和复读结果 JSON。`collection.json` 记录最终收集顺序。失败不会提交一份不完整的会话。

常见错误含义：

| 错误 | 含义 |
| --- | --- |
| `MOMO_CONTACT_NAME_REQUIRED` | 没有传联系人姓名 |
| `MOMO_CHAT_NOT_READY` | 页面或联系人身份未能确认 |
| `MOMO_CHAT_TEXT_UNREADABLE` | 已确认文字气泡多次重读仍读不清 |
| `MOMO_CHAT_NOT_SETTLED` | 画面仍在变化，无法确认稳定 |
| `MOMO_HISTORY_UNALIGNED` | 相邻历史画面无法可靠拼接 |
| `MOMO_HISTORY_INCOMPLETE` | 仍有被遮挡或跨屏的未完成消息 |
| `MOMO_HISTORY_EMPTY` | 没有读到文字消息或明确历史起点 |
| `MOMO_SCREENSHOT_ARCHIVE_FAILED` | 证据截图保存失败，采集停止 |
| `MOMO_DATABASE_OPEN_FAILED` / `MOMO_DATABASE_WRITE_FAILED` | 数据库打开或事务提交失败 |
| `CONNECTION_LOST` / `CONNECTION_CHANGED` / `SCREEN_CHANGED` | 连接或设备屏幕在采集中变化 |

## 数据库

每台设备默认写入独立库 `.runtime/momo-data/devices/device-<deviceId>/momo.sqlite`。旧消息表和消息记录会保留。每次完成的历史采集另外追加一份按时间顺序排列的完整消息快照；应用通过 `getMessagesByContact` 读取最新已确认的顺序，因此重复文字、标点差异或补录顺序不会把当前会话排乱。失败的事务不会更新快照。

数据库格式不改变旧联系人和消息表。执行器并发沿用共享识别服务已有的上限 3。

## 主要实现

- `src/tools/momo/contact-sync.js`：兼容入口。
- `src/tools/momo/contact-sync-runner.js`：联系人确认、截图、翻页、历史拼接和事务提交。
- `src/tools/momo/chat-frame.js`：单屏气泡、OCR 映射及相邻屏拼接。
- `src/tools/vision/bubble_color.py`：按粉/白填充色与原始像素轮廓筛选气泡。
- `src/tools/momo/db.js`：兼容旧表并保存完整有序快照。
- `src/workflows/momo-contact-sync.js`：网页/命令行入口。
- `scripts/replay-momo-sync-v2.js`：离线截图回放；不操作手机，不写入联系人数据库。
