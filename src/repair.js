import { resolve } from "node:path";
import { GitObjectReader } from "./git.js";
import { openDatabase } from "./storage.js";
import { AnalyzerPool } from "./analyzer-pool.js";
import { createAnalysisPersister } from "./analysis-persistence.js";

function languageForPath(path) {
  const extension = `.${path.split(".").at(-1)}`;
  if (extension === ".cljs") return "clojurescript";
  if ([".clj", ".cljc", ".bb"].includes(extension)) return "clojure";
  return null;
}

export async function repairAnalysisGaps({ repository = ".", databasePath = ".code-historian/index.sqlite", analyzers = {}, fallbackAnalyzers = {}, analyzerConfig = {}, analyzerConcurrency = 2 } = {}) {
  const root = resolve(repository);
  const db = await openDatabase(databasePath);
  const repositoryId = db.query("SELECT id FROM repositories WHERE path = ?").get(root)?.id;
  if (!repositoryId) throw new Error(`repository is not indexed: ${root}`);
  const gaps = db.query(`SELECT DISTINCT pc.repository_id, pc.commit_oid, pc.new_path AS path, pc.new_blob_oid AS blob_oid
                         FROM path_changes pc
                         WHERE pc.repository_id = ?
                           AND pc.new_blob_oid IS NOT NULL
                           AND pc.new_blob_oid <> '0000000000000000000000000000000000000000'
                           AND NOT EXISTS (SELECT 1 FROM analyzer_runs ar WHERE ar.repository_id = pc.repository_id AND ar.blob_oid = pc.new_blob_oid)
                         ORDER BY pc.commit_oid, pc.new_path`).all(repositoryId);
  const pool = new AnalyzerPool({ commands: analyzers, config: analyzerConfig, concurrency: analyzerConcurrency });
  const fallbackPool = Object.keys(fallbackAnalyzers).length
    ? new AnalyzerPool({ commands: fallbackAnalyzers, config: analyzerConfig, concurrency: analyzerConcurrency })
    : null;
  const persist = createAnalysisPersister(db);
  const objects = new GitObjectReader(root);
  let repaired = 0;
  let errors = 0;
  try {
    for (const gap of gaps) {
      const language = languageForPath(gap.path);
      if (!language) continue;
      const source = new TextDecoder().decode((await objects.read(gap.blob_oid)).bytes);
      let response = await pool.analyze({ language, path: gap.path, blob_oid: gap.blob_oid, source });
      let fingerprint = "repair";
      if (!(response.result?.file && Array.isArray(response.result.symbols) && Array.isArray(response.result.references)) && fallbackPool) {
        const fallbackResponse = await fallbackPool.analyze({ language, path: gap.path, blob_oid: gap.blob_oid, source });
        if (fallbackResponse.result?.file && Array.isArray(fallbackResponse.result.symbols) && Array.isArray(fallbackResponse.result.references)) {
          response = fallbackResponse;
          fingerprint = "repair-fallback";
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        if (response.result?.file && Array.isArray(response.result.symbols) && Array.isArray(response.result.references)) {
          persist({ repositoryId, commitOid: gap.commit_oid, path: gap.path, analysis: response.result, analyzerFingerprint: fingerprint });
          repaired += 1;
        } else {
          errors += 1;
          db.query(`INSERT OR REPLACE INTO analysis_errors(repository_id, commit_oid, path, blob_oid, language, error_json)
                    VALUES (?, ?, ?, ?, ?, ?)`)
            .run(repositoryId, gap.commit_oid, gap.path, gap.blob_oid, language, JSON.stringify(response.error ?? response));
          db.query(`INSERT OR IGNORE INTO analyzer_runs(repository_id, blob_oid, analyzer_fingerprint, config_hash, status)
                    VALUES (?, ?, 'repair-error', '{}', 'error')`).run(repositoryId, gap.blob_oid);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return { repository: root, candidates: gaps.length, repaired, errors, memory: pool.observeMemory() };
  } finally {
    await objects.close();
    await pool.close();
    await fallbackPool?.close();
    db.close();
  }
}
