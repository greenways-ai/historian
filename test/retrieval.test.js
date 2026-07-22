import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { createCommitDocumentWriter, createRevisionDocumentWriter } from "../src/search.js";
import { retrieveContext } from "../src/retrieval.js";

describe("lineage-aware retrieval", () => {
  test("returns deduplicated revisions and commit changes with provenance", async () => {
    const root = await mkdtemp("/tmp/code-historian-retrieval-");
    const db = await openDatabase(join(root, "index.sqlite"));
    try {
      db.exec(`INSERT INTO repositories(path) VALUES ('fixture');
        INSERT INTO commits(repository_id, oid, committed_at, message) VALUES (1, 'commit-1', '2026-01-01', 'change parser');
        INSERT INTO logical_symbols(id, repository_id, language, qualified_name, kind) VALUES ('logical-1', 1, 'clojure', 'example/parse', 'function');
        INSERT INTO revisions(id, logical_symbol_id, structural_hash, source_hash, first_commit_oid, last_commit_oid) VALUES ('revision-1', 'logical-1', 'shape', 'source', 'commit-1', 'commit-1');
        INSERT INTO transitions(repository_id, from_revision_id, to_revision_id, commit_oid, kind, confidence, evidence_json) VALUES (1, NULL, 'revision-1', 'commit-1', 'introduced', 1, '{}');
        INSERT INTO path_changes(repository_id, commit_oid, old_path, new_path, change_kind) VALUES (1, 'commit-1', 'old.clj', 'new.clj', 'renamed');`);
      createRevisionDocumentWriter(db)({ revisionId: "revision-1", logicalSymbolId: "logical-1", name: "parse", qualifiedName: "example/parse", kind: "function", language: "clojure", path: "new.clj", firstCommitOid: "commit-1", lastCommitOid: "commit-1", content: "parse parser" });
      createCommitDocumentWriter(db)({ commitOid: "commit-1", repositoryId: 1, committedAt: "2026-01-01", message: "change parser", content: "change parser old.clj new.clj" });
      const result = retrieveContext(db, "parser");
      expect(result.counts).toEqual({ symbol_revisions: 1, commit_changes: 1 });
      expect(result.documents.map((document) => document.type)).toEqual(["symbol_revision", "commit_change"]);
      expect(result.documents[0].provenance.source).toBe("sqlite.revision_search");
      expect(result.documents[0].provenance.lineage.transitions[0].kind).toBe("introduced");
      expect(result.documents[1].changes[0].new_path).toBe("new.clj");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
