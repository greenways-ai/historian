#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { Database } from "bun:sqlite";

const VERSION = "0.1.0";

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
  console.log(`code-historian ${VERSION}\n\nUsage:\n  code-historian doctor\n  code-historian --version\n`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" } }
});

if (values.version) {
  console.log(VERSION);
} else if (values.help || positionals.length === 0) {
  usage();
} else if (positionals[0] === "doctor") {
  process.exitCode = await doctor();
} else {
  console.error(`Unknown command: ${positionals[0]}`);
  usage();
  process.exitCode = 2;
}

