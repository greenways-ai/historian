#!/usr/bin/env python3
"""Deterministic blob-local Python analyzer for Greenways Historian."""

from __future__ import annotations

import ast
import bisect
import hashlib
import io
import json
import re
import sys
import tokenize
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = "1.0"
ANALYZER_VERSION = "0.1.0"
MAX_MESSAGE_BYTES = 10 * 1024 * 1024
EXTENSIONS = [".py", ".pyi", ".pyw"]


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def utf8_size(value: str) -> int:
    return len(value.encode("utf-8"))


def module_name(path: str) -> str:
    base = path.replace("\\", "/").rsplit("/", 1)[-1]
    return re.sub(r"\.py(?:i|w)?$", "", base, flags=re.IGNORECASE) or "module"


@dataclass
class TokenInfo:
    text: str
    start_byte: int
    end_byte: int


class SourceMap:
    def __init__(self, source: str):
        self.source = source
        self.lines = source.splitlines(keepends=True) or [""]
        self.byte_starts = [0]
        self.char_starts = [0]
        for line in self.lines:
            self.byte_starts.append(self.byte_starts[-1] + utf8_size(line))
            self.char_starts.append(self.char_starts[-1] + len(line))
        self.source_bytes = source.encode("utf-8")

    def offset(self, line: int, column_bytes: int) -> int:
        index = max(0, min(line - 1, len(self.byte_starts) - 1))
        return self.byte_starts[index] + max(0, column_bytes)

    def char_offset(self, line: int, column_chars: int) -> int:
        index = max(0, min(line - 1, len(self.char_starts) - 1))
        return self.char_starts[index] + max(0, column_chars)

    def position(self, offset: int) -> dict[str, int]:
        offset = max(0, min(offset, len(self.source_bytes)))
        line_index = max(0, bisect.bisect_right(self.byte_starts, offset) - 1)
        prefix = self.source_bytes[self.byte_starts[line_index] : offset]
        return {"line": line_index + 1, "column": len(prefix.decode("utf-8", errors="ignore")) + 1}

    def range(self, start: int, end: int) -> dict[str, Any]:
        return {"start_byte": start, "end_byte": end, "start": self.position(start), "end": self.position(end)}

    def node_range(self, node: ast.AST) -> dict[str, Any]:
        start = self.offset(getattr(node, "lineno", 1), getattr(node, "col_offset", 0))
        end = self.offset(getattr(node, "end_lineno", getattr(node, "lineno", 1)), getattr(node, "end_col_offset", getattr(node, "col_offset", 0)))
        return self.range(start, max(start, end))


def token_infos(source: str, source_map: SourceMap) -> list[TokenInfo]:
    result: list[TokenInfo] = []
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type not in (tokenize.NAME, tokenize.OP, tokenize.STRING, tokenize.NUMBER):
                continue
            start_char = source_map.char_offset(token.start[0], token.start[1])
            end_char = source_map.char_offset(token.end[0], token.end[1])
            result.append(TokenInfo(token.string, utf8_size(source[:start_char]), utf8_size(source[:end_char])))
    except (tokenize.TokenError, IndentationError):
        pass
    return result


def ast_shape(value: Any) -> Any:
    if isinstance(value, ast.AST):
        if isinstance(value, (ast.Name, ast.arg, ast.alias)):
            return "Identifier"
        if isinstance(value, ast.Constant):
            return ["Literal", type(value.value).__name__]
        return [type(value).__name__, *[ast_shape(getattr(value, field)) for field in value._fields if field not in {"type_comment"}]]
    if isinstance(value, list):
        return [ast_shape(item) for item in value]
    if isinstance(value, tuple):
        return [ast_shape(item) for item in value]
    if isinstance(value, (str, int, float, complex, bool)) or value is None:
        return "Value"
    return "Value"


def structural_features(node: ast.AST) -> dict[str, Any]:
    shape = ast_shape(node)
    state = {"node_count": 0, "depth": 0, "arity": 0, "features": set()}

    def walk(value: Any, depth: int) -> None:
        if not isinstance(value, list):
            return
        state["node_count"] += 1
        state["depth"] = max(state["depth"], depth)
        if value and isinstance(value[0], str):
            state["features"].add(value[0])
            if value[0] in {"Call", "Await", "Yield", "YieldFrom"}:
                state["arity"] = max(state["arity"], len(value) - 1)
        for child in value[1:]:
            walk(child, depth + 1)

    walk(shape, 1)
    encoded = json.dumps(shape, ensure_ascii=False, separators=(",", ":"))
    return {"shape": encoded, "shape_hash": sha256(encoded), "node_count": state["node_count"], "depth": state["depth"], "arity": state["arity"], "features": sorted(state["features"])}


def docstring(node: ast.AST) -> str | None:
    try:
        return ast.get_docstring(node, clean=False)
    except (AttributeError, TypeError):
        return None


