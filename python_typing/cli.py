"""Command-line entry point for dry-run and explicitly requested execution."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .engine import TypingConfig, report_json, type_chinese, type_segments


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description="中文分词、拼音和云手机输入法打字")
    command.add_argument("--text", help="要输入的中文或中英数字混合文本")
    command.add_argument("--segments-json", help="AI 分词/拼音 JSON 字符串")
    command.add_argument("--segments-file", help="包含 AI 分词/拼音 JSON 的文件")
    command.add_argument("--userdict", help="jieba 用户词典路径")
    command.add_argument("--key-interval", type=float, default=0.03)
    command.add_argument("--word-interval", type=float, default=0.15)
    command.add_argument("--countdown", type=int, default=5)
    command.add_argument("--execute", action="store_true", help="真实敲击键盘；省略则只输出操作")
    return command


def _load_segments(args: argparse.Namespace) -> Any | None:
    if args.segments_json and args.segments_file:
        raise ValueError("--segments-json and --segments-file are mutually exclusive")
    if args.segments_json:
        return json.loads(args.segments_json)
    if args.segments_file:
        return json.loads(Path(args.segments_file).read_text(encoding="utf-8"))
    return None


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    segments = _load_segments(args)
    if args.text is None:
        args.text = input("输入中文回复（默认只做 dry-run）：")
    config = TypingConfig(
        key_interval=args.key_interval,
        word_interval=args.word_interval,
        countdown=args.countdown,
    )
    if segments is None:
        report = type_chinese(
            args.text,
            userdict=args.userdict,
            config=config,
            dry_run=not args.execute,
        )
    else:
        report = type_segments(
            args.text,
            segments,
            config=config,
            dry_run=not args.execute,
        )
    print(report_json(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
