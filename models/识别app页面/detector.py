"""
Momo 页面层级识别器 (Page Level Detector)
根据底栏与顶栏特征，识别传入截图处于：
- 1级页面 (可附带首页 / 消息列表细分)
- 2级消息页 (聊天详情页)
- 可能不在momoapp
"""

import os
import sys
from pathlib import Path
from typing import Dict, Any, Union
import cv2
import numpy as np

try:
    from ultralytics import YOLO
except ImportError:
    YOLO = None

try:
    from rapidocr_onnxruntime import RapidOCR
except ImportError:
    RapidOCR = None

# 关键词常量
TAB_KEYWORDS = {"首页", "直播", "消息", "小宇宙", "更多"}
EXCLUSIVE_BOTTOM_TABS = {"首页", "直播", "小宇宙", "更多"}  # 聊天页绝不可能出现的底栏一级Tab
HOME_TOP_KEYWORDS = {"动态", "附近", "AI小陌", "发动态"}
MSG_TOP_KEYWORDS = {"马上聊", "消息", "收到的招呼", "互动通知"}

CURRENT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = CURRENT_DIR.parents[1]

# 优先定位聊天模型权重
DEFAULT_CHAT_DETAIL_WEIGHTS = CURRENT_DIR.parent / "02_聊天详情页识别模型" / "weights" / "best.pt"
if not DEFAULT_CHAT_DETAIL_WEIGHTS.exists():
    DEFAULT_CHAT_DETAIL_WEIGHTS = PROJECT_ROOT / "models" / "02_聊天详情页识别模型" / "weights" / "best.pt"


class MomoPageDetector:
    def __init__(self, chat_model_path: Union[str, Path] = None, device: str = None):
        if chat_model_path is None:
            chat_model_path = DEFAULT_CHAT_DETAIL_WEIGHTS
        self.chat_model_path = Path(chat_model_path)
        
        if not self.chat_model_path.exists():
            raise FileNotFoundError(f"聊天详情页模型权重未找到: {self.chat_model_path}")
            
        self.chat_model = YOLO(str(self.chat_model_path))
        self.ocr = RapidOCR()
        self.device = device

    def detect(self, image_input: Union[str, Path, np.ndarray], return_detail: bool = False) -> Union[str, Dict[str, Any]]:
        """
        判断输入截图处于哪一级页面。

        :param image_input: 图片路径 (str/Path) 或 OpenCV BGR 矩阵 (np.ndarray)
        :param return_detail: 是否返回包含子页面与置信度的详细字典
        :return: 字符串 ("1级页面" | "2级消息页" | "可能不在momoapp")，或详细字典
        """
        if isinstance(image_input, (str, Path)):
            img = cv2.imread(str(image_input))
            if img is None:
                raise ValueError(f"无法读取图片: {image_input}")
        elif isinstance(image_input, np.ndarray):
            img = image_input
        else:
            raise TypeError("image_input 必须是文件路径或 numpy.ndarray")

        h, w = img.shape[:2]

        # 1. 优先检测是否处于 1级页面 (屏幕底部存在 1 级 Tab 关键词)
        bottom_crop = img[int(h * 0.80):, :]
        res_bottom, _ = self.ocr(bottom_crop)
        bottom_texts = [r[1] for r in res_bottom] if res_bottom else []

        # 过滤输入框文案（避免“请输入消息”误伤“消息”Tab）
        filtered_bottom_texts = [
            t for t in bottom_texts
            if not any(noise in t for noise in ("请输入消息", "按住说话", "按住 发送", "发送语音消息"))
        ]

        matched_tabs = [kw for kw in TAB_KEYWORDS if any(kw in t for t in filtered_bottom_texts)]
        has_exclusive_bottom_tab = any(kw in t for kw in EXCLUSIVE_BOTTOM_TABS for t in filtered_bottom_texts)

        top_crop = img[:int(h * 0.18), :]
        res_top, _ = self.ocr(top_crop)
        top_texts = [r[1] for r in res_top] if res_top else []
        top_str = "".join(top_texts)

        has_top_msg = any(k in top_str for k in MSG_TOP_KEYWORDS)
        has_top_home = any(k in top_str for k in HOME_TOP_KEYWORDS)

        # 底栏有 >= 2 个 Tab，或底栏有一级独占Tab且顶栏匹配，绝对是 1 级页面
        is_level_1 = len(matched_tabs) >= 2 or (has_exclusive_bottom_tab and (has_top_msg or has_top_home))

        if is_level_1:
            sub_page = "未知1级页面"
            if any(k in top_str for k in HOME_TOP_KEYWORDS):
                sub_page = "首页"
            elif any(k in top_str for k in MSG_TOP_KEYWORDS):
                sub_page = "消息列表"

            if return_detail:
                return {
                    "page_level": "1级页面",
                    "sub_page": sub_page,
                    "is_momo": True,
                    "matched_tabs": matched_tabs,
                    "top_keywords": top_texts
                }
            return "1级页面"

        # 2. 严格核验是否处于 2级消息页 (聊天详情页)
        # 一票否决：真实的聊天详情页绝对没有底栏一级Tab（首页/直播/小宇宙/更多），也没有顶栏“马上聊”！
        has_top_match_tab = "马上聊" in top_str
        if not has_exclusive_bottom_tab and not has_top_match_tab:
            predict_kwargs = {"conf": 0.45, "verbose": False}
            if self.device:
                predict_kwargs["device"] = self.device

            chat_results = self.chat_model(img, **predict_kwargs)[0]
            detected_classes = [self.chat_model.names[int(c)] for c in chat_results.boxes.cls]

            has_input_box = "input_box" in detected_classes
            has_back_btn = "back_btn" in detected_classes

            # 语义特征：输入框提示语或“与...对话”顶栏标题
            has_input_text = any("请输入消息" in t or "按住说话" in t for t in bottom_texts)
            has_chat_title = any("与" in t and "对话" in t for t in top_texts)

            if (has_input_box and has_back_btn) or (has_input_text and has_back_btn) or (has_input_text and has_chat_title):
                if return_detail:
                    return {
                        "page_level": "2级消息页",
                        "sub_page": "聊天详情页",
                        "is_momo": True,
                        "confidence": {
                            "has_input_box": has_input_box or has_input_text,
                            "has_back_btn": has_back_btn or has_chat_title
                        }
                    }
                return "2级消息页"

        # 3. 未检测到目标内容
        if return_detail:
            return {
                "page_level": "可能不在momoapp",
                "sub_page": None,
                "is_momo": False
            }
        return "可能不在momoapp"


_default_detector = None

def check_momo_page(image_input: Union[str, Path, np.ndarray], return_detail: bool = False) -> Union[str, Dict[str, Any]]:
    global _default_detector
    if _default_detector is None:
        _default_detector = MomoPageDetector()
    return _default_detector.detect(image_input, return_detail=return_detail)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        img_path = sys.argv[1]
        detail_flag = "--detail" in sys.argv
        detector = MomoPageDetector()
        res = detector.detect(img_path, return_detail=detail_flag)
        print(f"Result: {res}")
    else:
        print("Usage: python detector.py <image_path> [--detail]")