class PythonAnalyzer:
    def __init__(self, language: str, path: str, blob_oid: str, source: str):
        if language != "python":
            raise ValueError("unsupported language", "unsupported_language")
        if utf8_size(source) > MAX_MESSAGE_BYTES:
            raise ValueError("source exceeds analyzer limit", "too_large")
        self.language, self.path, self.blob_oid, self.source = language, path, blob_oid, source
        self.map = SourceMap(source)
        self.tokens = token_infos(source, self.map)
        self.module = module_name(path)
        self.module_id = f"module:0:{self.module}"
        self.symbols: list[dict[str, Any]] = []
        self.symbol_nodes: dict[int, str] = {}
        self.symbol_names: dict[str, str] = {}
        self.references: list[dict[str, Any]] = []
        self.reference_keys: set[tuple[Any, ...]] = set()
        self.imports: list[str] = []

    def node_range(self, node: ast.AST) -> dict[str, Any]:
        return self.map.node_range(node)

    def text(self, range_value: dict[str, Any]) -> str:
        return self.map.source_bytes[range_value["start_byte"] : range_value["end_byte"]].decode("utf-8", errors="replace")

    def selection(self, node: ast.AST, name: str | None = None) -> dict[str, Any]:
        node_range = self.node_range(node)
        if name:
            for token in self.tokens:
                if token.text == name and node_range["start_byte"] <= token.start_byte and token.end_byte <= node_range["end_byte"]:
                    return self.map.range(token.start_byte, token.end_byte)
        return node_range

    def add_symbol(self, node: ast.AST, kind: str, name: str, parent: str, selection_node: ast.AST | None = None) -> str:
        range_value = self.node_range(node)
        local_id = f"{kind}:{range_value['start_byte']}:{name}"
        if local_id in self.symbol_nodes.values():
            return local_id
        features = structural_features(node)
        symbol: dict[str, Any] = {"local_id": local_id, "parent_local_id": parent, "kind": kind, "name": name, "qualified_name": f"{self.module}/{name}", "range": range_value, "selection_range": self.selection(selection_node or node, name), "source_hash": sha256(self.text(range_value)), "structural_hash": features["shape_hash"], "structural_features": features, "structure": {"ast": type(node).__name__, "structural_features": features}}
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body_start = self.node_range(node.body[0])["start_byte"] if node.body else range_value["end_byte"]
            symbol["signature"] = self.map.source_bytes[range_value["start_byte"] : body_start].decode("utf-8", errors="replace").strip()
            if docstring(node):
                symbol["documentation"] = docstring(node)
        self.symbols.append(symbol)
        self.symbol_nodes[id(node)] = local_id
        self.symbol_names.setdefault(name, local_id)
        return local_id

    def define_target(self, node: ast.AST, parent: str, field: bool = False) -> None:
        if isinstance(node, ast.Name):
            self.add_symbol(node, "field" if field else ("constant" if node.id.isupper() else "variable"), node.id, parent)
        elif isinstance(node, (ast.Tuple, ast.List)):
            for element in node.elts:
                self.define_target(element, parent, field)
        elif isinstance(node, ast.Starred):
            self.define_target(node.value, parent, field)

    def declarations(self, node: ast.AST, parent: str | None = None) -> None:
        parent = parent or self.module_id
        current = parent
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            is_method = any(item["local_id"] == parent and item["kind"] == "class" for item in self.symbols)
            current = self.add_symbol(node, "test" if node.name.startswith("test") else ("method" if is_method else "function"), node.name, parent, node)
            arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
            if node.args.vararg:
                arguments.append(node.args.vararg)
            if node.args.kwarg:
                arguments.append(node.args.kwarg)
            for argument in arguments:
                self.add_symbol(argument, "variable", argument.arg, current, argument)
        elif isinstance(node, ast.ClassDef):
            current = self.add_symbol(node, "class", node.name, parent, node)
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.NamedExpr)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                self.define_target(target, current, any(item["local_id"] == current and item["kind"] == "class" for item in self.symbols))
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            self.define_target(node.target, current)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars:
                    self.define_target(item.optional_vars, current)
        for child in ast.iter_child_nodes(node):
            self.declarations(child, current)

    def target_name(self, node: ast.AST) -> str | None:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return self.text(self.node_range(node)).strip()
        return None

    def add_reference(self, node: ast.AST, source_id: str, kind: str, target: str | None, resolution: str = "unresolved", confidence: float = 0.4) -> None:
        if not target:
            return
        range_value = self.node_range(node)
        key = (kind, range_value["start_byte"], range_value["end_byte"], target)
        if key in self.reference_keys:
            return
        self.reference_keys.add(key)
        if target in self.symbol_names and resolution == "unresolved":
            resolution, confidence = "resolved", 1.0
        self.references.append({"kind": kind, "range": range_value, "source_symbol_local_id": source_id, "target_text": target, "target_qualified_name": f"{self.module}/{target}" if target in self.symbol_names else target, "resolution": resolution, "confidence": confidence})

    def references_for(self, node: ast.AST, source_id: str | None = None, type_context: bool = False) -> None:
        current = self.symbol_nodes.get(id(node), source_id or self.module_id)
        if isinstance(node, ast.Import):
            for alias in node.names:
                self.add_reference(node, current, "import", alias.name, "candidate", 0.8)
                if alias.name not in self.imports:
                    self.imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            value = "." * node.level + (node.module or "")
            if value:
                self.add_reference(node, current, "import", value, "candidate", 0.8)
                if value not in self.imports:
                    self.imports.append(value)
        elif isinstance(node, ast.Call):
            self.add_reference(node.func, current, "call", self.target_name(node.func))
        elif isinstance(node, ast.ClassDef):
            for base in node.bases:
                self.add_reference(base, current, "inheritance", self.target_name(base), "candidate", 0.8)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for decorator in node.decorator_list:
                self.add_reference(decorator, current, "call", self.target_name(decorator))
        elif isinstance(node, ast.Name):
            self.add_reference(node, current, "type" if type_context else ("write" if isinstance(node.ctx, ast.Store) else "read"), node.id, "candidate" if type_context else "unresolved", 0.7 if type_context else 0.4)
        for field_name, value in ast.iter_fields(node):
            context = type_context or field_name in {"annotation", "returns", "type_comment", "type_params"}
            if isinstance(value, ast.AST):
                self.references_for(value, current, context)
            elif isinstance(value, list):
                for child in value:
                    if isinstance(child, ast.AST):
                        self.references_for(child, current, context)

    def analyze(self) -> dict[str, Any]:
        try:
            tree = ast.parse(self.source, filename=self.path, type_comments=True)
        except SyntaxError as error:
            line = max(1, error.lineno or 1)
            column = max(0, (error.offset or 1) - 1)
            start_char = self.map.char_offset(line, column)
            end_char = min(len(self.source), start_char + 1)
            return {"file": {"language": self.language, "path": self.path, "blob_oid": self.blob_oid, "namespace": self.module, "imports": [], "source_bytes": utf8_size(self.source)}, "symbols": [], "references": [], "diagnostics": [{"severity": "error", "message": error.msg, "range": self.map.range(utf8_size(self.source[:start_char]), utf8_size(self.source[:end_char]))}]}
        self.declarations(tree)
        self.references_for(tree)
        self.symbols.sort(key=lambda item: (item["range"]["start_byte"], item["range"]["end_byte"], item["name"]))
        self.references.sort(key=lambda item: (item["range"]["start_byte"], item["range"]["end_byte"], item["kind"], item.get("target_text", "")))
        return {"file": {"language": self.language, "path": self.path, "blob_oid": self.blob_oid, "namespace": self.module, "imports": self.imports, "source_bytes": utf8_size(self.source)}, "symbols": self.symbols, "references": self.references, "diagnostics": []}


