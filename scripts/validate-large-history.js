import { access, stat } from "node:fs/promises";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve, join } from "node:path";
import { indexRepository } from "../src/indexer.js";
import { openDatabase } from "../src/storage.js";

const repository = resolve(process.argv[2] ?? "/tmp/code-historian-large-fixture");
const databasePath = resolve(process.argv[3] ?? join(repository, ".greenways-historian", "index.sqlite"));
const commitCount = Number(process.argv[4] ?? process.env.HISTORIAN_FIXTURE_COMMITS ?? 10_000);
const maxRssKb = Number(process.env.HISTORIAN_MAX_RSS_KB ?? 512_000);
const generator = resolve("benchmarks/generate-history-fast.js");

await access(join(repository, ".git")).catch(() => {
  execFileSync("bun", [generator, repository, String(commitCount)], { stdio: "inherit" });
});

const analyzer = { clojure: { command: ["bb", "-cp", resolve("analyzers/clojure/src"), "-m", "greenways-historian.analyzer"] } };
const started = performance.now();
const first = await indexRepository({ repository, databasePath, analyzers: analyzer, analyzerConcurrency: 2 });
const initialElapsedMs = Math.round(performance.now() - started);
const updateStarted = performance.now();
const update = await indexRepository({ repository, databasePath, analyzers: analyzer, analyzerConcurrency: 2 });
const updateElapsedMs = Math.round(performance.now() - updateStarted);
const db = await openDatabase(databasePath);
try {
  const counts = Object.fromEntries([
    ["commits", "SELECT COUNT(*) AS count FROM commits"],
    ["path_changes", "SELECT COUNT(*) AS count FROM path_changes"],
    ["revisions", "SELECT COUNT(*) AS count FROM revisions"],
    ["structures", "SELECT COUNT(*) AS count FROM revision_structures"],
    ["revision_documents", "SELECT COUNT(*) AS count FROM revision_documents"],
    ["commit_documents", "SELECT COUNT(*) AS count FROM commit_documents"],
    ["analyzer_runs", "SELECT COUNT(*) AS count FROM analyzer_runs"],
    ["distinct_blobs", "SELECT COUNT(DISTINCT blob_oid) AS count FROM analyzer_runs"],
    ["file_analyses", "SELECT COUNT(*) AS count FROM file_analyses"],
    ["lineage_candidates", "SELECT COUNT(*) AS count FROM lineage_candidates"],
    ["checkpoints", "SELECT COUNT(*) AS count FROM index_checkpoints"]
  ].map(([name, query]) => [name, db.query(query).get().count]));
  const databaseBytes = await stat(databasePath).then((value) => value.size);
  const walBytes = await stat(`${databasePath}-wal`).then((value) => value.size).catch(() => 0);
  const cacheReuseCount = counts.file_analyses - counts.distinct_blobs;
  if (counts.commits < commitCount) throw new Error(`expected at least ${commitCount} commits, found ${counts.commits}`);
  if (counts.commit_documents !== counts.commits || counts.checkpoints < 1) throw new Error(`incomplete index: ${JSON.stringify(counts)}`);
  if (first.analysisErrors > 0 || update.analysisErrors > 0) throw new Error(`analyzer errors: ${JSON.stringify({ first, update })}`);
  if (cacheReuseCount < 1) throw new Error(`duplicate blob reuse was not observed: ${JSON.stringify(counts)}`);
  if (first.memory.peakRssKb > maxRssKb) throw new Error(`process-tree RSS exceeded ${maxRssKb} KB: ${first.memory.peakRssKb} KB`);
  console.log(JSON.stringify({
    repository,
    databasePath,
    requestedCommits: commitCount,
    counts: { ...counts, cacheReuseCount },
    initialElapsedMs,
    updateElapsedMs,
    result: { first, update },
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      bun: process.versions.bun,
      sqliteBytes: databaseBytes,
      walBytes
    }
  }, null, 2));
} finally {
  db.close();
}
