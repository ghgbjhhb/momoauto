"""Public typing API and execution engine."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Iterable

from .candidate import NoopCandidateConfirmer, SpaceCandidateConfirmer
from .keyboard import PyAutoGUIKeyboard, RecordingKeyboard
from .models import InputUnit
from .pipeline import ai_segments_to_units, text_to_units


@dataclass(frozen=True)
class TypingConfig:
    key_interval: float = 0.03
    word_interval: float = 0.15
    countdown: int = 5

    def validate(self) -> "TypingConfig":
        if self.key_interval < 0 or self.word_interval < 0:
            raise ValueError("key_interval and word_interval must be non-negative")
        if self.countdown < 0:
            raise ValueError("countdown must be non-negative")
        return self


def _countdown(seconds: int, sleep_fn: Callable[[float], None], output: Callable[[str], None]) -> None:
    for remaining in range(seconds, 0, -1):
        output(f"真实键盘输入将在 {remaining} 秒后开始；将焦点放到云手机输入框，鼠标移到左上角可紧急停止。")
        sleep_fn(1)


def execute_units(
    units: Iterable[InputUnit],
    config: TypingConfig | None = None,
    *,
    dry_run: bool = True,
    sleep_fn: Callable[[float], None] = time.sleep,
    output: Callable[[str], None] = print,
) -> list[dict[str, str]]:
    """Execute units and return the actual/expected keyboard operations."""

    settings = (config or TypingConfig()).validate()
    recording = RecordingKeyboard() if dry_run else None
    keyboard = recording if recording is not None else PyAutoGUIKeyboard()
    confirmer = NoopCandidateConfirmer() if dry_run else SpaceCandidateConfirmer()

    if not dry_run:
        _countdown(settings.countdown, sleep_fn, output)

    for unit in units:
        for action in unit.actions:
            if action.action == "write":
                keyboard.write_char(action.key)  # type: ignore[union-attr]
            else:
                keyboard.press(action.key)  # type: ignore[union-attr]
            if not dry_run and settings.key_interval:
                sleep_fn(settings.key_interval)
        if unit.kind == "pinyin":
            confirmer.confirm(keyboard)  # type: ignore[arg-type]
            if not dry_run and settings.word_interval:
                sleep_fn(settings.word_interval)

    if recording is None:
        return []
    return [action.to_dict() for action in recording.actions]


def _report(
    original: str,
    tokens: list[str],
    units: list[InputUnit],
    actions: list[dict[str, str]],
    dry_run: bool,
) -> dict[str, Any]:
    return {
        "ok": True,
        "dryRun": dry_run,
        "original": original,
        "tokens": tokens,
        "reconstructed": "".join(tokens),
        "units": [unit.to_dict() for unit in units],
        "keyboardOperations": actions,
        "note": (
            "dry-run: no keyboard input was sent"
            if dry_run
            else "real keyboard input sent; candidate confirmation uses Space"
        ),
    }


def type_chinese(
    text: str,
    *,
    userdict: str | None = None,
    config: TypingConfig | None = None,
    dry_run: bool = True,
    sleep_fn: Callable[[float], None] = time.sleep,
    output: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Segment, convert and type a Chinese/mixed-language reply."""

    tokens, units = text_to_units(text, userdict=userdict)
    actions = execute_units(units, config, dry_run=dry_run, sleep_fn=sleep_fn, output=output)
    return _report(text, tokens, units, actions, dry_run)


def type_segments(
    original: str,
    segments: Any,
    *,
    config: TypingConfig | None = None,
    dry_run: bool = True,
    sleep_fn: Callable[[float], None] = time.sleep,
    output: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Execute AI-provided text/pinyin JSON after exact reconstruction check."""

    tokens, units = ai_segments_to_units(original, segments)
    actions = execute_units(units, config, dry_run=dry_run, sleep_fn=sleep_fn, output=output)
    return _report(original, tokens, units, actions, dry_run)


def type_ai_reply(
    reply: str,
    *,
    segments: Any | None = None,
    **kwargs: Any,
) -> dict[str, Any]:
    """Adapter for an AI assistant: plain reply or validated segment JSON."""

    if segments is None:
        return type_chinese(reply, **kwargs)
    return type_segments(reply, segments, **kwargs)


def report_json(report: dict[str, Any]) -> str:
    return json.dumps(report, ensure_ascii=False, indent=2)
