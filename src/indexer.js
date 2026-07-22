import { resolve } from "node:path";
import { changedPaths, commitMetadata, GitObjectReader, repositoryObjectFormat, walkCommits } from "./git.js";
import { openDatabase, writeCheckpoint } from "./storage.js";
import { AnalyzerPool } from "./analyzer-pool.js";
import { analysisConfigHash, createAnalysisPersister, persistDeletions } from "./analysis-persistence.js";
import { persistFuzzyLineage } from "./lineage-persistence.js";
import { createCommitDocumentWriter } from "./search.js";
import { checkpointReachability } from "./recovery.js";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

function languageForPath(path) {
  const lowerPath = path.toLowerCase();
  const extension = `.${lowerPath.split(".").at(-1)}`;
  if (lowerPath.endsWith(".d.ts") || [".ts", ".tsx"].includes(extension)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  if (extension === ".cljs") return "clojurescript";
  if ([".clj", ".cljc", ".bb"].includes(extension)) return "clojure";
  if ([".py", ".pyi", ".pyw"].includes(extension)) return "python";
  return null;
}

function excludedPathReason(path) {
  const segments = path.toLowerCase().split("/");
  if (segments.includes("node_modules") || segments.includes("vendor") || segments.includes("third_party")) return "vendored";
  if (segments.includes("generated") || /\.(generated|gen)\./i.test(path)) return "generated";
  return null;
}

export async function indexRepository({ repository = ".", refs = ["HEAD"], databasePath = ".greenways-historian/index.sqlite", analyzers = {}, analyzerConfig = {}, analyzerConcurrency = 1, faultInjector = null } = {}) {
  const root = resolve(repository);
  const objectFormat = await repositoryObjectFormat(root);
  const db = await openDatabase(databasePath);
  db.query("INSERT OR IGNORE INTO repositories(path, object_format) VALUES (?, ?)").run(root, objectFormat);
  const repositoryId = db.query("SELECT id FROM repositories WHERE path = ?").get(root).id;
  db.query("UPDATE repositories SET object_format = ? WHERE id = ?").run(objectFormat, repositoryId);
  const checkpoint = db.query("SELECT last_commit_oid FROM index_checkpoints WHERE repository_id = ? AND ref_name = ?").get(repositoryId, refs[0]);
  const reachability = checkpoint?.last_commit_oid
    ? await checkpointReachability(root, refs[0], checkpoint.last_commit_oid)
    : null;
  let afterCheckpoint = !checkpoint?.last_commit_oid || reachability?.status === "ref-rewritten";
  const recoveryMode = reachability?.status === "ref-rewritten" ? "ref-rewritten" : null;
  const persist = createAnalysisPersister(db);
  const configHash = analysisConfigHash(analyzerConfig);
  const cachedAnalysisQuery = db.query(`
    SELECT fa.result_json
    FROM analyzer_runs ar
    JOIN file_analyses fa ON fa.analyzer_run_id = ar.id
    WHERE ar.repository_id = ? AND ar.blob_oid = ? AND ar.analyzer_fingerprint = ?
      AND ar.config_hash = ? AND fa.language = ?
    ORDER BY fa.id LIMIT 1
  `);
  const insertSkip = db.query("INSERT OR IGNORE INTO analysis_skips(repository_id, commit_oid, path, blob_oid, language, reason) VALUES (?, ?, ?, ?, ?, ?)");
  const findJob = db.query("SELECT id FROM jobs WHERE repository_id = ? AND kind = 'index-commit' AND payload_json = ? ORDER BY id DESC LIMIT 1");
  const insertJob = db.query("INSERT INTO jobs(repository_id, kind, status, payload_json) VALUES (?, 'index-commit', 'running', ?)");
  const updateJob = db.query("UPDATE jobs SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  const writeCommitDocument = createCommitDocumentWriter(db);
  const pool = new AnalyzerPool({ commands: analyzers, config: analyzerConfig, concurrency: analyzerConcurrency });
  const memoryMonitor = setInterval(() => pool.observeMemory(), 1000);
  const objects = new GitObjectReader(root);
  let commits = 0;
  let analysisErrors = 0;
  let analysisCacheHits = 0;
  let analysisSkips = 0;
  let fuzzyTransitionCount = 0;
  let lineageCandidateCount = 0;
  const analysisSkipReasons = {};
  try {
    for await (const commit of walkCommits(root, refs)) {
      if (!afterCheckpoint) {
        if (commit.oid === checkpoint.last_commit_oid) afterCheckpoint = true;
        continue;
      }
      const metadata = await commitMetadata(root, commit.oid);
      const jobPayload = JSON.stringify({ ref: refs[0], commit_oid: commit.oid });
      const existingJob = findJob.get(repositoryId, jobPayload);
      const jobId = existingJob?.id ?? insertJob.run(repositoryId, jobPayload).lastInsertRowid;
      updateJob.run("running", null, jobId);
      const changesByParent = await Promise.all((commit.parents.length ? commit.parents : [null]).map(async (parentOid) => ({
        parentOid,
        changes: await changedPaths(root, commit.oid, parentOid)
      })));
      const analysisJobs = [];
      const commitSkips = [];
      for (const { changes } of changesByParent) {
        for (const change of changes) {
          if (!change.newBlobOid || change.newBlobOid === "0000000000000000000000000000000000000000" || change.newMode === "160000") continue;
          const analyzedPath = change.newPath ?? change.path;
          const pathReason = excludedPathReason(analyzedPath);
          const language = languageForPath(analyzedPath);
          if (pathReason || !language) {
            commitSkips.push({ path: analyzedPath, blobOid: change.newBlobOid, language, reason: pathReason ?? "unsupported-language" });
            continue;
          }
          const source = new TextDecoder().decode((await objects.read(change.newBlobOid)).bytes);
          if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
            commitSkips.push({ path: analyzedPath, blobOid: change.newBlobOid, language, reason: "oversized" });
            continue;
          }
          let cachedAnalysis = null;
          const cached = cachedAnalysisQuery.get(repositoryId, change.newBlobOid, "configured", configHash, language);
          if (cached) {
            try { cachedAnalysis = JSON.parse(cached.result_json); }
            catch { cachedAnalysis = null; }
          }
          if (cachedAnalysis) analysisCacheHits += 1;
          analysisJobs.push({ path: analyzedPath, language, blobOid: change.newBlobOid, source, cachedAnalysis });
        }
      }
      const responses = await Promise.all(analysisJobs.map(async (job) => ({
        path: job.path,
        blobOid: job.blobOid,
        language: job.language,
        response: job.cachedAnalysis
          ? { result: { ...job.cachedAnalysis, file: { ...job.cachedAnalysis.file, path: job.path } }, cached: true }
          : await pool.analyze({ language: job.language, path: job.path, blob_oid: job.blobOid, source: job.source })
      })));
      const analysisFailures = [];
      let commitAnalysisErrors = 0;
      const analyses = responses.flatMap((item) => {
        if (item.response.skipped) {
          if (item.response.reason === "worker-failed") {
            commitAnalysisErrors += 1;
            analysisErrors += 1;
            analysisFailures.push({ path: item.path, blobOid: item.blobOid, language: item.language, error: item.response });
          } else {
            commitSkips.push({ path: item.path, blobOid: item.blobOid, language: item.language, reason: item.response.reason });
          }
          return [];
        }
        if (item.response.result?.file && Array.isArray(item.response.result.symbols) && Array.isArray(item.response.result.references)) {
          return [{ path: item.path, analysis: item.response.result }];
        }
        commitAnalysisErrors += 1;
        analysisErrors += 1;
        analysisFailures.push({ path: item.path, blobOid: item.blobOid, language: item.language, error: item.response.error ?? item.response });
        return [];
      });
      if (commitAnalysisErrors > 0) {
        updateJob.run("failed", JSON.stringify(analysisFailures), jobId);
        throw new Error(`analysis batch failed for ${commit.oid}`);
      }
      await faultInjector?.({ phase: "before-checkpoint", repository: root, ref: refs[0], commitOid: commit.oid, jobId });
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
            persist({ repositoryId, commitOid: commit.oid, path: item.path, analysis: item.analysis, analyzerFingerprint: "configured", config: analyzerConfig });
          }
          const analysesByPath = new Map(analyses.map((item) => [item.path, item.analysis]));
          for (const { parentOid, changes } of changesByParent) {
            if (!parentOid) continue;
            for (const change of changes) {
              if (!change.oldBlobOid || !change.newBlobOid || change.newMode === "160000") continue;
              const oldPath = change.oldPath ?? change.path;
              const newPath = change.newPath ?? change.path;
              const currentAnalysis = analysesByPath.get(newPath);
              if (!currentAnalysis) continue;
              const previousRows = db.query(`SELECT r.id AS revision_id, s.qualified_name, s.kind, r.structural_hash,
                                                    rs.shape_hash, rs.shape_json, rs.node_count, rs.depth, rs.arity, rs.feature_json
                                             FROM locations l
                                             JOIN revisions r ON r.id = l.revision_id
                                             JOIN logical_symbols s ON s.id = r.logical_symbol_id
                                             LEFT JOIN revision_structures rs ON rs.revision_id = r.id
                                             WHERE s.repository_id = ? AND l.commit_oid = ? AND l.path = ?
                                             ORDER BY l.rowid`).all(repositoryId, parentOid, oldPath);
              if (!previousRows.length) continue;
              const previous = previousRows.map((row) => ({
                ...row,
                name: row.qualified_name?.split("/").at(-1) ?? row.qualified_name,
                structural_features: {
                  shape_hash: row.shape_hash,
                  shape: row.shape_json,
                  node_count: row.node_count,
                  depth: row.depth,
                  arity: row.arity,
                  features: (() => { try { return JSON.parse(row.feature_json ?? "[]"); } catch { return []; } })()
                }
              }));
              const match = persistFuzzyLineage(db, {
                repositoryId,
                commitOid: commit.oid,
                previous,
                current: currentAnalysis.symbols
              });
              fuzzyTransitionCount += match.transitionCount;
              lineageCandidateCount += match.candidateCount;
            }
          }
          for (const failure of analysisFailures) {
            db.query(`INSERT OR REPLACE INTO analysis_errors(repository_id, commit_oid, path, blob_oid, language, error_json)
                      VALUES (?, ?, ?, ?, ?, ?)`)
              .run(repositoryId, commit.oid, failure.path, failure.blobOid, failure.language, JSON.stringify(failure.error));
          }
          for (const skip of commitSkips) {
            insertSkip.run(repositoryId, commit.oid, skip.path, skip.blobOid, skip.language, skip.reason);
            analysisSkips += 1;
            analysisSkipReasons[skip.reason] = (analysisSkipReasons[skip.reason] ?? 0) + 1;
          }
          persistDeletions(db, {
            repositoryId,
            commitOid: commit.oid,
            paths: changesByParent.flatMap(({ changes }) => changes.filter((change) => change.status === "D").map((change) => change.oldPath ?? change.path))
          });
          const changed = changesByParent.flatMap(({ changes }) => changes.map((change) => `${change.status} ${change.oldPath ?? change.path} ${change.newPath ?? change.path}`));
          writeCommitDocument({
            commitOid: commit.oid,
            repositoryId,
            committedAt: metadata.committedAt,
            message: metadata.message,
            content: [metadata.message, ...changed].join(" ")
          });
          updateJob.run("completed", null, jobId);
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
  return { repository: root, refs, commits, analysisErrors, analysisCacheHits, analysisSkips, analysisSkipReasons, fuzzyTransitionCount, lineageCandidateCount, recoveryMode, memory: pool.memoryStats() };
}

export async function updateRepository(options) {
  return indexRepository(options);
}

export async function gcDatabase(databasePath = ".greenways-historian/index.sqlite") {
  const db = await openDatabase(databasePath);
  try { db.exec("VACUUM"); return { ok: true }; }
  finally { db.close(); }
}
