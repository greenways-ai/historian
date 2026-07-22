import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { indexRepository } from "../src/indexer.js";
import { openDatabase } from "../src/storage.js";

const repository = resolve(process.argv[2] ?? "/tmp/code-historian-large-fixture");
const databasePath = resolve(process.argv[3] ?? `${repository}/.code-historian/index.sqlite`);
const minimumCommits = Number(process.argv[4] ?? 1);
const analyzer = process.env.CODE_HISTORIAN_ANALYZER ?? "rewrite";
const analyzerModule = analyzer === "kondo" ? "code-historian.kondo-analyzer" : "code-historian.analyzer";

await access(`${repository}/.git`);
const result = await indexRepository({
  repository,
  databasePath,
  analyzers: { clojure: { command: ["bb", "-cp", resolve("analyzers/clojure/src"), "-m", analyzerModule] } },
  analyzerConcurrency: 2
});
const db = await openDatabase(databasePath);
try {
  const counts = Object.fromEntries([
    ["commits", "SELECT COUNT(*) AS count FROM commits"],
    ["path_changes", "SELECT COUNT(*) AS count FROM path_changes"],
    ["revisions", "SELECT COUNT(*) AS count FROM revisions"],
    ["structures", "SELECT COUNT(*) AS count FROM revision_structures"],
    ["revision_documents", "SELECT COUNT(*) AS count FROM revision_documents"],
    ["commit_documents", "SELECT COUNT(*) AS count FROM commit_documents"],
    ["checkpoints", "SELECT COUNT(*) AS count FROM index_checkpoints"]
  ].map(([name, query]) => [name, db.query(query).get().count]));
  if (counts.commits < minimumCommits) throw new Error(`expected at least ${minimumCommits} commits, found ${counts.commits}`);
  if (counts.checkpoints < 1) throw new Error("index checkpoint missing");
  if (counts.commit_documents !== counts.commits) throw new Error("commit documents are not complete");
  if (result.analysisErrors > 0) throw new Error(`analyzer errors: ${result.analysisErrors}`);
  console.log(JSON.stringify({ repository, databasePath, analyzer, result, counts }));
} finally {
  db.close();
}
