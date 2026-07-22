import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const destination = resolve(process.argv[2] ?? "/tmp/historian-typescript-fixture");
const count = Number(process.argv[3] ?? 250);
const git = (...args) => execFileSync("git", ["-C", destination, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const blob = (source) => execFileSync("git", ["-C", destination, "hash-object", "-w", "--stdin"], { input: source, encoding: "utf8" }).trim();

await mkdir(destination, { recursive: true });
if (!await Bun.file(`${destination}/.git/HEAD`).exists()) {
  git("init", "-q");
  git("branch", "-M", "main");
  git("config", "user.name", "Historian Fixture");
  git("config", "user.email", "fixture@example.test");
}

let parent = null;
let existing = 0;
try {
  parent = git("rev-parse", "--verify", "HEAD");
  existing = Number(git("rev-list", "--count", "HEAD"));
} catch {}

let entries = new Map();
for (let index = existing; index < count; index += 1) {
  const bucket = index % 32;
  const tsPath = `module-${bucket}.ts`;
  const jsPath = `module-${bucket}.js`;
  entries.set(tsPath, { mode: "100644", oid: blob(`export interface Record${bucket} { value: number; }\nexport const value${bucket} = (input: Record${bucket}): number => input.value + ${index % 17};\n`) });
  entries.set(jsPath, { mode: "100644", oid: blob(`import { value${bucket} } from './module-${bucket}.ts';\nexport function run${bucket}(value) { return value${bucket}({ value }); }\n`) });
  const treeInput = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([path, item]) => `${item.mode} blob ${item.oid}\t${path}\n`).join("");
  const tree = execFileSync("git", ["-C", destination, "mktree"], { input: treeInput, encoding: "utf8" }).trim();
  const args = ["-C", destination, "commit-tree", tree];
  if (parent) args.push("-p", parent);
  parent = execFileSync("git", args, {
    input: `typescript fixture commit ${index}\n`,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Historian Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Historian Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" }
  }).trim();
  git("update-ref", "refs/heads/main", parent);
}
console.log(JSON.stringify({ destination, commits: Number(git("rev-list", "--count", "HEAD")), files: entries.size }));
