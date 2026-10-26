# 打开 MOMO

`phone.tools().openMomo()` 通过 SDK 原图、桌面图标模板和现有两套 YOLO 权重打开 MOMO，并在连续画面确认后返回；不使用 OCR、ADB 或电脑鼠标焦点。

前提与边界：真实调用会发 HOME、翻页和一次图标点击。不会登录、同意授权、发送消息或在成功后返回桌面。当前只确认已支持的消息列表、主导航页和聊天详情；未知页面不算成功。默认模板仅覆盖本项目已观察到的蓝色 MOMO 图标和桌面，暂不搜索文件夹。

默认识别进程现由项目级常驻服务持有，多个命令借用同一路有界队列，避免反复加载两套 YOLO；模板与判断算法不变。关闭手机工具不停止公共进程。显式传入 `momoVision` 时仍使用指定的私有进程。启动、关闭与资源限制见 [GPU 识别说明](GPU-RECOGNITION.md)。

## 先预演，再明确启动

在项目根目录运行：

```powershell
node examples/open-momo.js
```

默认返回 `planned`，不需要 token，不截图、不启动 Python、不连接或操作手机。这只是流程预演，不能证明真实手机可以打开。

只识别已有 SDK 原图、不操作手机：

```powershell
node examples/open-momo.js --image ".local-output/改机重置/第5台实机-UThe7e/before.jpg"
```

确认目标设备、配置当前进程的 `YUNMOMO_TOKEN` 后，才手动执行真实启动。设备必须使用后台真实 `deviceId`，不是“第几号”或显示名称：

```powershell
node examples/open-momo.js --execute --device-id $env:YUNMOMO_DEVICE_ID --timeout 60000
```

`YUNMOMO_DEVICE_ID` 需由调用者设为已核对的目标；没有显式 `--execute` 不会操作手机。示例不打印截图字节，也不自动保存含聊天内容的图片。

## 在脚本中调用

以下代码在项目根目录的 CommonJS 脚本中使用：

```js
const { YunmomoClient } = require('./src');

async function main() {
  const tools = new YunmomoClient({ token: process.env.YUNMOMO_TOKEN })
    .device(process.env.YUNMOMO_DEVICE_ID).tools();
  try {
    const result = await tools.openMomo({ timeoutMs: 60000 });
    if (!result.ok) {
      console.error(result.operationId, result.error, result.execution);
      // result.data?.lastScreenshot.image 是最后取得的 SDK 原始 Buffer。
      // 根据隐私和留存规则按需保存；不要直接 JSON.stringify 整个结果。
      return;
    }
    console.log(result.status, result.data.page, result.data.alreadyOpen);
  } finally {
    await tools.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
```

`tools` 应按设备复用，避免重复加载模型；最终使用完再 `close()`。同一实例内四种工具串行执行，计入排队时间。不要为同一设备同时创建多个操作者，也不要在搜索时手工拖动页面；队列不能锁住其他进程或浏览器的操作。

`openMomo({ dryRun: true })` 只输出计划，且不需要 `screenSize`。构造选项错误抛出异常；操作参数、识别或设备错误通过统一失败结果返回。

## 实际执行流程

1. 校验参数，初始化本地常驻 Python 进程，加载并预热两个本地模型。初始化失败时不发 HOME 或触控。
2. 取得 SDK `level: 2` 原图。若 YOLO 已确认 MOMO 页面，继续观察到稳定后直接返回 `alreadyOpen: true`，不连接触控、不发 HOME。
3. 否则通过 SDK 发 HOME，确认至少两个不同的系统图标锚点和两个不同的 Dock 锚点；连续稳定才进入搜索。未确认时最多再发一次 HOME。
4. 多尺度匹配 MOMO 图标。当前页没有时先向左翻，再 HOME 回确认页后向右翻。后续页以 Dock 锚点确认桌面，避免要求每一页都有图库和时钟。画面指纹用于终止重复页循环。
5. 必须只有一个图标候选。点击前重新截图，核对桌面、图标位置和稳定性；随后在图标中心点击一次。使用截图尺寸映射到 SDK 控制尺寸，不硬编码某台手机坐标；本步骤按住 80ms、不加随机偏移。
6. 等待 YOLO 页面锚点连续稳定。消息列表要求底部至少四个导航图标顺序、位置合理；聊天详情要求返回键、输入框、顶栏头像或顶部关注按钮联合成立。不是识别到单个框就成功。
7. 返回 `opened` 并停留在当前 App 页面。遇到拦截、超时、断线、图标歧义或尺寸变化时停止，不自动重放点击。

