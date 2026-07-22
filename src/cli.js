#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { runAnalyzerConformance } from "./analyzer-conformance.js";
import { openDatabase } from "./storage.js";
import { gcDatabase, indexRepository, updateRepository } from "./indexer.js";
import { ingestAnalysisJsonl } from "./ingest.js";
import { commitSearch, hybridSearch, materializeCommitDocuments, materializeRevisionDocuments, similarSymbolsByName } from "./search.js";
import { EmbeddingAdapter, QdrantClient } from "./embeddings.js";
import { inspectRecovery } from "./recovery.js";
import { resolveHistory } from "./history.js";
import { traceGraph } from "./trace.js";
import { retrieveContext } from "./retrieval.js";

const VERSION = "0.1.0";

async function loadConfiguration(path = "code-historian.json") {
  try { return await Bun.file(path).json(); }
  catch { return {}; }
}

async function commandVersion(command, args = ["--version"]) {
  try {
    const process = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(process.stdout).text();
    const error = await new Response(process.stderr).text();
    const exitCode = await process.exited;
    return { command, ok: exitCode === 0, version: (output || error).trim() };
  } catch (error) {
    return { command, ok: false, error: error.message };
  }
}

async function doctor() {
  const stateDir = resolve(".code-historian");
  const checks = await Promise.all([
    commandVersion("git"),
    commandVersion("bb"),
    fetch("http://127.0.0.1:6333/healthz")
      .then((response) => ({ command: "qdrant", ok: response.ok, version: response.statusText }))
      .catch((error) => ({ command: "qdrant", ok: false, error: error.message }))
  ]);

  const db = new Database(":memory:");
  db.exec("create table health (ok integer not null); insert into health values (1)");
  checks.push({ command: "sqlite", ok: db.query("select ok from health").get().ok === 1, version: "bun:sqlite" });
  db.close();

  try {
    await access(resolve("bb.edn"));
    checks.push({ command: "project", ok: true, version: stateDir });
  } catch {
    checks.push({ command: "project", ok: false, error: "run from the code-historian checkout" });
  }

  for (const check of checks) {
    console.log(`${check.ok ? "ok" : "missing"}\t${check.command}\t${check.version ?? check.error}`);
  }
  return checks.every((check) => check.ok || check.command === "qdrant") ? 0 : 1;
}

function usage() {
  console.log(`code-historian ${VERSION}\n\nUsage:\n  code-historian doctor\n  code-historian analyzer check <command...>\n  code-historian --version\n`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: { version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" } }
});

if (values.version) {
  console.log(VERSION);
} else if (values.help || positionals.length === 0) {
  usage();
} else if (positionals[0] === "doctor" && positionals[1] === "recovery") {
  console.log(JSON.stringify(await inspectRecovery()));
} else if (positionals[0] === "doctor") {
  process.exitCode = await doctor();
} else if (positionals[0] === "analyzer" && positionals[1] === "check") {
  process.exitCode = await runAnalyzerConformance(process.argv.slice(4));
} else if (positionals[0] === "init") {
  const db = await openDatabase(positionals[1] ?? ".code-historian/index.sqlite");
  db.close();
  console.log(JSON.stringify({ ok: true, database: positionals[1] ?? ".code-historian/index.sqlite" }));
} else if (positionals[0] === "ingest") {
  console.log(JSON.stringify(await ingestAnalysisJsonl({
    inputPath: positionals[1],
    repository: positionals[2] ?? ".",
    databasePath: positionals[3] ?? ".code-historian/index.sqlite"
  })));
} else if (["index", "update"].includes(positionals[0])) {
  const operation = positionals[0] === "index" ? indexRepository : updateRepository;
  const configuration = await loadConfiguration();
  process.exitCode = 0;
  console.log(JSON.stringify(await operation({
    repository: positionals[1] ?? ".",
    refs: ["HEAD"],
    analyzers: configuration.analyzers ?? {},
    analyzerConfig: configuration.analyzerConfig ?? {}
  })));
} else if (positionals[0] === "gc") {
  console.log(JSON.stringify(await gcDatabase()));
} else if (positionals[0] === "search") {
  const db = await openDatabase();
  const configuration = await loadConfiguration();
  const embedding = configuration.embedding ?? {};
  const adapter = embedding.baseUrl || embedding.model
    ? new EmbeddingAdapter({ baseUrl: embedding.baseUrl, model: embedding.model, dimensions: embedding.dimensions, apiKey: embedding.apiKeyEnv ? process.env[embedding.apiKeyEnv] : undefined })
    : null;
  const qdrant = configuration.qdrant?.url ? new QdrantClient({ url: configuration.qdrant.url }) : null;
  try { console.log(JSON.stringify(await hybridSearch(db, positionals.slice(1).join(" "), { embeddingAdapter: adapter, qdrant }))); }
  finally { db.close(); }
} else if (positionals[0] === "similar") {
  const db = await openDatabase();
  try { console.log(JSON.stringify(similarSymbolsByName(db, positionals.slice(1).join(" ")))); }
  finally { db.close(); }
} else if (positionals[0] === "changes") {
  const db = await openDatabase();
  try { console.log(JSON.stringify(commitSearch(db, positionals.slice(1).join(" ")))); }
  finally { db.close(); }
} else if (positionals[0] === "retrieve") {
  const db = await openDatabase();
  try { console.log(JSON.stringify(retrieveContext(db, positionals.slice(1).join(" ")))); }
  finally { db.close(); }
} else if (positionals[0] === "materialize" && positionals[1] === "revisions") {
  const db = await openDatabase(positionals[2] ?? ".code-historian/index.sqlite");
  try { console.log(JSON.stringify(materializeRevisionDocuments(db))); }
  finally { db.close(); }
} else if (positionals[0] === "materialize" && positionals[1] === "commits") {
  const db = await openDatabase(positionals[2] ?? ".code-historian/index.sqlite");
  try { console.log(JSON.stringify(materializeCommitDocuments(db))); }
  finally { db.close(); }
} else if (positionals[0] === "history") {
  const db = await openDatabase();
  try { console.log(JSON.stringify(resolveHistory(db, positionals.slice(1).join(" ")))); }
  finally { db.close(); }
} else if (positionals[0] === "trace") {
  const db = await openDatabase();
  try { console.log(JSON.stringify(traceGraph(db, positionals[1]))); }
  finally { db.close(); }
} else {
  console.error(`Unknown command: ${positionals[0]}`);
  usage();
  process.exitCode = 2;
}
