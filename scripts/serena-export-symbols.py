#!/usr/bin/env python3
"""把 Serena 的 LSP 符号缓存导出为 docs/代码符号索引.md 消费的 JSON。

数据来源是 `serena project index` 落盘的 .serena/cache/<language>/document_symbols.pkl，
符号名与行号由 language server 给出，因此本脚本只做降噪与结构化，不做任何语法解析。
"""

import json
import os
import pickle
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, ".serena", "cache")
OUTPUT_FILE = os.path.join(CACHE_DIR, "symbols.json")

LANGUAGES = ("typescript", "python")

KIND_CLASS = {5, 10, 11}  # Class / Enum / Interface
KIND_CALLABLE = {6, 9, 12}  # Method / Constructor / Function
KIND_MEMBER = {6, 7, 8, 9, 12, 13, 14}
KIND_VALUE = {13, 14}  # Variable / Constant

IDENTIFIER_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
DEPENDENCY_RE = re.compile(r"\brequire\s*\(|^\s*(import|export\s+import)\b")
MAX_DECL_CHARS = 150
MAX_DECL_CONTINUATIONS = 8


class _Stub:
    """缓存里只有 DocumentSymbols/SymbolBody 两个 dataclass，字段本身已是纯 dict，无需依赖 solidlsp。"""

    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    def __setstate__(self, state):
        self.state = state


class _StubUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        return type(name, (_Stub,), {"__module__": module})


def load_cache(language):
    path = os.path.join(CACHE_DIR, language, "document_symbols.pkl")
    if not os.path.exists(path):
        return None
    with open(path, "rb") as handle:
        payload = _StubUnpickler(handle).load()["obj"]
    entries = {}
    for key, (_digest, symbols) in payload.items():
        state = getattr(symbols, "state", None)
        root = state.get("root_symbols", []) if isinstance(state, dict) else []
        entries[key.replace(os.sep, "/")] = root
    return {
        "path": os.path.relpath(path, ROOT).replace(os.sep, "/"),
        "mtime": os.path.getmtime(path),
        "entries": entries,
    }


def declaration(source, line_index):
    if not 0 <= line_index < len(source):
        return ""
    text = source[line_index].strip()
    # 跨行签名（多参数 def / 换行箭头函数）向后拼接至括号闭合
    for _ in range(MAX_DECL_CONTINUATIONS):
        if text.count("(") <= text.count(")") or text.endswith(("{", ":")):
            break
        line_index += 1
        if line_index >= len(source):
            break
        text = f"{text} {source[line_index].strip()}"
    text = re.split(r"\s*\{", text, maxsplit=1)[0]
    text = re.sub(r"\s*[:=]\s*$", "", text).rstrip()
    return text if len(text) <= MAX_DECL_CHARS else text[:MAX_DECL_CHARS].rstrip() + " …"


