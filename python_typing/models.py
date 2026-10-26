"""Small immutable data structures shared by the typing pipeline."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


ActionName = Literal["write", "press"]


@dataclass(frozen=True)
class KeyAction:
    """One keyboard operation that can be executed or printed."""

    action: ActionName
    key: str

    def to_dict(self) -> dict[str, str]:
        return {"action": self.action, "key": self.key}


@dataclass(frozen=True)
class InputUnit:
    """A Chinese pinyin candidate or a directly typed text run."""

    text: str
    kind: Literal["pinyin", "direct"]
    pinyin: str = ""
    actions: tuple[KeyAction, ...] = ()
    source: str = "jieba"

    def to_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "text": self.text,
            "kind": self.kind,
            "source": self.source,
            "actions": [action.to_dict() for action in self.actions],
        }
        if self.kind == "pinyin":
            result["pinyin"] = self.pinyin
            result["confirm"] = "space"
        return result
