import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ingestAnalysisJsonl } from "../src/ingest.js";
import { openDatabase } from "../src/storage.js";

function git(root, ...args) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

const range = { start_byte: 17, end_byte: 39, start: { line: 2, column: 1 }, end: { line: 2, column: 23 } };

describe("JSONL analysis ingest", () => {
  test("persists normalized facts and is idempotent", async () => {
    const root = await mkdtemp("/tmp/code-historian-ingest-");
    const inputPath = join(root, "analysis.jsonl");
    const databasePath = join(root, ".code-historian", "index.sqlite");
    try {
      git(root, "init", "-q");
      git(root, "config", "user.name", "fixture");
      git(root, "config", "user.email", "fixture@example.test");
      await writeFile(join(root, "core.clj"), "(ns example.core)\n(defn answer [x] (inc x))\n");
      git(root, "add", "core.clj");
      git(root, "commit", "-qm", "fixture");
      const analysis = {
        file: { path: "core.clj", language: "clojure", blob_oid: "blob-fixture", namespace: "example.core", imports: [], source_bytes: 48 },
        symbols: [{ local_id: "answer", kind: "function", name: "answer", qualified_name: "example.core/answer", range, selection_range: range, source_hash: "source", structural_hash: "structure", structure: { normalized: "(defn answer [x] (inc x))" } }],
        references: [{ kind: "call", range, source_symbol_local_id: "answer", target_text: "inc", target_qualified_name: "clojure.core/inc", resolution: "resolved", confidence: 1 }],
        diagnostics: []
      };
      await writeFile(inputPath, `${JSON.stringify({ protocol_version: "1.0", request_id: "core.clj", op: "analyze", result: analysis })}\n`);
      const first = await ingestAnalysisJsonl({ inputPath, repository: root, databasePath });
      const second = await ingestAnalysisJsonl({ inputPath, repository: root, databasePath });
      expect(first.imported).toBe(1);
      expect(first.symbols).toBe(1);
      expect(first.references).toBe(1);
      expect(second.skipped).toBe(1);
      const db = await openDatabase(databasePath);
      expect(db.query("SELECT COUNT(*) AS count FROM file_analyses").get().count).toBe(1);
      expect(db.query("SELECT COUNT(*) AS count FROM logical_symbols").get().count).toBe(1);
      expect(db.query("SELECT COUNT(*) AS count FROM \"references\"").get().count).toBe(1);
      expect(db.query("SELECT COUNT(*) AS count FROM index_checkpoints").get().count).toBe(1);
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
