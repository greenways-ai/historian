import { logicalSymbolId, revisionId } from "./lineage.js";

export function ensureSearchIndex(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS symbol_search USING fts5(symbol_id UNINDEXED, name, qualified_name, path, language, kind, content)`);
}

export function ensureRevisionSearchIndex(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS revision_documents (
    revision_id TEXT PRIMARY KEY,
    logical_symbol_id TEXT NOT NULL,
    qualified_name TEXT,
    kind TEXT NOT NULL,
    language TEXT NOT NULL,
    path TEXT NOT NULL,
    first_commit_oid TEXT,
    last_commit_oid TEXT,
    content TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS revision_search USING fts5(
    revision_id UNINDEXED,
    logical_symbol_id UNINDEXED,
    name,
    qualified_name,
    kind,
    language,
    path,
    content
  );`);
}

export function createRevisionDocumentWriter(db) {
  ensureRevisionSearchIndex(db);
  const getDocument = db.query("SELECT revision_id FROM revision_documents WHERE revision_id = ?");
  const upsertDocument = db.query(`INSERT INTO revision_documents(revision_id, logical_symbol_id, qualified_name, kind, language, path, first_commit_oid, last_commit_oid, content)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                                   ON CONFLICT(revision_id) DO UPDATE SET last_commit_oid = excluded.last_commit_oid, path = excluded.path`);
  const insertSearch = db.query("INSERT INTO revision_search(revision_id, logical_symbol_id, name, qualified_name, kind, language, path, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  return (document) => {
    const exists = getDocument.get(document.revisionId);
    upsertDocument.run(document.revisionId, document.logicalSymbolId, document.qualifiedName ?? "", document.kind ?? "", document.language ?? "", document.path ?? "", document.firstCommitOid ?? null, document.lastCommitOid ?? null, document.content ?? "");
    if (!exists) {
      insertSearch.run(document.revisionId, document.logicalSymbolId, document.name ?? "", document.qualifiedName ?? "", document.kind ?? "", document.language ?? "", document.path ?? "", document.content ?? "");
    }
  };
}

export function revisionSearch(db, query, { limit = 50 } = {}) {
  ensureRevisionSearchIndex(db);
  return db.query(`SELECT revision_id, logical_symbol_id, name, qualified_name, kind, language, path, bm25(revision_search) AS score
                   FROM revision_search WHERE revision_search MATCH ? ORDER BY score LIMIT ?`).all(ftsQuery(query), limit);
}

function ftsQuery(query) {
  const terms = String(query ?? "").match(/[A-Za-z0-9_./:-]+/g) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ") || '""';
}

export function materializeRevisionDocuments(db) {
  const write = createRevisionDocumentWriter(db);
  const revisions = db.query(`SELECT r.id AS revision_id, r.logical_symbol_id, r.first_commit_oid, r.last_commit_oid,
                                     s.qualified_name, s.kind, s.language
                              FROM revisions r JOIN logical_symbols s ON s.id = r.logical_symbol_id`).all();
  const byRevision = new Map(revisions.map((revision) => [revision.revision_id, revision]));
  const analyses = db.query(`SELECT ar.repository_id, fa.path, fa.result_json
                             FROM file_analyses fa JOIN analyzer_runs ar ON ar.id = fa.analyzer_run_id`).all();
  let documents = 0;
  for (const row of analyses) {
    const analysis = JSON.parse(row.result_json);
    for (const symbol of analysis.symbols ?? []) {
      const logicalId = logicalSymbolId(row.repository_id, symbol);
      const revisionIdValue = revisionId(logicalId, symbol);
      const revision = byRevision.get(revisionIdValue);
      if (!revision) continue;
      write({
        revisionId: revision.revision_id,
        logicalSymbolId: revision.logical_symbol_id,
        name: symbol.name,
        qualifiedName: revision.qualified_name,
        kind: revision.kind,
        language: revision.language,
        path: row.path,
        firstCommitOid: revision.first_commit_oid,
        lastCommitOid: revision.last_commit_oid,
        content: [symbol.name, symbol.signature, JSON.stringify(symbol.structure ?? {})].filter(Boolean).join(" ")
      });
      documents += 1;
    }
  }
  return { revisions: revisions.length, documents };
}

