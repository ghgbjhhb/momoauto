"""Emit the existing jieba/pypinyin plan; never touches a keyboard."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from python_typing.pipeline import text_to_units
from pypinyin import Style, lazy_pinyin

def make_plan(text):
    tokens, units = text_to_units(text)
    output = []
    for unit in units:
        value = unit.to_dict()
        if unit.kind == "pinyin":
            value["syllables"] = lazy_pinyin(unit.text, style=Style.NORMAL, v_to_u=False)
        output.append(value)
    return {"text": text, "tokens": tokens, "units": output}


if __name__ == "__main__":
    if "--serve" in sys.argv:
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                if not isinstance(request.get("text"), str) or len(request["text"].encode("utf-8")) > 65536:
                    raise ValueError("invalid text")
                response = {"id": request["id"], "ok": True, "data": make_plan(request["text"])}
            except Exception as error:
                response = {"id": request.get("id"), "ok": False, "errorType": type(error).__name__}
            print(json.dumps(response, ensure_ascii=False), flush=True)
    else:
        print(json.dumps(make_plan(sys.stdin.read()), ensure_ascii=False))
