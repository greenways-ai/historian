import ts from "typescript";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { structuralFeatures } from "./normalize.js";

const protocolVersion = "1.0";
const analyzerVersion = "0.1.0";
const maxMessageBytes = 10 * 1024 * 1024;
const encoder = new TextEncoder();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value) {
  return encoder.encode(String(value)).byteLength;
}

function lineColumn(sourceFile, position) {
  const location = sourceFile.getLineAndCharacterOfPosition(Math.max(0, position));
  return { line: location.line + 1, column: location.character + 1 };
}

function rangeFor(sourceFile, start, end) {
  return {
    start_byte: byteLength(sourceFile.text.slice(0, start)),
    end_byte: byteLength(sourceFile.text.slice(0, end)),
    start: lineColumn(sourceFile, start),
    end: lineColumn(sourceFile, end)
  };
}

function scriptKindFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".ts") || lower.endsWith(".d.ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function moduleNameFor(path) {
  return path.replaceAll("\\", "/")
    .replace(/^.*\//, "")
    .replace(/\.d\.(ts|tsx)$/i, "")
    .replace(/\.(jsx?|tsx?|mjs|cjs)$/i, "");
}

function modifiersFor(node) {
  return (node.modifiers ?? [])
    .map((modifier) => ts.tokenToString(modifier.kind))
    .filter(Boolean);
}

function declarationInfo(node, parent, sourceFile, moduleName) {
  let kind = null;
  let nameNode = node.name;
  switch (node.kind) {
    case ts.SyntaxKind.FunctionDeclaration: kind = "function"; break;
    case ts.SyntaxKind.MethodDeclaration: kind = "method"; break;
    case ts.SyntaxKind.Constructor: kind = "constructor"; nameNode = null; break;
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor: kind = "method"; break;
    case ts.SyntaxKind.ClassDeclaration: kind = "class"; break;
    case ts.SyntaxKind.InterfaceDeclaration: kind = "interface"; break;
    case ts.SyntaxKind.TypeAliasDeclaration: kind = "type"; break;
    case ts.SyntaxKind.EnumDeclaration: kind = "enum"; break;
    case ts.SyntaxKind.EnumMember: kind = "constant"; break;
    case ts.SyntaxKind.VariableDeclaration:
      if (parent?.kind === ts.SyntaxKind.VariableDeclarationList) {
        kind = (parent.flags & ts.NodeFlags.Const) !== 0 ? "constant" : "variable";
      }
      break;
    case ts.SyntaxKind.PropertyDeclaration: kind = "property"; break;
    case ts.SyntaxKind.PropertySignature: kind = "property"; break;
    case ts.SyntaxKind.ModuleDeclaration: kind = "namespace"; break;
    default: break;
  }
  const name = nameNode?.getText(sourceFile) ?? (kind === "constructor" ? "constructor" : null);
  if (!kind || !name || !/^[$A-Z_a-z][$\w]*$/u.test(name)) return null;
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const selectionStart = nameNode?.getStart(sourceFile) ?? start;
  const selectionEnd = nameNode?.getEnd() ?? selectionStart + name.length;
  const localId = `${kind}:${start}:${name}`;
  const sourceText = sourceFile.text.slice(start, end);
  const bodyStart = node.body?.getStart(sourceFile) ?? end;
  return {
    localId,
    symbol: {
      local_id: localId,
      kind,
      name,
      qualified_name: `${moduleName}/${name}`,
      range: rangeFor(sourceFile, start, end),
      selection_range: rangeFor(sourceFile, selectionStart, selectionEnd),
      signature: sourceFile.text.slice(start, bodyStart).trim(),
      modifiers: modifiersFor(node),
      source_hash: sha256(sourceText),
      structural_hash: sha256(JSON.stringify(structuralFeatures(node))),
      structural_features: structuralFeatures(node),
      structure: { kind: ts.SyntaxKind[node.kind], normalized: sourceText.replace(/\s+/g, " ").trim() }
    }
  };
}

function targetText(node, sourceFile) {
  return node?.getText(sourceFile)?.trim() || null;
}

function analyzeSource({ language, path, blob_oid: blobOid, source }) {
  if (!["javascript", "typescript"].includes(language)) {
    throw Object.assign(new Error("unsupported language"), { code: "unsupported_language" });
  }
  if (byteLength(source) > maxMessageBytes) {
    throw Object.assign(new Error("source exceeds analyzer limit"), { code: "too_large" });
  }
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const moduleName = moduleNameFor(path);
  const moduleLocalId = `module:0:${moduleName}`;
  const symbols = [];
  const symbolIds = new Set();
  const declarations = new Map();

  function visitDeclarations(node, parent, parentLocalId = moduleLocalId) {
    const info = declarationInfo(node, parent, sourceFile, moduleName);
    const current = info?.localId ?? parentLocalId;
    if (info && !symbolIds.has(info.localId)) {
      symbols.push(info.symbol);
      symbolIds.add(info.localId);
      declarations.set(node, info.localId);
    }
    node.forEachChild((child) => visitDeclarations(child, node, current));
  }
  visitDeclarations(sourceFile, null);

  const references = [];
  const referenceKeys = new Set();
  function addReference(node, sourceSymbolLocalId, kind, text) {
    if (!text) return;
    const range = rangeFor(sourceFile, node.getStart(sourceFile), node.getEnd());
    const key = `${kind}:${range.start_byte}:${text}`;
    if (referenceKeys.has(key)) return;
    referenceKeys.add(key);
    references.push({
      kind,
      range,
      source_symbol_local_id: sourceSymbolLocalId ?? moduleLocalId,
      target_text: text,
      target_qualified_name: text,
      resolution: kind === "import" ? "candidate" : "unresolved",
      confidence: kind === "import" ? 0.8 : 0.4
    });
  }

  function visitReferences(node, parent, currentLocalId = moduleLocalId) {
    const declarationId = declarations.get(node);
    const current = declarationId ?? currentLocalId;
    if (node.kind === ts.SyntaxKind.ImportDeclaration) {
      addReference(node.moduleSpecifier, current, "import", targetText(node.moduleSpecifier, sourceFile)?.replace(/^['"]|['"]$/g, ""));
    } else if (node.kind === ts.SyntaxKind.ExportDeclaration && node.moduleSpecifier) {
      addReference(node.moduleSpecifier, current, "import", targetText(node.moduleSpecifier, sourceFile)?.replace(/^['"]|['"]$/g, ""));
    } else if (node.kind === ts.SyntaxKind.CallExpression) {
      addReference(node.expression, current, "call", targetText(node.expression, sourceFile));
    } else if (node.kind === ts.SyntaxKind.NewExpression) {
      addReference(node.expression, current, "call", targetText(node.expression, sourceFile));
    } else if (node.kind === ts.SyntaxKind.TypeReference) {
      addReference(node.typeName, current, "type", targetText(node.typeName, sourceFile));
    } else if (node.kind === ts.SyntaxKind.HeritageClause) {
      for (const type of node.types) addReference(type.expression, current, "inherit", targetText(type.expression, sourceFile));
    } else if (node.kind === ts.SyntaxKind.JsxOpeningElement || node.kind === ts.SyntaxKind.JsxSelfClosingElement) {
      addReference(node.tagName, current, "call", targetText(node.tagName, sourceFile));
    }
    node.forEachChild((child) => visitReferences(child, node, current));
  }
  visitReferences(sourceFile, null);

  const diagnostics = (sourceFile.parseDiagnostics ?? []).map((diagnostic) => {
    const start = diagnostic.start ?? 0;
    const end = start + (diagnostic.length ?? 0);
    return {
      severity: "error",
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      range: rangeFor(sourceFile, start, end)
    };
  });
  const imports = [];
  sourceFile.forEachChild((node) => {
    if (node.kind === ts.SyntaxKind.ImportDeclaration || node.kind === ts.SyntaxKind.ExportDeclaration) {
      const value = targetText(node.moduleSpecifier, sourceFile)?.replace(/^['"]|['"]$/g, "");
      if (value && !imports.includes(value)) imports.push(value);
    }
  });
  return {
    file: { language, path, blob_oid: blobOid, namespace: moduleName, imports, source_bytes: byteLength(source) },
    symbols,
    references: references.sort((a, b) => a.range.start_byte - b.range.start_byte),
    diagnostics
  };
}

function describe() {
  return {
    name: "greenways-historian-typescript",
    version: analyzerVersion,
    protocol_versions: [protocolVersion],
    languages: ["javascript", "typescript"],
    extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".d.ts"],
    capabilities: ["symbols", "calls", "imports", "structural_hashes", "structural_features", "partial_parse"],
    max_message_bytes: maxMessageBytes,
    fingerprint: sha256(`${analyzerVersion}:typescript-${ts.version}`)
  };
}

function response(request, bodyKey, body) {
  return { protocol_version: protocolVersion, request_id: request.request_id ?? "unknown", op: request.op ?? "unknown", [bodyKey]: body };
}

function handle(request) {
  try {
    if (request.protocol_version !== protocolVersion) throw Object.assign(new Error("unsupported protocol version"), { code: "invalid_request" });
    if (request.op === "describe") return response(request, "result", describe());
    if (request.op === "ping") return response(request, "result", { ok: true });
    if (request.op === "shutdown") return response(request, "result", { ok: true });
    if (request.op === "analyze") return response(request, "result", analyzeSource(request));
    throw Object.assign(new Error("unsupported operation"), { code: "unsupported_operation" });
  } catch (error) {
    return response(request, "error", { code: error.code ?? "internal_error", message: error.message });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); }
  catch { request = { request_id: "unknown", op: "unknown", protocol_version: protocolVersion }; }
  process.stdout.write(`${JSON.stringify(handle(request))}\n`);
  if (request.op === "shutdown") break;
}

