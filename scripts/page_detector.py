"""
页面层级识别器 (兼容入口)
实际核心模块已统一归入: models/识别app页面/
"""

import sys
from pathlib import Path

# 将项目根目录加入 sys.path
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# 转发调用
from models.识别app页面.detector import MomoPageDetector, check_momo_page

if __name__ == "__main__":
    if len(sys.argv) > 1:
        img_path = sys.argv[1]
        detail_flag = "--detail" in sys.argv
        detector = MomoPageDetector()
        res = detector.detect(img_path, return_detail=detail_flag)
        print(f"Result: {res}")
    else:
        print("Usage: python page_detector.py <image_path> [--detail]")
