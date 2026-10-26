import os
import sys
import json
import cv2

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.append(CURRENT_DIR)
from chat_parser import ChatScreenParser

def evaluate_images(image_paths, output_dir=None):
    if output_dir is None:
        output_dir = os.path.join(CURRENT_DIR, "eval_outputs")
    os.makedirs(output_dir, exist_ok=True)
    
    parser = ChatScreenParser()
    results = {}
    
    for i, p in enumerate(image_paths):
        if not os.path.exists(p):
            print(f"[Warning] Image not found: {p}")
            continue
        im = cv2.imread(p)
        res = parser.parse(im)
        base_name = os.path.splitext(os.path.basename(p))[0]
        results[base_name] = res
        
        annotated = parser.annotate(im, res)
        out_jpg = os.path.join(output_dir, f"{base_name}_annotated.jpg")
        cv2.imwrite(out_jpg, annotated, [cv2.IMWRITE_JPEG_QUALITY, 95])
        print(f"Processed: {base_name} -> {list(res['elements'].keys())}")
        
    json_path = os.path.join(output_dir, "results.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"All results saved to: {json_path}")
    return results

if __name__ == '__main__':
    # 示例调用
    if len(sys.argv) > 1:
        test_imgs = sys.argv[1:]
        evaluate_images(test_imgs)
    else:
        print("Usage: python run_chat_eval.py <image1_path> <image2_path> ...")
