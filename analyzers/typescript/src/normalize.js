import ts from "typescript";
import { createHash } from "node:crypto";

const literalKinds = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword
]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function kindName(node) {
  if (node.kind === ts.SyntaxKind.Identifier) return "Identifier";
  if (literalKinds.has(node.kind)) return "Literal";
  return ts.SyntaxKind[node.kind] ?? String(node.kind);
}

export function normalizeNode(node) {
  const children = [];
  node.forEachChild((child) => children.push(normalizeNode(child)));
  return [kindName(node), ...children];
}

function walk(shape, depth, state) {
  state.nodeCount += 1;
  state.depth = Math.max(state.depth, depth);
  if (!Array.isArray(shape)) return;
  state.features.add(shape[0]);
  if (shape[0] === "CallExpression" || shape[0] === "NewExpression") {
    state.arity = Math.max(state.arity, Math.max(0, shape.length - 1));
  }
  for (const child of shape.slice(1)) walk(child, depth + 1, state);
}

export function structuralFeatures(node) {
  const shape = normalizeNode(node);
  const state = { nodeCount: 0, depth: 0, arity: 0, features: new Set() };
  walk(shape, 1, state);
  const encoded = JSON.stringify(shape);
  return {
    shape: encoded,
    shape_hash: hash(encoded),
    node_count: state.nodeCount,
    depth: state.depth,
    arity: state.arity,
    features: [...state.features].sort()
  };
}

