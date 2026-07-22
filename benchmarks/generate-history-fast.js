import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const destination = resolve(process.argv[2] ?? "/tmp/code-historian-large-fixture");
const count = Number(process.argv[3] ?? 10_000);
const decoder = new TextDecoder();

function git(...args) {
  return execFileSync("git", ["-C", destination, ...args], { encoding: "utf8" }).trim();
}

async function blob(value) {
  return execFileSync("git", ["-C", destination, "hash-object", "-w", "--stdin"], { input: value, encoding: "utf8" }).trim();
}

await mkdir(destination, { recursive: true });
if (!await Bun.file(join(destination, ".git", "HEAD")).exists()) {
  git("init", "-q");
  git("branch", "-M", "main");
  git("config", "user.name", "Code Historian Fixture");
  git("config", "user.email", "fixture@example.test");
}

let entries = new Map();
let head;
try { head = git("rev-parse", "--verify", "HEAD"); }
catch { head = "empty"; }
if (head !== "empty") {
  for (const line of git("ls-tree", "-r", "HEAD").split("\n").filter(Boolean)) {
    const [modeType, path] = line.split("\t");
    const [mode, type, oid] = modeType.split(" ");
    if (type === "blob") entries.set(path, { mode, oid });
  }
} else {
  entries.set("fixture.clj", { mode: "100644", oid: await blob("(ns fixture.core)\n(defn value [x] x)\n") });
}

let parent = head === "empty" ? null : head;
let existing = head === "empty" ? 0 : Number(git("rev-list", "--count", "HEAD"));
for (let index = existing; index < count; index += 1) {
  const bucket = index % 32;
  const path = `fixture-${bucket}.clj`;
  entries.set(path, { mode: "100644", oid: await blob(`(ns fixture.core)\n(defn value-${bucket} [x] (+ x ${index % 97}))\n`) });
  if (index % 500 === 0 && index > 0) {
    const oldPath = `fixture-${(bucket + 31) % 32}.clj`;
    const old = entries.get(oldPath);
    if (old) { entries.delete(oldPath); entries.set(`renamed-${bucket}.clj`, old); }
  }
  if (index % 250 === 0) entries.set("duplicate.clj", entries.get(path));
  const treeInput = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([pathName, item]) => `${item.mode} blob ${item.oid}\t${pathName}\n`).join("");
  const tree = execFileSync("git", ["-C", destination, "mktree"], { input: treeInput, encoding: "utf8" }).trim();
  const commitArgs = ["git", "-C", destination, "commit-tree", tree];
  if (parent) commitArgs.push("-p", parent);
  parent = execFileSync(commitArgs[0], commitArgs.slice(1), { input: `fixture commit ${index}\n`, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Code Historian Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Code Historian Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }).trim();
  git("update-ref", "refs/heads/main", parent);
}
console.log(JSON.stringify({ destination, commits: Number(git("rev-list", "--count", "HEAD")), files: entries.size }));