桌面稳定性比较画面缩略图；App 稳定性比较页面类型与锚点位置，避免新消息、动态横幅使整个画面永远“不稳定”。`momo_main` 只证明训练过的主导航结构可见，不保证某一个具体业务标签已选中。聊天助手浮层若未遮住必要锚点，不会被本工具自动关闭；后续聊天脚本仍需做遮挡检查。

## 参数与运行环境

### 每次打开的选项

所有时间为毫秒；除阈值外均为整数，不接受数字字符串。接口类型见 [src/index.d.ts](../src/index.d.ts)。

| 参数 | 默认值 | 范围 / 含义 |
| --- | --- | --- |
| `timeoutMs` | `60000` | 1–300000；总预算含排队、模型冷启动、截图、翻页、确认。若构造 tools 时显式给了 timeoutMs，则继承该值，调用时仍可覆盖 |
| `signal` | 无 | AbortSignal，取消后停止新操作，已发送动作不回滚 |
| `dryRun` | 继承 tools，默认 false | true 时只返回计划，无手机 I/O、无 Python 进程 |
| `maxPagesPerDirection` | `5` | 0–10；每方向最多翻页次数，另检查起始页；指纹重复会提前停止 |
| `pollMs` | `300` | 100–3000；两次观察之间的等待，不含截图和推理耗时 |
| `homeTimeoutMs` | `10000` | 500–60000；每轮 HOME / 翻页后的稳定等待预算 |
| `launchTimeoutMs` | `15000` | 500–120000；点击后的页面确认预算；初始已打开页先使用最多 3000ms 确认 |
| `stableObservations` | `2` | 2–5；需要连续一致的观察次数 |
| `confidence` | `0.65` | 0.50–0.99；YOLO 检测阈值，不是最终正确率 |
| `iconThreshold` | `0.86` | 0.75–0.99；图标模板相关性阈值，不是概率 |
| `anchorThreshold` | `0.88` | 0.75–0.99；桌面 / 拦截模板相关性阈值 |

阶段预算在观察之间检查；已经开始的截图或推理由总预算限制，阶段耗时可能超过该阶段值。每次截图只尝试一次，不用旧图伪装新结果。工具对相同内容的两张截图不能证明服务端一定返回了不同采集时刻。

### 配置视觉进程

通过 `phone.tools({ momoVision: { ... } })` 配置，不能传给 `openMomo()`：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `runtime` | Windows 为 `wsl`，其他为 `native` | 使用现有 WSL 或本机 Python；子进程不经过 shell |
| `pythonPath` | WSL：`/root/screenparser/venv/bin/python`；本机：`python3` | 复用已有视觉环境；不会自动安装或下载 |
| `distribution` | `Ubuntu` | WSL 发行版名；native 时不使用 |
| `device` | `cuda:0` | 支持 `cuda:0` / `cpu`；GPU 不可用会报错，不静默降到 CPU |
| `manifestPath` | `src/tools/vision/templates/manifest.json` | 图标与锚点模板清单 |
| `listWeights` | `models/01_消息列表页识别模型/weights/best.pt` | 用户自训列表权重 |
| `detailWeights` | `models/02_聊天详情页识别模型/weights/best.pt` | 用户自训聊天详情权重 |

例如已有 Windows 原生视觉虚拟环境时，显式使用它：

```js
const tools = phone.tools({ momoVision: {
  runtime: 'native', pythonPath: process.env.MOMO_PYTHON, device: 'cpu'
} });
```

`MOMO_PYTHON` 必须是调用者现有的有效 Python 路径。此处 CPU 为显式选择，不是推荐速度配置。本次只核对过本机 WSL + CUDA 环境，未实测其他部署组合。

视觉环境需要 OpenCV、NumPy、PyTorch 和 Ultralytics。目录名含 `screenparser` 只是复用 Python 环境；本工具不调用通用 ScreenParser 模型。权重按自身 `model.names` 读取，不根据旧文档或硬编码类别编号解释。两个模型常驻、预热一次；桌面模板优先，确认是桌面后不跑 YOLO；缩放模板有上限缓存。同一 tools 实例复用进程，不是每帧启动 WSL。

模型权重不在现有 npm `files` 发布白名单中。复制 / 分发 SDK 时要另行保留合法的模型文件，或通过上表显式配置路径；缺文件会失败，不会联网下载替代权重。

## 返回值与故障定位

