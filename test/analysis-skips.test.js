import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { indexRepository } from "../src/indexer.js";
import { openDatabase } from "../src/storage.js";

function git(root, ...args) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

describe("analysis skip persistence", () => {
  test("records generated, vendored, unsupported, and oversized inputs", async () => {
    const root = await mkdtemp("/tmp/historian-analysis-skips-");
    const databasePath = join(root, ".greenways-historian", "index.sqlite");
    try {
      git(root, "init", "-q");
      git(root, "config", "user.name", "fixture");
      git(root, "config", "user.email", "fixture@example.test");
      await mkdir(join(root, "generated"), { recursive: true });
      await mkdir(join(root, "vendor"), { recursive: true });
      await writeFile(join(root, "generated", "bundle.js"), "generated\n");
      await writeFile(join(root, "vendor", "library.ts"), "export const library = true;\n");
      await writeFile(join(root, "README.md"), "documentation\n");
      await writeFile(join(root, "huge.clj"), "x".repeat(10 * 1024 * 1024 + 1));
      git(root, "add", ".");
      git(root, "add", "-f", "vendor/library.ts");
      git(root, "commit", "-qm", "skip fixture");
      const result = await indexRepository({
        repository: root,
        databasePath,
        analyzers: { clojure: { command: ["bb", "-cp", resolve("analyzers/clojure/src"), "-m", "greenways-historian.analyzer"] } }
      });
      expect(result.analysisErrors).toBe(0);
      expect(result.analysisSkipReasons).toEqual({ generated: 1, vendored: 1, "unsupported-language": 1, oversized: 1 });
      expect(result.analysisSkips).toBe(4);
      const db = await openDatabase(databasePath);
      expect(db.query("SELECT COUNT(*) AS count FROM analysis_skips").get().count).toBe(4);
      db.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
