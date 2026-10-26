"""Chinese-to-pinyin keyboard typing for a projected cloud-phone input box.

The public functions default to dry-run mode.  Real keyboard input is only
enabled when the caller explicitly passes ``dry_run=False`` (or the CLI is
started with ``--execute``).
"""

from .engine import TypingConfig, type_ai_reply, type_chinese, type_segments
from .pipeline import ai_segments_to_units, text_to_units
from .segmenter import segment_text

__all__ = [
    "TypingConfig",
    "ai_segments_to_units",
    "segment_text",
    "text_to_units",
    "type_ai_reply",
    "type_chinese",
    "type_segments",
]
