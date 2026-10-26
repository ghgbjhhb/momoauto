#!/usr/bin/env python3
"""Persistent OCR worker for IME candidates, splitting words before batch OCR.

All coordinates are calculated from screenshot pixels. No expected candidate
index or text is supplied to the recognizer. ROI values are normalized and must
be configured for the current app/keyboard layout.
"""

from __future__ import annotations

import json
import sys
import time

from rapidocr_worker import get_engine, box_to_rect, cv2, request_image
import numpy as np


def corrected_score(engine, value, score):
    # The legacy 1.2.x decoder adds an extra zero to its mean; the GPU runtime's
    # newer decoder does not. Probe once, instead of inflating modern scores.
    if not hasattr(engine, "_ime_legacy_ctc_mean"):
        recognizer = getattr(engine, "text_recognizer", None)
        if recognizer is None:
            recognizer = engine.text_rec
        sample = recognizer.postprocess_op.decode(np.array([[1]]), np.ones((1, 1)), is_remove_duplicate=True)
        engine._ime_legacy_ctc_mean = float(sample[0][1]) < .75
    if value and engine._ime_legacy_ctc_mean:
        score = float(score) * (len(value) + 1) / len(value)
    return min(1.0, float(score))


def rect(image, roi):
    height, width = image.shape[:2]
    if len(roi) != 4 or not all(0 <= float(value) <= 1 for value in roi):
        raise ValueError("ROI must contain four normalized coordinates")
    left, top, right, bottom = [round(float(v) * size) for v, size in zip(roi, (width, height, width, height))]
    if right <= left or bottom <= top:
        raise ValueError("ROI has no area")
    return left, top, right, bottom


def reading_order(items):
    """Keep fragments on the same text row in left-to-right order."""
    rows = []
    for item in sorted(items or [], key=lambda value: box_to_rect(value[0])[1]):
        _, top, _, bottom = box_to_rect(item[0])
        row = next((row for row in rows if
                    min(bottom, row["bottom"]) - max(top, row["top"]) >=
                    max(1, min(bottom - top, row["bottom"] - row["top"])) * 0.5), None)
        if row is None:
            rows.append({"top": top, "bottom": bottom, "items": [item]})
        else:
            row["top"] = min(row["top"], top)
            row["bottom"] = max(row["bottom"], bottom)
            row["items"].append(item)
    return [item for row in rows for item in
            sorted(row["items"], key=lambda value: box_to_rect(value[0])[0])]


def clean_input_field(image, bounds):
    left, top, right, bottom = bounds
    field = image[top:bottom, left:right].copy()
    gray = cv2.cvtColor(field, cv2.COLOR_BGR2GRAY)
    mask = (gray < 170).astype(np.uint8) * 255
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    cursor_mask = np.zeros_like(mask)
    for index in range(1, count):
        x, y, w, h, area = stats[index]
        # 兼容深色/黑色细竖线光标（不局限于整场输入框的 55%，单行文本光标即可识别清理）
        if ((w <= 2 and h >= field.shape[0] * 0.55 and h / max(1, w) >= 8) or
            (1 <= w <= max(4, round(image.shape[1] * 0.012)) and
             h >= max(14, round(image.shape[0] * 0.012)) and h / max(1, w) >= 4)):
            cursor_mask[labels == index] = 255
    hsv = cv2.cvtColor(field, cv2.COLOR_BGR2HSV)
    blue = (((hsv[:, :, 0] >= 90) & (hsv[:, :, 0] <= 140) &
             (hsv[:, :, 1] >= 70) & (hsv[:, :, 2] >= 80)).astype(np.uint8) * 255)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(blue, 8)
    for index in range(1, count):
        x, y, w, h, area = stats[index]
        # Caret height follows the text line, not the whole multiline field.
        if (2 <= w <= max(4, round(image.shape[1] * 0.012)) and
                h >= max(12, round(image.shape[0] * 0.012)) and h / w >= 5):
            cursor_mask[labels == index] = 255
    return cv2.inpaint(field, cursor_mask, 2, cv2.INPAINT_TELEA)


