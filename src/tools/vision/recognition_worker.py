"""Persistent, read-only GPU recognizers. The Node owner bounds and schedules queues."""

import sys

sys.dont_write_bytecode = True

import base64
import importlib.util
import importlib
import io
import json
import os
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from bubble_color import detect_bubble_regions

PROTOCOL = sys.stdout
sys.stdout = sys.stderr  # Library prints must never corrupt JSON-lines, including in threads.
OUTPUT_LOCK = threading.Lock()
STOPPING = threading.Event()
MODELS = ("chatList", "chatDetail", "page", "ocr")
MAX_IMAGE_BYTES = 32 * 1024 * 1024


class RecognitionFailure(Exception):
    def __init__(self, code, message, stage, details=None, fatal=False):
        super().__init__(message)
        self.code, self.stage = code, stage
        self.details, self.fatal = details or {}, fatal

    def public(self):
        return {"code": self.code, "message": str(self), "stage": self.stage,
                "details": self.details, "fatal": self.fatal}


def require(condition, code, message, stage, details=None):
    if not condition:
        raise RecognitionFailure(code, message, stage, details)


def send(value):
    with OUTPUT_LOCK:
        try:
            PROTOCOL.write(json.dumps(value, ensure_ascii=True, allow_nan=False) + "\n")
            PROTOCOL.flush()
        except (BrokenPipeError, OSError):
            STOPPING.set()


def checked_stop():
    require(not STOPPING.is_set(), "POOL_CLOSED", "Recognition owner disconnected", "shutdown")


