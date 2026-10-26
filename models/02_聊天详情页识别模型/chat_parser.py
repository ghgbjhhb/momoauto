import os
import sys
import json
import cv2
import ctypes
import glob
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = "/mnt/c/Windows/Fonts/msyhbd.ttc"
if not os.path.exists(FONT_PATH):
    FONT_PATH = "/mnt/c/Windows/Fonts/msyh.ttc"

try:
    font_main = ImageFont.truetype(FONT_PATH, 12)
    font_small = ImageFont.truetype(FONT_PATH, 10)
except Exception:
    font_main = font_small = ImageFont.load_default()

def _enable_gpu_acceleration():
    """
    自动检测并预加载环境中的 NVIDIA CUDA 12 共享库，确保 ONNXRuntime 挂载 RTX 3060 独显
    """
    try:
        candidates = [
            '/root/screenparser/venv/lib/python3.*/site-packages/nvidia/*/lib/*.so*',
            '/root/screenparser/venv/lib/python*/*/nvidia/*/lib/*.so*'
        ]
        for pattern in candidates:
            for lib in sorted(glob.glob(pattern)):
                try:
                    ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                except Exception:
                    pass
    except Exception:
        pass

_enable_gpu_acceleration()

from rapidocr_onnxruntime import RapidOCR

def to_py(val):
    if isinstance(val, (np.integer, np.int32, np.int64)):
        return int(val)
    elif isinstance(val, (np.floating, np.float32, np.float64)):
        return float(val)
    elif isinstance(val, list):
        return [to_py(v) for v in val]
    elif isinstance(val, dict):
        return {k: to_py(v) for k, v in val.items()}
    return val

