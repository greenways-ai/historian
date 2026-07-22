import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase, writeCheckpoint } from "../src/storage.js";

async function temporaryDatabase(name) {
  const directory = join("/tmp", `code-historian-${name}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  return { directory, path: join(directory, "index.sqlite") };
}

describe("SQLite persistence", () => {
  test("applies migrations repeatably and enables WAL", async () => {
    const temporary = await temporaryDatabase("migrations");
    const first = await openDatabase(temporary.path);
    expect(first.query("SELECT journal_mode FROM pragma_journal_mode").get().journal_mode).toBe("wal");
    expect(first.query("SELECT MAX(version) AS version FROM schema_migrations").get().version).toBe(5);
    first.close();
    const second = await openDatabase(temporary.path);
    expect(second.query("SELECT COUNT(*) AS count FROM schema_migrations").get().count).toBe(5);
    expect(second.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'index_checkpoints'").get().name).toBe("index_checkpoints");
    expect(second.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analysis_skips'").get().name).toBe("analysis_skips");
    expect(second.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lineage_candidates'").get().name).toBe("lineage_candidates");
    second.close();
    await rm(temporary.directory, { recursive: true, force: true });
  });

  test("commits facts and checkpoint atomically", async () => {
    const temporary = await temporaryDatabase("checkpoint");
    const db = await openDatabase(temporary.path);
    db.query("INSERT INTO repositories(path) VALUES (?)").run("fixture");
    const repositoryId = db.query("SELECT id FROM repositories WHERE path = 'fixture'").get().id;
    writeCheckpoint(db, { repositoryId, refName: "HEAD", lastCommitOid: "abc", write: () => {
      db.query("INSERT INTO commits(repository_id, oid) VALUES (?, ?)").run(repositoryId, "abc");
    }});
    expect(db.query("SELECT last_commit_oid FROM index_checkpoints").get().last_commit_oid).toBe("abc");
    expect(db.query("SELECT oid FROM commits").get().oid).toBe("abc");
    expect(() => writeCheckpoint(db, { repositoryId, refName: "HEAD", lastCommitOid: "broken", write: () => { throw new Error("rollback"); } })).toThrow("rollback");
    expect(db.query("SELECT last_commit_oid FROM index_checkpoints").get().last_commit_oid).toBe("abc");
    db.close();
    await rm(temporary.directory, { recursive: true, force: true });
  });
});
