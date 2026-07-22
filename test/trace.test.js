import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "../src/storage.js";
import { traceGraph } from "../src/trace.js";

describe("bounded static tracing", () => {
  test("resolves symbol queries with source provenance and explicit terminal uncertainty", async () => {
    const root = await mkdtemp("/tmp/historian-trace-");
    const db = await openDatabase(join(root, "index.sqlite"));
    try {
      db.exec(`
        INSERT INTO repositories(path) VALUES ('fixture');
        INSERT INTO commits(repository_id, oid, committed_at, message) VALUES
          (1, 'commit-1', '2026-01-01', 'trace fixture');
        INSERT INTO logical_symbols(id, repository_id, language, qualified_name, kind) VALUES
          ('logical-start', 1, 'clojure', 'app/start', 'function'),
          ('logical-worker', 1, 'clojure', 'app/worker', 'function'),
          ('logical-sink', 1, 'clojure', 'app/write', 'function');
        INSERT INTO revisions(id, logical_symbol_id, structural_hash, source_hash, first_commit_oid, last_commit_oid) VALUES
          ('revision-start', 'logical-start', 'shape-start', 'source-start', 'commit-1', 'commit-1'),
          ('revision-worker', 'logical-worker', 'shape-worker', 'source-worker', 'commit-1', 'commit-1'),
          ('revision-sink', 'logical-sink', 'shape-sink', 'source-sink', 'commit-1', 'commit-1');
        INSERT INTO locations(revision_id, commit_oid, path, range_json, selection_range_json) VALUES
          ('revision-start', 'commit-1', 'src/start.clj', '{"start":{"line":1}}', '{"start":{"line":1}}'),
          ('revision-worker', 'commit-1', 'src/worker.clj', '{"start":{"line":2}}', '{"start":{"line":2}}'),
          ('revision-sink', 'commit-1', 'src/io.clj', '{"start":{"line":3}}', '{"start":{"line":3}}');
        INSERT INTO "references"(revision_id, commit_oid, kind, target_text, target_qualified_name, resolution, confidence, range_json) VALUES
          ('revision-start', 'commit-1', 'call', 'app/worker', 'app/worker', 'resolved', 1, '{"start":{"line":1}}'),
          ('revision-worker', 'commit-1', 'call', 'app/write', 'app/write', 'resolved', 1, '{"start":{"line":2}}'),
          ('revision-worker', 'commit-1', 'call', 'eval', NULL, 'dynamic', 0.2, '{"start":{"line":4}}'),
          ('revision-worker', 'commit-1', 'call', 'app/start', 'app/start', 'resolved', 0.9, '{"start":{"line":5}}');
      `);
      const result = traceGraph(db, "start", { sinks: ["app/write"], maxDepth: 8, maxPaths: 10 });
      expect(result.starts.map((start) => start.qualified_name)).toEqual(["app/start"]);
      expect(result.paths.map((path) => path.terminal.kind)).toEqual(["sink", "dynamic", "cycle"]);
      const sinkPath = result.paths[0];
      expect(sinkPath.steps[0].source.path).toBe("src/start.clj");
      expect(sinkPath.steps[0].source.commit).toEqual({ oid: "commit-1", committed_at: "2026-01-01", message: "trace fixture" });
      expect(sinkPath.steps[1].target.path).toBe("src/io.clj");
      expect(result.paths[1].steps.at(-1).uncertainty).toEqual({ kind: "dynamic", reason: "the analyzer marked this reference dynamic" });
      expect(result.paths[2].terminal.kind).toBe("cycle");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("honors depth and path limits without traversing unbounded cycles", async () => {
    const root = await mkdtemp("/tmp/historian-trace-limits-");
    const db = await openDatabase(join(root, "index.sqlite"));
    try {
      db.exec(`
        INSERT INTO repositories(path) VALUES ('fixture');
        INSERT INTO commits(repository_id, oid, committed_at) VALUES (1, 'commit-1', '2026-01-01');
        INSERT INTO logical_symbols(id, repository_id, language, qualified_name, kind) VALUES
          ('logical-a', 1, 'typescript', 'a', 'function'), ('logical-b', 1, 'typescript', 'b', 'function');
        INSERT INTO revisions(id, logical_symbol_id, structural_hash, source_hash) VALUES
          ('revision-a', 'logical-a', 'a', 'a'), ('revision-b', 'logical-b', 'b', 'b');
        INSERT INTO locations(revision_id, commit_oid, path, range_json, selection_range_json) VALUES
          ('revision-a', 'commit-1', 'a.ts', '{}', '{}'), ('revision-b', 'commit-1', 'b.ts', '{}', '{}');
        INSERT INTO "references"(revision_id, commit_oid, kind, target_text, target_qualified_name, resolution, confidence, range_json) VALUES
          ('revision-a', 'commit-1', 'call', 'b', 'b', 'resolved', 1, '{}'),
          ('revision-b', 'commit-1', 'call', 'a', 'a', 'resolved', 1, '{}');
      `);
      const result = traceGraph(db, "a", { maxDepth: 1, maxPaths: 1 });
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0].terminal.kind).toBe("max-depth");
      expect(result.truncated).toBe(false);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
