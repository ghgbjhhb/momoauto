# 云机八步流程

所有流程通过 `YUNMOMO_DEVICE_ID` 选择同一台云机，统一名称和执行顺序如下：

1. `01-导入云盘所有文件.js`：把私有云盘文件传到目标云机，等待传输完成。
2. `02-上传证书.js`：上传 `YUNMOMO_CERT_PATH` 指定的 keybox XML 证书。
3. `03-设置VPC代理.js`：应用指定或第一条可用 VPC 线路。
4. `04-环境配置.js`：打开密钥认证，确认根证书和引导锁定状态，返回桌面。
5. `05-一键生成全部.js`：打开伍羊工具箱，等待全部数据生成完成，返回桌面。
6. `06-定位到ip地.js`：点击高德后至少等 3 秒，并确认加载圈消失和地图已显示；点击底部 IP 定位，等待成功提示消失，点击右上角定位图标；等地图加载和蓝色定位标记稳定后，在标记附近随机点击一次，重新截图识别水滴形标记的新位置，等标记和地图稳定后点击标记，识别“是否穿越到标记位置？”弹窗并点击右侧“穿越”；等弹窗消失、定位完成且地图稳定后，再返回桌面。
7. `07-高德初始化.js`：处理首次启动权限和弹窗，确认进入地图后返回桌面。
8. `08-输入法初始化.js`：启用输入法并处理切换；协议页点击“同意并继续”后即结束。

```powershell
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
$env:YUNMOMO_DEVICE_ID = '<目标设备 ID>'
$env:YUNMOMO_CERT_PATH = 'C:\Users\Administrator\Documents\app\keybox(2)(1) (1).xml'
node flows/执行全部.js --execute
```

单独执行某一步，例如 `node flows/07-高德初始化.js --execute`。正式实现统一位于 `src/workflows`，公共找应用/OCR 逻辑位于 `src/automation`；`examples` 中的旧入口继续兼容转发。

脚本 6 首次随机点击后至少等待 500 ms，再重新取图，连续两帧确认唯一水滴标记的位置和地图稳定；第二次点击使用最新截图坐标按控制屏幕尺寸换算，不复用第一次随机坐标。水滴图标使用 OpenCV 的 HSV 颜色分离和上宽下尖轮廓检测，不使用 YOLO 或 OCR 找图标；先分离水滴的较低饱和度蓝色与箭头的高饱和度蓝色，重叠时结合箭头遮挡证据处理不完整轮廓。弹窗文字及按钮继续用 OCR。原 `mapVision.marker` 不变，`selectionMarkers`/`selectionMarker` 增加 `occluded` 遮挡信息；多个标记或识别不到时不盲点。若第一次点击已出现确认框，直接处理确认框，不再点地图。必须同时识别完整提示、“取消”和同排右侧唯一的“穿越”按钮才会确认；未找到稳定标记、未出现确认框、按钮无法唯一确定、确认后弹窗不消失或定位等待超时均按失败返回。结果保留原有字段，并记录 `randomNearbyLocationTapCount`、`randomNearbyMarkerTap`、`randomNearbyMarker`、`randomNearbyMarkerStableObservations` 和 `randomLocationConfirmation`，便于对照两次点击位置。

随机位置的默认椭圆半径由屏幕宽度的 10%、高度的 8% 扩大到 14%、10%，仍以当前定位标记为中心，保留原随机方式及地图安全区域限制。可通过 `YUNMOMO_RANDOM_RADIUS_X_RATIO`、`YUNMOMO_RANDOM_RADIUS_Y_RATIO` 覆盖，显式设置优先于默认值。范围扩大只能降低图标重叠的机会，不能保证完全不重叠；识别失败仍会停止，不按旧坐标继续。

水滴标记检测复用现有 OpenCV，不修改或重训 `models/`。常驻识别进程启动后不会自动重载 Python 源码；更新 `python_workers/ocr/rapidocr_worker.py` 后，应在没有识别任务时执行 `npm run recognition:stop`，再执行 `npm run recognition:start`。