def _match_braces(text, open_index):
    depth = 0
    for index in range(open_index, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[open_index + 1:index]
    return text[open_index + 1:]


def collect_exports(text):
    names = []

    def add(value):
        value = value.strip().split(":")[0].split(" as ")[-1].strip()
        if re.match(r"^[A-Za-z0-9_$]+$", value) and value not in names:
            names.append(value)

    for match in re.finditer(r"(?:module\.)?exports\s*=\s*\{", text):
        for token in _match_braces(text, match.end() - 1).split(","):
            add(token)

    for match in re.finditer(r"^\s*export\s*\{([^}]*)\}", text, re.MULTILINE):
        for token in match.group(1).split(","):
            add(token)

    for line in text.splitlines():
        member = re.match(r"^\s*exports\.([A-Za-z0-9_$]+)\s*=", line)
        if member:
            add(member.group(1))
        esm = re.match(r"^\s*export\s+(?:async\s+)?(?:default\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)", line)
        if esm:
            add(esm.group(1))

    return names


def build_members(symbol, source):
    members = []
    seen = set()
    for child in symbol.get("children") or []:
        name = (child.get("name") or "").strip()
        kind = child.get("kind") or 0
        line = child.get("selectionRange", {}).get("start", {}).get("line")
        if line is None or kind not in KIND_MEMBER or not IDENTIFIER_RE.match(name) or name in seen:
            continue
        seen.add(name)
        members.append({"name": name, "line": line + 1, "kind": kind, "decl": declaration(source, line)})
    members.sort(key=lambda item: item["line"])
    return members


def file_level_symbols(root_symbols):
    """IIFE/闭包包装（tsserver 命名为 `<function>`）本身不是符号，展开其直接子级。"""
    for symbol in root_symbols:
        name = (symbol.get("name") or "").strip()
        if IDENTIFIER_RE.match(name):
            yield symbol
            continue
        for child in symbol.get("children") or []:
            if IDENTIFIER_RE.match((child.get("name") or "").strip()):
                yield child
            else:
                for grandchild in child.get("children") or []:
                    if IDENTIFIER_RE.match((grandchild.get("name") or "").strip()):
                        yield grandchild


def build_file_entry(rel_path, root_symbols):
    try:
        with open(os.path.join(ROOT, rel_path), "r", encoding="utf-8", errors="replace") as handle:
            source = handle.read().splitlines()
    except OSError:
        return None

    entry = {
        "lines": len(source),
        "classes": [],
        "functions": [],
        "constants": [],
        "exports": collect_exports("\n".join(source)),
    }
    claimed = set()

    for symbol in file_level_symbols(root_symbols):
        name = (symbol.get("name") or "").strip()
        kind = symbol.get("kind") or 0
        start = symbol.get("selectionRange", {}).get("start", {}).get("line")
        end = symbol.get("range", {}).get("end", {}).get("line")
        if start is None or not IDENTIFIER_RE.match(name) or name in claimed:
            continue
        line_text = source[start].strip() if 0 <= start < len(source) else ""

        if kind in KIND_CLASS:
            claimed.add(name)
            entry["classes"].append({
                "name": name,
                "line": start + 1,
                "endLine": end + 1 if end is not None else None,
                "kind": kind,
                "decl": declaration(source, start),
                "members": build_members(symbol, source),
            })
        elif kind in KIND_CALLABLE:
            claimed.add(name)
            entry["functions"].append({
                "name": name,
                "line": start + 1,
                "endLine": end + 1 if end is not None else None,
                "decl": declaration(source, start),
            })
        elif kind in KIND_VALUE:
            # 根级 Property/Constant 大量来自 module.exports 与 require 解构，只保留真正的顶层声明
            if DEPENDENCY_RE.search(line_text) or not re.match(r"^(?:export\s+)?(?:const|let|var)\b", line_text):
                continue
            claimed.add(name)
            entry["constants"].append({
                "name": name,
                "line": start + 1,
                "endLine": end + 1 if end is not None else None,
                "decl": declaration(source, start),
            })

    for bucket in ("classes", "functions", "constants"):
        entry[bucket].sort(key=lambda item: item["line"])
    return entry


def main():
    caches = {language: load_cache(language) for language in LANGUAGES}
    if all(cache is None for cache in caches.values()):
        sys.exit("[serena-export] 缺少 .serena/cache/*/document_symbols.pkl，请先运行: serena project index")

    files = {}
    for cache in caches.values():
        for rel_path, root_symbols in cache["entries"].items():
            if not os.path.exists(os.path.join(ROOT, rel_path)):
                continue
            built = build_file_entry(rel_path, root_symbols)
            if built is not None:
                files[rel_path] = built

    languages = {}
    for language, cache in caches.items():
        if cache is None:
            continue
        suffixes = (".py",) if language == "python" else (".js", ".ts", ".html", ".css")
        languages[language] = {
            "cache": cache["path"],
            "cacheUpdatedAt": cache["mtime"],
            "cached": len(cache["entries"]),
            "indexed": sum(1 for path in files if path.endswith(suffixes)),
        }

    payload = {"schemaVersion": 1, "source": "serena", "languages": languages, "files": files}
    with open(OUTPUT_FILE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1, sort_keys=True)

    print(f"[serena-export] 已导出 {len(files)} 个文件的 LSP 符号: "
          f"{os.path.relpath(OUTPUT_FILE, ROOT).replace(os.sep, '/')}")
    for language, info in languages.items():
        print(f"  - {language}: 缓存 {info['cached']} 个文件，落在索引范围内 {info['indexed']} 个")


if __name__ == "__main__":
    main()
