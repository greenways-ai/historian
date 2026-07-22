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

export async function repairAnalysisGaps({ repository = ".", databasePath = ".code-historian/index.sqlite", analyzers = {}, analyzerConfig = {}, analyzerConcurrency = 2 } = {}) {
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
  const persist = createAnalysisPersister(db);
  const objects = new GitObjectReader(root);
  let repaired = 0;
  let errors = 0;
  try {
    for (const gap of gaps) {
      const language = languageForPath(gap.path);
      if (!language) continue;
      const source = new TextDecoder().decode((await objects.read(gap.blob_oid)).bytes);
      const response = await pool.analyze({ language, path: gap.path, blob_oid: gap.blob_oid, source });
      db.exec("BEGIN IMMEDIATE");
      try {
        if (response.result?.file && Array.isArray(response.result.symbols) && Array.isArray(response.result.references)) {
          persist({ repositoryId, commitOid: gap.commit_oid, path: gap.path, analysis: response.result, analyzerFingerprint: "repair" });
          repaired += 1;
        } else {
          errors += 1;
          db.query(`INSERT OR REPLACE INTO analysis_errors(repository_id, commit_oid, path, blob_oid, language, error_json)
                    VALUES (?, ?, ?, ?, ?, ?)`)
            .run(repositoryId, gap.commit_oid, gap.path, gap.blob_oid, language, JSON.stringify(response.error ?? response));
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
    db.close();
  }
}
