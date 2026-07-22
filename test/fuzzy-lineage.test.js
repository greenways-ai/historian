import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fuzzyCandidates, matchLineage, scoreCandidate } from "../src/fuzzy-lineage.js";
import { logicalSymbolId, revisionId } from "../src/lineage.js";
import { persistFuzzyLineage } from "../src/lineage-persistence.js";
import { openDatabase } from "../src/storage.js";

function symbol(overrides = {}) {
  return {
    name: "parse-config",
    qualified_name: "example.core/parse-config",
    kind: "function",
    signature: "[config]",
    structural_hash: "shape-1",
    structural_features: {
      shape_hash: "shape-tree-1",
      features: ["[:call]", "[:map]", "[:symbol]"],
      node_count: 12,
      depth: 4,
      arity: 1
    },
    references: ["example.core/load-config"],
    changed_paths: ["src/config.clj"],
    content: "parse config load",
    ...overrides
  };
}

function insertSymbol(db, repositoryId, commitOid, value) {
  const logicalId = logicalSymbolId(repositoryId, value);
  const currentRevisionId = revisionId(logicalId, value);
  db.query("INSERT OR IGNORE INTO logical_symbols(id, repository_id, language, qualified_name, kind) VALUES (?, ?, ?, ?, ?)")
    .run(logicalId, repositoryId, "clojure", value.qualified_name, value.kind);
  db.query("INSERT OR IGNORE INTO revisions(id, logical_symbol_id, structural_hash, source_hash, first_commit_oid, last_commit_oid) VALUES (?, ?, ?, ?, ?, ?)")
    .run(currentRevisionId, logicalId, value.structural_hash, `${value.name}-source`, commitOid, commitOid);
  return currentRevisionId;
}

describe("fuzzy lineage matching", () => {
  test("scores rename-plus-edit evidence deterministically", () => {
    const previous = symbol();
    const current = symbol({
      name: "parse-options",
      qualified_name: "example.options/parse-options",
      structural_hash: "shape-2",
      signature: "[config]",
      content: "parse options load",
      changed_paths: ["src/config.clj"]
    });
    const first = scoreCandidate(previous, current);
    const second = scoreCandidate(previous, current);
    expect(first).toEqual(second);
    expect(first.evidence.structure).toBeGreaterThan(0.8);
    expect(first.evidence.signature).toBe(1);
    expect(first.evidence.references).toBe(1);
    expect(first.evidence.diff).toBe(1);
    expect(first.confidence).toBeGreaterThan(0.45);
    const result = matchLineage([previous], [current]);
    expect(result.transitions.map((transition) => transition.kind)).toEqual(["moved"]);
    expect(result.transitions[0].resolution).toBe("resolved");
  });

  test("retains split and merge transformations as multi-edge transitions", () => {
    const previous = symbol();
    const split = matchLineage([previous], [
      symbol({ name: "parse-config-header", qualified_name: "example.core/parse-config-header", signature: "[config]" }),
      symbol({ name: "parse-config-body", qualified_name: "example.core/parse-config-body", signature: "[config body]" })
    ], { ambiguityDelta: 0.02 });
    expect(split.transitions).toHaveLength(2);
    expect(split.transitions.every((transition) => transition.kind === "split")).toBe(true);

    const merge = matchLineage([
      symbol({ name: "parse-config-header", qualified_name: "example.core/parse-config-header", signature: "[config]" }),
      symbol({ name: "parse-config-body", qualified_name: "example.core/parse-config-body", signature: "[config body]" })
    ], [symbol({ name: "parse-config", qualified_name: "example.core/parse-config", signature: "[config]" })], { ambiguityDelta: 0.02 });
    expect(merge.transitions).toHaveLength(2);
    expect(merge.transitions.every((transition) => transition.kind === "merge")).toBe(true);
  });

  test("does not promote competing candidates to lineage facts", () => {
    const previous = symbol();
    const current = [
      symbol({ name: "parse-options", qualified_name: "example.core/parse-options" }),
      symbol({ name: "parse-settings", qualified_name: "example.core/parse-settings" })
    ];
    const result = matchLineage([previous], current);
    expect(fuzzyCandidates([previous], current).every((candidate) => candidate.resolution === "candidate")).toBe(true);
    expect(result.transitions).toHaveLength(0);
    expect(result.unmatchedPrevious).toHaveLength(1);
    expect(result.unmatchedCurrent).toHaveLength(2);
  });

  test("persists accepted transitions and ambiguous candidates separately", async () => {
    const root = await mkdtemp("/tmp/code-historian-fuzzy-persistence-");
    const db = await openDatabase(join(root, "index.sqlite"));
    try {
      db.query("INSERT INTO repositories(path) VALUES (?)").run("fixture");
      const repositoryId = db.query("SELECT id FROM repositories WHERE path = 'fixture'").get().id;
      const previous = symbol();
      const moved = symbol({ name: "parse-options", qualified_name: "example.options/parse-options", structural_hash: "shape-2", content: "parse options load" });
      insertSymbol(db, repositoryId, "parent", previous);
      insertSymbol(db, repositoryId, "child", moved);
      const accepted = persistFuzzyLineage(db, { repositoryId, commitOid: "child", previous: [{ ...previous, revision_id: revisionId(logicalSymbolId(repositoryId, previous), previous) }], current: [moved] });
      expect(accepted.transitionCount).toBe(1);
      expect(db.query("SELECT kind, confidence FROM transitions WHERE commit_oid = 'child'").get().kind).toBe("moved");

      const options = [
        symbol({ name: "parse-options", qualified_name: "example.options/parse-options", structural_hash: "shape-options" }),
        symbol({ name: "parse-settings", qualified_name: "example.settings/parse-settings", structural_hash: "shape-settings" })
      ];
      for (const value of options) insertSymbol(db, repositoryId, "ambiguous", value);
      const ambiguous = persistFuzzyLineage(db, {
        repositoryId,
        commitOid: "ambiguous",
        previous: [{ ...previous, revision_id: revisionId(logicalSymbolId(repositoryId, previous), previous) }],
        current: options
      });
      expect(ambiguous.transitionCount).toBe(0);
      expect(db.query("SELECT COUNT(*) AS count FROM lineage_candidates WHERE commit_oid = 'ambiguous'").get().count).toBe(2);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
