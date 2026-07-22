import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { commitMetadata } from "./git.js";
import { openDatabase } from "./storage.js";
import { createAnalysisPersister } from "./analysis-persistence.js";

function gitRef(repository, ref) {
  const result = Bun.spawnSync(["git", "-C", repository, "rev-parse", ref], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `unable to resolve git ref ${ref}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function repositoryId(db, path) {
  db.query("INSERT OR IGNORE INTO repositories(path) VALUES (?)").run(path);
  return db.query("SELECT id FROM repositories WHERE path = ?").get(path).id;
}

export async function ingestAnalysisJsonl({ inputPath, repository = ".", databasePath = ".code-historian/index.sqlite", ref = "HEAD", commitOid } = {}) {
  if (!inputPath) throw new Error("inputPath is required");
  const root = resolve(repository);
  const oid = commitOid ?? gitRef(root, ref);
  const metadata = await commitMetadata(root, oid);
  const db = await openDatabase(databasePath);
  const persist = createAnalysisPersister(db);
  const counts = { records: 0, imported: 0, skipped: 0, symbols: 0, references: 0, errors: 0 };
  try {
    const id = repositoryId(db, root);
    db.query(`INSERT OR IGNORE INTO commits(repository_id, oid, author_name, author_email, authored_at, committer_name, committer_email, committed_at, message)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, oid, metadata.authorName, metadata.authorEmail, metadata.authoredAt, metadata.committerName, metadata.committerEmail, metadata.committedAt, metadata.message);
    db.query(`INSERT INTO refs(repository_id, name, oid) VALUES (?, ?, ?)
              ON CONFLICT(repository_id, name) DO UPDATE SET oid = excluded.oid, updated_at = CURRENT_TIMESTAMP`)
      .run(id, ref, oid);
    db.exec("BEGIN IMMEDIATE");
    try {
      const lines = createInterface({ input: createReadStream(resolve(inputPath)), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        counts.records += 1;
        const record = JSON.parse(line);
        if (record.error || !record.result) {
          counts.errors += 1;
          continue;
        }
        const result = persist({
          repositoryId: id,
          commitOid: oid,
          path: record.result.file.path,
          analysis: record.result,
          analyzerFingerprint: "clj-kondo-jsonl"
        });
        if (result.skipped) counts.skipped += 1;
        else {
          counts.imported += 1;
          counts.symbols += result.symbolCount;
          counts.references += result.referenceCount;
        }
      }
      db.query(`INSERT INTO index_checkpoints(repository_id, ref_name, last_commit_oid, generation)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(repository_id, ref_name) DO UPDATE SET
                  last_commit_oid = excluded.last_commit_oid,
                  generation = index_checkpoints.generation + 1,
                  updated_at = CURRENT_TIMESTAMP`)
        .run(id, ref, oid);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { repository: root, ref, commitOid: oid, ...counts };
  } finally {
    db.close();
  }
}