OCR 默认借用跨进程 GPU 常驻服务；可以先运行 `npm run recognition:start`，后续步骤不会各自冷启动。原 CPU 工作进程仅在显式设置 `YUNMOMO_OCR_LEGACY=1` 时使用，不会静默回退。运行环境、关闭规则和错误码见 [GPU 识别说明](../docs/GPU-RECOGNITION.md)。

完整执行保存每一步的日志、完成页面及 OCR 截图到 `.local-output/流程执行/全流程-*`。失败时停止，不自动重跑已经完成的传输或生成步骤；修正后继续：

新运行的 OCR 图直接写入该步骤记录的 `ocr/yunmomo-scriptN-随机后缀/`，同时将原图片字节提交识别，省去临时目录结束后再复制。旧记录的平铺 `ocr/*.jpg` 仍可查看；步骤检查、断点恢复和人工核对要求不变。

```powershell
$env:YUNMOMO_RUN_DIR = '<该次全流程记录目录的绝对路径>'
node flows/执行全部.js --execute --resume
```

逐步运行并核对截图：首次用 `--step=1` 创建新记录；后续指定该记录目录，依次用 `--resume --step=2` 等参数执行。每步执行完停下，不自动进入下一步。核对截图和日志后，设置 `YUNMOMO_REVIEW_NOTE`，再用 `--execute --resume --review-step=1` 等命令记录通过；前一步未核对通过时，下一步不能启动。

## 应用入口逐级返回容错

脚本 4～8 通过 `src/automation/app-navigation.js` 共用入口恢复：打开应用后先识别目标页面；若仍在上次遗留的子页面，发送一次返回键、等待页面切换、重新截图并 OCR，再决定是否继续返回。确认到达目标后立即交回原流程，不继续返回，不重放生成、定位确认或其他业务操作。

| 脚本 | 恢复目标 |
| --- | --- |
| 04 环境配置 | 原根证书、引导锁定状态校验页面 |
| 05 一键生成全部 | 伍羊工具箱的“一键生成全部”入口 |
| 06 定位到ip地 | 扩展服务设置根页面；遗留的虚拟定位、Socks5 页面逐级返回 |
| 07 高德初始化 | 地图首页，或交给原权限/协议/弹窗处理逻辑的已知提示页 |
| 08 输入法初始化 | 搜狗“启用/切换”入口或首启协议页；启用后的系统设置页面也用相同方式返回搜狗 |

默认最多返回 8 次，每次返回后至少等待 600 ms，再观察最新页面；连续 3 次返回后文字与位置没有变化则停止。返回预算从第一次返回前开始计时，默认 30 秒；会在动作之间检查，已在执行的截图/OCR 请求仍受其自身超时控制，不保证整个脚本 30 秒内结束。正常已经处于目标页时不额外返回。

只有新截图确认到了桌面，才允许重新找应用图标；不复用打开前的旧坐标，不在入口恢复中发送 HOME。退到桌面最多重新打开应用一次，未点中桌面图标时仍受原有有限点击候选次数约束。原流程启动、完成及失败清理的 HOME 规则保留，脚本 8 点击协议同意后结束的规则也不变。脚本 5 若识别到生成中或短信授权待处理、脚本 6 若识别到定位加载中，会明确停止恢复，避免返回键打断进行中的任务。

配置可通过环境变量或公共函数的 `options` 传入；`options` 优先：

| 环境变量 | options 字段 | 默认值 / 范围 |
| --- | --- | --- |
| `YUNMOMO_APP_RECOVERY_MAX_BACKS` | `appRecoveryMaxBacks` | 8 / 0～20 次；0 表示禁止自动返回 |
| `YUNMOMO_APP_RECOVERY_TIMEOUT_MS` | `appRecoveryTimeoutMs` | 30000 / 1000～120000 ms |
| `YUNMOMO_APP_BACK_SETTLE_MS` | `appBackSettleMs` | 600 / 100～5000 ms |

旧 `YUNMOMO_APP_CHILD_SETTLE_MS` 保留为返回后等待时间的低优先级别名；未设置新选项/新环境变量时才使用。原 `YUNMOMO_HOME_SETTLE_MS` 不用于逐级返回等待。

