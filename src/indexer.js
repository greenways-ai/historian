import { resolve } from "node:path";
import { changedPaths, commitMetadata, GitObjectReader, walkCommits } from "./git.js";
import { openDatabase, writeCheckpoint } from "./storage.js";
import { AnalyzerPool } from "./analyzer-pool.js";
import { createAnalysisPersister } from "./analysis-persistence.js";
import { createCommitDocumentWriter } from "./search.js";

export async function indexRepository({ repository = ".", refs = ["HEAD"], databasePath = ".greenways-historian/index.sqlite", analyzers = {}, analyzerConfig = {}, analyzerConcurrency = 1 } = {}) {
  const root = resolve(repository);
  const db = await openDatabase(databasePath);
  db.query("INSERT OR IGNORE INTO repositories(path) VALUES (?)").run(root);
  const repositoryId = db.query("SELECT id FROM repositories WHERE path = ?").get(root).id;
  const checkpoint = db.query("SELECT last_commit_oid FROM index_checkpoints WHERE repository_id = ? AND ref_name = ?").get(repositoryId, refs[0]);
  let afterCheckpoint = !checkpoint?.last_commit_oid;
  const persist = createAnalysisPersister(db);
  const writeCommitDocument = createCommitDocumentWriter(db);
  const pool = new AnalyzerPool({ commands: analyzers, config: analyzerConfig, concurrency: analyzerConcurrency });
  const memoryMonitor = setInterval(() => pool.observeMemory(), 1000);
  const objects = new GitObjectReader(root);
  let commits = 0;
  let analysisErrors = 0;
  try {
    for await (const commit of walkCommits(root, refs)) {
      if (!afterCheckpoint) {
        if (commit.oid === checkpoint.last_commit_oid) afterCheckpoint = true;
        continue;
      }
      const metadata = await commitMetadata(root, commit.oid);
      const changesByParent = await Promise.all((commit.parents.length ? commit.parents : [null]).map(async (parentOid) => ({
        parentOid,
        changes: await changedPaths(root, commit.oid, parentOid)
      })));
      const analysisJobs = [];
      for (const { changes } of changesByParent) {
        for (const change of changes) {
          if (!change.newBlobOid || change.newBlobOid === "0000000000000000000000000000000000000000" || change.newMode === "160000") continue;
          const source = new TextDecoder().decode((await objects.read(change.newBlobOid)).bytes);
          const lowerPath = change.path.toLowerCase();
          const extension = `.${lowerPath.split(".").at(-1)}`;
          const language = lowerPath.endsWith(".d.ts") || [".ts", ".tsx"].includes(extension)
            ? "typescript"
            : [".js", ".jsx", ".mjs", ".cjs"].includes(extension)
              ? "javascript"
              : extension === ".cljs"
                ? "clojurescript"
                : [".clj", ".cljc", ".bb"].includes(extension)
                  ? "clojure"
                  : null;
          if (!language) continue;
          analysisJobs.push({ path: change.newPath ?? change.path, language, blobOid: change.newBlobOid, source });
        }
      }
      const responses = await Promise.all(analysisJobs.map(async (job) => ({
        path: job.path,
        blobOid: job.blobOid,
        language: job.language,
        response: await pool.analyze({ language: job.language, path: job.path, blob_oid: job.blobOid, source: job.source })
      })));
      const analysisFailures = [];
      const analyses = responses.flatMap((item) => {
        if (item.response.result?.file && Array.isArray(item.response.result.symbols) && Array.isArray(item.response.result.references)) {
          return [{ path: item.path, analysis: item.response.result }];
        }
        analysisErrors += 1;
        analysisFailures.push({ path: item.path, blobOid: item.blobOid, language: item.language, error: item.response.error ?? item.response });
        return [];
      });
      writeCheckpoint(db, {
        repositoryId,
        refName: refs[0],
        lastCommitOid: commit.oid,
        write: () => {
          db.query(`INSERT OR IGNORE INTO commits(repository_id, oid, author_name, author_email, authored_at, committer_name, committer_email, committed_at, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(repositoryId, commit.oid, metadata.authorName, metadata.authorEmail, metadata.authoredAt, metadata.committerName, metadata.committerEmail, metadata.committedAt, metadata.message);
          for (const [parentIndex, parentOid] of (commit.parents.length ? commit.parents : [null]).entries()) {
            db.query("INSERT OR IGNORE INTO direct_parents(repository_id, commit_oid, parent_oid, parent_index) VALUES (?, ?, ?, ?)")
              .run(repositoryId, commit.oid, parentOid, parentIndex);
            const parentChanges = changesByParent[parentIndex]?.changes ?? [];
            for (const change of parentChanges) {
              db.query("INSERT OR IGNORE INTO path_changes(repository_id, commit_oid, old_path, new_path, change_kind, old_blob_oid, new_blob_oid) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .run(repositoryId, commit.oid, change.oldPath ?? change.path, change.newPath ?? change.path, change.status, change.oldBlobOid, change.newBlobOid);
              if (change.newBlobOid && change.newMode !== "160000") {
                db.query("INSERT OR IGNORE INTO blobs(repository_id, oid, byte_count) VALUES (?, ?, ?)").run(repositoryId, change.newBlobOid, 0);
              }
            }
          }
          for (const item of analyses) {
            persist({ repositoryId, commitOid: commit.oid, path: item.path, analysis: item.analysis, analyzerFingerprint: "configured" });
          }
          for (const failure of analysisFailures) {
            db.query(`INSERT OR REPLACE INTO analysis_errors(repository_id, commit_oid, path, blob_oid, language, error_json)
                      VALUES (?, ?, ?, ?, ?, ?)`)
              .run(repositoryId, commit.oid, failure.path, failure.blobOid, failure.language, JSON.stringify(failure.error));
          }
          const changed = changesByParent.flatMap(({ changes }) => changes.map((change) => `${change.status} ${change.oldPath ?? change.path} ${change.newPath ?? change.path}`));
          writeCommitDocument({
            commitOid: commit.oid,
            repositoryId,
            committedAt: metadata.committedAt,
            message: metadata.message,
            content: [metadata.message, ...changed].join(" ")
          });
        }
      });
      commits += 1;
    }
  } finally {
    clearInterval(memoryMonitor);
    pool.observeMemory();
    await objects.close();
    await pool.close();
    db.close();
  }
  return { repository: root, refs, commits, analysisErrors, memory: pool.memoryStats() };
}

export async function updateRepository(options) {
  return indexRepository(options);
}

export async function gcDatabase(databasePath = ".greenways-historian/index.sqlite") {
  const db = await openDatabase(databasePath);
  try { db.exec("VACUUM"); return { ok: true }; }
  finally { db.close(); }
}