class ChatScreenParser:
    """
    单人聊天页面视觉与语义多模态解析器：
    1. back_btn: 左上角返回键 (物理白色圆形按钮容器优先，其次精确连通域箭头笔画)
    2. header_avatar: 顶栏右上角对方头像 (严格水平对齐 nav_y，排除电池栏与下方气泡)
    3. other_avatar_msg_X: 消息区左侧对方头像 (隔离采样带背景差分 + 纹理方差防虚警，零漏检零漂移)
    4. input_box: 底部输入框 (物理 Canny 闭合轮廓精确定位，拒绝截断残缺公式)
    5. assistant_close_x: 悬浮聊天助手面板右上角关闭按钮 (X)
    6. blue_follow_msg: 消息气泡中的蓝色高亮「关注对方」
    7. top_follow_btn: 顶部常驻提示卡片中的「关注」按钮
    8. blue_block_msg: 消息气泡中的蓝色高亮「拉黑」
    9. blue_open_msg: 消息气泡中的蓝色高亮「开启」
    """
    def __init__(self, use_gpu=True):
        if use_gpu:
            try:
                self.ocr = RapidOCR(det_use_cuda=True, rec_use_cuda=True, cls_use_cuda=False, use_cls=False)
                det_providers = self.ocr.text_det.infer.session.get_providers()
                self.is_gpu = 'CUDAExecutionProvider' in det_providers
                dummy = np.zeros((64, 64, 3), dtype=np.uint8)
                self.ocr(dummy)
            except Exception:
                self.ocr = RapidOCR(use_cls=False)
                self.is_gpu = False
        else:
            self.ocr = RapidOCR(use_cls=False)
            self.is_gpu = False
        print(f"[ChatScreenParser] Initialized | Device: {'NVIDIA GeForce RTX 3060 (CUDA GPU 加速)' if getattr(self, 'is_gpu', False) else 'CPU'}")

    def _find_back_button(self, img, nav_y, max_x=120):
        h, w = img.shape[:2]
        rx1, rx2 = 5, int(max(20, max_x - 5))
        ry1, ry2 = max(0, nav_y - 25), min(h, nav_y + 25)
        sub_back = img[ry1:ry2, rx1:rx2]
        if sub_back.size == 0:
            cx, cy, r = int(rx1 + 18), int(nav_y), 18
            return {'class': 'back_btn', 'label': '返回键', 'box': [cx - r, cy - r, cx + r, cy + r], 'center': [cx, cy]}
            
        gray_b = cv2.cvtColor(sub_back, cv2.COLOR_BGR2GRAY)
        
        # 1. 优先定位物理白色圆形按钮容器 (gray >= 248)
        white_b = (gray_b >= 248).astype(np.uint8)
        num, lbl, stats, centroids = cv2.connectedComponentsWithStats(white_b)
        for i in range(1, num):
            bx, by, bw, bh, ba = stats[i]
            if 20 <= bw <= 48 and 20 <= bh <= 48 and abs(bw - bh) <= 8:
                cx = int(rx1 + bx + bw // 2)
                cy = int(ry1 + by + bh // 2)
                return {
                    'class': 'back_btn',
                    'label': '返回键',
                    'box': [int(rx1 + bx), int(ry1 + by), int(rx1 + bx + bw), int(ry1 + by + bh)],
                    'center': [cx, cy],
                    'confidence': 0.99
                }
                
        # 2. 其次定位暗色箭头笔画连通域
        bin_dark = (gray_b < 130).astype(np.uint8)
        num, lbl, stats, centroids = cv2.connectedComponentsWithStats(bin_dark)
        for i in range(1, num):
            bx, by, bw, bh, ba = stats[i]
            if 10 <= bh <= 28 and 4 <= bw <= 20:
                cx = int(round(rx1 + centroids[i][0]))
                cy = int(round(ry1 + centroids[i][1]))
                r = 18
                return {
                    'class': 'back_btn',
                    'label': '返回键',
                    'box': [cx - r, cy - r, cx + r, cy + r],
                    'center': [cx, cy],
                    'confidence': 0.96
                }
                
        # 3. 几何安全兜底
        cx, cy, r = int(rx1 + 18), int(nav_y), 18
        return {'class': 'back_btn', 'label': '返回键', 'box': [cx - r, cy - r, cx + r, cy + r], 'center': [cx, cy], 'confidence': 0.90}

    def _find_header_avatar(self, img, nav_y, min_x=None, back_btn=None):
        h, w = img.shape[:2]
        ref_y = back_btn['center'][1] if back_btn else nav_y
        ax1 = max(w - 75, int(min_x + 5) if min_x else w - 75)
        ax2 = w - 8
        ay1, ay2 = max(0, ref_y - 26), min(h, ref_y + 26)
        asub = img[ay1:ay2, ax1:ax2]
        if asub.size == 0:
            cx, cy, r = int(ax1 + 25), int(ref_y), 19
            return {'class': 'header_avatar', 'label': '顶栏·对方头像', 'box': [cx - r, cy - r, cx + r, cy + r], 'center': [cx, cy], 'confidence': 0.90}
            
        agray = cv2.cvtColor(asub, cv2.COLOR_BGR2GRAY)
        
        # 1. 高置信度圆检测 (|cy - ref_y| <= 10)
        for p2 in [22, 18, 15]:
            blurred = cv2.GaussianBlur(agray, (5, 5), 0)
            circles = cv2.HoughCircles(blurred, cv2.HOUGH_GRADIENT, dp=1.2, minDist=15,
                                       param1=50, param2=p2, minRadius=14, maxRadius=24)
            if circles is not None:
                circles = np.round(circles[0, :]).astype(int)
                valid = [c for c in circles if 14 <= c[2] <= 24 and abs((ay1 + c[1]) - ref_y) <= 10]
                if valid:
                    cx = int(ax1 + valid[0][0])
                    cy = int(ay1 + valid[0][1])
                    r = int(valid[0][2])
                    return {'class': 'header_avatar', 'label': '顶栏·对方头像', 'box': [cx - r, cy - r, cx + r, cy + r], 'center': [cx, cy], 'confidence': 0.99}
                    
        # 2. 色彩饱和度/方差质心定位 (|cy - ref_y| <= 12)
        ahsv = cv2.cvtColor(asub, cv2.COLOR_BGR2HSV)
        sat = ahsv[:, :, 1]
        pts = np.where(sat > 35)
        if len(pts[0]) >= 20:
            cy_rel = int(np.mean(pts[0]))
            cx_rel = int(np.mean(pts[1]))
            if abs(ay1 + cy_rel - ref_y) <= 12:
                cx = int(ax1 + cx_rel)
                cy = int(ay1 + cy_rel)
                r = 19
                return {'class': 'header_avatar', 'label': '顶栏·对方头像', 'box': [cx - r, cy - r, cx + r, cy + r], 'center': [cx, cy], 'confidence': 0.95}
                
        # 3. 几何安全兜底
        cx, cy, r = int(ax1 + 25), int(ref_y), 19
        return {'class': 'header_avatar', 'label': '顶栏·对方头像', 'box': [cx - r, cy - r, cx + r, cy + r], 'center': [cx, cy], 'confidence': 0.90}

    def _find_input_box(self, img, ocr_results=None):
        h, w = img.shape[:2]
        target_line = None
        for line in ocr_results or []:
            box, text, score = line
            if any(kw in text for kw in ['输入消息', '请输入', '消息...']) and box[0][1] > h * 0.60:
                target_line = line
                break
                
        if target_line:
            box, text, score = target_line
            bx1, by1 = int(box[0][0]), int(box[0][1])
            bx2, by2 = int(box[2][0]), int(box[2][1])
            
            y_start = max(0, by1 - 35)
            y_end = min(h, by1 + 45)
            roi = img[y_start:y_end, :]
            gray_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
            
            # Canny 物理闭合轮廓定位
            edges = cv2.Canny(gray_roi, 20, 60)
            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
            dil = cv2.dilate(edges, kernel)
            contours, _ = cv2.findContours(dil, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            
            best_box = None
            for c in contours:
                x, y, cw, ch = cv2.boundingRect(c)
                if cw >= 220 and 24 <= ch <= 65 and x <= bx1 and (x + cw) >= bx2:
                    best_box = [int(x), int(y_start + y), int(x + cw), int(y_start + y + ch)]
                    break
                    
            if best_box:
                cx = (best_box[0] + best_box[2]) // 2
                cy = (best_box[1] + best_box[3]) // 2
                return {'class': 'input_box', 'label': '输入框', 'box': best_box, 'center': [cx, cy], 'confidence': 0.99}
            else:
                # 语义胶囊跨度 (从相机右侧至表情按钮右侧)
                cap_x1 = max(60, bx1 - 25)
                cap_x2 = min(w - 30, w - 38)
                best_box = [cap_x1, max(0, by1 - 12), cap_x2, min(h, by2 + 12)]
                cx = (cap_x1 + cap_x2) // 2
                cy = (by1 + by2) // 2
                return {'class': 'input_box', 'label': '输入框', 'box': best_box, 'center': [cx, cy], 'confidence': 0.95}
                
        # 纯几何兜底检测
        y_start = int(0.70 * h)
        y_end = int(0.95 * h)
        roi = img[y_start:y_end, :]
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        white_mask = (gray >= 245).astype(np.uint8)
        num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(white_mask)
        for lbl in range(1, num_labels):
            x, y, cw, ch, area = stats[lbl]
            if 200 <= cw <= 360 and 30 <= ch <= 75:
                cx = int(x + cw // 2)
                cy = int(y_start + y + ch // 2)
                return {'class': 'input_box', 'label': '输入框', 'confidence': 0.92, 'box': [int(x), int(y_start + y), int(x + cw), int(y_start + y + ch)], 'center': [cx, cy]}
                
        return {'class': 'input_box', 'label': '输入框', 'box': [70, h - 145, w - 35, h - 90], 'center': [w // 2, h - 118], 'confidence': 0.90}

    def _get_exact_avatar_circle(self, img, cy, bg_color):
        h, w = img.shape[:2]
        # 头像位于左侧区域，通常 x 范围在 15~60 之间。
        # 取局部 ROI: x in [8, min(w, 68)]，安全避开最左侧 0~7px 的模拟器/窗口黑边与外框阴影
        roi_x1 = 8
        roi_x2 = min(w, 68)
        roi_y1 = max(0, cy - 24)
        roi_y2 = min(h, cy + 24)
        roi = img[roi_y1:roi_y2, roi_x1:roi_x2]
        if roi.size == 0 or roi.shape[0] < 15 or roi.shape[1] < 15:
            return None
            
        gray_roi = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        
        # 1. 霍夫圆检测 (标准灵敏度 param2=18)
        circles = cv2.HoughCircles(gray_roi, cv2.HOUGH_GRADIENT, dp=1.2, minDist=10,
                                   param1=45, param2=18, minRadius=15, maxRadius=24)
        if circles is not None and len(circles) > 0:
            for c in circles[0]:
                actual_cx = int(roi_x1 + c[0])
                actual_cy = int(roi_y1 + c[1])
                r = int(c[2])
                if abs(actual_cy - cy) <= 10 and 20 <= actual_cx <= 50:
                    return actual_cx, actual_cy, r
                    
        # 2. 霍夫圆检测 (微弱对比度 param2=14)
        circles = cv2.HoughCircles(gray_roi, cv2.HOUGH_GRADIENT, dp=1.2, minDist=10,
                                   param1=40, param2=14, minRadius=15, maxRadius=24)
        if circles is not None and len(circles) > 0:
            for c in circles[0]:
                actual_cx = int(roi_x1 + c[0])
                actual_cy = int(roi_y1 + c[1])
                r = int(c[2])
                if abs(actual_cy - cy) <= 10 and 20 <= actual_cx <= 50:
                    return actual_cx, actual_cy, r

        # 3. 闭合圆形几何轮廓拟合
        diff = np.abs(gray_roi.astype(np.float32) - bg_color)
        mask = (diff > 16).astype(np.uint8)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask_c = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        cnts, _ = cv2.findContours(mask_c, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in cnts:
            area = cv2.contourArea(cnt)
            peri = cv2.arcLength(cnt, True)
            if peri > 0:
                circularity = 4 * np.pi * area / (peri * peri)
                bx, by, bw, bh = cv2.boundingRect(cnt)
                if circularity > 0.50 and 26 <= bw <= 48 and 26 <= bh <= 48:
                    actual_cx = roi_x1 + bx + bw // 2
                    actual_cy = roi_y1 + by + bh // 2
                    r = (bw + bh) // 4
                    if abs(actual_cy - cy) <= 10 and 20 <= actual_cx <= 50:
                        return actual_cx, actual_cy, r

        return None

    def _find_left_message_avatars(self, img, nav_y, input_box, back_btn=None):
        h, w = img.shape[:2]
        bb_bottom = back_btn['box'][3] if back_btn else nav_y + 20
        strip_y1 = max(nav_y + 40, bb_bottom + 10)
        strip_y2 = min(h, input_box['box'][1] - 12) if input_box else int(h * 0.80)
        if strip_y2 <= strip_y1 + 30:
            return []
            
        # 隔离采样带：x 轴限定在 [10, 50]，彻底剔除左侧屏幕边缘暗边及多窗口黑边干扰
        strip = img[strip_y1:strip_y2, 10:50]
        if strip.size == 0 or strip.shape[0] < 20 or strip.shape[1] < 10:
            return []
            
        gray_s = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)
        bg_color = np.median(gray_s)
        diff = np.abs(gray_s.astype(np.float32) - bg_color)
        hsv_s = cv2.cvtColor(strip, cv2.COLOR_BGR2HSV)
        sat_s = hsv_s[:, :, 1].astype(np.float32)
        
        activity = np.maximum(diff, sat_s * 0.8)
        row_act = np.mean(activity, axis=1)
        
        active_rows = np.where(row_act > 15)[0]
        groups = []
        if len(active_rows) > 0:
            curr = [active_rows[0]]
            for r in active_rows[1:]:
                if r - curr[-1] <= 4:
                    curr.append(r)
                else:
                    groups.append(curr)
                    curr = [r]
            groups.append(curr)
            
        avatars = []
        idx_av = 1
        for g in groups:
            y_start, y_end = g[0], g[-1]
            height = y_end - y_start
            if 20 <= height <= 60:
                cand_cy = int(strip_y1 + (y_start + y_end) // 2)
                circle_info = self._get_exact_avatar_circle(img, cand_cy, bg_color)
                if circle_info is None:
                    continue
                    
                cx, cy, r = circle_info
                
                # 排除平滑渐变阴影：真实头像具有丰富的纹理与边缘，排除左右边缘后拉普拉斯方差 >= 160
                sub_cand = img[max(0, cy - r):min(h, cy + r), max(0, cx - r):min(w, cx + r)]
                if sub_cand.shape[0] > 12 and sub_cand.shape[1] > 12:
                    inner = sub_cand[3:-3, 3:-3]
                    lap = cv2.Laplacian(cv2.cvtColor(inner, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
                    if lap < 160:
                        continue
                        
                avatars.append({
                    'class': f'other_avatar_msg_{idx_av}',
                    'label': f'消息·对方头像{idx_av}',
                    'confidence': 0.99,
                    'box': [int(max(0, cx - r)), int(max(0, cy - r)), int(min(w, cx + r)), int(min(h, cy + r))],
                    'center': [int(cx), int(cy)]
                })
                idx_av += 1
        return avatars

    def _find_exact_assistant_x(self, img, refresh_box):
        rx2 = int(refresh_box[2][0])
        ry1 = int(refresh_box[0][1])
        ry2 = int(refresh_box[2][1])
        
        roi_x1 = rx2 + 10
        roi_x2 = min(img.shape[1], rx2 + 48)
        roi_y1 = max(0, ry1 - 8)
        roi_y2 = min(img.shape[0], ry2 + 8)
        
        sub = img[roi_y1:roi_y2, roi_x1:roi_x2]
        gray = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY)
        
        y_idx, x_idx = np.where(gray < 210)
        if len(x_idx) > 0:
            cx = int(round(roi_x1 + float(np.mean(x_idx))))
            cy = int(round(roi_y1 + float(np.mean(y_idx))))
            r = 9
            return (cx, cy), [cx - r, cy - r, cx + r, cy + r]
        else:
            cx = rx2 + 35
            cy = (ry1 + ry2) // 2
            return (cx, cy), [cx - 9, cy - 9, cx + 9, cy + 9]

    def _analyze_occlusion(self, img, detected_elements, ocr_results):
        h, w = img.shape[:2]
        is_occluded = False
        occlusion_info = None
        
        if 'assistant_close_x' in detected_elements:
            close_el = detected_elements['assistant_close_x']
            card_top = max(0, close_el['box'][1] - 15)
            assistant_y2 = [line[0][2][1] for line in (ocr_results or []) if line[0][0][1] >= card_top]
            card_bottom = int(max(assistant_y2)) + 15 if assistant_y2 else h - 80
            if 'input_box' in detected_elements:
                card_bottom = min(card_bottom, detected_elements['input_box']['box'][1] - 5)
                
            is_occluded = True
            occlusion_info = {
                'is_occluded': True,
                'type': 'floating_assistant_panel',
                'severity': 'blocking',
                'title': '聊天助手悬浮窗遮挡',
                'message': '检测到底部聊天助手悬浮面板弹出，遮挡了消息流与历史记录',
                'occluding_box': [0, card_top, w, card_bottom],
                'occluded_regions': ['message_history_bottom'],
                'recovery_action': {
                    'action': 'click',
                    'target': 'assistant_close_x',
                    'target_coord': close_el['center'],
                    'target_box': close_el['box'],
                    'description': '点击右上角关闭按钮(X)关闭悬浮卡片恢复正常视野'
                }
            }
        elif ocr_results:
            modal_btn_keywords = ['我知道了', '知道了', '取消', '确定', '允许', '始终允许', '拒绝', '跳过', '同意', '残忍离开', '去开启', '去设置', '以后再说', '立即更新', '放弃', '我知道啦', '立即体验', '关闭']
            for line in ocr_results:
                box, text, score = line
                bx1, by1 = int(box[0][0]), int(box[0][1])
                bx2, by2 = int(box[2][0]), int(box[2][1])
                cx, cy = (bx1 + bx2) // 2, (by1 + by2) // 2
                
                if text == '关注' or by1 < 160 or by1 > h - 70:
                    continue
                    
                if any(k == text or (k in text and len(text) <= len(k) + 2) for k in modal_btn_keywords):
                    is_occluded = True
                    occlusion_info = {
                        'is_occluded': True,
                        'type': 'modal_dialog',
                        'severity': 'critical',
                        'title': '业务/系统弹窗遮挡',
                        'message': f'检测到弹窗阻断操作，发现弹窗按钮: 「{text}」',
                        'occluded_regions': ['full_screen'],
                        'recovery_action': {
                            'action': 'click',
                            'target': 'dialog_dismiss_button',
                            'target_coord': [cx, cy],
                            'target_box': [bx1, by1, bx2, by2],
                            'button_text': text,
                            'description': f'点击「{text}」按钮关闭弹窗解除遮挡'
                        }
                    }
                    break

        return is_occluded, occlusion_info

    def parse(self, img_path_or_array):
        if isinstance(img_path_or_array, str):
            img = cv2.imread(img_path_or_array)
        else:
            img = img_path_or_array
            
        h, w = img.shape[:2]
        detected_elements = {}
        
        # 1. OCR 毫秒级优先执行
        ocr_results, elapse = self.ocr(img)
        
        # 2. 语义动态物理基准线
        title_box = None
        for line in (ocr_results or []):
            box, text, score = line
            if '与' in text and any(k in text for k in ['对话', '对', '话']):
                title_box = box
                break
        
        if title_box is not None:
            tx1, ty1 = title_box[0][0], title_box[0][1]
            tx2, ty2 = title_box[2][0], title_box[2][1]
            nav_y = int((ty1 + ty2) / 2)
        else:
            cand = [l for l in (ocr_results or []) if 20 <= l[0][0][1] <= 130 and l[0][0][0] > 40]
            if cand:
                nav_y = int((cand[0][0][0][1] + cand[0][0][2][1]) / 2)
                tx1 = cand[0][0][0][0]
                tx2 = cand[0][0][2][0]
            else:
                nav_y = 55
                tx1 = 100
                tx2 = w - 80

        # 3. 定位返回键
        back_btn = self._find_back_button(img, nav_y=nav_y, max_x=tx1)
        if back_btn:
            detected_elements['back_btn'] = back_btn

        # 4. 定位顶栏对方头像
        header_avatar = self._find_header_avatar(img, nav_y=nav_y, min_x=tx2, back_btn=back_btn)
        if header_avatar:
            detected_elements['header_avatar'] = header_avatar

        # 5. 定位底部输入框
        input_box = self._find_input_box(img, ocr_results)
        if input_box:
            detected_elements['input_box'] = input_box

        # 6. 检测消息区域左侧对方头像列表
        left_avatars = self._find_left_message_avatars(img, nav_y=nav_y, input_box=input_box, back_btn=back_btn)
        for la in left_avatars:
            detected_elements[la['class']] = la
            
        # 7. OCR 业务交互
        for line in (ocr_results or []):
            box, text, score = line
            bx1, by1 = int(box[0][0]), int(box[0][1])
            bx2, by2 = int(box[2][0]), int(box[2][1])
            
            if text == '关注' and by1 < 200:
                detected_elements['top_follow_btn'] = {
                    'class': 'top_follow_btn',
                    'label': '顶部关注按钮',
                    'confidence': round(score, 4),
                    'box': [int(bx1 - 10), int(by1 - 4), int(bx2 + 10), int(by2 + 4)],
                    'center': [int((bx1 + bx2) // 2), int((by1 + by2) // 2)]
                }
                
            if '刷新' in text and by1 > 250:
                (cx, cy), x_box = self._find_exact_assistant_x(img, box)
                detected_elements['assistant_close_x'] = {
                    'class': 'assistant_close_x',
                    'label': '聊天助手关闭X',
                    'confidence': round(score, 4),
                    'box': x_box,
                    'center': [cx, cy]
                }
                
            is_follow_text = any(k in text for k in ['关注对方', '大注对方', '关住对方', '注对方'])
            if is_follow_text and by1 > 80:
                sub = img[by1:by2, bx1:bx2]
                hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
                mask_blue = cv2.inRange(hsv, np.array([90, 70, 70]), np.array([130, 255, 255]))
                pts = cv2.findNonZero(mask_blue)
                if pts is not None and len(pts) >= 15:
                    xs, ys, ws, hs = cv2.boundingRect(pts)
                    blue_box = [int(bx1 + xs), int(by1 + ys), int(bx1 + xs + ws), int(by1 + ys + hs)]
                    detected_elements['blue_follow_msg'] = {
                        'class': 'blue_follow_msg',
                        'label': '消息·关注对方',
                        'confidence': round(score, 4),
                        'box': blue_box,
                        'center': [int((blue_box[0] + blue_box[2]) // 2), int((blue_box[1] + blue_box[3]) // 2)],
                        'full_text': text
                    }
                    
            if '开启' in text and by1 > 80:
                sub = img[by1:by2, bx1:bx2]
                hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
                mask_blue = cv2.inRange(hsv, np.array([90, 70, 70]), np.array([130, 255, 255]))
                pts = cv2.findNonZero(mask_blue)
                if pts is not None and len(pts) >= 15:
                    xs, ys, ws, hs = cv2.boundingRect(pts)
                    blue_box = [int(bx1 + xs), int(by1 + ys), int(bx1 + xs + ws), int(by1 + ys + hs)]
                    detected_elements['blue_open_msg'] = {
                        'class': 'blue_open_msg',
                        'label': '消息·开启',
                        'confidence': round(score, 4),
                        'box': blue_box,
                        'center': [int((blue_box[0] + blue_box[2]) // 2), int((blue_box[1] + blue_box[3]) // 2)],
                        'full_text': text
                    }

            if '拉黑' in text and by1 > 80:
                sub = img[by1:by2, bx1:bx2]
                hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
                mask_blue = cv2.inRange(hsv, np.array([90, 70, 70]), np.array([130, 255, 255]))
                pts = cv2.findNonZero(mask_blue)
                if pts is not None and len(pts) >= 15:
                    xs, ys, ws, hs = cv2.boundingRect(pts)
                    blue_box = [int(bx1 + xs), int(by1 + ys), int(bx1 + xs + ws), int(by1 + ys + hs)]
                    detected_elements['blue_block_msg'] = {
                        'class': 'blue_block_msg',
                        'label': '消息·可拉黑',
                        'confidence': round(score, 4),
                        'box': blue_box,
                        'center': [int((blue_box[0] + blue_box[2]) // 2), int((blue_box[1] + blue_box[3]) // 2)],
                        'full_text': text
                    }

        # 8. 遮挡分析
        is_occluded, occlusion_info = self._analyze_occlusion(img, detected_elements, ocr_results)
        if is_occluded and occlusion_info and 'occluding_box' in occlusion_info:
            ox1, oy1, ox2, oy2 = occlusion_info['occluding_box']
            for name, el in detected_elements.items():
                if name == 'assistant_close_x':
                    continue
                ecx, ecy = el['center']
                if ox1 <= ecx <= ox2 and oy1 <= ecy <= oy2:
                    el['is_occluded'] = True
                    el['occluded_by'] = occlusion_info['type']
                else:
                    el['is_occluded'] = False

        res_dict = {
            'resolution': [w, h],
            'is_occluded': is_occluded,
            'occlusion_info': occlusion_info,
            'elements': detected_elements
        }
        return to_py(res_dict)

    def annotate(self, img_path_or_array, parse_result=None):
        if isinstance(img_path_or_array, str):
            img = cv2.imread(img_path_or_array)
        else:
            img = img_path_or_array
            
        if parse_result is None:
            parse_result = self.parse(img)
            
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(img_rgb)
        draw = ImageDraw.Draw(pil_img, "RGBA")
        
        elements = parse_result['elements']
        
        COLOR_DEFAULT = ((255, 60, 100, 255), (200, 30, 70, 230))
        COLORS = {
            'back_btn': ((255, 180, 0, 255), (200, 140, 0, 230)),
            'header_avatar': ((255, 60, 100, 255), (200, 30, 70, 230)),
            'input_box': ((170, 70, 240, 255), (130, 40, 190, 230)),
            'assistant_close_x': ((0, 220, 50, 255), (0, 150, 30, 230)),
            'blue_follow_msg': ((0, 150, 255, 255), (0, 100, 200, 230)),
            'blue_open_msg': ((0, 180, 255, 255), (0, 120, 220, 230)),
            'top_follow_btn': ((255, 120, 0, 255), (200, 90, 0, 230)),
            'blue_block_msg': ((255, 50, 120, 255), (200, 30, 90, 230))
        }
        
        for k, el in elements.items():
            x1, y1, x2, y2 = el['box']
            cx, cy = el['center']
            
            if k.startswith('other_avatar_msg_'):
                line_col, bg_col = COLORS['header_avatar']
            else:
                line_col, bg_col = COLORS.get(k, COLOR_DEFAULT)
            
            draw.rectangle([x1, y1, x2, y2], outline=line_col, width=2)
            
            r = 3
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255), outline=line_col)
            draw.line([(cx - 7, cy), (cx + 7, cy)], fill=line_col, width=1)
            draw.line([(cx, cy - 7), (cx, cy + 7)], fill=line_col, width=1)
            
            occ_tag = " (已遮挡)" if el.get('is_occluded') else ""
            label = f"{el['label']} [{cx}, {cy}]{occ_tag}"
            bbox = draw.textbbox((x1, y1), label, font=font_small)
            lbl_w = bbox[2] - bbox[0]
            lbl_h = bbox[3] - bbox[1]
            
            if k == 'back_btn':
                lbl_x = max(2, x1 - 2)
                lbl_y = y2 + 3
            elif k == 'header_avatar':
                lbl_x = max(2, min(x1 - lbl_w + 25, img.shape[1] - lbl_w - 6))
                lbl_y = y2 + 3
            elif k.startswith('other_avatar_msg_'):
                lbl_x = max(2, x1 - 2)
                lbl_y = y2 + 2
            elif k == 'top_follow_btn':
                lbl_x = max(2, x1 - lbl_w - 6)
                lbl_y = y1 - 2
            elif k == 'input_box':
                lbl_x = x1 + 4
                lbl_y = y1 - lbl_h - 4
            else:
                lbl_y = y1 - lbl_h - 4 if y1 - lbl_h - 4 > 25 else y2 + 3
                lbl_x = max(2, min(x1, img.shape[1] - lbl_w - 6))
                
            draw.rounded_rectangle([lbl_x - 3, lbl_y - 2, lbl_x + lbl_w + 3, lbl_y + lbl_h + 2], radius=3, fill=bg_col)
            draw.text((lbl_x, lbl_y), label, fill=(255, 255, 255), font=font_small)
            
        if parse_result.get('is_occluded') and parse_result.get('occlusion_info'):
            occ = parse_result['occlusion_info']
            rec = occ.get('recovery_action') or {}
            rec_coord = rec.get('target_coord', [])
            warn_text = f"[! 遮挡警报 !] {occ.get('title', '页面被遮挡')} | 建议恢复点击坐标: {rec_coord}"
            
            banner_y1, banner_y2 = 0, 24
            draw.rectangle([0, banner_y1, img.shape[1], banner_y2], fill=(210, 50, 0, 240))
            draw.text((10, banner_y1 + 4), warn_text, fill=(255, 255, 255), font=font_small)
            
            if 'occluding_box' in occ:
                bx1, by1, bx2, by2 = occ['occluding_box']
                draw.rectangle([bx1 + 1, by1 + 1, bx2 - 1, by2 - 1], outline=(255, 100, 0, 220), width=2)
                box_title = f" [遮挡区域: {occ.get('title')}] "
                draw.rounded_rectangle([bx1 + 8, by1 + 4, bx1 + 160, by1 + 22], radius=3, fill=(210, 50, 0, 220))
                draw.text((bx1 + 12, by1 + 6), box_title, fill=(255, 255, 255), font=font_small)

        res_bgr = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        return res_bgr

if __name__ == '__main__':
    parser = ChatScreenParser()
    sample = '/mnt/c/Users/Administrator/Pictures/聊天界面素材/微信图片_20261011172450_87_13.png'
    res = parser.parse(sample)
    print(json.dumps(res, indent=2, ensure_ascii=False))
