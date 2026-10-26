"""
一键将高精度解析标注 (benchmark_results.json) 转换为 YOLO 目标检测训练集
支持直接训练 YOLO11 聊天页专属检测模型，实现后续零门槛迭代
"""
import os
import sys
import json
import shutil
import random
import cv2

CLASSES = [
    'back_btn',            # 0: 返回键
    'avatar',              # 1: 统一头像（顶栏、消息流对方、自己）
    'input_box',           # 2: 底部输入框
    'top_follow_btn',      # 3: 顶部关注按钮
    'assistant_close_x',   # 4: 聊天助手关闭X
    'assistant_panel'      # 5: 聊天助手面板
]

def export_to_yolo(
    benchmark_json_path,
    images_dir,
    output_dataset_dir,
    train_ratio=0.85,
    seed=42
):
    random.seed(seed)
    os.makedirs(os.path.join(output_dataset_dir, 'images', 'train'), exist_ok=True)
    os.makedirs(os.path.join(output_dataset_dir, 'images', 'val'), exist_ok=True)
    os.makedirs(os.path.join(output_dataset_dir, 'labels', 'train'), exist_ok=True)
    os.makedirs(os.path.join(output_dataset_dir, 'labels', 'val'), exist_ok=True)

    with open(benchmark_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    keys = list(data.keys())
    random.shuffle(keys)
    split_idx = int(len(keys) * train_ratio)
    train_keys = set(keys[:split_idx])

    converted_count = 0
    box_count = 0

    for name in keys:
        res = data[name]
        elements = res.get('elements', {})
        
        # 查找对应图片文件
        img_path = None
        for ext in ['.png', '.jpg', '.jpeg']:
            cand = os.path.join(images_dir, name + ext)
            if os.path.exists(cand):
                img_path = cand
                break
        
        if not img_path:
            continue
            
        im = cv2.imread(img_path)
        if im is None:
            continue
        h, w = im.shape[:2]

        split = 'train' if name in train_keys else 'val'
        dst_img_name = f"{name}.jpg"
        dst_img_path = os.path.join(output_dataset_dir, 'images', split, dst_img_name)
        dst_lbl_path = os.path.join(output_dataset_dir, 'labels', split, f"{name}.txt")

        # 保存为统一的 JPEG 格式
        cv2.imwrite(dst_img_path, im, [cv2.IMWRITE_JPEG_QUALITY, 95])

        lbl_lines = []
        for k, el in elements.items():
            # 归一化类别名 (合并 other_avatar_msg_1, other_avatar_msg_2 -> other_avatar_msg)
            cls_name = 'other_avatar_msg' if k.startswith('other_avatar_msg') else k
            if cls_name not in CLASSES:
                continue
            cls_id = CLASSES.index(cls_name)
            
            box = el['box']
            x1, y1, x2, y2 = box
            
            # YOLO 归一化 [cx, cy, w, h]
            cx = ((x1 + x2) / 2.0) / w
            cy = ((y1 + y2) / 2.0) / h
            bw = (x2 - x1) / float(w)
            bh = (y2 - y1) / float(h)

            cx = max(0.0, min(1.0, cx))
            cy = max(0.0, min(1.0, cy))
            bw = max(0.0, min(1.0, bw))
            bh = max(0.0, min(1.0, bh))

            lbl_lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
            box_count += 1

        with open(dst_lbl_path, 'w', encoding='utf-8') as lf:
            lf.write('\n'.join(lbl_lines))
        converted_count += 1

    # 生成 data.yaml
    yaml_content = f"""path: .
train: images/train
val: images/val
nc: {len(CLASSES)}
names: {CLASSES}
"""
    yaml_path = os.path.join(output_dataset_dir, 'data.yaml')
    with open(yaml_path, 'w', encoding='utf-8') as yf:
        yf.write(yaml_content)

    print(f"Dataset export completed!")
    print(f"Total images converted: {converted_count} (Train: {len(train_keys)}, Val: {len(keys) - len(train_keys)})")
    print(f"Total bounding boxes: {box_count}")
    print(f"Dataset configuration saved to: {yaml_path}")

if __name__ == '__main__':
    CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
    BENCHMARK_JSON = os.path.join(CURRENT_DIR, "..", "eval_benchmark", "benchmark_results.json")
    IMAGES_DIR = "C:\\Users\\Administrator\\Pictures\\聊天界面素材"
    OUTPUT_DIR = os.path.join(CURRENT_DIR, "..", "yolo_dataset")
    
    # 转换为 WSL 路径 (若在 WSL 中运行)
    if not os.path.exists(IMAGES_DIR) and os.path.exists('/mnt/c/Users/Administrator/Pictures/聊天界面素材'):
        IMAGES_DIR = '/mnt/c/Users/Administrator/Pictures/聊天界面素材'
        
    export_to_yolo(BENCHMARK_JSON, IMAGES_DIR, OUTPUT_DIR)
