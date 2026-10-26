"""Compatibility entry for the relocated IME OCR worker."""
import runpy
import sys
from pathlib import Path

worker_dir = Path(__file__).resolve().parents[1] / "python_workers" / "ocr"
sys.path.insert(0, str(worker_dir))
namespace = runpy.run_path(str(worker_dir / "ime_ocr_worker.py"), run_name="__main__" if __name__ == "__main__" else "_legacy_ime_ocr")
globals().update({name: value for name, value in namespace.items() if not name.startswith("__")})