export function ensureCommitSearchIndex(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS commit_documents (
    commit_oid TEXT PRIMARY KEY,
    repository_id INTEGER NOT NULL,
    committed_at TEXT,
    message TEXT NOT NULL,
    content TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS commit_search USING fts5(
    commit_oid UNINDEXED,
    repository_id UNINDEXED,
    message,
    content
  );`);
}

export function createCommitDocumentWriter(db) {
  ensureCommitSearchIndex(db);
  const getDocument = db.query("SELECT commit_oid FROM commit_documents WHERE commit_oid = ?");
  const insertDocument = db.query(`INSERT OR IGNORE INTO commit_documents(commit_oid, repository_id, committed_at, message, content)
                                   VALUES (?, ?, ?, ?, ?)`);
  const insertSearch = db.query("INSERT INTO commit_search(commit_oid, repository_id, message, content) VALUES (?, ?, ?, ?)");
  return (document) => {
    const exists = getDocument.get(document.commitOid);
    insertDocument.run(document.commitOid, document.repositoryId, document.committedAt ?? null, document.message ?? "", document.content ?? "");
    if (!exists) insertSearch.run(document.commitOid, document.repositoryId, document.message ?? "", document.content ?? "");
  };
}

export function commitSearch(db, query, { limit = 50 } = {}) {
  ensureCommitSearchIndex(db);
  return db.query(`SELECT commit_oid, repository_id, message, bm25(commit_search) AS score
                   FROM commit_search WHERE commit_search MATCH ? ORDER BY score LIMIT ?`).all(ftsQuery(query), limit);
}

export function materializeCommitDocuments(db) {
  const write = createCommitDocumentWriter(db);
  const commits = db.query("SELECT oid, repository_id, committed_at, message FROM commits ORDER BY committed_at, oid").all();
  const pathChanges = db.query("SELECT commit_oid, change_kind, old_path, new_path FROM path_changes ORDER BY id").all();
  const pathsByCommit = new Map();
  for (const change of pathChanges) {
    const paths = pathsByCommit.get(change.commit_oid) ?? [];
    paths.push(`${change.change_kind} ${change.old_path ?? ""} ${change.new_path ?? ""}`);
    pathsByCommit.set(change.commit_oid, paths);
  }
  const symbolsByCommit = new Map();
  for (const row of db.query(`SELECT t.commit_oid, s.qualified_name
                              FROM transitions t
                              JOIN revisions r ON r.id = COALESCE(t.to_revision_id, t.from_revision_id)
                              JOIN logical_symbols s ON s.id = r.logical_symbol_id
                              WHERE s.qualified_name IS NOT NULL`).all()) {
    const symbols = symbolsByCommit.get(row.commit_oid) ?? [];
    symbols.push(row.qualified_name);
    symbolsByCommit.set(row.commit_oid, symbols);
  }
  for (const commit of commits) {
    write({
      commitOid: commit.oid,
      repositoryId: commit.repository_id,
      committedAt: commit.committed_at,
      message: commit.message,
      content: [commit.message, ...(pathsByCommit.get(commit.oid) ?? []), ...(symbolsByCommit.get(commit.oid) ?? [])].join(" ")
    });
  }
  return { commits: commits.length, documents: commits.length };
}

export function createSearchWriter(db) {
  ensureSearchIndex(db);
  const remove = db.query("DELETE FROM symbol_search WHERE symbol_id = ?");
  const insert = db.query("INSERT INTO symbol_search(symbol_id, name, qualified_name, path, language, kind, content) VALUES (?, ?, ?, ?, ?, ?, ?)");
  return (document) => {
    remove.run(document.symbolId);
    insert.run(document.symbolId, document.name ?? "", document.qualifiedName ?? "", document.path ?? "", document.language ?? "", document.kind ?? "", document.content ?? "");
  };
}

export function indexSearchDocument(db, document, writer = createSearchWriter(db)) {
  writer(document);
}

export function lexicalSearch(db, query, { limit = 50 } = {}) {
  ensureSearchIndex(db);
  return db.query(`SELECT symbol_id, name, qualified_name, path, language, kind, bm25(symbol_search) AS score FROM symbol_search WHERE symbol_search MATCH ? ORDER BY score LIMIT ?`).all(ftsQuery(query), limit)
    .map((row, index) => ({ ...row, rank: index + 1, source: "lexical" }));
}

function tokens(value) {
  return new Set(String(value ?? "").toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function structureForSymbol(db, symbolId) {
  return db.query(`SELECT rs.shape_hash, rs.node_count, rs.depth, rs.arity, rs.feature_json
                   FROM revision_structures rs JOIN revisions r ON r.id = rs.revision_id
                   WHERE r.logical_symbol_id = ? ORDER BY r.rowid DESC LIMIT 1`).get(symbolId);
}

function structuralOverlap(left, right) {
  if (!left || !right) return 0;
  let leftFeatures;
  let rightFeatures;
  try {
    leftFeatures = new Set(JSON.parse(left.feature_json));
    rightFeatures = new Set(JSON.parse(right.feature_json));
  } catch {
    return 0;
  }
  const featureScore = overlap(leftFeatures, rightFeatures);
  const sizeScore = 1 - Math.min(1, Math.abs(left.node_count - right.node_count) / Math.max(left.node_count, right.node_count, 1));
  const depthScore = 1 - Math.min(1, Math.abs(left.depth - right.depth) / Math.max(left.depth, right.depth, 1));
  const arityScore = 1 - Math.min(1, Math.abs(left.arity - right.arity) / Math.max(left.arity, right.arity, 1));
  return 0.65 * featureScore + 0.15 * sizeScore + 0.1 * depthScore + 0.1 * arityScore;
}

export function similarSymbols(db, symbolId, { limit = 20 } = {}) {
  ensureSearchIndex(db);
  const target = db.query("SELECT symbol_id, name, qualified_name, path, language, kind FROM symbol_search WHERE symbol_id = ? LIMIT 1").get(symbolId);
  if (!target) return [];
  const query = [...new Set([...tokens(target.name), ...tokens(target.qualified_name), target.kind].filter(Boolean))].join(" OR ");
  if (!query) return [];
  const nameTokens = tokens(target.name);
  const namespace = String(target.qualified_name ?? "").split("/")[0];
  const targetStructure = structureForSymbol(db, symbolId);
  return lexicalSearch(db, query, { limit: Math.max(limit * 5, 50) })
    .filter((candidate) => candidate.symbol_id !== symbolId)
    .map((candidate) => {
      const nameScore = overlap(nameTokens, tokens(candidate.name));
      const namespaceScore = namespace && namespace === String(candidate.qualified_name ?? "").split("/")[0] ? 1 : 0;
      const kindScore = target.kind && target.kind === candidate.kind ? 1 : 0;
      const lexicalScore = 1 / candidate.rank;
      const structuralScore = structuralOverlap(targetStructure, structureForSymbol(db, candidate.symbol_id));
      return { ...candidate, structural_score: structuralScore,
        similarity: 0.30 * lexicalScore + 0.25 * nameScore + 0.15 * kindScore + 0.05 * namespaceScore + 0.25 * structuralScore };
    })
    .sort((left, right) => right.similarity - left.similarity || left.qualified_name.localeCompare(right.qualified_name))
    .slice(0, limit);
}

export function similarSymbolsByName(db, qualifiedName, options = {}) {
  const symbol = db.query("SELECT id FROM logical_symbols WHERE qualified_name = ? LIMIT 1").get(qualifiedName);
  return symbol ? similarSymbols(db, symbol.id, options) : [];
}

export function reciprocalRankFusion(resultSets, { k = 60, limit = 50 } = {}) {
  const merged = new Map();
  for (const results of resultSets) {
    for (const [index, result] of results.entries()) {
      const current = merged.get(result.symbol_id) ?? { ...result, score: 0, sources: [] };
      current.score += 1 / (k + index + 1);
      current.sources.push(result.source ?? "unknown");
      merged.set(result.symbol_id, current);
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.symbol_id.localeCompare(b.symbol_id)).slice(0, limit);
}

export async function hybridSearch(db, query, { embeddingAdapter, qdrant, collection = "code_current", limit = 50 } = {}) {
  const lexical = lexicalSearch(db, query, { limit }).map((item) => ({ ...item, symbol_id: item.symbol_id, source: "lexical" }));
  if (!embeddingAdapter || !qdrant) return reciprocalRankFusion([lexical], { limit });
  try {
    const [vector] = await embeddingAdapter.embed([query]);
    const dense = (await qdrant.search(collection, vector, { limit })).map((item, index) => ({
      symbol_id: item.payload?.symbol_id ?? String(item.id),
      score: item.score,
      rank: index + 1,
      source: "dense",
      ...item.payload
    }));
    return reciprocalRankFusion([lexical, dense], { limit });
  } catch {
    return reciprocalRankFusion([lexical], { limit });
  }
}
