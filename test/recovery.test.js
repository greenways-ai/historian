import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/storage.js";
import { indexRepository } from "../src/indexer.js";
import { inspectRecovery } from "../src/recovery.js";

async function git(root, args) {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function fixtureRepository(prefix) {
  const root = await mkdtemp(prefix);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Historian Test"]);
  await git(root, ["config", "user.email", "historian@example.test"]);
  return root;
}

describe("index recovery", () => {
  test("replays a rewritten ref from its new root without advancing through invented ancestry", async () => {
    const root = await fixtureRepository("/tmp/historian-rewrite-");
    const databasePath = join(root, ".greenways-historian", "index.sqlite");
    try {
      await writeFile(join(root, "old.txt"), "old\n");
      await git(root, ["add", "old.txt"]);
      await git(root, ["commit", "-q", "-m", "old history"]);
      const oldOid = await git(root, ["rev-parse", "HEAD"]);
      await indexRepository({ repository: root, databasePath, refs: ["main"] });

      await git(root, ["checkout", "-q", "--orphan", "rewritten"]);
      await writeFile(join(root, "new.txt"), "new\n");
      await git(root, ["add", "new.txt"]);
      await git(root, ["commit", "-q", "-m", "rewritten history"]);
      await git(root, ["branch", "-M", "main"]);
      const newOid = await git(root, ["rev-parse", "HEAD"]);

      const result = await indexRepository({ repository: root, databasePath, refs: ["main"] });
      expect(result.recoveryMode).toBe("ref-rewritten");
      expect(result.commits).toBe(1);
      const db = await openDatabase(databasePath);
      try {
        expect(db.query("SELECT last_commit_oid FROM index_checkpoints WHERE ref_name = 'main'").get().last_commit_oid).toBe(newOid);
        expect(db.query("SELECT oid FROM commits WHERE oid = ?").get(oldOid).oid).toBe(oldOid);
      } finally { db.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports SQLite and checkpoint state without claiming a corrupted index is consistent", async () => {
    const root = await fixtureRepository("/tmp/historian-recovery-");
    const databasePath = join(root, ".greenways-historian", "index.sqlite");
    const db = await openDatabase(databasePath);
    try {
      db.exec("INSERT INTO repositories(path) VALUES ('" + root.replaceAll("'", "''") + "');");
      db.exec("INSERT INTO index_checkpoints(repository_id, ref_name, last_commit_oid) VALUES (1, 'main', 'missing-commit');");
      db.exec("PRAGMA foreign_keys = OFF; INSERT INTO direct_parents(repository_id, commit_oid, parent_oid, parent_index) VALUES (1, 'orphan-commit', 'missing-parent', 0); PRAGMA foreign_keys = ON;");
    } finally { db.close(); }
    try {
      const result = await inspectRecovery(root, databasePath);
      expect(result.consistent).toBe(false);
      expect(result.checkpoints[0].status).toBe("checkpoint-missing");
      expect(result.sqlite.integrity).toBe("ok");
      expect(result.sqlite.foreign_keys.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not advance a checkpoint when interrupted before the atomic commit and resumes it", async () => {
    const root = await fixtureRepository("/tmp/historian-interrupt-");
    const databasePath = join(root, ".greenways-historian", "index.sqlite");
    try {
      await writeFile(join(root, "one.txt"), "one\n");
      await git(root, ["add", "one.txt"]);
      await git(root, ["commit", "-q", "-m", "one"]);
      await writeFile(join(root, "two.txt"), "two\n");
      await git(root, ["add", "two.txt"]);
      await git(root, ["commit", "-q", "-m", "two"]);
      await expect(indexRepository({
        repository: root,
        databasePath,
        refs: ["main"],
        faultInjector: async () => { throw new Error("injected interruption"); }
      })).rejects.toThrow("injected interruption");
      const interrupted = await openDatabase(databasePath);
      try {
        expect(interrupted.query("SELECT COUNT(*) AS count FROM index_checkpoints").get().count).toBe(0);
        expect(interrupted.query("SELECT status FROM jobs ORDER BY id DESC LIMIT 1").get().status).toBe("running");
      } finally { interrupted.close(); }
      const resumed = await indexRepository({ repository: root, databasePath, refs: ["main"] });
      expect(resumed.commits).toBe(2);
      const complete = await openDatabase(databasePath);
      try {
        expect(complete.query("SELECT COUNT(*) AS count FROM jobs WHERE status = 'completed'").get().count).toBe(2);
        expect(complete.query("SELECT COUNT(*) AS count FROM jobs WHERE status <> 'completed'").get().count).toBe(0);
      } finally { complete.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a failed analyzer batch resumable until a later analyzer succeeds", async () => {
    const root = await fixtureRepository("/tmp/historian-analyzer-failure-");
    const databasePath = join(root, ".greenways-historian", "index.sqlite");
    const marker = join(root, "worker-ready");
    try {
      await writeFile(join(root, "value.clj"), "(def value 1)\n");
      await git(root, ["add", "value.clj"]);
      await git(root, ["commit", "-q", "-m", "value"]);
      await expect(indexRepository({
        repository: root,
        databasePath,
        refs: ["main"],
        analyzers: { clojure: ["bun", resolve("test/fixtures/fail-analyzer.js")] }
      })).rejects.toThrow("analysis batch failed");
      const failed = await openDatabase(databasePath);
      try {
        expect(failed.query("SELECT COUNT(*) AS count FROM index_checkpoints").get().count).toBe(0);
        expect(failed.query("SELECT status FROM jobs ORDER BY id DESC LIMIT 1").get().status).toBe("failed");
      } finally { failed.close(); }
      await writeFile(marker, "ready");
      const resumed = await indexRepository({
        repository: root,
        databasePath,
        refs: ["main"],
        analyzers: { clojure: ["bun", resolve("test/fixtures/retry-analyzer.js"), marker] }
      });
      expect(resumed.commits).toBe(1);
      const complete = await openDatabase(databasePath);
      try {
        expect(complete.query("SELECT status FROM jobs ORDER BY id DESC LIMIT 1").get().status).toBe("completed");
        expect(complete.query("SELECT COUNT(*) AS count FROM analysis_errors").get().count).toBe(0);
      } finally { complete.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resumes an interrupted merge at the merge tip with both parents intact", async () => {
    const root = await fixtureRepository("/tmp/historian-merge-recovery-");
    const databasePath = join(root, ".greenways-historian", "index.sqlite");
    try {
      await writeFile(join(root, "base.txt"), "base\n");
      await git(root, ["add", "base.txt"]);
      await git(root, ["commit", "-q", "-m", "base"]);
      await git(root, ["checkout", "-q", "-b", "side"]);
      await writeFile(join(root, "side.txt"), "side\n");
      await git(root, ["add", "side.txt"]);
      await git(root, ["commit", "-q", "-m", "side"]);
      await git(root, ["checkout", "-q", "main"]);
      await writeFile(join(root, "main.txt"), "main\n");
      await git(root, ["add", "main.txt"]);
      await git(root, ["commit", "-q", "-m", "main"]);
      await git(root, ["merge", "--no-ff", "-q", "side", "-m", "merge"]);
      const mergeOid = await git(root, ["rev-parse", "HEAD"]);
      await expect(indexRepository({
        repository: root,
        databasePath,
        refs: ["main"],
        faultInjector: async ({ commitOid }) => {
          if (commitOid === mergeOid) throw new Error("merge interruption");
        }
      })).rejects.toThrow("merge interruption");
      const interrupted = await openDatabase(databasePath);
      try {
        expect(interrupted.query("SELECT last_commit_oid FROM index_checkpoints WHERE ref_name = 'main'").get().last_commit_oid).not.toBe(mergeOid);
        expect(interrupted.query("SELECT status FROM jobs ORDER BY id DESC LIMIT 1").get().status).toBe("running");
      } finally { interrupted.close(); }
      const resumed = await indexRepository({ repository: root, databasePath, refs: ["main"] });
      expect(resumed.commits).toBe(1);
      const complete = await openDatabase(databasePath);
      try {
        expect(complete.query("SELECT COUNT(*) AS count FROM direct_parents WHERE commit_oid = ?").get(mergeOid).count).toBe(2);
        expect(complete.query("SELECT last_commit_oid FROM index_checkpoints WHERE ref_name = 'main'").get().last_commit_oid).toBe(mergeOid);
      } finally { complete.close(); }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
