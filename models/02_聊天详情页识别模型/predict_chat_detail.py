import os
import sys
import json
import cv2
import torch
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from ultralytics import YOLO

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WEIGHTS = os.path.join(CURRENT_DIR, "weights", "best.pt")

CLASS_NAMES = [
    "back_btn",            # 0: 返回键
    "avatar",              # 1: 统一头像（不区分归属，仅输出目标坐标与置信度）
    "input_box",           # 2: 底部输入框容器
    "top_follow_btn",      # 3: 顶部关注按钮
    "assistant_close_x",   # 4: 聊天助手关闭X
    "assistant_panel",     # 5: 聊天助手面板
    "send_btn"             # 6: 发送按钮（激活状态蓝色胶囊按钮）
]

CLASS_LABELS_ZH = {
    "back_btn": "返回键",
    "avatar": "头像",
    "input_box": "输入框",
    "top_follow_btn": "关注按钮",
    "assistant_close_x": "助手关闭X",
    "assistant_panel": "助手面板",
    "send_btn": "发送按钮"
}

CONF_THRESHOLDS = {
    "back_btn": 0.40,
    "avatar": 0.28,
    "input_box": 0.35,
    "top_follow_btn": 0.35,
    "assistant_close_x": 0.25,
    "assistant_panel": 0.30,
    "send_btn": 0.35
}


def assistant_pair_is_valid(panel, close_x, width, height):
    """Require the close X to belong to a real assistant panel.

    A close-X detection by itself is not actionable: chat text, avatars and
    other high-contrast UI details can produce a visually similar rectangle.
    The trained panel and close-X detections must be present in the same frame,
    with the X inside the panel's upper-right header area.
    """
    if not panel or not close_x:
        return False
    panel_box = panel.get("box")
    close_box = close_x.get("box")
    if (not isinstance(panel_box, list) or len(panel_box) != 4 or
            not isinstance(close_box, list) or len(close_box) != 4):
        return False
    px1, py1, px2, py2 = panel_box
    cx1, cy1, cx2, cy2 = close_box
    panel_width = px2 - px1
    panel_height = py2 - py1
    if panel_width < width * 0.35 or panel_height < height * 0.08 or py1 < height * 0.18:
        return False

    close_cx = (cx1 + cx2) / 2
    close_cy = (cy1 + cy2) / 2
    relative_x = (close_cx - px1) / panel_width
    relative_y = (close_cy - py1) / panel_height
    inside = px1 - width * 0.02 <= close_cx <= px2 + width * 0.02 and \
        py1 - height * 0.02 <= close_cy <= py2 + height * 0.02
    return inside and 0.65 <= relative_x <= 1.08 and -0.12 <= relative_y <= 0.45

