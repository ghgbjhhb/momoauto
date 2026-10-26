"""Conservative mapping for common Chinese punctuation to keyboard keys."""

from __future__ import annotations

from .models import KeyAction


# These are ASCII keystrokes.  The phone IME may render them as Chinese or
# ASCII punctuation depending on its current mode; no universal mapping can
# be guaranteed for every Android keyboard.
PUNCTUATION_MAP: dict[str, str] = {
    "，": ",",
    "。": ".",
    "！": "!",
    "？": "?",
    "：": ":",
    "；": ";",
    "、": "/",
    "（": "(",
    "）": ")",
    "【": "[",
    "】": "]",
    "『": "[",
    "』": "]",
    "“": '"',
    "”": '"',
    "‘": "'",
    "’": "'",
    "《": "<",
    "》": ">",
    "〈": "<",
    "〉": ">",
    "—": "-",
    "–": "-",
    "…": "...",
    "·": ".",
    "～": "~",
    "％": "%",
    "＃": "#",
    "＠": "@",
    "＆": "&",
    "＋": "+",
    "＝": "=",
    "－": "-",
    "／": "/",
    "＼": "\\",
    "｜": "|",
}


def direct_actions(value: str) -> tuple[KeyAction, ...]:
    """Build actions for English, digits, whitespace and mapped punctuation."""

    actions: list[KeyAction] = []
    for char in value:
        if char in ("\r", "\n"):
            actions.append(KeyAction("press", "enter"))
            continue
        if char == "\t":
            actions.append(KeyAction("press", "tab"))
            continue
        if char == " ":
            actions.append(KeyAction("press", "space"))
            continue
        mapped = PUNCTUATION_MAP.get(char, char)
        if ord(mapped[0]) > 127:
            raise ValueError(
                f"unsupported non-ASCII direct character {char!r}; "
                "add an explicit punctuation mapping or use an IME-aware handler"
            )
        actions.extend(KeyAction("write", key) for key in mapped)
    return tuple(actions)
