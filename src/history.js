export function symbolHistory(db, symbolId, { limit = 100 } = {}) {
  return db.query(`
    SELECT t.commit_oid, t.kind, t.confidence, t.evidence_json,
           t.from_revision_id, t.to_revision_id,
           c.committed_at, c.message
    FROM transitions t
    LEFT JOIN commits c ON c.repository_id = t.repository_id AND c.oid = t.commit_oid
    WHERE t.from_revision_id IN (SELECT id FROM revisions WHERE logical_symbol_id = ?)
       OR t.to_revision_id IN (SELECT id FROM revisions WHERE logical_symbol_id = ?)
    ORDER BY c.committed_at, t.id
    LIMIT ?
  `).all(symbolId, symbolId, limit).map((row) => ({ ...row, evidence: JSON.parse(row.evidence_json) }));
}

export function resolveHistory(db, query, options = {}) {
  const symbols = db.query(`SELECT id, qualified_name, kind FROM logical_symbols WHERE qualified_name = ? OR qualified_name LIKE ? ORDER BY qualified_name LIMIT ?`)
    .all(query, `${query}%`, options.candidates ?? 20);
  return symbols.map((symbol) => ({ ...symbol, transitions: symbolHistory(db, symbol.id, options) }));
}
