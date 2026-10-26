"""
单人聊天页 YOLO11 目标检测模型微调训练脚本
基于 yolo_dataset 训练端到端多类别聊天页控件定位模型
训练产物将自动归档至 weights/ 与 training_metrics/ 目录
"""
import os
import shutil
import time
import torch
import yaml
from ultralytics import YOLO

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
DATASET_DIR = os.path.join(BASE_DIR, "yolo_dataset")
DATA_YAML = os.path.join(DATASET_DIR, "data.yaml")

# 动态确保 data.yaml 中的 path 为绝对路径
with open(DATA_YAML, "r", encoding="utf-8") as yf:
    ydata = yaml.safe_load(yf)
ydata["path"] = DATASET_DIR
with open(DATA_YAML, "w", encoding="utf-8") as yf:
    yaml.dump(ydata, yf, allow_unicode=True, sort_keys=False)

EPOCHS = 60
IMGSZ = 832
BATCH = 8
DEVICE = 0 if torch.cuda.is_available() else "cpu"
RUNS_DIR = "/root/runs"
NAME = "chat_detail_yolo11"

def train():
    print("==================================================")
    print("STARTING YOLO11m CHAT DETAIL TRAINING")
    print(f"Device: {DEVICE} ({torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'})")
    print(f"Dataset: {DATA_YAML}")
    print(f"Epochs: {EPOCHS} | ImgSz: {IMGSZ} | Batch: {BATCH}")
    print("==================================================")

    model = YOLO("yolo11m.pt")

    t0 = time.time()
    results = model.train(
        data=DATA_YAML,
        epochs=EPOCHS,
        imgsz=IMGSZ,
        batch=BATCH,
        device=DEVICE,
        project=RUNS_DIR,
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
        verbose=True,
        seed=42
    )

    duration = round(time.time() - t0, 1)
    print(f"Training finished in {duration}s!")

    # 归档 weights/ 与 training_metrics/
    exp_dir = os.path.join(RUNS_DIR, NAME)
    weights_dst = os.path.join(BASE_DIR, "weights")
    metrics_dst = os.path.join(BASE_DIR, "training_metrics")
    os.makedirs(weights_dst, exist_ok=True)
    os.makedirs(metrics_dst, exist_ok=True)

    src_weights = os.path.join(exp_dir, "weights")
    if os.path.exists(src_weights):
        for f in os.listdir(src_weights):
            if f.endswith(".pt"):
                shutil.copy2(os.path.join(src_weights, f), os.path.join(weights_dst, f))
        print(f"Model weights archived to: {weights_dst}")

    # 拷贝指标文件
    metric_extensions = [".png", ".jpg", ".csv", ".yaml"]
    for f in os.listdir(exp_dir):
        if any(f.endswith(ext) for ext in metric_extensions) and not os.path.isdir(os.path.join(exp_dir, f)):
            shutil.copy2(os.path.join(exp_dir, f), os.path.join(metrics_dst, f))
    print(f"Training metrics archived to: {metrics_dst}")

    # 验证并输出评估指标
    best_pt = os.path.join(weights_dst, "best.pt")
    if os.path.exists(best_pt):
        print(f"Validating best model: {best_pt}...")
        val_model = YOLO(best_pt)
        metrics = val_model.val(data=DATA_YAML, imgsz=IMGSZ, rect=True, device=DEVICE)
        print("Validation mAP50-95:", metrics.box.map)
        print("Validation mAP50:", metrics.box.map50)

if __name__ == '__main__':
    train()
