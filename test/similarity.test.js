import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { commitSearch, createCommitDocumentWriter, createRevisionDocumentWriter, createSearchWriter, revisionSearch, similarSymbols } from "../src/search.js";

describe("direct symbol similarity", () => {
  test("ranks lexical and metadata-near symbols without generation", async () => {
    const root = await mkdtemp("/tmp/code-historian-similarity-");
    const db = await openDatabase(join(root, "index.sqlite"));
    try {
      const write = createSearchWriter(db);
      write({ symbolId: "target", name: "parse-config", qualifiedName: "example.config/parse-config", path: "config.clj", language: "clojure", kind: "function", content: "parse config map" });
      write({ symbolId: "near", name: "parse-options", qualifiedName: "example.config/parse-options", path: "config.clj", language: "clojure", kind: "function", content: "parse options map" });
      write({ symbolId: "far", name: "render-page", qualifiedName: "example.web/render-page", path: "web.clj", language: "clojure", kind: "function", content: "render html" });
      const results = similarSymbols(db, "target", { limit: 2 });
      expect(results[0].symbol_id).toBe("near");
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stores one revision retrieval document across repeated locations", async () => {
    const root = await mkdtemp("/tmp/code-historian-revision-search-");
    const db = await openDatabase(join(root, "index.sqlite"));
    try {
      const write = createRevisionDocumentWriter(db);
      const document = { revisionId: "revision-1", logicalSymbolId: "logical-1", name: "answer", qualifiedName: "example.core/answer", kind: "function", language: "clojure", path: "core.clj", firstCommitOid: "commit-1", lastCommitOid: "commit-1", content: "answer function" };
      write(document);
      write({ ...document, path: "src/core.clj", lastCommitOid: "commit-2" });
      expect(db.query("SELECT COUNT(*) AS count FROM revision_documents").get().count).toBe(1);
      expect(db.query("SELECT path, last_commit_oid FROM revision_documents WHERE revision_id = ?").get("revision-1")).toEqual({ path: "src/core.clj", last_commit_oid: "commit-2" });
      expect(revisionSearch(db, "answer")[0].revision_id).toBe("revision-1");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("indexes commit change documents independently from symbol revisions", async () => {
    const root = await mkdtemp("/tmp/code-historian-commit-search-");
    const db = await openDatabase(join(root, "index.sqlite"));
    try {
      const write = createCommitDocumentWriter(db);
      write({ commitOid: "commit-1", repositoryId: 1, committedAt: "2026-01-01", message: "rename parser", content: "rename parser src/parser.clj" });
      expect(db.query("SELECT COUNT(*) AS count FROM commit_documents").get().count).toBe(1);
      expect(commitSearch(db, "rename parser")[0].commit_oid).toBe("commit-1");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("adds graded structural overlap to similarity", async () => {
    const root = await mkdtemp("/tmp/code-historian-structural-similarity-");
    const db = await openDatabase(join(root, "index.sqlite"));
    try {
      db.exec(`INSERT INTO logical_symbols(id, repository_id, language, qualified_name, kind) VALUES
        ('target', 1, 'clojure', 'example.core/parse-config', 'function'),
        ('near', 1, 'clojure', 'example.other/parse-options', 'function'),
        ('far', 1, 'clojure', 'example.other/render-page', 'function');
        INSERT INTO revisions(id, logical_symbol_id, structural_hash, source_hash) VALUES
        ('target-rev', 'target', 'target-shape', 'target-source'),
        ('near-rev', 'near', 'near-shape', 'near-source'),
        ('far-rev', 'far', 'far-shape', 'far-source');
        INSERT INTO revision_structures(revision_id, shape_hash, shape_json, node_count, depth, arity, feature_json) VALUES
        ('target-rev', 'target-shape', 'target', 12, 5, 2, '["[:call]","[:special if]","[:number]"]'),
        ('near-rev', 'near-shape', 'near', 13, 5, 2, '["[:call]","[:special if]","[:number]"]'),
        ('far-rev', 'far-shape', 'far', 30, 9, 5, '["[:map]","[:string]","[:vector]"]');`);
      const write = createSearchWriter(db);
      write({ symbolId: "target", name: "parse-config", qualifiedName: "example.core/parse-config", path: "core.clj", language: "clojure", kind: "function", content: "parse config" });
      write({ symbolId: "near", name: "parse-options", qualifiedName: "example.other/parse-options", path: "other.clj", language: "clojure", kind: "function", content: "parse options" });
      write({ symbolId: "far", name: "render-page", qualifiedName: "example.other/render-page", path: "web.clj", language: "clojure", kind: "function", content: "render html" });
      const results = similarSymbols(db, "target", { limit: 2 });
      expect(results[0].symbol_id).toBe("near");
      expect(results[0].structural_score).toBeGreaterThan(0.9);
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