def read_input_lines(image, roi, engine):
    """Recognize real ink rows directly when the detector misses a lone glyph."""
    field = clean_input_field(image, rect(image, roi))
    ink = (cv2.cvtColor(field, cv2.COLOR_BGR2GRAY) < 170).astype(np.uint8)
    occupied = np.flatnonzero(ink.sum(axis=1) >= 2)
    rows = []
    gap = max(3, round(image.shape[0] * 0.004))
    for y in occupied:
        y = int(y)
        if not rows or y - rows[-1][1] > gap:
            rows.append([y, y])
        else:
            rows[-1][1] = y
    if not rows or len(rows) > 8:
        return None
    crops = []
    for top, bottom in rows:
        columns = np.flatnonzero(ink[top:bottom + 1].any(axis=0))
        if not len(columns) or bottom - top < max(7, round(image.shape[0] * 0.006)):
            return None
        left, right = int(columns[0]), int(columns[-1])
        crop = field[max(0, top - 3):min(field.shape[0], bottom + 4),
                     max(0, left - 3):min(field.shape[1], right + 4)]
        crops.append(cv2.copyMakeBorder(crop, 5, 5, 5, 5, cv2.BORDER_CONSTANT,
                                       value=(255, 255, 255)))
    recognizer = getattr(engine, "text_recognizer", None)
    if recognizer is None:
        recognizer = engine.text_rec
    results, _ = recognizer(crops)
    if len(results) != len(crops):
        return None
    texts = [str(result[0]) for result in results]
    scores = [corrected_score(engine, text, result[1]) if text else 0
              for text, result in zip(texts, results)]
    if not all(texts) or not all(score >= 0.8 for score in scores):
        return None
    return "".join(texts), scores


