import { resolve } from "node:path";
import { openDatabase } from "./storage.js";

async function runGit(repository, args) {
  const child = Bun.spawn(["git", "-C", repository, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { code: await child.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function checkpointReachability(repository, refName, checkpointOid) {
  const ref = await runGit(repository, ["rev-parse", refName]);
  if (ref.code !== 0) return { refOid: null, reachable: false, status: "ref-missing", error: ref.stderr };
  const ancestry = await runGit(repository, ["merge-base", "--is-ancestor", checkpointOid, ref.stdout]);
  return {
    refOid: ref.stdout,
    reachable: ancestry.code === 0,
    status: ancestry.code === 0 ? "ready" : "ref-rewritten",
    error: ancestry.code === 0 ? null : ancestry.stderr || "checkpoint is not an ancestor of the current ref"
  };
}

export async function inspectRecovery(repository = ".", databasePath = ".greenways-historian/index.sqlite") {
  const db = await openDatabase(databasePath);
  try {
    const root = resolve(repository);
    const shallowState = await runGit(root, ["rev-parse", "--is-shallow-repository"]);
    const shallow = shallowState.code === 0 && shallowState.stdout === "true";
    const checkpoints = db.query(`
      SELECT c.repository_id, r.path AS repository, c.ref_name, c.last_commit_oid, c.generation,
             EXISTS(SELECT 1 FROM commits WHERE repository_id = c.repository_id AND oid = c.last_commit_oid) AS commit_present
      FROM index_checkpoints c
      JOIN repositories r ON r.id = c.repository_id
      WHERE r.path = ?
    `).all(root);
    for (const checkpoint of checkpoints) {
      if (checkpoint.last_commit_oid === null) {
        checkpoint.ref_oid = null;
        checkpoint.reachable = true;
        checkpoint.status = "empty";
      } else {
        const reachability = await checkpointReachability(root, checkpoint.ref_name, checkpoint.last_commit_oid);
        checkpoint.ref_oid = reachability.refOid;
        checkpoint.reachable = reachability.reachable;
        checkpoint.status = !checkpoint.commit_present
          ? "checkpoint-missing"
          : shallow
            ? "blocked-shallow"
            : reachability.status;
        if (reachability.error) checkpoint.error = reachability.error;
      }
    }
    const integrity = db.query("PRAGMA integrity_check").get();
    const foreignKeys = db.query("PRAGMA foreign_key_check").all();
    const repositoryId = db.query("SELECT id FROM repositories WHERE path = ?").get(root)?.id;
    const jobCounts = db.query("SELECT status, COUNT(*) AS count FROM jobs WHERE repository_id = ? GROUP BY status ORDER BY status").all(repositoryId ?? 0);
    const sqliteOk = integrity?.integrity_check === "ok" && foreignKeys.length === 0;
    const checkpointsOk = checkpoints.every((checkpoint) => ["empty", "ready", "ref-rewritten"].includes(checkpoint.status));
    const jobs = Object.fromEntries(jobCounts.map((row) => [row.status, row.count]));
    return { shallow, checkpoints, jobs: { counts: jobs, resume_required: Boolean(jobs.running || jobs.failed) }, sqlite: { integrity: integrity?.integrity_check ?? "unknown", foreign_keys: foreignKeys }, consistent: sqliteOk && checkpointsOk };
  } finally { db.close(); }
}