内部调用：`openAppWithRecovery(phone, control, worker, directory, state, found, options, config)` 负责打开及有限重开，继续返回兼容的 `{ opened, point, retried }`；`recoverAppPage(..., initialObservation, options, config)` 只负责恢复，返回 `{ observation, reachedTarget, report }`。`config` 指定 `appName`、`isTarget(observation)`，可增加桌面识别 `isLauncher`/`launcherObservation`、已知子页面 `launchEvidence`、已有弹窗处理 `prepare` 和进行中状态保护 `blockedReason`。两个方法均须顺序等待完成，不能对同一手机并行发送返回和业务动作。

成功输出增加 `appNavigationRecoveries`，每项包含 `app`、`target`、`backSteps`、`outcome`；错误包含 `code`、`stage: app_entry_recovery` 及最后截图路径/返回次数，命令行错误消息也保留代码和最后 OCR 页面摘要。常见代码：`APP_RECOVERY_INVALID_CONFIG`（配置无效）、`APP_RECOVERY_BUSY`（任务进行中）、`APP_RECOVERY_NO_OBSERVATION`（缺少截图）、`APP_RECOVERY_BACK_FAILED`（返回键发送失败，原控制通道代码保留在 `details.controlCode`）、`APP_RECOVERY_NO_PROGRESS`（页面无变化）、`APP_RECOVERY_BACK_LIMIT`（次数上限）、`APP_RECOVERY_TIMEOUT`（超时）、`APP_RECOVERY_RELAUNCH_LIMIT`（重开上限）、`APP_OPEN_FAILED`（未进入应用）。底层截图/OCR、找图标及原弹窗处理异常原样向上传递，不会吞掉后继续盲点。

本次仅做语法及模块导入检查，未操作实机，未新增测试文件或运行测试套件。模型及其资料未改动。

## 独立脚本 9：改机重置

`09-改机重置.js` 默认在 Android 16 内随机选择机型，固定启用“改机成功后自动重置数据（30 秒后）”，国家默认中国 `CN`。目标设备必须显式指定，不按“第几台”写死，也不自动加入上述八步初始化流程。清数据应在初始化之前做，不能在初始化完成后自动执行。

```powershell
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
$env:YUNMOMO_DEVICE_ID = '<目标设备 ID>'
node flows/09-改机重置.js                       # 只读预览
node flows/09-改机重置.js --list-countries      # 读取目标云机支持的国家
node flows/09-改机重置.js --list-models         # 读取网页可选机型
node flows/09-改机重置.js --execute            # Android 16 随机机型、CN，实际改机并清数据
node flows/09-改机重置.js --country=US --android-version=16 --execute
```

也可用 `YUNMOMO_COUNTRY_CODE` 指定国家代码、`YUNMOMO_ANDROID_VERSION` 指定安卓版本（命令行参数优先）。版本默认 `16`；后台实机返回确认机型大版本必须与云机系统一致，改机不会升级/降级系统。Android 10、14 的云机应显式指定对应版本；`all` 仅保留为显式选项，可能因跨版本选择被后台拒绝。机型和国家每次从接口读取，国家代码必须在该云机支持的列表中。预览与执行是不同调用，执行时会重新随机选择；实际提交的机型记录在报告中。

请求与网页一致，只调用一次 `switchModel`，字段为 `id/modelId/modelName/resetData/countryCode`，不重复调用 `resetV3`。提交后保存 `.local-output/改机重置/改机重置-*/report.json`，状态 `submitted` 仅表示接口返回，不能当作清数据及重启完成；先观察云机重置完成，再运行八步初始化。异常不自动重试，避免重复清数据。

代码复用：`src/workflows/change-model-reset.js` 导出 `prepareChangeModelReset(client, deviceId, options)`（只读准备）与 `submitChangeModelReset(client, plan)`（实际提交同一个已准备计划）；后者不会再次随机选择。原 `examples/change-model-reset.js` 导入方式仍兼容。

## 独立脚本 10：增加VPC网络

