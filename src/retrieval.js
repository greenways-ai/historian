import { commitSearch, revisionSearch } from "./search.js";

function json(value, fallback) {
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function revisionLineage(db, logicalSymbolId, revisionId, limit) {
  const transitions = db.query(`SELECT t.commit_oid, t.kind, t.confidence, t.from_revision_id, t.to_revision_id,
                                       c.committed_at, c.message
                                FROM transitions t
                                LEFT JOIN commits c ON c.repository_id = t.repository_id AND c.oid = t.commit_oid
                                WHERE t.from_revision_id IN (SELECT id FROM revisions WHERE logical_symbol_id = ?)
                                   OR t.to_revision_id IN (SELECT id FROM revisions WHERE logical_symbol_id = ?)
                                ORDER BY c.committed_at, t.id LIMIT ?`).all(logicalSymbolId, logicalSymbolId, limit);
  const related = db.query(`SELECT revision_id, path, first_commit_oid, last_commit_oid
                            FROM revision_documents WHERE logical_symbol_id = ?
                            ORDER BY first_commit_oid, revision_id LIMIT ?`).all(logicalSymbolId, limit);
  return {
    matched_revision_id: revisionId,
    related_revisions: related,
    transitions: transitions.map((transition) => ({ ...transition, evidence: { lineage: true } }))
  };
}

function revisionDocument(db, revision, lineageLimit) {
  const document = db.query(`SELECT revision_id, logical_symbol_id, qualified_name, kind, language, path,
                                    first_commit_oid, last_commit_oid, content
                             FROM revision_documents WHERE revision_id = ?`).get(revision.revision_id);
  if (!document) return null;
  const locations = db.query(`SELECT commit_oid, path, range_json, selection_range_json
                              FROM locations WHERE revision_id = ? ORDER BY commit_oid, path LIMIT ?`)
    .all(revision.revision_id, lineageLimit)
    .map((location) => ({ ...location, range: json(location.range_json, {}), selection_range: json(location.selection_range_json, {}) }));
  return {
    type: "symbol_revision",
    ...document,
    locations,
    provenance: {
      source: "sqlite.revision_search",
      revision_id: document.revision_id,
      logical_symbol_id: document.logical_symbol_id,
      lineage: revisionLineage(db, document.logical_symbol_id, document.revision_id, lineageLimit)
    }
  };
}

function commitDocument(db, hit) {
  const document = db.query(`SELECT commit_oid, repository_id, committed_at, message, content
                             FROM commit_documents WHERE commit_oid = ?`).get(hit.commit_oid);
  if (!document) return null;
  const changes = db.query(`SELECT old_path, new_path, change_kind, old_blob_oid, new_blob_oid
                            FROM path_changes WHERE repository_id = ? AND commit_oid = ? ORDER BY id`)
    .all(document.repository_id, document.commit_oid);
  return {
    type: "commit_change",
    ...document,
    changes,
    provenance: {
      source: "sqlite.commit_search",
      commit_oid: document.commit_oid,
      repository_id: document.repository_id
    }
  };
}

export function retrieveContext(db, query, { limit = 20, commitLimit = limit, lineageLimit = 20 } = {}) {
  const documents = new Map();
  for (const hit of revisionSearch(db, query, { limit })) {
    const document = revisionDocument(db, hit, lineageLimit);
    if (document) documents.set(`revision:${document.revision_id}`, { ...document, match: { score: hit.score, rank: hit.rank ?? null } });
  }
  for (const hit of commitSearch(db, query, { limit: commitLimit })) {
    const document = commitDocument(db, hit);
    if (document) documents.set(`commit:${document.commit_oid}`, { ...document, match: { score: hit.score } });
  }
  const values = [...documents.values()];
  return {
    query,
    documents: values,
    counts: {
      symbol_revisions: values.filter((document) => document.type === "symbol_revision").length,
      commit_changes: values.filter((document) => document.type === "commit_change").length
    }
  };
}