def load_module(name, source):
    require(source.is_file(), "MODEL_MISSING", "Recognition parser is missing", "load",
            {"asset": str(source)})
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def legacy_ocr_class(root, configured=None):
    # Keep the old generic/IME implementation and PP-OCRv3 assets intact.
    # Loading it under a private name leaves the page detector's v4 library alone.
    configured = configured or os.environ.get("YUNMOMO_OCR_SITE_PACKAGES")
    candidates = [Path(configured)] if configured else [
        root / ".runtime/ocr/site-packages", root / ".local-output/vision-test/site-packages"]
    source = next((p / "rapidocr_onnxruntime" for p in candidates
                   if (p / "rapidocr_onnxruntime/rapid_ocr_api.py").is_file()), None)
    require(source is not None, "DEPENDENCY_MISSING", "Original PP-OCRv3 runtime is missing", "load",
            {"dependency": "legacy rapidocr_onnxruntime"})
    name = "pool_legacy_rapidocr"
    spec = importlib.util.spec_from_file_location(name, source / "__init__.py", submodule_search_locations=[str(source)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    legacy_utils = importlib.import_module(name + ".utils")
    original = sys.modules.get("rapidocr_onnxruntime.utils")
    try:
        sys.modules["rapidocr_onnxruntime.utils"] = legacy_utils
        classes = {key: importlib.import_module(name + "." + key) for key in
                   ("ch_ppocr_v3_det", "ch_ppocr_v3_rec", "ch_ppocr_v2_cls")}
    finally:
        if original is None:
            sys.modules.pop("rapidocr_onnxruntime.utils", None)
        else:
            sys.modules["rapidocr_onnxruntime.utils"] = original
        if str(source) in sys.path:
            sys.path.remove(str(source))
    module.RapidOCR.init_module = staticmethod(lambda key, cls: getattr(classes[key], cls))
    return module.RapidOCR


def classify_exception(error, stage, model=None, lane=None):
    if isinstance(error, RecognitionFailure):
        return error
    details = {"exceptionType": type(error).__name__}
    if model is not None:
        details.update(model=model, lane=lane)
    # CUDA context errors are not safe to reuse; do not silently retry on CPU.
    message = str(error).lower()
    if "out of memory" in message:
        return RecognitionFailure("GPU_OUT_OF_MEMORY", "GPU memory exhausted; reduce resident workers",
                                  stage, details, fatal=True)
    if any(term in message for term in ("illegal memory access", "device-side assert", "cuda error")):
        return RecognitionFailure("GPU_EXECUTION_FAILED", "CUDA execution failed; recreate the pool",
                                  stage, details, fatal=True)
    code = {"load": "MODEL_LOAD_FAILED", "warmup": "MODEL_WARMUP_FAILED"}.get(stage, "INFERENCE_FAILED")
    return RecognitionFailure(code, "Recognition failed at " + stage, stage, details)


class Lane:
    def __init__(self, model, index, service):
        checked_stop()
        self.model, self.index, self.service = model, index, service
        stage = "load"
        try:
            if model == "ocr":
                self.stream = torch.cuda.Stream(device=0)
                self.engine = service.gpu_ocr(general=True)
                stage = "warmup"
                began = time.perf_counter()
                for width, height in service.warmup_sizes:
                    checked_stop()
                    image = np.full((height, width, 3), 255, dtype=np.uint8)
                    for ratio in (.39, .56):
                        cv2.putText(image, "HOME CHAT 123", (int(width * .12), int(height * ratio)),
                                    cv2.FONT_HERSHEY_SIMPLEX, max(.5, width / 600), (0, 0, 0), 2)
                    with torch.cuda.device(0), torch.cuda.stream(self.stream):
                        result = self.predict(image, {})
                        require(bool(result["items"]), "MODEL_WARMUP_FAILED", "OCR glyph warmup returned no text", stage)
                        self.predict(image, {"mode": "ime"})
                        self.stream.synchronize()
                self.info = {"lane": index, "device": "cuda:0", "classes": [],
                             "warmupMs": round((time.perf_counter() - began) * 1000, 2),
                             "ocr": {"detProvider": self.engine.text_det.infer.session.get_providers()[0],
                                     "recProvider": self.engine.text_rec.session.session.get_providers()[0],
                                     "clsProvider": self.engine.text_cls.infer.session.get_providers()[0],
                                     "directionClassifier": True, "limitType": self.engine.text_det.limit_type,
                                     "cudnnSearch": "HEURISTIC", "implementation": "legacy-ppocr-v3"}}
                return
            if model == "chatList":
                self.engine = service.list_module.ChatListVisionParser(service.list_weights, device=0)
                expected = service.list_module.CLASS_NAMES
            elif model == "chatDetail":
                self.engine = service.detail_module.ChatDetailYOLOParser(service.detail_weights, device=0)
                expected = service.detail_module.CLASS_NAMES
            else:
                self.engine = service.page_module.MomoPageDetector(service.detail_weights, device="0")
                expected = service.detail_module.CLASS_NAMES
            self.yolo = self.engine.chat_model if model == "page" else self.engine.model
            names = self.yolo.names
            names = [names[i] for i in range(len(names))] if isinstance(names, dict) else list(names)
            require(names == list(expected), "MODEL_CLASSES_INVALID", "Weights do not match their parser",
                    stage, {"model": model, "lane": index, "classes": names})
            self.stream = torch.cuda.Stream(device=0)
            stage = "warmup"
            began = time.perf_counter()
            ocr_runs = []
            with torch.cuda.device(0), torch.cuda.stream(self.stream):
                for width, height in service.warmup_sizes:
                    checked_stop()
                    image = np.full((height, width, 3), 245, dtype=np.uint8)
                    self.predict(image, {})
                    if model == "page":
                        # Blank frames warm only the detector. Real glyphs also exercise recognition.
                        for crop_height in (int(height * .18), height - int(height * .80)):
                            patch = np.full((crop_height, width, 3), 255, dtype=np.uint8)
                            scale = max(.5, width / 600)
                            cv2.putText(patch, "HOME CHAT MORE 123", (8, max(24, crop_height // 2)),
                                        cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 2)
                            found, stages = self.engine.ocr(patch)
                            require(bool(found) and isinstance(stages, (list, tuple)) and stages[-1] > 0,
                                    "MODEL_WARMUP_FAILED", "OCR text recognition did not warm successfully",
                                    stage, {"model": model, "lane": index, "width": width})
                            ocr_runs.append({"width": width, "height": crop_height, "recognized": True})
                self.stream.synchronize()
            require(str(self.yolo.predictor.model.device) == "cuda:0", "GPU_UNAVAILABLE",
                    "YOLO did not initialize on CUDA", stage, {"model": model, "lane": index})
            self.info = {"lane": index, "device": "cuda:0", "classes": names,
                         "warmupMs": round((time.perf_counter() - began) * 1000, 2)}
            if model == "page":
                self.info["ocr"] = {"detProvider": self.engine.ocr.text_det.infer.session.get_providers()[0],
                                    "recProvider": self.engine.ocr.text_rec.session.session.get_providers()[0],
                                    "directionClassifier": False, "limitType": "max",
                                    "cudnnSearch": "HEURISTIC", "warmup": ocr_runs}
        except Exception as error:
            raise classify_exception(error, stage, model, index) from error

    def predict(self, image, options):
        if self.model == "ocr":
            if options.get("mode", "general") == "ime":
                return self.service.ime_module.recognize(options, image=image, engine=self.engine)
            if options.get("regions"):
                return self.service.ocr_module.recognize_regions(image, self.engine, options["regions"])
            return self.service.ocr_module.recognize_image(image, self.engine)
        if self.model == "chatList":
            return self.engine.detect(image, conf=options.get("confidence"),
                                      filter_edge_cards=options.get("filterEdgeCards", True),
                                      return_all_with_status=options.get("returnAllWithStatus", False))
        if self.model == "page":
            return self.engine.detect(image, return_detail=True)
        result = self.engine.detect(image, conf=options.get("confidence"))
        h, w = image.shape[:2]
        result["bubbleRegions"] = detect_bubble_regions(image, cv2, np)
        # Same guard as chat_detail_worker.py; it is not a user identity.
        header = image[int(h * .052):int(h * .087), int(w * .16):int(w * .80)]
        thumb = cv2.resize(cv2.cvtColor(header, cv2.COLOR_BGR2GRAY), (48, 8))
        result["headerSignature"] = thumb.flatten().tolist()
        return result

    def inspect(self, payload):
        started = time.perf_counter()
        try:
            raw = base64.b64decode(payload.get("image", ""), validate=True)
            require(0 < len(raw) <= MAX_IMAGE_BYTES, "IMAGE_INVALID", "Image must contain 1 byte to 32 MiB",
                    "decode")
            with Image.open(io.BytesIO(raw)) as header:
                w, h = header.size
                require(100 <= w <= 16384 and 200 <= h <= 16384 and w * h <= 40_000_000,
                        "IMAGE_INVALID", "Image dimensions are outside the supported range", "decode")
            image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
            require(image is not None, "IMAGE_INVALID", "Image could not be decoded", "decode")
        except RecognitionFailure:
            raise
        except Exception as error:
            raise RecognitionFailure("IMAGE_INVALID", "Image bytes are not a supported image", "decode",
                                     {"exceptionType": type(error).__name__}) from error
        decoded = time.perf_counter()
        try:
            with torch.cuda.device(0), torch.cuda.stream(self.stream):
                result = self.predict(image, payload.get("options", {}))
                self.stream.synchronize()
            finished = time.perf_counter()
            processing = round((finished - started) * 1000, 2)
            result.update(width=w, height=h, elapsedMs=processing)
            return {"data": result, "timings": {"decodeMs": round((decoded - started) * 1000, 2),
                    "predictMs": round((finished - decoded) * 1000, 2), "processingMs": processing}}
        except Exception as error:
            raise classify_exception(error, "inference", self.model, self.index) from error


class Service:
    def __init__(self, settings):
        global cv2, np, torch, Image
        try:
            import cv2
            import numpy as np
            import torch
            from PIL import Image
            from ultralytics import YOLO
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as error:
            raise RecognitionFailure("DEPENDENCY_MISSING", "Recognition Python dependency is missing", "load",
                                     {"dependency": error.name}) from error
        checked_stop()
        require(torch.cuda.is_available(), "GPU_UNAVAILABLE", "CUDA is unavailable; CPU fallback is disabled", "load")
        torch.cuda.set_device(0)
        torch.set_num_threads(2)
        cv2.setNumThreads(2)
        root = Path(__file__).resolve().parents[3]
        self.list_weights = str(Path(settings["listWeights"]))
        self.detail_weights = str(Path(settings["detailWeights"]))
        for asset in (self.list_weights, self.detail_weights):
            require(Path(asset).is_file(), "MODEL_MISSING", "Recognition weights are missing", "load", {"asset": asset})
        self.list_module = load_module("pool_list_parser", Path(self.list_weights).parent.parent / "predict_chat_list.py")
        self.detail_module = load_module("pool_detail_parser", Path(self.detail_weights).parent.parent / "predict_chat_detail.py")
        self.page_module = load_module("pool_page_parser", root / "models/识别app页面/detector.py")
        self.warmup_sizes = settings["warmupSizes"]
        self.max_active = settings["maxInFlight"]
        LegacyOCR = legacy_ocr_class(root, settings.get("legacyOcrSitePackages"))

        def gpu_ocr(general=False):
            # General/IME retain the old resize and direction-classifier settings.
            # Only the existing page recognizer uses its previously optimized settings.
            engine = LegacyOCR() if general else \
                RapidOCR(det_limit_type="max", use_cls=False, det_use_cuda=True, rec_use_cuda=True, cls_use_cuda=False)
            if general:
                engine.text_det, engine.text_rec = engine.text_detector, engine.text_recognizer
                engine.text_det.limit_type = engine.text_detector.preprocess_op[0].limit_type
            options = {"device_id": 0, "arena_extend_strategy": "kNextPowerOfTwo",
                       "cudnn_conv_algo_search": "HEURISTIC", "do_copy_in_default_stream": True}
            sessions = [engine.text_det.infer, engine.text_rec.session]
            if general:
                sessions.append(engine.text_cls.infer)
            for session in sessions:
                session.session.set_providers([("CUDAExecutionProvider", options), "CPUExecutionProvider"])
                require(session.session.get_providers()[0] == "CUDAExecutionProvider", "GPU_PROVIDER_UNAVAILABLE",
                        "OCR could not enable CUDA; CPU fallback is disabled", "load")
            return engine

        self.gpu_ocr = gpu_ocr
        ocr_dir = root / "python_workers/ocr"
        sys.path.insert(0, str(ocr_dir))
        self.ocr_module = load_module("rapidocr_worker", ocr_dir / "rapidocr_worker.py")
        sys.modules["rapidocr_worker"] = self.ocr_module
        self.ime_module = load_module("pool_ime_ocr", ocr_dir / "ime_ocr_worker.py")
        # Configure the adapter, not the protected model source or its defaults.
        self.page_module.RapidOCR = gpu_ocr
        self.lanes = {model: [] for model in MODELS}
        self.busy, self.ids, self.lock = set(), set(), threading.Lock()
        began = time.perf_counter()
        for model in MODELS:
            count = settings["workers"][model]
            require(type(count) is int and 1 <= count <= 8, "INVALID_ARGUMENT", "Invalid lane count", "load")
            for index in range(count):
                self.lanes[model].append(Lane(model, index, self))
        self.executor = ThreadPoolExecutor(max_workers=self.max_active, thread_name_prefix="gpu-recognition")
        self.info = {"ready": True, "device": "cuda:0", "gpu": torch.cuda.get_device_name(0),
                     "pid": os.getpid(), "startupMs": round((time.perf_counter() - began) * 1000, 2),
                     "warmupSizes": self.warmup_sizes, "maxInFlight": self.max_active,
                     "models": {model: {"workers": len(lanes), "lanes": [lane.info for lane in lanes]}
                                for model, lanes in self.lanes.items()}}

    def dispatch(self, request):
        payload = request["payload"]
        model, index = payload.get("model"), payload.get("lane")
        require(model in self.lanes and type(index) is int and 0 <= index < len(self.lanes[model]),
                "WORKER_PROTOCOL_ERROR", "Unknown model or lane", "dispatch")
        key = (model, index)
        with self.lock:
            require(key not in self.busy and len(self.busy) < self.max_active and request["id"] not in self.ids,
                    "WORKER_BUSY", "A recognition lane is already occupied", "dispatch")
            self.busy.add(key)
            self.ids.add(request["id"])
        future = self.executor.submit(self.lanes[model][index].inspect, payload)

        def completed(done):
            try:
                result = done.result()
                response = {"id": request["id"], "ok": True, "model": model, "lane": index, **result}
            except Exception as error:
                failure = classify_exception(error, "inference", model, index)
                response = {"id": request["id"], "ok": False, "model": model, "lane": index,
                            "error": failure.public()}
                if failure.fatal:
                    STOPPING.set()
            with self.lock:
                self.busy.discard(key)
                self.ids.discard(request["id"])
            send(response)

        future.add_done_callback(completed)

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.lanes.clear()
        torch.cuda.empty_cache()


def read_requests(inbox):
    try:
        while not STOPPING.is_set():
            line = sys.stdin.buffer.readline(46 * 1024 * 1024 + 1)
            if not line:
                break
            require(len(line) <= 46 * 1024 * 1024, "WORKER_PROTOCOL_ERROR", "Request exceeds size limit", "protocol")
            inbox.put(line)
    except Exception:
        pass
    finally:
        STOPPING.set()
        # An owner crash/pipe close must not orphan GPU allocations, even during initialization.
        watchdog = threading.Timer(5, lambda: os._exit(0))
        watchdog.daemon = True
        watchdog.start()
        inbox.put(None)


def main():
    service = None
    inbox = queue.Queue(maxsize=32)
    reader = threading.Thread(target=read_requests, args=(inbox,), daemon=True)
    reader.start()
    try:
        while True:
            line = inbox.get()
            if line is None:
                break
            request = {}
            try:
                request = json.loads(line)
                require(isinstance(request.get("id"), str) and len(request["id"]) <= 128,
                        "WORKER_PROTOCOL_ERROR", "Request id is invalid", "protocol")
                if request.get("command") == "init":
                    require(service is None, "WORKER_PROTOCOL_ERROR", "Worker is already initialized", "load")
                    service = Service(request["payload"])
                    send({"id": request["id"], "ok": True, "data": service.info})
                elif request.get("command") == "recognize":
                    checked_stop()
                    require(service is not None, "WORKER_NOT_READY", "Initialize recognition first", "dispatch")
                    service.dispatch(request)
                else:
                    raise RecognitionFailure("WORKER_PROTOCOL_ERROR", "Unknown worker command", "protocol")
            except Exception as error:
                failure = classify_exception(error, "load" if service is None else "dispatch")
                send({"id": request.get("id"), "ok": False, "error": failure.public()})
    finally:
        if service is not None:
            service.close()


if __name__ == "__main__":
    main()