`10-增加VPC网络.js` 与云机无关：添加账号下的 VPC 线路，并查询、唯一匹配和读回验证新线路 ID。支持截图里的五种文本格式、多行批量输入及 JSON 对象/数组；可指定已有分组 ID，默认未分组。不会自动切换任何云机的代理，也不加入八步初始化。

```powershell
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
$env:YUNMOMO_VPC_DATA_FILE = '<私有代理文本或 JSON 文件的绝对路径>'
node flows/10-增加VPC网络.js             # 本地解析预览，用户名/密码隐藏
node flows/10-增加VPC网络.js --execute   # 添加并返回 vpcId / ids / results
```

文件也可通过 `--file=<路径>` 指定；无需文件时，通过 `YUNMOMO_VPC_DATA` 传多行文本。`--group-id=<已有分组ID>`、`--remarks=<备注>` 为可选参数，对应环境变量 `YUNMOMO_VPC_GROUP_ID`、`YUNMOMO_VPC_REMARKS`。JSON 字段为 `ip/port/username/password/groupId?/remarks?/expTime?`，用户名/密码包含文本分隔符时优先使用 JSON。

成功结果不含代理用户名或密码，写入 `.local-output/VPC网络/新增-*/report.json` 和 `.local-output/VPC网络/latest.json`。单条结果包含 `vpcId`；多条结果包含 `ids` 与对应的 `results`。只发一次新增请求，ID 无法唯一确认时停止，不自动重发，不猜测“列表第一条就是刚新增的”。新增失败时 `latest.json` 标为未确认，设置脚本拒绝沿用旧结果；并行新增时应使用每次输出的独立 `reportPath` 串联，避免共享 latest 文件相互覆盖。

后续使用刚新增的单条线路：

```powershell
$env:YUNMOMO_DEVICE_ID = '<目标云机ID>'
$env:YUNMOMO_VPC_RESULT_PATH = 'D:\AA-project\自动化\.local-output\VPC网络\latest.json'
node flows/03-设置VPC代理.js --execute
```

也可直接将输出的 ID 赋给 `YUNMOMO_VPC_ID`，优先级高于结果文件。批量新增必须显式选择其中一个 ID；脚本 3 会按该 ID 查询线路，不受列表前 100 条的限制。新建凭据只在输入文件/内存中存在，结果文件不保存凭据。当前仅核对网页参数并完成语法/只读查询验证；没有提供代理数据，本次未实际新增线路。

## 独立脚本 11：MOMO首页养号

`11-momo首页养号.js` 用于云机完成环境与系统初始化后的陌陌 App 首页基础浏览（刚开始的养号动作）；只刷新动态列表和帖文滑动浏览，不点赞、不评论、不关注、不发消息。

```powershell
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
$env:YUNMOMO_DEVICE_ID = '<目标设备 ID>'
node flows/11-momo首页养号.js                         # 只读预览（planned）
node flows/11-momo首页养号.js --cycles 2              # 预览 2 轮
node flows/11-momo首页养号.js --execute               # 实际执行养号循环
node flows/11-momo首页养号.js --execute --cycles 3    # 实际执行 3 轮养号
```

核心规则与防检测设计：
1. **首页识别校验**：使用 YOLO 页面分类与底栏检测器，核验当前屏幕为 1 级页面/首页（包含“动态”、“附近/发动态”及“首页”Tab）；未确认处于首页时拒绝操作，不盲目乱点。
2. **刷首页方式与概率**：
   - 方式 1（点击底栏“首页”按钮）：概率 70%。
     - 点击坐标采用防检测区域加权采样：中心 0%~40% 核心区域概率 70%，最外围区域概率 30%，避免点击固定点位。
   - 方式 2（下拉刷新）：概率 30%。
     - 在内容安全区域内从上向下拉动刷新；若已浏览滚动过列表，自动先点一次首页键复位到顶部再下拉。
