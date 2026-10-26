"""Crop pixel templates from an explicitly supplied, full-frame SDK screenshot.

No OCR, network, model training or phone actions. Existing assets are not overwritten
unless --overwrite is supplied. The manifest remains a source-controlled document.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    image = cv2.imdecode(np.frombuffer(Path(args.image).read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Input is not a decodable image")
    planned = []
    for item in manifest["templates"]:
        if [image.shape[1], image.shape[0]] != [item["referenceWidth"], item["referenceHeight"]]:
            raise ValueError("Manifest crop coordinates do not match input resolution")
        output = (manifest_path.parent / item["file"]).resolve()
        if output.parent != manifest_path.parent or (output.exists() and not args.overwrite):
            raise ValueError("Unsafe output path or existing template; explicit --overwrite is required")
        x1, y1, x2, y2 = item["crop"]
        if not (0 <= x1 < x2 <= image.shape[1] and 0 <= y1 < y2 <= image.shape[0]):
            raise ValueError("Crop is outside source image")
        ok, data = cv2.imencode(".png", image[y1:y2, x1:x2])
        if not ok:
            raise ValueError("PNG encoding failed")
        planned.append((output, data.tobytes()))
    for output, data in planned:
        with output.open("wb" if args.overwrite else "xb") as stream:
            stream.write(data)
        print(output.name)


if __name__ == "__main__":
    main()
