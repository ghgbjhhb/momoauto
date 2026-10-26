# 中文自动分词、拼音与云手机键盘输入

本项目新增 `python_typing` Python 模块，默认只做 dry-run。它不使用剪贴板，不依赖 ADB、Root 或手机内部 API；真实模式通过 PyAutoGUI 把 ASCII 拼音逐字符发送到当前获得焦点的浏览器投屏输入框，由云手机中文拼音输入法显示候选词，再用 Space 确认第一个候选词。

## 部署

项目根目录使用独立虚拟环境：

```powershell
py -3 -m venv .venv-zhtyping
.\.venv-zhtyping\Scripts\python.exe -m pip install -r requirements.txt
```

不要把中文输入法切换留在本机中文模式；建议把 Windows 本机键盘布局切到英文，避免本机输入法先拦截拼音。云手机投屏内的搜狗/讯飞拼音输入法保持开启。

## dry-run

```powershell
.\.venv-zhtyping\Scripts\python.exe -m python_typing.cli `
  --text "你好，我今天想去北京玩。" 
```

输出包含 jieba tokens、pypinyin 无声调拼音、候选确认 Space 以及最终预期键盘操作，但不会敲击键盘。

自定义词典遵循 jieba 格式：

```text
重庆 100000 ns
```

调用时增加 `--userdict path\to\userdict.txt`。`重庆` 等多音字优先使用 pypinyin 的词组规则；需要业务专名时用用户词典或 AI JSON 显式指定拼音。

## AI 提供分词和拼音

```powershell
.\.venv-zhtyping\Scripts\python.exe -m python_typing.cli `
  --text "你好，我今天想去北京玩。" `
  --segments-json '[{"text":"你好","pinyin":"nihao"},{"text":"，"},{"text":"我"},{"text":"今天","pinyin":"jintian"},{"text":"想"},{"text":"去"},{"text":"北京","pinyin":"beijing"},{"text":"玩"},{"text":"。"}]'
```

程序会先把每个 segment 的 `text` 拼接，并与原文逐字校验；不一致时直接报错，不会开始输入。

Python 集成入口：

```python
from python_typing import type_chinese, type_ai_reply

type_chinese("你好，我今天想去北京玩。")  # 默认 dry-run
type_ai_reply(reply, segments=ai_json, dry_run=True)
```

## 真实模式（需手动启动）

只有明确增加 `--execute` 才会创建 PyAutoGUI 后端：

```powershell
.\.venv-zhtyping\Scripts\python.exe -m python_typing.cli `
  --text "你好，我今天想去北京玩。" --execute --countdown 5
```

命令开始前倒计时 5 秒。倒计时期间把焦点点到云手机聊天输入框；把鼠标移动到屏幕左上角会触发 PyAutoGUI 的 `FAILSAFE` 紧急停止。第一版只按 Space 选第一个候选词，不能保证候选词始终正确；候选确认被单独封装在 `python_typing/candidate.py`，以后可替换为 OCR、候选匹配或鼠标选择。

中文标点会先映射成常见 ASCII 键。最终显示中文标点还是取决于云手机输入法当前的中英文标点模式，未知 Unicode 字符会在真正输入前报错，不会静默粘贴或伪造输入。

## WS 拼音输入 + 自动 OCR 候选选择

新增入口 `scripts/ws-ime-input.js`，不使用电脑焦点、PyAutoGUI 或剪贴板。

默认分词规划现在复用已预热的 Python/jieba 进程；候选与草稿 OCR 借用项目级 GPU 常驻队列，直接传截图字节。拼音敲击、候选精确匹配、全文核对与发送限制不变。自定义 Python 路径仍保留单次进程调用；共享服务说明见 [GPU 识别说明](GPU-RECOGNITION.md)。
仍逐键发送拼音，云手机输入法生成候选；OpenCV 分割候选区域后用常驻本地 RapidOCR 批量识别，按目标文字精确匹配并点击对应坐标，不预设候选序号。每次确认后再次 OCR 核对输入框全文；缺少匹配、低置信度或输入框内容不一致时停止并保留截图，不发送消息。

当前 `BROWSER_NINE_KEY` 配置针对本次第三台手机的浏览器主页搜索框和九宫格输入法。切换到聊天软件、其他输入法布局或横屏时，必须调整 `inputRoi`、`candidateRoi`、`focus`，并验证后再使用；目前不是通用聊天框定位器。候选超出可见栏且自动分词拆分后仍找不到时会停止，尚不自动翻页或纠错。OCR 也不能保证百分之百准确。

WS 后端和本地键盘无关，不需要抢电脑窗口焦点，但手机内正确的输入框必须获得焦点。本入口拒绝 Enter/Tab，不会触发发送。Ctrl+C 可终止命令行运行；PyAutoGUI 左上角紧急停止仅对 PyAutoGUI 后端有效，不适用于 WS 后端。

无需登录凭证的不敲键模式：

```powershell
npm run type:ws -- --device-id 2030225672674516993 --text "美女这么晚了还不睡，"
```

真实输入要求已配置 `YUNMOMO_TOKEN`，并显式增加 `--live`；默认等待 5 秒。以下示例要求目标输入框为空：

```powershell
npm run type:ws -- --device-id 2030225672674516993 --text "美女这么晚了还不睡，" --live
```

如果输入框已经有本次这句草稿，要明确指定旧内容后才会自动清空重打：

```powershell
npm run type:ws -- --device-id 2030225672674516993 --text "美女这么晚了还不睡，" --live --replace-existing --expected-existing "美女这么晚了还不睡，"
```

在项目根目录集成：`require('./src/typing/ws-ime-input').runWsImeInput({client, deviceId, udid, text, live: true, profile, ...})`。旧 `scripts/ws-ime-input.js` 入口继续兼容。可配置 `keyIntervalMs`、`settleMs`、`minimumScore`、`countdownSeconds`；默认 dry-run。

2026-10-13 第三台实际全自动运行成功：jieba 分词 `美女 / 这么晚 / 了 / 还 / 不 / 睡 / ，`；“这么晚”不是首选，OCR 自动选中第二个候选。最终输入框 OCR 为 `美女这么晚了还不睡，`，未发送。全流程 14.242 秒（包含 5 秒倒计时），本次候选 OCR 单次约 63–78 毫秒。截图及记录见 `.local-output/auto-ime-BeNi1d/result.json`。