class ChatDetailYOLOParser:
    """
    单人聊天详情页专属 YOLO11m 端到端目标检测解析器 (7-Class 架构)
    支持返回键、统一头像、输入框、关注按钮、悬浮助手遮挡、发送按钮的高精定位。
    """
    def __init__(self, weights=DEFAULT_WEIGHTS, device=None):
        if device is None:
            device = 0 if torch.cuda.is_available() else "cpu"
        self.device = device
        device_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() and device != "cpu" else "CPU"
        print(f"[ChatDetailYOLOParser] 加载 YOLO11m 模型: {weights} | 设备: {device_name}")
        self.model = YOLO(weights)

    def detect(self, img_path_or_array, conf=None, imgsz=832):
        if isinstance(img_path_or_array, str):
            img = cv2.imread(img_path_or_array)
        else:
            img = img_path_or_array
            
        h, w = img.shape[:2]
        pred_results = self.model.predict(
            img,
            conf=0.20,
            iou=0.45,
            imgsz=imgsz,
            rect=True,
            device=self.device,
            verbose=False
        )
        
        raw_items = []
        for r in pred_results:
            boxes = r.boxes
            for i in range(len(boxes)):
                cls_id = int(boxes.cls[i].item())
                score = float(boxes.conf[i].item())
                if cls_id >= len(CLASS_NAMES):
                    continue
                cls_name = CLASS_NAMES[cls_id]

                min_conf = conf if conf is not None else CONF_THRESHOLDS.get(cls_name, 0.30)
                if score < min_conf:
                    continue

                x1, y1, x2, y2 = [int(v) for v in boxes.xyxy[i].tolist()]
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(w, x2), min(h, y2)
                cx = (x1 + x2) // 2
                cy = (y1 + y2) // 2

                raw_items.append({
                    "class": cls_name,
                    "confidence": round(score, 4),
                    "box": [x1, y1, x2, y2],
                    "center": [cx, cy]
                })

        # 1. 结构化单例元素提取（返回键、输入框、关注按钮、助手面板、关闭X、发送按钮）
        single_elements = {}
        for item in raw_items:
            cls_name = item["class"]
            if cls_name != "avatar":
                # 若页面中同类别出现多目标，保留最高置信度项
                if cls_name not in single_elements or item["confidence"] > single_elements[cls_name]["confidence"]:
                    single_elements[cls_name] = {
                        "class": cls_name,
                        "label": CLASS_LABELS_ZH.get(cls_name, cls_name),
                        "confidence": item["confidence"],
                        "box": item["box"],
                        "center": item["center"]
                    }

        # 2. 统一头像列表提取（不分是谁的头像，仅按垂直坐标从上到下排序输出）
        avatars = []
        for item in raw_items:
            if item["class"] == "avatar":
                avatars.append({
                    "class": "avatar",
                    "confidence": item["confidence"],
                    "box": item["box"],
                    "center": item["center"]
                })
        avatars.sort(key=lambda a: a["center"][1])

        # 3. 检查是否有聊天助手悬浮窗遮挡。
        #    关闭 X 单独出现时只能作为候选证据，不能触发点击。
        has_panel = "assistant_panel" in single_elements
        has_close_x = "assistant_close_x" in single_elements
        panel_el = single_elements.get("assistant_panel")
        close_el = single_elements.get("assistant_close_x")
        pair_confirmed = assistant_pair_is_valid(panel_el, close_el, w, h)
        is_occluded = pair_confirmed
        occlusion_info = None
        if is_occluded:
            target_coord = close_el["center"]
            target_box = close_el["box"]

            occlusion_info = {
                "type": "floating_assistant_panel",
                "severity": "blocking",
                "title": "聊天助手悬浮窗遮挡",
                "panel_box": panel_el["box"] if panel_el else None,
                "recovery_action": {
                    "action": "click",
                    "target": "assistant_close_x",
                    "target_coord": target_coord,
                    "target_box": target_box
                }
            }

        return {
            "resolution": [w, h],
            "is_occluded": is_occluded,
            "occlusion_info": occlusion_info,
            "assistant_overlay_candidate": {
                "panel_detected": has_panel,
                "close_x_detected": has_close_x,
                "confirmed": pair_confirmed,
            },
            "elements": single_elements,
            "avatars": avatars,
            "all_detections": raw_items
        }

    def annotate(self, img_path_or_array, detection_result=None):
        if isinstance(img_path_or_array, str):
            img = cv2.imread(img_path_or_array)
        else:
            img = img_path_or_array

        if detection_result is None:
            detection_result = self.detect(img)

        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(img_rgb)
        draw = ImageDraw.Draw(pil_img, "RGBA")

        font = None
        for font_candidate in [
            "/mnt/c/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/msyh.ttc",
            "/mnt/c/Windows/Fonts/simhei.ttf",
            "C:/Windows/Fonts/simhei.ttf",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
        ]:
            if os.path.exists(font_candidate):
                try:
                    font = ImageFont.truetype(font_candidate, 13)
                    break
                except Exception:
                    pass
        if font is None:
            font = ImageFont.load_default()

        COLORS = {
            "back_btn": (255, 180, 0),        # 橙黄
            "avatar": (255, 60, 100),          # 统一粉红
            "input_box": (170, 70, 240),       # 紫色
            "top_follow_btn": (255, 120, 0),   # 深橙
            "assistant_close_x": (0, 220, 50), # 绿色
            "assistant_panel": (30, 144, 255), # 蓝色
            "send_btn": (0, 120, 255)          # 明蓝 (发送按钮)
        }

        draw_items = []
        for el in detection_result["elements"].values():
            draw_items.append({
                "class": el["class"],
                "label": el["class"],
                "confidence": el["confidence"],
                "box": el["box"],
                "center": el["center"]
            })
        for av in detection_result["avatars"]:
            draw_items.append({
                "class": "avatar",
                "label": "avatar",
                "confidence": av["confidence"],
                "box": av["box"],
                "center": av["center"]
            })

        for el in draw_items:
            x1, y1, x2, y2 = el["box"]
            cx, cy = el["center"]
            cls_name = el["class"]
            col = COLORS.get(cls_name, (255, 60, 100))

            draw.rectangle([x1, y1, x2, y2], outline=col, width=2)
            # 十字靶心
            draw.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=(255, 255, 255), outline=col)
            draw.line([(cx - 7, cy), (cx + 7, cy)], fill=col, width=1)
            draw.line([(cx, cy - 7), (cx, cy + 7)], fill=col, width=1)

            label = f"{el['label']} {el['confidence']:.2f} [{cx}, {cy}]"
            bbox = draw.textbbox((x1, y1), label, font=font)
            lbl_w, lbl_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
            lbl_y = y1 - lbl_h - 4 if y1 - lbl_h - 4 > 5 else y2 + 3
            lbl_x = max(2, min(x1, img.shape[1] - lbl_w - 6))

            draw.rounded_rectangle([lbl_x - 2, lbl_y - 2, lbl_x + lbl_w + 2, lbl_y + lbl_h + 2], radius=3, fill=(col[0], col[1], col[2], 220))
            draw.text((lbl_x, lbl_y), label, fill=(255, 255, 255), font=font)

        return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)

if __name__ == '__main__':
    parser = ChatDetailYOLOParser()
    test_img = "/mnt/c/Users/Administrator/Pictures/聊天界面素材/微信图片_20261011172003_46_13.png"
    if len(sys.argv) > 1:
        test_img = sys.argv[1]
        
    print(f"Testing YOLO inference on: {test_img}")
    res = parser.detect(test_img)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    
    out_img = parser.annotate(test_img, res)
    out_path = os.path.join(CURRENT_DIR, "yolo_test_output.jpg")
    cv2.imwrite(out_path, out_img)
    print(f"Annotated test image saved to: {out_path}")
