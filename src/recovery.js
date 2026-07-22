import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { openDatabase } from "./storage.js";

export async function inspectRecovery(repository = ".", databasePath = ".code-historian/index.sqlite") {
  const db = await openDatabase(databasePath);
  try {
    const shallow = await access(resolve(repository, ".git", "shallow")).then(() => true).catch(() => false);
    const checkpoints = db.query(`SELECT c.ref_name, c.last_commit_oid, c.generation, EXISTS(SELECT 1 FROM commits WHERE repository_id = c.repository_id AND oid = c.last_commit_oid) AS commit_present FROM index_checkpoints c`).all();
    return { shallow, checkpoints, consistent: checkpoints.every((checkpoint) => checkpoint.commit_present || checkpoint.last_commit_oid === null) };
  } finally { db.close(); }
}
