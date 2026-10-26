"""Read-only adapter for model 2. JSON-lines transport; no phone input."""
import sys

sys.dont_write_bytecode = True

import base64
import contextlib
import importlib.util
import json
import time
from pathlib import Path

from bubble_color import detect_bubble_regions


class WorkerError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Engine:
    def __init__(self, settings):
        import cv2
        import numpy as np
        import torch

        weights = Path(settings['detailWeights'])
        source = weights.parent.parent / 'predict_chat_detail.py'
        if not weights.is_file() or not source.is_file():
            raise WorkerError('MODEL_NOT_FOUND', 'Model 2 weights or parser are missing')
        device = settings.get('device', 'cuda:0')
        if device != 'cpu' and not torch.cuda.is_available():
            raise WorkerError('GPU_UNAVAILABLE', 'CUDA is unavailable; CPU fallback must be explicitly configured')
        spec = importlib.util.spec_from_file_location('contact_chat_parser', source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.parser = module.ChatDetailYOLOParser(str(weights), device=0 if device != 'cpu' else 'cpu')
        names = self.parser.model.names
        names = [names[i] for i in range(len(names))] if isinstance(names, dict) else list(names)
        if names != list(module.CLASS_NAMES) or not {'back_btn', 'input_box', 'send_btn'}.issubset(names):
            raise WorkerError('MODEL_CLASSES_INVALID', 'Model 2 class names do not match its parser')
        self.cv2, self.np = cv2, np
        self.parser.detect(np.zeros((1280, 720, 3), dtype=np.uint8))
        self.info = {'device': device, 'gpu': torch.cuda.get_device_name(0) if device != 'cpu' else None,
                     'classes': names, 'model': '02_聊天详情页识别模型'}

    def inspect(self, payload):
        started = time.perf_counter()
        raw = base64.b64decode(payload['image'], validate=True)
        if not raw or len(raw) > 32 * 1024 * 1024:
            raise WorkerError('VISION_IMAGE_INVALID', 'Image exceeds the permitted size')
        img = self.cv2.imdecode(self.np.frombuffer(raw, dtype=self.np.uint8), self.cv2.IMREAD_COLOR)
        if img is None or img.shape[0] * img.shape[1] > 40_000_000:
            raise WorkerError('VISION_IMAGE_INVALID', 'Could not decode a usable screenshot')
        result = self.parser.detect(img, conf=payload.get('confidence'))
        result['bubbleRegions'] = detect_bubble_regions(img, self.cv2, self.np)
        h, w = img.shape[:2]
        # 蓝色发送胶囊按钮快速检测 (屏幕中下部右侧)
        try:
            roi_top, roi_left = int(h * 0.20), int(w * 0.45)
            hsv = self.cv2.cvtColor(img[roi_top:, roi_left:], self.cv2.COLOR_BGR2HSV)
            mask = self.cv2.inRange(hsv, self.np.array([95, 60, 60]), self.np.array([135, 255, 255]))
            contours, _ = self.cv2.findContours(mask, self.cv2.RETR_EXTERNAL, self.cv2.CHAIN_APPROX_SIMPLE)
            blue_btn = None
            max_area = 0
            for c in contours:
                x, y, bw, bh = self.cv2.boundingRect(c)
                area = bw * bh
                if area >= 150 and 0.8 <= (bw / max(1, bh)) <= 4.5 and area > max_area:
                    max_area = area
                    blue_btn = {'cx': roi_left + x + bw // 2, 'cy': roi_top + y + bh // 2, 'w': bw, 'h': bh}
            result['blueSendButton'] = blue_btn
        except Exception:
            result['blueSendButton'] = None
        # Exclude the online/time/distance line. This is a change guard, not a UID.
        header = img[int(h * .052):int(h * .087), int(w * .16):int(w * .80)]
        thumb = self.cv2.resize(self.cv2.cvtColor(header, self.cv2.COLOR_BGR2GRAY), (48, 8))
        return {**result, 'width': w, 'height': h, 'headerSignature': thumb.flatten().tolist(),
                'elapsedMs': round((time.perf_counter() - started) * 1000, 2)}


def main():
    engine = None
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                if request['command'] == 'init':
                    engine = Engine(request['payload'])
                    data = engine.info
                elif request['command'] == 'inspect' and engine is not None:
                    data = engine.inspect(request['payload'])
                else:
                    raise WorkerError('VISION_PROTOCOL_ERROR', 'Unknown command or uninitialized worker')
            response = {'id': request.get('id'), 'ok': True, 'data': data}
        except WorkerError as error:
            response = {'id': request.get('id'), 'ok': False, 'error': {'code': error.code, 'message': str(error)}}
        except Exception:
            response = {'id': request.get('id'), 'ok': False,
                        'error': {'code': 'VISION_FAILED', 'message': 'Model 2 initialization or inference failed'}}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
