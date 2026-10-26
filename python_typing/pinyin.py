"""No-tone pinyin conversion helpers."""

from __future__ import annotations

import re

from pypinyin import Style, lazy_pinyin


CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")


def contains_cjk(value: str) -> bool:
    return bool(CJK_RE.search(value))


def chinese_runs(value: str) -> list[str]:
    return CJK_RUN_RE.findall(value)


def to_pinyin(value: str) -> str:
    """Convert Chinese to full, lower-case, no-tone pinyin."""

    if not isinstance(value, str):
        raise TypeError("value must be a string")
    if not value:
        return ""
    result = lazy_pinyin(value, style=Style.NORMAL, errors="keep")
    pinyin = "".join(str(part) for part in result).lower()
    if any(ord(char) > 127 for char in pinyin):
        raise ValueError(f"pinyin contains a non-ASCII character for {value!r}: {pinyin!r}")
    return pinyin
