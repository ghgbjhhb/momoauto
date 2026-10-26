"""Local JSON-lines vision worker: icon templates + the two user-trained YOLOs.

This process can only inspect image bytes. It has no phone control or OCR code.
"""
import base64
import contextlib
import json
import math
import sys
import time
from pathlib import Path


class VisionFailure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise VisionFailure(code, message)


class Engine:
    def __init__(self, options):
        try:
            global cv2, np, torch
            import cv2
            import numpy as np
            import torch
            from ultralytics import YOLO
        except ImportError:
            raise VisionFailure("VISION_DEPENDENCY_MISSING", "Python requires OpenCV, NumPy, PyTorch and Ultralytics")
        cv2.setNumThreads(2)
        self.device = options.get("device", "cuda:0")
        require(self.device == "cpu" or self.device == "cuda:0", "VISION_CONFIG_INVALID", "device must be cpu or cuda:0")
        require(self.device == "cpu" or torch.cuda.is_available(), "GPU_UNAVAILABLE", "CUDA is unavailable; CPU fallback must be explicitly configured")
        self.imgsz = 832
        self.scaled_templates = {}
        manifest_path = Path(options["manifestPath"]).resolve()
        require(manifest_path.is_file(), "TEMPLATES_MISSING", "Template manifest does not exist")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            require(manifest.get("version") == 1, "TEMPLATES_INVALID", "Unsupported template manifest version")
            self.templates = []
            ids = set()
            for item in manifest["templates"]:
                require(item["id"] not in ids, "TEMPLATES_INVALID", "Duplicate template id")
                ids.add(item["id"])
                require(item["role"] in {"app_icon", "home_anchor", "dock_anchor", "login", "permission", "update", "blocked"},
                        "TEMPLATES_INVALID", "Unsupported template role")
                file = (manifest_path.parent / item["file"]).resolve()
                require(file.is_relative_to(manifest_path.parent) and file.is_file(), "TEMPLATES_MISSING", "Template file is missing or outside its directory")
                image = cv2.imdecode(np.frombuffer(file.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
                require(image is not None and min(image.shape[:2]) >= 12 and image.std() > 5, "TEMPLATES_INVALID", "Template is empty, too small or lacks visual detail")
                require(1 <= item["referenceWidth"] <= 65535 and 1 <= item["referenceHeight"] <= 65535,
                        "TEMPLATES_INVALID", "Invalid template reference dimensions")
                self.templates.append({**item, "image": image})
            roles = [item["role"] for item in self.templates]
            require(roles.count("app_icon") >= 1 and roles.count("home_anchor") >= 2 and roles.count("dock_anchor") >= 2,
                    "TEMPLATES_INVALID", "Templates require an app icon, two home anchors and two dock anchors")
        except VisionFailure:
            raise
        except (ValueError, KeyError, TypeError, OSError):
            raise VisionFailure("TEMPLATES_INVALID", "Template manifest or image cannot be read")
        paths = [Path(options["listWeights"]), Path(options["detailWeights"])]
        require(all(path.is_file() for path in paths), "MODEL_MISSING", "One or both user-trained model files are missing")
        try:
            self.models = [YOLO(str(path)) for path in paths]
            names = [set(model.names.values()) for model in self.models]
            require({"tab_home", "tab_msg", "tab_more", "chat_card"} <= names[0], "MODEL_CLASSES_INVALID", "Message-list weights do not contain expected classes")
            require({"back_btn", "input_box"} <= names[1] and bool({"header_avatar", "avatar"} & names[1]),
                    "MODEL_CLASSES_INVALID", "Chat-detail weights do not contain expected classes")
            blank = np.zeros((640, 360, 3), np.uint8)
            for model in self.models:
                model.predict(blank, imgsz=self.imgsz, rect=True, device=self.device, conf=0.65, verbose=False)
        except VisionFailure:
            raise
        except Exception:
            raise VisionFailure("MODEL_LOAD_FAILED", "Could not load or warm up the configured YOLO weights")
        self.info = {"device": self.device, "gpu": torch.cuda.get_device_name(0) if self.device != "cpu" else None,
                     "classes": [model.names for model in self.models], "templateCount": len(self.templates),
                     "opencv": cv2.__version__, "torch": torch.__version__}

    @staticmethod
    def overlap(a, b):
        x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
        intersection = max(0, x2 - x1) * max(0, y2 - y1)
        return intersection / max(1, min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])))

    def matches(self, image, item, threshold):
        h, w = image.shape[:2]
        role = item["role"]
        top, bottom = (0.77, 0.96) if role == "dock_anchor" else (0.04, 0.78) if role == "home_anchor" else (0.035, 0.94)
        y0, y_end = int(h * top), int(h * bottom)
        region = image[y0:y_end]
        reference = item["image"]
        base_scale = min(w / item["referenceWidth"], h / item["referenceHeight"])
        candidates = []
        for factor in (1.0, 0.95, 1.05, 0.90, 1.10, 0.85, 1.15, 0.80, 1.20):
            tw, th = round(reference.shape[1] * base_scale * factor), round(reference.shape[0] * base_scale * factor)
            if min(tw, th) < 10 or tw > w or th > region.shape[0]:
                continue
            cache_key = (item["id"], tw, th)
            if cache_key not in self.scaled_templates:
                # Keep the cache bounded if a caller repeatedly changes screen sizes.
                if len(self.scaled_templates) >= 512:
                    self.scaled_templates.clear()
                self.scaled_templates[cache_key] = cv2.resize(reference, (tw, th), interpolation=cv2.INTER_AREA if base_scale * factor < 1 else cv2.INTER_LINEAR)
            template = self.scaled_templates[cache_key]
            result = cv2.matchTemplate(region, template, cv2.TM_CCOEFF_NORMED)
            strong_anchor = False
            # Multiple non-overlapping peaks are retained; do not blindly pick the best icon.
            for _ in range(4):
                _, score, _, (x, y) = cv2.minMaxLoc(result)
                if not math.isfinite(score) or score < threshold:
                    break
                candidates.append({"id": item["id"], "role": role, "confidence": round(score, 4),
                                   "box": [x, y + y0, x + tw, y + th + y0]})
                strong_anchor = strong_anchor or score >= 0.985
                result[max(0, y - th // 2):y + th // 2 + 1, max(0, x - tw // 2):x + tw // 2 + 1] = -1
            if strong_anchor and role in {"home_anchor", "dock_anchor"}:
                break  # Anchor presence is enough; app-icon ambiguity still checks every scale.
        return candidates

    def predict(self, model, image, threshold):
        prediction = model.predict(image, conf=threshold, iou=0.45, imgsz=self.imgsz, rect=True, device=self.device, verbose=False)[0]
        return [{"class": model.names[int(label)], "confidence": round(float(score), 4), "box": [round(float(v), 2) for v in box]}
                for box, score, label in zip(prediction.boxes.xyxy.cpu().tolist(), prediction.boxes.conf.cpu().tolist(), prediction.boxes.cls.cpu().tolist())]

    @staticmethod
    def page_signature(detections, w, h, detail=False):
        best = {}
        for item in detections:
            if item["class"] not in best or item["confidence"] > best[item["class"]]["confidence"]:
                best[item["class"]] = item
        if not detail:
            order = ["tab_home", "tab_live", "tab_msg", "tab_universe", "tab_more"]
            tabs = [best[name] for name in order if name in best and best[name]["box"][1] > h * 0.78]
            if len(tabs) < 4:
                return None
            centers = [(item["box"][0] + item["box"][2]) / 2 for item in tabs]
            if centers != sorted(centers) or max(centers) - min(centers) < w * 0.55:
                return None
            ys = [(item["box"][1] + item["box"][3]) / 2 for item in tabs]
            if max(ys) - min(ys) > h * 0.06:
                return None
            page = "message_list" if any(name in best for name in ("chat_card", "recent_block")) else "momo_main"
            return {"page": page, "confidence": min(item["confidence"] for item in tabs), "anchors": tabs}
        back, input_box = best.get("back_btn"), best.get("input_box")
        headers = [item for item in detections if item["class"] in ("header_avatar", "avatar") and
                   item["box"][1] < h * 0.15 and item["box"][0] > w * 0.6]
        # Newer six-class weights unify avatars and can miss the top avatar.
        # An independently detected top follow control can supply the third anchor.
        headers.extend(item for item in detections if item["class"] == "top_follow_btn" and
                       item["box"][1] < h * 0.22 and item["box"][0] > w * 0.5)
        if not back or not input_box or not headers:
            return None
        b, i = back["box"], input_box["box"]
        if b[0] > w * 0.2 or b[1] > h * 0.15 or i[1] < h * 0.48 or i[2] - i[0] < w * 0.35:
            return None
        header = max(headers, key=lambda item: item["confidence"])
        return {"page": "chat_detail", "confidence": min(back["confidence"], input_box["confidence"], header["confidence"]),
                "anchors": [back, input_box, header]}

    @staticmethod
    def modal_present(image):
        h, w = image.shape[:2]
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        mask = cv2.inRange(gray, 220, 255)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, cw, ch = cv2.boundingRect(contour)
            if not (w * 0.65 < cw < w * 0.96 and h * 0.12 < ch < h * 0.58 and h * 0.12 < y < h * 0.7):
                continue
            if cv2.contourArea(contour) / (cw * ch) < 0.8:
                continue
            outside = np.concatenate((gray[:max(1, y - 5)].ravel(), gray[min(h - 1, y + ch + 5):].ravel()))
            if outside.size and float(outside.mean()) < 165:
                return True
        return False

    def inspect(self, payload):
        start = time.perf_counter()
        try:
            raw = base64.b64decode(payload["image"], validate=True)
            require(0 < len(raw) <= 32 * 1024 * 1024, "VISION_IMAGE_INVALID", "Image exceeds worker size limit")
            image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            require(image is not None, "VISION_IMAGE_INVALID", "Image could not be decoded")
        except (KeyError, ValueError):
            raise VisionFailure("VISION_IMAGE_INVALID", "Image payload is invalid")
        h, w = image.shape[:2]
        candidates = []
        for item in self.templates:
            threshold = payload["iconThreshold"] if item["role"] == "app_icon" else payload["anchorThreshold"]
            candidates.extend(self.matches(image, item, threshold))
        found = []
        for item in sorted(candidates, key=lambda value: -value["confidence"]):
            if not any(other["role"] == item["role"] and self.overlap(item["box"], other["box"]) > 0.3 for other in found):
                found.append(item)
        home = [item for item in found if item["role"] == "home_anchor"]
        dock = [item for item in found if item["role"] == "dock_anchor"]
        # Independent anchors must not all be copies of the same template.
        home_confirmed = len({item["id"] for item in home}) >= 2 and len({item["id"] for item in dock}) >= 2
        launcher = home_confirmed or len({item["id"] for item in dock}) >= 2
        blocked = next((item for item in found if item["role"] in {"login", "permission", "update", "blocked"}), None)
        modal = self.modal_present(image)
        scene = None
        if not launcher and not blocked and not modal:
            detections = self.predict(self.models[0], image, payload["confidence"])
            scene = self.page_signature(detections, w, h)
            if scene is None:
                detections = self.predict(self.models[1], image, payload["confidence"])
                scene = self.page_signature(detections, w, h, detail=True)
        content = cv2.cvtColor(image[int(h * 0.06):int(h * 0.80)], cv2.COLOR_BGR2GRAY)
        thumb = cv2.resize(content, (16, 24), interpolation=cv2.INTER_AREA)
        dhash_image = cv2.resize(content, (17, 16), interpolation=cv2.INTER_AREA)
        bits = (dhash_image[:, 1:] > dhash_image[:, :-1]).ravel()
        fingerprint = hex(int("".join("1" if bit else "0" for bit in bits), 2))[2:].zfill(64)
        return {"width": w, "height": h, "homeConfirmed": home_confirmed, "launcher": launcher,
                "icons": [item for item in found if item["role"] == "app_icon"], "homeAnchors": home,
                "dockAnchors": dock, "blocked": blocked, "modal": modal, "scene": scene,
                "fingerprint": fingerprint, "thumbnail": thumb.ravel().tolist(),
                "elapsedMs": round((time.perf_counter() - start) * 1000, 2)}


def main():
    engine = None
    for line in sys.stdin:
        request_id = None
        try:
            require(len(line) < 46 * 1024 * 1024, "VISION_PROTOCOL_ERROR", "Request exceeds size limit")
            request = json.loads(line)
            request_id = request.get("id")
            with contextlib.redirect_stdout(sys.stderr):
                if request["command"] == "init":
                    engine = Engine(request["payload"])
                    result = engine.info
                elif request["command"] == "inspect":
                    require(engine is not None, "VISION_NOT_READY", "Initialize the worker first")
                    result = engine.inspect(request["payload"])
                else:
                    raise VisionFailure("VISION_PROTOCOL_ERROR", "Unsupported worker command")
            response = {"id": request_id, "ok": True, "data": result}
        except VisionFailure as error:
            response = {"id": request_id, "ok": False, "error": {"code": error.code, "message": str(error)}}
        except Exception:
            response = {"id": request_id, "ok": False, "error": {"code": "VISION_INTERNAL_ERROR", "message": "Vision request failed; check configured assets and runtime"}}
        print(json.dumps(response, ensure_ascii=True, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