def describe() -> dict[str, Any]:
    version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    return {"name": "greenways-historian-python", "version": ANALYZER_VERSION, "protocol_versions": [PROTOCOL_VERSION], "languages": ["python"], "extensions": EXTENSIONS, "capabilities": ["symbols", "calls", "reads", "writes", "imports", "types", "inheritance", "structural_hashes", "structural_features", "partial_parse"], "max_message_bytes": MAX_MESSAGE_BYTES, "fingerprint": sha256(f"{ANALYZER_VERSION}:python-{version}")}


def respond(request: dict[str, Any], key: str, value: Any) -> dict[str, Any]:
    return {"protocol_version": PROTOCOL_VERSION, "request_id": request.get("request_id", "unknown"), "op": request.get("op", "unknown"), key: value}


def handle(request: dict[str, Any]) -> dict[str, Any]:
    try:
        if request.get("protocol_version") != PROTOCOL_VERSION:
            raise ValueError("unsupported protocol version", "invalid_request")
        if request.get("op") == "describe":
            return respond(request, "result", describe())
        if request.get("op") == "ping":
            return respond(request, "result", {"ok": True})
        if request.get("op") == "shutdown":
            return respond(request, "result", {"ok": True})
        if request.get("op") == "analyze":
            return respond(request, "result", PythonAnalyzer(request.get("language", ""), request.get("path", "module.py"), request.get("blob_oid", "unknown"), request.get("source", "")).analyze())
        raise ValueError("unsupported operation", "unsupported_operation")
    except ValueError as error:
        return respond(request, "error", {"code": error.args[1] if len(error.args) > 1 else "internal_error", "message": str(error.args[0])})
    except Exception as error:
        return respond(request, "error", {"code": "internal_error", "message": str(error)})


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            request = {"protocol_version": PROTOCOL_VERSION, "request_id": "unknown", "op": "unknown"}
        print(json.dumps(handle(request), ensure_ascii=False, separators=(",", ":")), flush=True)
        if request.get("op") == "shutdown":
            break


if __name__ == "__main__":
    main()
