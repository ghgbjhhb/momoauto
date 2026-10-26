"""Candidate confirmation strategies.

The first implementation confirms the first IME candidate with Space.  The
interface is intentionally independent from text conversion so OCR matching,
mouse selection or correction can be added later without changing the
segmentation/pinyin pipeline.
"""

from __future__ import annotations

from typing import Protocol


class KeyboardLike(Protocol):
    def press(self, key: str) -> None: ...


class CandidateConfirmer(Protocol):
    def confirm(self, keyboard: KeyboardLike) -> None: ...


class SpaceCandidateConfirmer:
    """Confirm the first visible candidate with the phone IME's Space key."""

    def confirm(self, keyboard: KeyboardLike) -> None:
        keyboard.press("space")


class NoopCandidateConfirmer:
    """Dry-run confirmer; the recording keyboard still records Space."""

    def confirm(self, keyboard: KeyboardLike) -> None:
        keyboard.press("space")
