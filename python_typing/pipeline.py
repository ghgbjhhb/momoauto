"""Transform plain text or AI-provided segments into input units."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

from .models import InputUnit, KeyAction
from .pinyin import CJK_RUN_RE, contains_cjk, to_pinyin
from .punctuation import direct_actions
from .segmenter import segment_text


RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")


def _pinyin_unit(text: str, pinyin: str | None, source: str) -> InputUnit:
    value = pinyin if pinyin is not None else to_pinyin(text)
    value = str(value).replace(" ", "").replace("-", "").lower()
    if not value or any(ord(char) > 127 for char in value):
        raise ValueError(f"invalid ASCII pinyin for {text!r}: {value!r}")
    return InputUnit(
        text=text,
        kind="pinyin",
        pinyin=value,
        actions=tuple(KeyAction("write", char) for char in value),
        source=source,
    )


def _units_for_token(token: str, source: str = "jieba", explicit_pinyin: str | None = None) -> list[InputUnit]:
    if not isinstance(token, str):
        raise TypeError("each token must be a string")
    if not token:
        return []
    if explicit_pinyin is not None and (len(CJK_RUN_RE.findall(token)) != 1 or not contains_cjk(token)):
        raise ValueError("an explicit pinyin value must belong to one contiguous Chinese token")
    units: list[InputUnit] = []
    runs = list(RUN_RE.finditer(token))
    for match in runs:
        run = match.group(0)
        if contains_cjk(run):
            units.append(_pinyin_unit(run, explicit_pinyin, source))
        else:
            units.append(InputUnit(text=run, kind="direct", actions=direct_actions(run), source=source))
    return units


def merge_cjk_tokens(tokens: Iterable[str], max_phrase_len: int = 4) -> list[str]:
    """Merge adjacent short CJK tokens into natural phrase-level tokens (up to max_phrase_len chars)."""
    merged: list[str] = []
    buffer: list[str] = []
    for token in tokens:
        if contains_cjk(token) and len(token) <= max_phrase_len:
            if len("".join(buffer)) + len(token) <= max_phrase_len:
                buffer.append(token)
            else:
                if buffer:
                    merged.append("".join(buffer))
                    buffer = []
                buffer.append(token)
        else:
            if buffer:
                merged.append("".join(buffer))
                buffer = []
            merged.append(token)
    if buffer:
        merged.append("".join(buffer))
    return merged


def units_from_tokens(tokens: Iterable[str], source: str = "jieba") -> list[InputUnit]:
    units: list[InputUnit] = []
    for token in tokens:
        units.extend(_units_for_token(token, source=source))
    return units


def text_to_units(text: str, userdict: str | None = None) -> tuple[list[str], list[InputUnit]]:
    tokens = segment_text(text, userdict=userdict)
    phrase_tokens = merge_cjk_tokens(tokens, max_phrase_len=4)
    return phrase_tokens, units_from_tokens(phrase_tokens)


def _segment_items(payload: Any) -> list[Any]:
    if isinstance(payload, Mapping):
        segments = payload.get("segments")
        if segments is None:
            raise ValueError("AI JSON object must contain a 'segments' array")
        payload = segments
    if not isinstance(payload, list):
        raise TypeError("AI segments must be a JSON array or an object with a 'segments' array")
    return payload


def ai_segments_to_units(original: str, payload: Any) -> tuple[list[str], list[InputUnit]]:
    """Validate AI token/pinyin JSON and turn it into executable units.

    Accepted item shapes are ``{"text":"北京", "pinyin":"beijing"}``,
    ``{"word":"北京", "pinyin":"beijing"}``, or a plain string.  The
    concatenated item text must equal ``original`` byte-for-byte.
    """

    items = _segment_items(payload)
    tokens: list[str] = []
    units: list[InputUnit] = []
    for index, item in enumerate(items):
        if isinstance(item, str):
            text = item
            pinyin = None
        elif isinstance(item, Mapping):
            raw_text = item.get("text", item.get("word", item.get("token")))
            if not isinstance(raw_text, str):
                raise ValueError(f"AI segment {index} is missing text/word/token")
            text = raw_text
            raw_pinyin = item.get("pinyin")
            pinyin = None if raw_pinyin is None else str(raw_pinyin)
        else:
            raise TypeError(f"AI segment {index} must be a string or object")
        tokens.append(text)
        units.extend(_units_for_token(text, source="ai", explicit_pinyin=pinyin))
    reconstructed = "".join(tokens)
    if reconstructed != original:
        raise ValueError(
            "AI segments do not reconstruct the original text: "
            f"expected {original!r}, got {reconstructed!r}"
        )
    return tokens, units