沿用 [底层工具统一结果](DEVICE-TOOLS.md#返回规范)：`ok / status / operationId / deviceId / execution / data / error`。`opened` 表示通过本地视觉规则确认了页面，不是 Android 回执，`execution.deviceConfirmed` 仍为 false。

| `data` 字段 | 含义 |
| --- | --- |
| `app` | 固定 `momo` |
| `alreadyOpen` | 初始页面已确认，不需要 HOME 或图标点击 |
| `page / pageConfirmed / verifiedBy` | 页面类型，是否确认，确认方式 `yolo_scene_signature`；失败时可能为 unknown / false / null |
| `screenshots / homeKeysSent / pagesVisited` | 已返回的截图数、已本地写入完成的 HOME 次数、搜索页检查次数；重复起始页也计数 |
| `iconClickAttempted / iconClickSent` | 是否尝试图标点击、是否完成该点击的本地写入；后者 false 不代表设备一定没收到部分操作 |
| `lastScreenshot` | 最后成功取得的原图与尺寸；视觉初始化或首次截图前失败时为 null |
| `lastObservation` | 最近一次完整识别，含图标 / 桌面锚点框、页面、指纹、推理流水线耗时；坐标为整张原图像素，框格式 xyxy |
| `history` | 有界步骤记录，包含观察、HOME、翻页 / 点击坐标、页面确认和最终错误；保留最近约 200 条 |
| `vision` | 实际 device、GPU 名、两模型类别表、模板数量、OpenCV / PyTorch 版本 |

顶层 `attempts` 沿用截图尝试计数，不能当作启动次数；总截图数看 `data.screenshots`。`lastObservation.elapsedMs` 是 Python 内解码、模板、可能的 YOLO 等整体耗时，不是纯神经网络推理时间，也不含 SDK 网络耗时和首次模型加载。

| 错误码 | 原因与处理 |
| --- | --- |
| `HOME_NOT_CONFIRMED` | 两轮 HOME 仍不能确认桌面；检查最后原图、锁屏、系统 / Dock 模板与桌面主题 |
| `APP_ICON_NOT_FOUND` | 有界搜索未找到图标；不等于没有安装，检查文件夹、图标版本和搜索上限 |
| `APP_ICON_AMBIGUOUS` | 多个分离的匹配，未点图标；检查是否有重复快捷方式或模板误匹配 |
| `APP_ICON_CHANGED / LAUNCHER_CHANGED / LAUNCHER_NOT_STABLE` | 点击前图标移动、页面变化或翻页不稳定；停止后检查原图，不自动盲点 |
| `APP_OPEN_FAILED` | 点击后仍停在桌面；不自动再点一次 |
| `APP_LAUNCH_TIMEOUT` | 未到支持的稳定页面，可能是启动页、登录、未知弹窗或检测漏检；不能只凭该码认定具体原因 |
| `APP_LOGIN_REQUIRED / APP_PERMISSION_REQUIRED / APP_UPDATE_REQUIRED` | 匹配到调用者提供的对应拦截模板；需手工处理 |
| `APP_DIALOG_BLOCKED` | 匹配拦截模板或通用疑似模态框特征；后者为启发式判断，可能误报，需看图 |
| `GPU_UNAVAILABLE / VISION_DEPENDENCY_MISSING` | CUDA 不可用 / 依赖缺失；配置正确环境，或明确选择 CPU |
| `MODEL_MISSING / MODEL_CLASSES_INVALID / MODEL_LOAD_FAILED` | 权重缺失、类别不兼容或模型加载 / 预热失败；不改模型、不自行重新训练 |
| `TEMPLATES_MISSING / TEMPLATES_INVALID` | 模板文件、清单或参考尺寸不合法 |
| `VISION_START_FAILED / VISION_PIPE_FAILED / VISION_EXITED / VISION_CLOSED` | Python / WSL 启动、进程通信或生命周期问题；检查环境，不自动重放手机动作 |
| `VISION_IMAGE_INVALID / VISION_PROTOCOL_ERROR / VISION_CONFIG_INVALID / VISION_NOT_READY / VISION_INTERNAL_ERROR` | 图像、协议或视觉配置问题；保留 operationId / stage，核对版本和资源 |
| `SCREEN_CHANGED / CONNECTION_CHANGED / CONNECTION_LOST` | 分辨率或控制会话变化 / 断开；停止使用旧坐标 |
| 其他通用码 | 参数、鉴权、HTTP、发送、取消与总超时见 [底层工具](DEVICE-TOOLS.md#错误定位) |

**默认七张模板不包含登录、权限、更新页面模板。** 因此不承诺直接识别这些语义；未命中通用模态特征的未知页面可能最终报 `APP_LAUNCH_TIMEOUT`。有对应模板后才能返回相应精确拦截码，不会猜测原因。

排查先看 `error.code / error.stage / operationId / execution`，再按需查看 `lastScreenshot / lastObservation / history`。阶段包含 `vision_start / vision / home / confirm_home / find_icon / confirm_app` 及通用的 capture、connect、dispatch、flush 等。已经发 HOME 或手势后，`retrySafe` 为 false；先截图核对，不自动重跑整段。失败不做额外“恢复到桌面”，以保留实际现场。

## 更换桌面或图标模板

模板位于 [src/tools/vision/templates](../src/tools/vision/templates/manifest.json)。当前七张 PNG 由历史 360×640 SDK 原图裁出，只保留图标，不包含聊天截图。`referenceWidth / referenceHeight` 指裁图前的完整画面；`crop` 为生成工具使用的 `[x1,y1,x2,y2]`。

为不同主题 / 图标建立独立目录和清单，通过 `manifestPath` 使用。清单要求 `version: 1`，至少一个 `app_icon`、两个不同 `home_anchor`、两个不同 `dock_anchor`。可增加 `login / permission / update / blocked` 角色。模板必须位于该清单目录内，PNG 至少 12×12 且有足够细节；匹配会按完整画面尺寸及 0.8–1.2 倍局部尺度搜索。

更新清单的参考尺寸和裁切框后，才对明确来源的原图执行裁切工具：

```powershell
wsl -d Ubuntu -e /root/screenparser/venv/bin/python /mnt/d/AA-project/自动化/scripts/prepare-momo-templates.py /mnt/d/AA-project/自动化/.local-output/改机重置/第5台实机-UThe7e/before.jpg --manifest /mnt/d/AA-project/自动化/src/tools/vision/templates/manifest.json
```

上例资源已存在时会拒绝覆盖。只有确实需要重新生成这些指定模板时才加 `--overwrite`，不要用新主题覆盖所有设备仍在使用的默认模板。此命令只裁图，不安装依赖、不操作手机、不训练模型。

## 文件职责与验证边界

| 文件 | 职责 |
| --- | --- |
| `src/tools/momo.js` | 打开流程、稳定等待、翻页去重、单次点击与现场记录 |
| `src/tools/momo-vision.js` | 常驻 Python 进程、Windows / WSL 路径转换、请求 ID、超时 / 取消清理 |
| `src/tools/vision/momo_worker.py` | 图标 / 锚点匹配、疑似模态检查、两套自训 YOLO 的页面联合判断 |
| `src/tools/vision/templates/*` | 版本化图标模板与来源清单 |
| `examples/open-momo.js` | 默认安全预演、离线原图识别、显式真实启动入口 |
| `scripts/prepare-momo-templates.py` | 明确原图来源、尺寸和覆盖控制的模板生成工具 |

2026-10-15 本次核对的是本地历史 SDK 原图，不是新采集的实机画面；没有对真实手机发 HOME、翻页、点击或消息。WSL 现有环境已实际导入 OpenCV 5.0.0、PyTorch 2.6.0+cu124、Ultralytics 8.4.176，识别进程实际使用 NVIDIA GeForce RTX 3060。未新增依赖、未下载 / 修改模型，未新增测试文件或运行旧测试套件。

本次实际结果：

| 输入 / 检查 | 结果 |
| --- | --- |
| 3 张历史桌面原图 | 均确认桌面；有 MOMO 图标的来源图找到一个候选，另外两张没有误报 MOMO 图标 |
| `live-phone2/list-01.jpg`、`list-02.jpg` | 均识别为 message_list，最低锚点置信度约 0.657–0.677 |
| `live-phone2/detail-01.jpg` 至 `detail-03.jpg` | 均识别为 chat_detail，最低锚点置信度约 0.856–0.859 |
| `yolo-blank360.jpg` | 非桌面、无图标、无 App 页面签名 |
| 同一常驻进程的 9 张图 | 冷启动约 4.32 秒；单张 Python 完整识别约 144–405ms，不是纯 YOLO 推理指标，不含 SDK 网络截图耗时 |
| `node examples/open-momo.js` | planned、0 帧发送、未启动视觉进程 |
| 原有 `examples/device-tools.js` | 点击 / 连续滑动预演正常；JavaScript 与新增 Python 文件语法检查通过 |

列表和详情原图目录为 `.local-output/models-audit-20261014/live-phone2`；桌面为模板来源 `before.jpg`、`.local-output/live-third/02-home.jpg`、`33-home.jpg`；空白图位于 `.local-output/custom-yolo-eval-20261014`。本次实际权重类别数为列表 10、详情 6；未依赖模型总览文档中旧的 9 类描述。

原图识别和本地流程预演只证明这些本地路径可运行，不代表所有版本 / 主题 / 账号页面都能识别。权重会变化，以每次返回的 `vision.classes` 为准；真实启动效果仍需在明确指定的设备上观察确认。对模板来源同一张图的匹配不能作为独立准确率评估。
