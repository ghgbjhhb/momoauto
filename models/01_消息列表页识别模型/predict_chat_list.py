import os
import sys
import json
import cv2
import torch
from ultralytics import YOLO

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WEIGHTS = os.path.join(CURRENT_DIR, "weights", "best.pt")

CLASS_NAMES = [
    "chat_card",     # 0: 纵向联系人卡片整行
    "recent_block",  # 1: '最近在线'整块区域
    "banner_card",   # 2: 顶部推广卡片整块(语音/视频匹配)
    "unread_badge",  # 3: 未读红点/数字红圈
    "floating_btn",  # 4: 一键AI找人悬浮胶囊
    "tab_home",      # 5: 底栏-首页
    "tab_live",      # 6: 底栏-直播
    "tab_msg",       # 7: 底栏-消息
    "tab_universe",  # 8: 底栏-小宇宙
    "tab_more"       # 9: 底栏-更多
]

CONF_THRESHOLDS = {
    "chat_card": 0.40,
    "recent_block": 0.45,
    "banner_card": 0.45,
    "unread_badge": 0.35,
    "floating_btn": 0.45,
    "tab_home": 0.45,
    "tab_live": 0.45,
    "tab_msg": 0.45,
    "tab_universe": 0.45,
    "tab_more": 0.45
}

class ChatListVisionParser:
    """
    针对消息列表页面的 YOLO11m 10分类全界面识别器
    """
    def __init__(self, weights=DEFAULT_WEIGHTS, device=None):
        if device is None:
            device = 0 if torch.cuda.is_available() else "cpu"
        print(f"[ChatListVisionParser] 加载模型: {weights} on device={device}")
        self.model = YOLO(weights)
        self.device = device
        
    def detect(self, img_path_or_array, conf=None, imgsz=832, filter_edge_cards=True, return_all_with_status=False):
        if isinstance(img_path_or_array, str):
            img = cv2.imread(img_path_or_array)
        else:
            img = img_path_or_array
            
        h, w = img.shape[:2]
        results = self.model.predict(
            img,
            conf=0.30,
            iou=0.45,
            imgsz=imgsz,
            rect=True,
            device=self.device,
            verbose=False
        )[0]
        
        boxes = results.boxes
        
        # 1. 动态确定底栏上边缘 (保证卡片绝不与底栏重叠)
        detected_tab_y1 = []
        for box in boxes:
            cls_id = int(box.cls[0].item())
            if cls_id >= 5: # tab buttons
                detected_tab_y1.append(int(box.xyxy[0][1].item()))
        tab_top_y = min(detected_tab_y1) if detected_tab_y1 else int(h * 0.88)
        
        # 2. 顶栏安全边界 (header bar)
        header_bottom_y = int(h * 0.105)
        
        raw_cards = []
        raw_other_dets = []
        
        for box in boxes:
            cls_id = int(box.cls[0].item())
            score = float(box.conf[0].item())
            cname = CLASS_NAMES[cls_id] if cls_id < len(CLASS_NAMES) else f"cls_{cls_id}"
            
            min_thresh = CONF_THRESHOLDS.get(cname, 0.40)
            if conf is not None:
                min_thresh = max(min_thresh, conf)
            if score < min_thresh:
                continue
                
            x1, y1, x2, y2 = map(int, box.xyxy[0].cpu().numpy())
            
            # 过滤头像区域内部误检的小红点
            if cname == "unread_badge":
                if header_bottom_y <= y1 < tab_top_y - 10 and x1 < int(w * 0.65):
                    continue
                    
            if cname == "chat_card":
                raw_cards.append({
                    "class": cname,
                    "confidence": round(score, 4),
                    "box": [x1, y1, x2, y2],
                    "center": [(x1 + x2) // 2, (y1 + y2) // 2],
                    "area": (x2 - x1) * (y2 - y1),
                    "height": y2 - y1
                })
            else:
                raw_other_dets.append({
                    "class": cname,
                    "confidence": round(score, 4),
                    "box": [x1, y1, x2, y2],
                    "center": [(x1 + x2) // 2, (y1 + y2) // 2],
                    "area": (x2 - x1) * (y2 - y1)
                })
                
        # 3. 底栏与悬浮按钮去重 (保留置信度最高的一个)
        final_other = []
        unique_seen = {}
        for d in sorted(raw_other_dets, key=lambda x: -x["confidence"]):
            cname = d["class"]
            if cname.startswith("tab_") or cname == "floating_btn":
                if cname not in unique_seen:
                    unique_seen[cname] = d
                    final_other.append(d)
            else:
                final_other.append(d)
                
        # 4. 联系人卡片由上至下排序并处理首尾边缘过滤
        raw_cards.sort(key=lambda item: item["box"][1])
        
        cards_with_status = []
        n_cards = len(raw_cards)
        for i, card in enumerate(raw_cards):
            card_copy = dict(card)
            is_edge = False
            edge_reason = None
            if filter_edge_cards:
                # 真实几何边缘判定：仅在卡片真正被顶栏遮挡、被底栏截断或高度过扁残缺时才判定为边缘截断
                if card["box"][1] < header_bottom_y or card["height"] < 35:
                    is_edge = True
                    edge_reason = "edge_top"
                elif card["box"][3] > tab_top_y - 5:
                    is_edge = True
                    edge_reason = "edge_bottom"
            
            # 边界安全夹紧
            bx1, by1, bx2, by2 = card_copy["box"]
            if by1 < header_bottom_y:
                by1 = header_bottom_y + 2
            if by2 >= tab_top_y:
                by2 = tab_top_y - 2
            card_copy["box"] = [bx1, by1, bx2, by2]
            card_copy["center"] = [(bx1 + bx2) // 2, (by1 + by2) // 2]
            
            card_copy["is_edge"] = is_edge
            card_copy["edge_reason"] = edge_reason
            cards_with_status.append(card_copy)
            
        if return_all_with_status:
            valid_cards = cards_with_status
        else:
            valid_cards = [c for c in cards_with_status if not c.get("is_edge", False)]
            
        return {
            "resolution": [w, h],
            "tab_top_y": tab_top_y,
            "header_bottom_y": header_bottom_y,
            "chat_cards": valid_cards,
            "other_elements": final_other,
            "total_detections": len(valid_cards) + len(final_other)
        }

if __name__ == '__main__':
    parser = ChatListVisionParser()
    print("ChatListVisionParser initialized successfully!")
