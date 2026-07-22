import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changedPaths, commitMetadata, repositoryObjectFormat, walkCommits } from "../src/git.js";

function git(root, ...args) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function fixture(format = null) {
  const root = await mkdtemp("/tmp/historian-git-");
  git(root, ...(format ? ["init", "-q", `--object-format=${format}`] : ["init", "-q"]));
  git(root, "config", "user.name", "fixture");
  git(root, "config", "user.email", "fixture@example.test");
  return root;
}

describe("Git traversal", () => {
  test("streams parent-before-child commits and records renames", async () => {
    const root = await fixture();
    try {
      await writeFile(join(root, "old.js"), "export const value = 1;\n");
      git(root, "add", "old.js");
      git(root, "commit", "-qm", "initial");
      const first = git(root, "rev-parse", "HEAD");
      git(root, "mv", "old.js", "new.js");
      git(root, "commit", "-qm", "rename");
      const second = git(root, "rev-parse", "HEAD");
      const commits = [];
      for await (const commit of walkCommits(root, ["HEAD"])) commits.push(commit.oid);
      expect(commits).toEqual([first, second]);
      expect(await repositoryObjectFormat(root)).toBe("sha1");
      const metadata = await commitMetadata(root, second);
      const changes = await changedPaths(root, second, metadata.parents[0]);
      expect(changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "R", path: "old.js", newPath: "new.js" })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves SHA-256 repository format", async () => {
    const root = await fixture("sha256");
    try {
      await writeFile(join(root, "value.ts"), "export const value = 1;\n");
      git(root, "add", "value.ts");
      git(root, "commit", "-qm", "sha256");
      expect(await repositoryObjectFormat(root)).toBe("sha256");
      const commits = [];
      for await (const commit of walkCommits(root, ["HEAD"])) commits.push(commit);
      expect(commits).toHaveLength(1);
      expect(commits[0].oid).toHaveLength(64);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves merge parents and empty commits", async () => {
    const root = await fixture();
    try {
      const baseBranch = git(root, "branch", "--show-current");
      await writeFile(join(root, "base.js"), "export const base = true;\n");
      git(root, "add", "base.js");
      git(root, "commit", "-qm", "base");
      git(root, "switch", "-q", "-c", "feature");
      await writeFile(join(root, "feature.ts"), "export const feature = true;\n");
      git(root, "add", "feature.ts");
      git(root, "commit", "-qm", "feature");
      git(root, "switch", "-q", baseBranch);
      await writeFile(join(root, "main.ts"), "export const main = true;\n");
      git(root, "add", "main.ts");
      git(root, "commit", "-qm", "main");
      git(root, "merge", "--no-ff", "-q", "feature", "-m", "merge");
      const mergeOid = git(root, "rev-parse", "HEAD");
      git(root, "commit", "--allow-empty", "-qm", "empty");
      const commits = [];
      for await (const commit of walkCommits(root, ["HEAD"])) commits.push(commit);
      const merge = commits.find((commit) => commit.oid === mergeOid);
      expect(merge.parents).toHaveLength(2);
      expect(commits.at(-1).parents).toHaveLength(1);
      expect((await commitMetadata(root, mergeOid)).parents).toEqual(merge.parents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects shallow history before indexing an incomplete ancestry", async () => {
    const source = await fixture();
    const shallow = await mkdtemp("/tmp/historian-shallow-");
    try {
      await writeFile(join(source, "value.js"), "export const value = 1;\n");
      git(source, "add", "value.js");
      git(source, "commit", "-qm", "source");
      Bun.spawnSync(["git", "clone", "--quiet", "--no-local", "--depth", "1", source, shallow], { stdout: "pipe", stderr: "pipe" });
      await expect((async () => {
        const commits = [];
        for await (const commit of walkCommits(shallow, ["HEAD"])) commits.push(commit);
      })()).rejects.toThrow("shallow");
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(shallow, { recursive: true, force: true });
    }
  });

  test("surfaces missing revision errors from Git", async () => {
    const root = await fixture();
    try {
      await expect((async () => {
        const commits = [];
        for await (const commit of walkCommits(root, ["missing-revision"])) commits.push(commit);
      })()).rejects.toThrow("unknown revision");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
