import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";

const MIGRATIONS = [
  `
  CREATE TABLE repositories (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    object_format TEXT NOT NULL DEFAULT 'sha1',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE refs (
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    oid TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (repository_id, name)
  );
  CREATE TABLE commits (
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    oid TEXT NOT NULL,
    author_name TEXT,
    author_email TEXT,
    authored_at TEXT,
    committer_name TEXT,
    committer_email TEXT,
    committed_at TEXT,
    message TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (repository_id, oid)
  );
  CREATE TABLE direct_parents (
    repository_id INTEGER NOT NULL,
    commit_oid TEXT NOT NULL,
    parent_oid TEXT NOT NULL,
    parent_index INTEGER NOT NULL,
    PRIMARY KEY (repository_id, commit_oid, parent_oid),
    FOREIGN KEY (repository_id, commit_oid) REFERENCES commits(repository_id, oid) ON DELETE CASCADE
  );
  CREATE TABLE path_changes (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL,
    commit_oid TEXT NOT NULL,
    old_path TEXT,
    new_path TEXT,
    change_kind TEXT NOT NULL,
    old_blob_oid TEXT,
    new_blob_oid TEXT,
    similarity INTEGER,
    UNIQUE (repository_id, commit_oid, old_path, new_path),
    FOREIGN KEY (repository_id, commit_oid) REFERENCES commits(repository_id, oid) ON DELETE CASCADE
  );
  CREATE TABLE blobs (
    repository_id INTEGER NOT NULL,
    oid TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    is_binary INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repository_id, oid)
  );
  CREATE TABLE analyzer_runs (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL,
    blob_oid TEXT NOT NULL,
    analyzer_fingerprint TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (repository_id, blob_oid, analyzer_fingerprint, config_hash)
  );
  CREATE TABLE file_analyses (
    id INTEGER PRIMARY KEY,
    analyzer_run_id INTEGER NOT NULL REFERENCES analyzer_runs(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    language TEXT NOT NULL,
    result_json TEXT NOT NULL,
    UNIQUE (analyzer_run_id, path)
  );
  CREATE TABLE logical_symbols (
    id TEXT PRIMARY KEY,
    repository_id INTEGER NOT NULL,
    language TEXT NOT NULL,
    qualified_name TEXT,
    kind TEXT NOT NULL
  );
  CREATE TABLE revisions (
    id TEXT PRIMARY KEY,
    logical_symbol_id TEXT NOT NULL REFERENCES logical_symbols(id) ON DELETE CASCADE,
    structural_hash TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    first_commit_oid TEXT,
    last_commit_oid TEXT,
    UNIQUE (logical_symbol_id, structural_hash)
  );
  CREATE TABLE locations (
    revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
    commit_oid TEXT NOT NULL,
    path TEXT NOT NULL,
    range_json TEXT NOT NULL,
    selection_range_json TEXT NOT NULL,
    PRIMARY KEY (revision_id, commit_oid, path)
  );
  CREATE TABLE transitions (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL,
    from_revision_id TEXT REFERENCES revisions(id),
    to_revision_id TEXT REFERENCES revisions(id),
    commit_oid TEXT NOT NULL,
    kind TEXT NOT NULL,
    confidence REAL NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "references" (
    id INTEGER PRIMARY KEY,
    revision_id TEXT REFERENCES revisions(id) ON DELETE CASCADE,
    commit_oid TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_text TEXT,
    target_qualified_name TEXT,
    resolution TEXT NOT NULL,
    confidence REAL NOT NULL,
    range_json TEXT NOT NULL
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE index_checkpoints (
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    ref_name TEXT NOT NULL,
    last_commit_oid TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (repository_id, ref_name)
  );
  CREATE INDEX commits_repository_time ON commits(repository_id, committed_at);
  CREATE INDEX transitions_commit ON transitions(repository_id, commit_oid);
  CREATE INDEX references_target ON "references"(target_qualified_name);
  `,
  `
  CREATE TABLE revision_structures (
    revision_id TEXT PRIMARY KEY REFERENCES revisions(id) ON DELETE CASCADE,
    shape_hash TEXT NOT NULL,
    shape_json TEXT NOT NULL,
    node_count INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    arity INTEGER NOT NULL,
    feature_json TEXT NOT NULL
  );
  CREATE INDEX revision_structures_shape ON revision_structures(shape_hash);
  `,
  `
  CREATE TABLE analysis_errors (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    commit_oid TEXT NOT NULL,
    path TEXT NOT NULL,
    blob_oid TEXT NOT NULL,
    language TEXT,
    error_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (repository_id, commit_oid, path, blob_oid)
  );
  CREATE INDEX analysis_errors_blob ON analysis_errors(repository_id, blob_oid);
  `,
  `
  CREATE TABLE analysis_skips (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    commit_oid TEXT NOT NULL,
    path TEXT NOT NULL,
    blob_oid TEXT,
    language TEXT,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (repository_id, commit_oid, path, blob_oid, reason)
  );
  CREATE INDEX analysis_skips_reason ON analysis_skips(repository_id, reason);
  `,
  `
  CREATE TABLE lineage_candidates (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    commit_oid TEXT NOT NULL,
    from_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
    to_revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
    confidence REAL NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (repository_id, commit_oid, from_revision_id, to_revision_id)
  );
  CREATE INDEX lineage_candidates_commit ON lineage_candidates(repository_id, commit_oid);
  `
];

export async function openDatabase(databasePath = ".greenways-historian/index.sqlite") {
  const path = resolve(databasePath);
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -100000; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const current = db.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[index]);
      db.query("INSERT INTO schema_migrations(version) VALUES (?)").run(index + 1);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  return db;
}

export function writeCheckpoint(db, { repositoryId, refName, lastCommitOid, write }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    write();
    db.query(`
      INSERT INTO index_checkpoints(repository_id, ref_name, last_commit_oid, generation)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(repository_id, ref_name) DO UPDATE SET
        last_commit_oid = excluded.last_commit_oid,
        generation = index_checkpoints.generation + 1,
        updated_at = CURRENT_TIMESTAMP
    `).run(repositoryId, refName, lastCommitOid ?? null);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