def read_candidates(image, roi, engine):
    left, top, right, bottom = rect(image, roi)
    strip = image[top:bottom, left:right]
    gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(strip, cv2.COLOR_BGR2HSV)
    mask = ((gray < 170) | ((hsv[:, :, 1] > 90) & (hsv[:, :, 2] < 250))).astype(np.uint8) * 255
    # Remove small JPEG artefacts, not isolated Chinese character strokes.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    clean = np.zeros_like(mask)
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] >= 3:
            clean[labels == index] = 255
    # The ROI may contain both the composing pinyin row and the candidate row.
    # Select the row with the most horizontally distributed ink before finding
    # word columns; otherwise "bu" above "不" becomes one tall false candidate.
    bands = []
    for row in np.flatnonzero((clean > 0).sum(axis=1) >= 2):
        row = int(row)
        if not bands or row - bands[-1][1] > max(2, round(image.shape[0] * 0.002)):
            bands.append([row, row])
        else:
            bands[-1][1] = row
    if bands:
        y0, y1 = max(bands, key=lambda band: (
            int(((clean[band[0]:band[1] + 1] > 0).sum(axis=0) >= 2).sum()), band[1]))
        clean[:y0] = 0
        clean[y1 + 1:] = 0
    columns = np.flatnonzero((clean > 0).sum(axis=0) >= 2)
    spans = []
    gap_limit = max(3, round(image.shape[1] * 0.016))
    for column in columns:
        column = int(column)
        if not spans or column - spans[-1][1] > gap_limit:
            spans.append([column, column])
        else:
            spans[-1][1] = column
    boxes, crops = [], []
    for x0, x1 in spans:
        ys = np.flatnonzero((clean[:, x0:x1 + 1] > 0).any(axis=1))
        if len(ys) == 0 or x1 - x0 < 5 or ys[-1] - ys[0] < 7:
            continue
        y0, y1 = int(ys[0]), int(ys[-1])
        ink = clean[y0:y1 + 1, x0:x1 + 1]
        crop = cv2.cvtColor(255 - ink, cv2.COLOR_GRAY2BGR)
        crop = cv2.copyMakeBorder(crop, 3, 3, 3, 3, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        binary_crop = cv2.resize(crop, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
        original = strip[max(0, y0 - 2):min(strip.shape[0], y1 + 3), max(0, x0 - 2):min(strip.shape[1], x1 + 3)]
        original = cv2.copyMakeBorder(original, 2, 2, 2, 2, cv2.BORDER_CONSTANT, value=(255, 255, 255))
        crops.extend([binary_crop, cv2.resize(original, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)])
        boxes.append({"left": left + x0, "top": top + y0, "right": left + x1 + 1,
                      "bottom": top + y1 + 1, "center_x": left + (x0 + x1) / 2,
                      "center_y": top + (y0 + y1) / 2})
    if not crops:
        return []
    recognizer = getattr(engine, "text_recognizer", None)
    if recognizer is None:
        recognizer = engine.text_rec
    results, _ = recognizer(crops)
    candidates = []
    for index, box in enumerate(boxes):
        variants = []
        for result in results[index * 2:index * 2 + 2]:
            value = str(result[0])
            # Installed RapidOCR's CTC decoder averages an extra zero into
            # every non-empty result. Undo this documented local calculation
            # so one-character confidences use the same scale as phrases.
            score = corrected_score(engine, value, result[1]) if value else 0
            variants.append({"text": value.strip(), "score": min(1.0, score)})
        best = max(variants, key=lambda value: value["score"])
        candidates.append({**box, **best, "variants": variants})
    return candidates


def recognize(request, image=None, engine=None):
    started = time.perf_counter()
    if image is None:
        image = cv2.imread(request["path"])
    if image is None:
        raise ValueError("Cannot read screenshot")
    engine = engine if engine is not None else get_engine()
    candidates = read_candidates(image, request.get("candidate_roi", [0, 0.537, 0.89, 0.597]), engine)
    left, top, right, bottom = rect(image, request.get("input_roi", [0.09, 0.373, 0.81, 0.412]))
    field = clean_input_field(image, (left, top, right, bottom))
    input_crop = cv2.resize(field, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    raw, _ = engine(input_crop)
    # Only actual detected text; do not fabricate a value for an empty field.
    items = reading_order(raw)
    input_text = "".join(str(item[1]) for item in items)
    # The fast strip recognizer can split a sparse character or confuse a
    # caret with punctuation. On demand, use native-resolution full-frame
    # detection and keep only boxes inside the configured regions.
    if request.get("full_field") or request.get("detected_candidates"):
        # The fallback must see the same caret-cleaned field as the fast pass;
        # using the original image here reintroduces the blue caret on a sparse
        # wrapped last character.
        native_image = image.copy()
        native_image[top:bottom, left:right] = field
        native, _ = engine(native_image)
        field_items = []
        candidate_bounds = rect(image, request.get("candidate_roi", [0, 0.537, 0.89, 0.597]))
        detected = []
        for item in native or []:
            x0, y0, x1, y1 = box_to_rect(item[0])
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            if left <= cx <= right and top <= cy <= bottom:
                field_items.append(item)
            cl, ct, cr, cb = candidate_bounds
            if cl <= cx <= cr and ct <= cy <= cb:
                value = str(item[1]).strip()
                score = corrected_score(engine, value, item[2]) if value else 0
                detected.append({"text": value, "score": min(1.0, score),
                                 "left": x0, "top": y0, "right": x1, "bottom": y1,
                                 "center_x": cx, "center_y": cy, "source": "detector-fallback"})
        if request.get("full_field"):
            # Group actual text rows before sorting horizontally: a few pixels
            # of box-height noise must not reorder fragments of the same line.
            items = reading_order(field_items)
            input_text = "".join(str(item[1]) for item in items)
        if request.get("detected_candidates"):
            # Use one recognition strategy per response so overlapping
            # projection/detection boxes cannot create duplicate matches.
            candidates = detected
    input_scores = [float(item[2]) for item in items]
    input_source = "full-frame" if request.get("full_field") else "crop"
    if request.get("full_field"):
        line_result = read_input_lines(image, request.get("input_full_roi", request.get(
            "input_roi", [0.09, 0.373, 0.81, 0.412])), engine)
        if line_result is not None:
            input_text, input_scores = line_result
            input_source = "text-rows"
    return {"ok": True, "width": int(image.shape[1]), "height": int(image.shape[0]),
            "candidates": candidates, "input_text": input_text,
            "input_scores": input_scores, "input_source": input_source,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 1)}


def main():
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            response = recognize(request, image=request_image(request))
        except Exception as error:
            response = {"ok": False, "error": str(error)}
        if isinstance(request, dict) and "id" in request:
            response["id"] = request["id"]
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
