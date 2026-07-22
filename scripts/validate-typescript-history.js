import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { indexRepository } from "../src/indexer.js";
import { openDatabase } from "../src/storage.js";
import { processTreeMemory } from "../src/process-memory.js";

const providedRepository = Boolean(process.argv[2]);
const repository = resolve(process.argv[2] ?? await mkdtemp("/tmp/historian-typescript-e2e-"));
const databasePath = resolve(process.argv[3] ?? join(repository, ".greenways-historian", "index.sqlite"));
const minimumCommits = Number(process.env.HISTORIAN_MIN_COMMITS ?? (providedRepository ? 1 : 2));
const maxRssKb = Number(process.env.HISTORIAN_MAX_RSS_KB ?? 512000);
const analyzer = ["bun", resolve("analyzers/typescript/src/analyzer.js")];
const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();

if (!providedRepository) {
  git("init", "-q");
  git("config", "user.name", "Historian Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(join(repository, "math.js"), "export const inc = (value) => value + 1;\n");
  await writeFile(join(repository, "model.ts"), "import { inc } from './math.js';\nexport interface User { id: string; }\nexport const greet = (user: User): string => inc(user.id.length).toString();\n");
  git("add", ".");
  git("commit", "-qm", "initial JavaScript and TypeScript history");
  await writeFile(join(repository, "model.ts"), "import { inc } from './math.js';\nexport interface User { id: string; active: boolean; }\nexport const greet = (user: User): string => inc(user.id.length + (user.active ? 1 : 0)).toString();\nexport class Service { run(user: User) { return greet(user); } }\n");
  git("add", ".");
  git("commit", "-qm", "evolve TypeScript symbols");
}

const result = await indexRepository({
  repository,
  databasePath,
  analyzers: { javascript: { command: analyzer }, typescript: { command: analyzer } },
  analyzerConcurrency: 2
});
const db = await openDatabase(databasePath);
try {
  const counts = Object.fromEntries([
    ["commits", "SELECT COUNT(*) AS count FROM commits"],
    ["analyses", "SELECT COUNT(*) AS count FROM file_analyses"],
    ["symbols", "SELECT COUNT(*) AS count FROM logical_symbols"],
    ["structures", "SELECT COUNT(*) AS count FROM revision_structures"],
    ["references", "SELECT COUNT(*) AS count FROM \"references\""],
    ["errors", "SELECT COUNT(*) AS count FROM analysis_errors"],
    ["checkpoints", "SELECT COUNT(*) AS count FROM index_checkpoints"]
  ].map(([name, query]) => [name, db.query(query).get().count]));
  if (counts.commits < minimumCommits) throw new Error(`expected at least ${minimumCommits} commits, found ${counts.commits}`);
  if (counts.analyses < 3 || counts.symbols < 4 || counts.structures < 4 || counts.references < 3) throw new Error(`insufficient TypeScript analysis facts: ${JSON.stringify(counts)}`);
  if (counts.errors !== 0 || counts.checkpoints !== 1 || result.analysisErrors !== 0) throw new Error(`historical indexing incomplete: ${JSON.stringify({ counts, result })}`);
  if (result.memory.peakRssKb > maxRssKb) throw new Error(`process-tree RSS exceeded ${maxRssKb} KB: ${result.memory.peakRssKb} KB`);
  const after = processTreeMemory();
  const lingeringWorkers = after.workers.filter(({ command }) => !command.startsWith("ps "));
  if (lingeringWorkers.length > 0) throw new Error(`analyzer process remained after indexing: ${JSON.stringify({ ...after, lingeringWorkers })}`);
  console.log(JSON.stringify({ repository, databasePath, counts, result, after }));
} finally {
  db.close();
}
