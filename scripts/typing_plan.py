"""Compatibility entry for the relocated keyboard plan generator."""
import runpy
from pathlib import Path

worker = Path(__file__).resolve().parents[1] / "python_workers" / "typing" / "plan.py"
namespace = runpy.run_path(str(worker), run_name="__main__" if __name__ == "__main__" else "_legacy_typing_plan")
globals().update({name: value for name, value in namespace.items() if not name.startswith("__")})