3. **浏览节奏与循环**：
   - 每轮随机刷新 2~8 次；
   - 刷新完成后开始向下滑动浏览帖文 3~6 次；
   - 每次下滑之间随机间隔停顿 1~5 秒（其中 1~3 秒概率为 80%，4~5 秒概率为 20%，模拟人类真实阅读帖文）；
   - 浏览完成后进入下一轮刷新，形成自然循环（受 `cycles` 参数控制，默认 1 轮）。
4. **执行结果归档**：真实执行结果写入 `.local-output/momo-warmup/run-*/report.json` 并保存最后截图；终端输出保留脱敏后的精简摘要。

## MOMO 消息页收到的招呼自动处理

`12-momo招呼处理.js` 用于处理 MOMO 消息列表中的“收到的招呼”卡片流；自动批量通过或拒绝招呼，控制单次通过人数并在频控或处理完毕时自动返回消息页。

```powershell
$env:YUNMOMO_TOKEN = '<当前登录令牌>'
$env:YUNMOMO_DEVICE_ID = '<目标设备 ID>'
node flows/12-momo招呼处理.js                         # 只读预览（planned）
node flows/12-momo招呼处理.js --execute               # 实际执行（单轮通过最多6人，90%通过/10%拒绝）
node flows/12-momo招呼处理.js --execute --max-approved 10   # 实际执行，最多通过 10 人
node flows/12-momo招呼处理.js --execute --cycles 3    # 连续执行 3 轮（轮次之间随机间隔 7~20 分钟）
```

核心规则与防检测设计：
1. **自动导航与入口定位**：自动确认处于消息页（若在首页或其他页面自动切回消息 Tab），识别“收到的招呼”并加权随机点击进入。
2. **通过与拒绝决策**：
   - 通过概率 90%，拒绝概率 10%；
   - 按钮点击采用防检测加权采样（中心 40% 核心区占 70% 权重，外围占 30% 权重，内缩 1px）；
   - 卡片之间保留 1.2~2.5 秒模拟人类看卡片思考的真实等待。
3. **通过人数上限控制**：单次通过人数达到设定上限（默认 6 人）后，自动按返回键返回消息列表。
4. **频率限制拦截**：若屏幕出现“消息发送过于频繁，请稍后再试”，退回消息列表并终止整个本次调用，即使配置多轮也不重进。默认一次调用一轮，后续调用时机由上层决定。
5. **处理完毕与人数不足**：若未读招呼已处理完毕或不足 6 人（转入全部招呼列表），自动按返回键安全退回消息页。
6. **多轮间隔机制**：若配置多轮巡检（`cycles > 1`），每轮完成并返回消息列表后，在 7~20 分钟区间内随机休眠等待，模拟真人定时查看消息。

## MOMO 消息页联系人及消息入库

`13-momo联系人及消息入库.js` 默认按机器独立存库。确认进入聊天页、完成历史首尾确认与相邻屏拼接后，才在事务中保存联系人、消息和同步完成标记。未完成联系人允许重试；保留真实重复消息，不按整段会话文字全局去重。旧公共库原样保留。

```powershell
$env:YUNMOMO_DEVICE_ID = '<目标设备 ID>'
# 只处理已经打开的当前聊天页；联系人姓名为必填参数
node flows/13-momo联系人及消息入库.js --execute --contact-name "星星"
```

脚本必须由调用方传入 `contactName`（CLI 为 `--contact-name`），并且执行前设备必须已经打开对应的聊天详情页。脚本只处理这一位联系人；历史上滑次数由内部安全预算控制，不作为调用参数。入库的聊天记录只保留发送者和聊天内容；时间、坐标、气泡颜色等只用于内部识别和翻页拼接。

默认库：`.runtime/momo-data/devices/device-<deviceId>/momo.sqlite`。单机内暂时仍按昵称区分；不要显式配置多台机器共用同一库。预览不创建数据库，真实执行报告仍写入 `.local-output/momo-sync/`。

识别失败、聊天页未确认、翻页无法对齐或预算内未确认首尾，都返回具体错误码，不伪造完整采集成功。方案依赖画面和 OCR，不承诺100%准确；纯图片、语音、跨屏巨大气泡等仍有限制。详见 [联系人入库文档](../docs/MOMO-CONTACT-SYNC.md)。



