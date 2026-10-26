"""jieba segmentation with optional user dictionary support."""

from __future__ import annotations

import os
import io
import threading
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import jieba

_LOCK = threading.RLock()


@lru_cache(maxsize=8)
def _tokenizer(dictionary_path, dictionary_content):
    tokenizer = jieba.Tokenizer()
    if dictionary_path is not None:
        tokenizer.load_userdict(io.BytesIO(dictionary_content))
    tokenizer.initialize()
    return tokenizer


def segment_text(text: str, userdict: str | os.PathLike[str] | None = None) -> list[str]:
    """Return jieba tokens while preserving the original text when joined.

    ``userdict`` follows jieba's format: ``word [frequency] [tag]`` per line.
    Private tokenizers are reused by dictionary content identity, never exposed
    or mutated by requests. Dictionary edits select a different cached instance.
    """

    if not isinstance(text, str):
        raise TypeError("text must be a string")
    dictionary_path, content = None, None
    if userdict is not None:
        path = Path(userdict)
        if not path.is_file():
            raise FileNotFoundError(f"jieba user dictionary not found: {path}")
        dictionary_path = os.fspath(path.resolve())
        content = path.read_bytes()
    with _LOCK:
        tokenizer = _tokenizer(dictionary_path, content)
        tokens = list(tokenizer.cut(text, HMM=True))
    if "".join(tokens) != text:
        raise ValueError("jieba segmentation did not preserve the original text")
    return tokens


def tokens_text(tokens: Iterable[str]) -> str:
    """Join tokens and make the reconstruction operation explicit."""

    values = list(tokens)
    if any(not isinstance(value, str) for value in values):
        raise TypeError("all tokens must be strings")
    return "".join(values)
