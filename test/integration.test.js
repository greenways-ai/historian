import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { indexRepository } from "../src/indexer.js";
import { openDatabase } from "../src/storage.js";
import { lexicalSearch } from "../src/search.js";
import { resolveHistory } from "../src/history.js";
import { retrieveContext } from "../src/retrieval.js";

function git(root, ...args) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

describe("index integration", () => {
  test("indexes Git, analyzer facts, search documents, history, and checkpoints", async () => {
    const root = await mkdtemp("/tmp/code-historian-integration-");
    const databasePath = join(root, ".code-historian", "index.sqlite");
    try {
      git(root, "init", "-q");
      git(root, "config", "user.name", "fixture");
      git(root, "config", "user.email", "fixture@example.test");
      await writeFile(join(root, "core.clj"), "(ns example.core)\n(defn answer [x] (inc x))\n");
      await mkdir(join(root, "generated"), { recursive: true });
      await writeFile(join(root, "generated", "bundle.js"), "generated output\n");
      git(root, "add", "."); git(root, "commit", "-qm", "initial");
      await writeFile(join(root, "core.clj"), "(ns example.core)\n(defn answer [x] (inc (inc x)))\n");
      git(root, "add", "core.clj"); git(root, "commit", "-qm", "change");
      const result = await indexRepository({
        repository: root,
        databasePath,
        analyzers: { clojure: { command: ["bb", "-cp", resolve("analyzers/clojure/src"), "-m", "greenways-historian.analyzer"] } }
      });
      expect(result.commits).toBe(2);
      expect(result.analysisSkips).toBe(1);
      expect(result.analysisSkipReasons.generated).toBe(1);
      await Bun.write(join(root, "core.clj"), "(ns example.core)\n(defn answer [x] (inc (inc x)))\n");
      git(root, "mv", "core.clj", "renamed.clj");
      git(root, "commit", "-qm", "rename unchanged source");
      const update = await indexRepository({
        repository: root,
        databasePath,
        analyzers: { clojure: { command: ["bb", "-cp", resolve("analyzers/clojure/src"), "-m", "greenways-historian.analyzer"] } }
      });
      expect(update.commits).toBe(1);
      expect(update.analysisCacheHits).toBe(1);
      git(root, "rm", "-q", "renamed.clj");
      git(root, "commit", "-qm", "delete source");
      const deletion = await indexRepository({
        repository: root,
        databasePath,
        analyzers: { clojure: { command: ["bb", "-cp", resolve("analyzers/clojure/src"), "-m", "greenways-historian.analyzer"] } }
      });
      expect(deletion.commits).toBe(1);
      await writeFile(join(root, "resurrected.clj"), "(ns example.core)\n(defn answer [x] (inc (inc x)))\n");
      git(root, "add", "resurrected.clj");
      git(root, "commit", "-qm", "resurrect source");
      const resurrection = await indexRepository({
        repository: root,
        databasePath,
        analyzers: { clojure: { command: ["bb", "-cp", resolve("analyzers/clojure/src"), "-m", "greenways-historian.analyzer"] } }
      });
      expect(resurrection.commits).toBe(1);
      const db = await openDatabase(databasePath);
      expect(db.query("SELECT COUNT(*) AS count FROM analyzer_runs").get().count).toBeGreaterThan(0);
      expect(db.query("SELECT reason FROM analysis_skips").get().reason).toBe("generated");
      expect(db.query("SELECT COUNT(*) AS count FROM index_checkpoints").get().count).toBe(1);
      expect(db.query("SELECT COUNT(*) AS count FROM revision_structures").get().count).toBeGreaterThan(0);
      expect(db.query("SELECT COUNT(*) AS count FROM commit_documents").get().count).toBe(5);
      expect(lexicalSearch(db, "answer")[0].qualified_name).toBe("example.core/answer");
      const history = resolveHistory(db, "example.core/answer")[0].transitions;
      expect(history.map((transition) => transition.kind)).toEqual(["introduced", "modified", "moved", "deleted", "resurrected"]);
      expect(retrieveContext(db, "change").documents.some((document) => document.type === "commit_change")).toBe(true);
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
