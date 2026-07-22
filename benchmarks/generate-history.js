import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const destination = resolve(process.argv[2] ?? "/tmp/code-historian-large-fixture");
const count = Number(process.argv[3] ?? 10_000);

function git(...args) {
  const result = Bun.spawnSync(["git", "-C", destination, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

await mkdir(destination, { recursive: true });
if (!await Bun.file(join(destination, ".git", "HEAD")).exists()) {
  git("init", "-q");
  git("config", "user.name", "Code Historian Fixture");
  git("config", "user.email", "fixture@example.test");
}

const sourcePath = join(destination, "src", "fixture.clj");
await mkdir(join(destination, "src"), { recursive: true });
if (!await Bun.file(sourcePath).exists()) {
  await Bun.write(sourcePath, "(ns fixture.core)\n(defn value [x] x)\n");
  git("add", ".");
  git("commit", "-qm", "fixture root");
}

const existing = Number(git("rev-list", "--count", "HEAD"));
for (let index = existing; index < count; index += 1) {
  const bucket = index % 32;
  const path = join(destination, "src", `fixture-${bucket}.clj`);
  const body = `(ns fixture.core)\n(defn value-${bucket} [x]\n  (+ x ${index % 97}))\n`;
  await Bun.write(path, body);
  if (index > 0 && index % 500 === 0) {
    const oldPath = join(destination, "src", `fixture-${(bucket + 31) % 32}.clj`);
    const renamedPath = join(destination, "src", `renamed-${bucket}.clj`);
    if (await Bun.file(oldPath).exists()) git("mv", oldPath, renamedPath);
  }
  if (index % 250 === 0) await Bun.write(join(destination, "src", "duplicate.clj"), body);
  git("add", "src");
  git("commit", "-qm", `fixture commit ${index}`);
}
console.log(JSON.stringify({ destination, commits: Number(git("rev-list", "--count", "HEAD")), files: Number(git("ls-files", "src").split("\n").filter(Boolean).length) }));
