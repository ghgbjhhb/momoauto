# 单人聊天页面端到端目标检测模型 (YOLO11m 7-Class 架构完整版)

本目录为针对**单人聊天会话详情页（返回键、输入框、头像、顶部关注按钮、遮挡关闭键、聊天助手浮层面板、发送按钮）**专属微调训练的 **YOLO11m 端到端深度学习目标检测模型**与完整资产归档。

> **文件夹别名**：`02_聊天详情页识别模型`（历史兼容别名 `chat_detail_parser`）
> 
> **7 分类架构说明**：
> 1. **统一头像分类 (`avatar`)**：界面内所有人物头像统一分类，覆盖对方顶栏头像、对方发言头像、己方彩色真人自拍与己方灰色默认剪影，纯坐标输出；
> 2. **发送按钮分类 (`send_btn`)**：打字激活状态下的蓝色胶囊发送按钮，兼顾键盘弹起与未弹起状态，彻底消除与顶部关注按钮的特征混淆；
> 3. **职责清晰解耦**：模型与解析引擎不强加任何主观身份归属推断，所有控件及头像输出标准精确坐标，供上层业务按需取用。

---

## 一、目录结构与资产清单

```
02_聊天详情页识别模型/
├── weights/                     # 【核心权重】训练生成的 YOLO 神经网络权重
│   ├── best.pt                  # 验证集最佳权重 (7-Class 架构完整版, 40.5MB)
│   └── last.pt                  # 最终轮次权重 (40.5MB)
│
├── training_metrics/            # 【训练指标】60 轮收敛数据与评测图表
│
├── predict_chat_detail.py       # 【核心推理引擎】纯 YOLO11m 端到端 7 分类推理与解析
│
├── yolo_dataset/                # 【训练数据集】全量素材标准标注集
│   ├── data.yaml                # 数据集配置文件与 7 大核心类别定义
│   ├── images/ (train, val)     # 训练集与验证集图片 (239 张)
│   └── labels/ (train, val)     # 7 分类 YOLO 归一化标注
│
├── yolo_finetune_tools/         # 【二次训练与微调脚本】
│   ├── train_chat_detail_yolo.py# 一键重新训练/增量微调脚本
│   └── export_to_yolo.py        # 数据集自动导出与划分工具
│
└── README.md                    # 本技术说明文档
```

---

## 二、支持的 7 大核心检测类别与输出设计

### 1. YOLO 基础视觉特征检测类别

| 类别 ID | 类别代码 (`name`) | 中文标签 | 推荐置信度 | 视觉特征与职责边界 |
| :---: | :--- | :--- | :---: | :--- |
| **0** | `back_btn` | 返回键 | `0.40` | 顶部左侧返回箭头图形 |
| **1** | `avatar` | 头像 | `0.28` | 界面内所有人物头像（不区分顶栏、消息流、对方或己方，统一只输出头像坐标） |
| **2** | `input_box` | 输入框 | `0.35` | 底部完整胶囊输入框容器（支持未弹起与键盘弹起两种状态） |
| **3** | `top_follow_btn` | 顶部关注按钮 | `0.35` | 顶部常驻提示卡片中「关注」引导按钮 |
| **4** | `assistant_close_x`| 聊天助手关闭X | `0.25` | 底部回复助手悬浮卡片右上角「X」，交互首选点击点 |
| **5** | `assistant_panel` | 聊天助手面板 | `0.30` | 底部聊天助手浮层卡片整体，界定遮挡禁行区与兜底关闭参考 |
| **6** | `send_btn` | 发送按钮 | `0.35` | 激活状态下的蓝色圆角胶囊发送按钮，文本输入就绪的关键状态标识 |

安全规则：`assistant_close_x` 不能单独触发关闭动作。只有同一帧同时检测到 `assistant_panel`，且关闭 X 位于该面板右上区域时，才会输出 `is_occluded=true` 并允许上层点击；单独 X 会被视为误报候选。

### 2. 头像数据输出规范

模型与推理引擎严格遵循「只认头像、输出坐标、不分归属」原则：
- **模型内部架构**：神经网络输出层仅有唯一 `avatar` 分类头，权重完全一致，不包含任何子身份记忆；
- **结构化输出**：解析器将所有检出的头像置于 `avatars` 列表中，提供标准 `box`、`center` 与 `confidence`，按纵坐标自上而下自然排序；
- **业务解耦**：若下游业务需要辨认顶栏头像或消息头像，仅需通过脚本判断纵坐标（如 `cy < 120` 为顶栏）或横坐标区分，底层解析器不做任何越权判定。

---

## 三、模型评估指标 (Validation Metrics)

在本地 RTX 3060 CUDA GPU 上完成 60 轮训练，验证集核心指标如下：

- **全局指标**：
  - **`mAP50`**：**95.8%**
  - **`mAP50-95`**：**89.5%**
  - **平均精度 (P)**：**0.922**
  - **召回率 (R)**：**0.972**
  - **单图推理耗时**：**$\approx 15.7\text{ms}$**
- **核心控件分项指标**：
  - `send_btn` (发送按钮): $P=0.938, R=1.000, \text{mAP50}=0.995, \text{mAP50-95}=0.995$
  - `input_box` (输入框): $P=0.990, R=1.000, \text{mAP50}=0.995, \text{mAP50-95}=0.986$
  - `avatar` (统一头像): $P=0.979, R=0.943, \text{mAP50}=0.987, \text{mAP50-95}=0.822$
  - `assistant_panel` (聊天助手面板): $P=0.922, R=1.000, \text{mAP50}=0.995, \text{mAP50-95}=0.995$
  - `assistant_close_x` (聊天助手关闭X): $P=0.947, R=1.000, \text{mAP50}=0.995, \text{mAP50-95}=0.885$
  - `back_btn` (顶部返回键): $P=0.990, R=0.974, \text{mAP50}=0.975, \text{mAP50-95}=0.906$
  - `top_follow_btn` (顶部关注按钮): $P=0.688, R=0.889, \text{mAP50}=0.766, \text{mAP50-95}=0.675$

---

## 四、Python 代码快速调用示例

```python
from predict_chat_detail import ChatDetailYOLOParser

# 1. 实例化检测器（默认自动加载 weights/best.pt 与 CUDA GPU）
parser = ChatDetailYOLOParser()

# 2. 单图检测
result = parser.detect("screenshot.png")

# 3. 判断是否有悬浮窗遮挡
if result["is_occluded"]:
    close_btn = result["occlusion_info"]["recovery_action"]["target_coord"]
    print(f"检测到悬浮遮挡，点击关闭: {close_btn}")
    device.click(close_btn[0], close_btn[1])
else:
    # 点击输入框
    input_box = result["elements"].get("input_box")
    if input_box:
        cx, cy = input_box["center"]
        device.click(cx, cy)

# 4. 生成可视化标注图
annotated_img = parser.annotate("screenshot.png", result)
cv2.imwrite("output.jpg", annotated_img)
```

---

## 五、如何二次微调迭代训练

后续如果有新手机、新 UI 界面需要增量训练：

1. 将新图片放入 `yolo_dataset/images/train/`，标注放入 `yolo_dataset/labels/train/`；
2. 运行训练脚本：
   ```bash
   python yolo_finetune_tools/train_chat_detail_yolo.py
   ```
   脚本会自动读取新数据，在 GPU 上完成 60 轮训练，并自动将最新的最佳权重归档更新至 `weights/best.pt`。
