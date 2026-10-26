#!/usr/bin/env python3
"""Persistent local RapidOCR worker used by the cloud-phone examples.

The worker communicates over JSON lines so Node can keep the OCR model loaded
while it polls screenshots. It only reads local image paths supplied by the
calling process; screenshots are not uploaded to a third-party service.
"""

from __future__ import annotations

import json
import base64
import os
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parents[1]
RUNTIME_SITE_PACKAGES = PROJECT_ROOT / ".runtime" / "ocr" / "site-packages"
LEGACY_SITE_PACKAGES = PROJECT_ROOT / ".local-output" / "vision-test" / "site-packages"
DEFAULT_SITE_PACKAGES = RUNTIME_SITE_PACKAGES if RUNTIME_SITE_PACKAGES.exists() else LEGACY_SITE_PACKAGES


def add_local_site_packages() -> None:
    configured = os.environ.get("YUNMOMO_OCR_SITE_PACKAGES")
    site_packages = Path(configured) if configured else DEFAULT_SITE_PACKAGES
    if site_packages.exists():
        sys.path.insert(0, str(site_packages))


add_local_site_packages()

try:
    import cv2
    from rapidocr_onnxruntime import RapidOCR
except Exception as error:  # pragma: no cover - exercised by environment setup
    print(
        json.dumps(
            {
                "ok": False,
                "error": "RapidOCR import failed: " + repr(error),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    raise


ENGINE = None


def get_engine():
    global ENGINE
    if ENGINE is None:
        ENGINE = RapidOCR()
    return ENGINE


def box_to_rect(box: object) -> tuple[float, float, float, float]:
    points = []
    for point in box:  # type: ignore[union-attr]
        if len(point) >= 2:
            points.append((float(point[0]), float(point[1])))
    if not points:
        raise ValueError("OCR returned an empty box")
    left = min(point[0] for point in points)
    top = min(point[1] for point in points)
    right = max(point[0] for point in points)
    bottom = max(point[1] for point in points)
    return left, top, right, bottom


def keyboard_switches(image: object, items: list[dict[str, object]]) -> list[dict[str, object]]:
    """Locate actual switch tracks next to OCR keyboard rows."""
    if not any("屏幕键盘" in str(item["text"]) or "虚拟键盘" in str(item["text"]) for item in items):
        return []
    height, width = image.shape[:2]
    switches = []
    for item in items:
        text = str(item["text"])
        if not any(name in text for name in ("搜狗输入", "讯飞输入", "gmime")):
            continue
        center_y = float(item["center_y"])
        left, right = round(width * 0.78), round(width * 0.98)
        top = max(0, round(center_y - height * 0.04))
        bottom = min(height, round(center_y + height * 0.04))
        region = image[top:bottom, left:right]
        gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
        mask = cv2.inRange(gray, 0, 175)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates = []
        for contour in contours:
            x, y, track_width, track_height = cv2.boundingRect(contour)
            if not (width * 0.09 <= track_width <= width * 0.21):
                continue
            if not (height * 0.02 <= track_height <= height * 0.07):
                continue
            if not (1.3 <= track_width / track_height <= 3.2):
                continue
            distance = abs(top + y + track_height / 2 - center_y)
            if distance <= height * 0.025:
                candidates.append((distance, x, y, track_width, track_height))
        if not candidates:
            continue
        _, x, y, track_width, track_height = min(candidates)
        track = region[y:y + track_height, x:x + track_width]
        hsv = cv2.cvtColor(track, cv2.COLOR_BGR2HSV)
        color_fraction = float(((hsv[:, :, 1] >= 65) & (hsv[:, :, 2] >= 40)).mean())
        state = "on" if color_fraction >= 0.12 else "off" if color_fraction <= 0.03 else "unknown"
        switches.append({
            "text": text,
            "state": state,
            "centerX": round(left + x + track_width / 2, 2),
            "centerY": round(top + y + track_height / 2, 2),
            "colorFraction": round(color_fraction, 4),
            "source": "opencv-switch-track",
        })
    return switches


def recognize(image_path: str) -> dict[str, object]:
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(str(path))

    image = cv2.imread(str(path))
    if image is None:
        raise ValueError("Unable to read image: " + str(path))
    return recognize_image(image, get_engine())


def recognize_image(image, engine):
    height, width = image.shape[:2]

    raw, elapsed = engine(image)
    items: list[dict[str, object]] = []
    for entry in raw or []:
        if len(entry) < 3:
            continue
        left, top, right, bottom = box_to_rect(entry[0])
        text = str(entry[1]).strip()
        if not text:
            continue
        items.append(
            {
                "text": text,
                "score": round(float(entry[2]), 4),
                "left": round(left, 2),
                "top": round(top, 2),
                "right": round(right, 2),
                "bottom": round(bottom, 2),
                "center_x": round((left + right) / 2, 2),
                "center_y": round((top + bottom) / 2, 2),
            }
        )

    elapsed_values = []
    for value in elapsed if elapsed is not None else []:
        try:
            elapsed_values.append(float(value))
        except (TypeError, ValueError):
            elapsed_values.append(None)

    return {
        "ok": True,
        "width": int(width),
        "height": int(height),
        "items": items,
        "keyboardSwitches": keyboard_switches(image, items),
        "mapVision": virtual_map_vision(image, items),
        "elapsed": elapsed_values,
    }


def recognize_regions(image, engine, regions):
    """Reread color-backed bubbles, preserving full-frame OCR coordinates.

    Crops use the existing OCR lane, sequentially. A single glyph may be missed
    by text detection even though recognition can read it; only a short,
    ink-bearing crop is allowed to use that direct-recognition fallback.
    """
    import numpy as np
    height, width = image.shape[:2]
    items, evidence = [], []
    for index, roi in enumerate(regions):
        left, top, right, bottom = [round(value * size) for value, size in zip(roi, (width, height, width, height))]
        crop = image[top:bottom, left:right]
        if crop.size == 0:
            continue
        scale = 3
        padding = 12
        enlarged = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        enlarged = cv2.copyMakeBorder(enlarged, padding, padding, padding, padding,
                                     cv2.BORDER_CONSTANT, value=(255, 255, 255))
        found = recognize_image(enlarged, engine)["items"]
        for item in found:
            for key in ("left", "right", "center_x"):
                item[key] = round(left + (item[key] - padding) / scale, 2)
            for key in ("top", "bottom", "center_y"):
                item[key] = round(top + (item[key] - padding) / scale, 2)
            item["source"] = "bubble-crop"
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        margin = max(2, round(min(gray.shape) * .10))
        ink = gray[margin:-margin, margin:-margin] < 170
        ink_fraction = float(ink.mean()) if ink.size else 0.0
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        interior = hsv[margin:-margin, margin:-margin]
        colorful = float(((interior[:, :, 1] > 65) & (interior[:, :, 2] > 70)).mean()) if interior.size else 0.0
        text_like = .002 <= ink_fraction <= .45 and colorful < .06
        if not found and text_like and right - left <= width * .4 and bottom - top <= height * .18:
            ys, xs = np.where(ink)
            x1, y1 = int(xs.min()) + margin, int(ys.min()) + margin
            x2, y2 = int(xs.max()) + margin + 1, int(ys.max()) + margin + 1
            glyph = crop[max(0, y1 - 4):min(crop.shape[0], y2 + 4),
                         max(0, x1 - 4):min(crop.shape[1], x2 + 4)]
            glyph = cv2.resize(glyph, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
            # Narrow punctuation needs horizontal whitespace; otherwise the
            # recognizer's temporal input can become too short for one glyph.
            side = max(6, glyph.shape[0])
            padded = cv2.copyMakeBorder(glyph, 6, 6, side, side, cv2.BORDER_CONSTANT, value=(255, 255, 255))
            recognized, _ = engine.text_rec([glyph, padded])
            if recognized:
                # The bundled legacy CTC decoder averages in an extra zero.
                # One-character scores are therefore capped at .5. Probe the
                # decoder, as the existing IME adapter does; do not inflate a
                # newer decoder's scores or simply lower the acceptance bar.
                if not hasattr(engine, "_bubble_legacy_ctc_mean"):
                    probe = engine.text_rec.postprocess_op.decode(np.array([[1]]), np.ones((1, 1)), is_remove_duplicate=True)
                    engine._bubble_legacy_ctc_mean = float(probe[0][1]) < .75
                candidates = [(text, min(1.0, float(score) * (len(text) + 1) / len(text))
                               if text and engine._bubble_legacy_ctc_mean else float(score))
                              for text, score in recognized if str(text).strip()]
                text, score = max(candidates, key=lambda candidate: candidate[1], default=("", 0.0))
                if str(text).strip() and float(score) >= .55:
                    found.append({"text": str(text).strip(), "score": round(float(score), 4),
                                  "left": left + x1, "top": top + y1,
                                  "right": left + x2, "bottom": top + y2,
                                  "center_x": left + (x1 + x2) / 2, "center_y": top + (y1 + y2) / 2,
                                  "source": "bubble-direct-recognition"})
        evidence.append({"index": index, "box": [left, top, right, bottom],
                         "inkFraction": round(ink_fraction, 5), "items": len(found),
                         "kind": "text" if found else "uncertain_text" if text_like else "non_text",
                         "unresolved": not found and text_like})
        items.extend(found)
    return {"ok": True, "width": width, "height": height, "items": items, "regions": evidence}


def request_image(request):
    if isinstance(request.get("image"), str):
        import numpy as np
        raw = base64.b64decode(request["image"], validate=True)
        if not 0 < len(raw) <= 32 * 1024 * 1024:
            raise ValueError("Invalid image size")
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    else:
        image = cv2.imread(str(request.get("path", "")))
    if image is None:
        raise ValueError("Unable to decode OCR image")
    return image


def selected_map_pins(hsv: object, left: int, top: int, width: int, height: int) -> list[dict[str, object]]:
    """Separate muted blue pins from saturated navigation arrows, even when touching."""
    pin_blue = cv2.inRange(hsv, (102, 80, 120), (116, 205, 255))
    arrow_blue = cv2.inRange(hsv, (90, 215, 130), (120, 255, 255))
    contours, _ = cv2.findContours(pin_blue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    pins = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        if not (width * 0.025 <= w <= width * 0.13 and height * 0.015 <= h <= height * 0.10):
            continue
        if not (1.05 <= h / w <= 2.1) or area < width * height * 0.00012:
            continue
        fill = area / (w * h)
        arrow_fraction = cv2.countNonZero(arrow_blue[y:y + h, x:x + w]) / (w * h)
        # A partly covered pin has less visible area; require overlapping arrow
        # pixels before accepting that case. A complete pin keeps the old limit.
        if fill < 0.45 and not (fill >= 0.25 and arrow_fraction >= 0.12):
            continue
        row_widths = (pin_blue[y:y + h, x:x + w] > 0).sum(axis=1)
        head_width = int(row_widths[round(h * 0.15):max(round(h * 0.5), 1)].max())
        tail_width = int(row_widths[round(h * 0.75):].max())
        if head_width < w * 0.75 or tail_width > head_width * 0.72:
            continue
        if len(cv2.approxPolyDP(contour, cv2.arcLength(contour, True) * 0.025, True)) < 5:
            continue
        pins.append({
            "x": round(left + x + w / 2, 2), "y": round(top + y + h / 2, 2),
            "bbox": [left + x, top + y, left + x + w, top + y + h],
            "source": "opencv-blue-location-pin", "occluded": arrow_fraction >= 0.12,
        })
    return pins


def virtual_map_vision(image: object, items: list[dict[str, object]]) -> dict[str, object] | None:
    """Check rendered map tiles and the blue location marker, not UI labels."""
    if not any("虚拟定位" in str(item["text"]) for item in items):
        return None
    height, width = image.shape[:2]
    left, right = round(width * 0.12), round(width * 0.84)
    top, bottom = round(height * 0.25), round(height * 0.80)
    region = image[top:bottom, left:right]
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    edges = cv2.Canny(gray, 50, 140)
    edge_fraction = float((edges > 0).mean())
    road_fraction = float(((hsv[:, :, 0] >= 8) & (hsv[:, :, 0] <= 40) & (hsv[:, :, 1] >= 90)).mean())
    blue = cv2.inRange(hsv, (90, 110, 100), (120, 255, 255))
    contours, _ = cv2.findContours(blue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    markers = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        if not (width * 0.025 <= w <= width * 0.13 and height * 0.015 <= h <= height * 0.10):
            continue
        if area < width * height * 0.00012 or area / (w * h) < 0.25 or not (0.45 <= w / h <= 1.6):
            continue
        center_x, center_y = left + x + w / 2, top + y + h / 2
        distance = abs(center_x / width - 0.5) + abs(center_y / height - 0.52)
        markers.append((distance, center_x, center_y))
    marker = min(markers) if markers else None
    selection_markers = selected_map_pins(hsv, left, top, width, height)
    return {
        "rendered": edge_fraction >= 0.012 and road_fraction >= 0.006,
        "edgeFraction": round(edge_fraction, 4),
        "roadFraction": round(road_fraction, 4),
        "marker": {"x": round(marker[1], 2), "y": round(marker[2], 2)} if marker else None,
        "selectionMarkers": selection_markers,
        "selectionMarker": selection_markers[0] if len(selection_markers) == 1 else None,
        "fingerprint": cv2.resize(gray, (16, 16), interpolation=cv2.INTER_AREA).reshape(-1).tolist(),
    }


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            response = recognize_image(request_image(request), get_engine())
        except Exception as error:  # keep the worker alive for the next poll
            response = {"ok": False, "error": str(error)}
        if isinstance(request, dict) and "id" in request:
            response["id"] = request["id"]
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
