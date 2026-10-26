# 运行依赖

| 清单 | 用途 | 当前环境 |
| --- | --- | --- |
| `typing.txt` | jieba、拼音转换、电脑键盘输入 | Windows `.venv-zhtyping` |
| `ocr-linux.txt` | 初始化流程和输入法候选识别 | WSL；版本来自现有安装元数据 |
| 根目录 `package-lock.json` | Node SDK、本地控制台、WebSocket | 根目录 `node_modules` |

根目录 `requirements.txt` 转引 `typing.txt`，原安装命令保持有效。OCR 清单只记录本机已有版本，本次没有重新安装依赖，也没有声称这些版本已在新环境重新验证。

新建 OCR 环境应使用独立的 `.runtime/ocr/venv`，或显式设置 `YUNMOMO_OCR_PYTHON`；额外挂载的包目录使用 `YUNMOMO_OCR_SITE_PACKAGES`。未配置新环境时仍兼容 `.local-output/vision-test/venv` 和 `site-packages`，因此不能把该历史目录当普通截图缓存删除。

自训练 YOLO 的环境、权重、训练集、标注、配置和评测资料继续按原模型说明维护，本次不搬迁或合并。
