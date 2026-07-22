import { performance } from "node:perf_hooks";
import { indexRepository } from "../src/indexer.js";

const repository = process.argv[2] ?? ".";
const started = performance.now();
const result = await indexRepository({ repository, databasePath: ".greenways-historian/benchmark.sqlite" });
console.log(JSON.stringify({ repository, commits: result.commits, elapsed_ms: Math.round(performance.now() - started), runtime: process.versions.bun }, null, 2));
