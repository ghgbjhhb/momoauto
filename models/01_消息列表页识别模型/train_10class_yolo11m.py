import os
import time
import torch
from ultralytics import YOLO

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_YAML = os.path.join(CURRENT_DIR, "dataset", "data.yaml")
EPOCHS = 60
IMGSZ = 832
BATCH = 8
DEVICE = 0 if torch.cuda.is_available() else "cpu"
PROJECT = os.path.join(CURRENT_DIR, "runs")
NAME = "yolo11m_10class"

def main():
    print("==================================================")
    print("TRAINING 10-CLASS FULL UI YOLO11m MODEL")
    print(f"Device: {DEVICE}")
    print(f"Dataset: {DATA_YAML}")
    print("==================================================")

    # 基础模型：yolo11m.pt
    model = YOLO("yolo11m.pt")

    t0 = time.time()
    results = model.train(
        data=DATA_YAML,
        epochs=EPOCHS,
        imgsz=IMGSZ,
        batch=BATCH,
        device=DEVICE,
        project=PROJECT,
        name=NAME,
        exist_ok=True,
        rect=True,
        cos_lr=True,
        lr0=0.003,
        lrf=0.01,
        box=9.0,
        dfl=2.5,
        cls=1.0,
        mosaic=0.1,
        close_mosaic=10,
        degrees=0.0,
        shear=0.0,
        perspective=0.0,
        verbose=True,
        seed=42
    )

    duration = round(time.time() - t0, 1)
    print(f"Training completed in {duration}s!")

    # 验证并输出评估指标
    best_pt = os.path.join(PROJECT, NAME, "weights", "best.pt")
    if os.path.exists(best_pt):
        val_model = YOLO(best_pt)
        metrics = val_model.val(data=DATA_YAML, imgsz=IMGSZ, rect=True, device=DEVICE)
        print("mAP50-95:", metrics.box.map)
        print("mAP50:", metrics.box.map50)

if __name__ == '__main__':
    main()
