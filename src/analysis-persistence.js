import { createHash } from "node:crypto";
import { logicalSymbolId, revisionId } from "./lineage.js";
import { createRevisionDocumentWriter, createSearchWriter } from "./search.js";

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function analysisConfigHash(config = {}) { return hash(config); }

function createStatements(db) {
  return {
    insertRun: db.query(`INSERT OR IGNORE INTO analyzer_runs(repository_id, blob_oid, analyzer_fingerprint, config_hash, status) VALUES (?, ?, ?, ?, 'complete')`),
    getRun: db.query("SELECT id FROM analyzer_runs WHERE repository_id = ? AND blob_oid = ? AND analyzer_fingerprint = ? AND config_hash = ?"),
    getFile: db.query("SELECT id FROM file_analyses WHERE analyzer_run_id = ? AND path = ?"),
    insertFile: db.query("INSERT OR IGNORE INTO file_analyses(analyzer_run_id, path, language, result_json) VALUES (?, ?, ?, ?)"),
    getLocation: db.query(`SELECT 1 FROM locations l JOIN revisions r ON r.id = l.revision_id
                           WHERE r.logical_symbol_id = ? AND l.commit_oid = ? AND l.path = ? LIMIT 1`),
    getLocationsForPath: db.query(`SELECT r.id AS revision_id, r.logical_symbol_id
                                   FROM locations l JOIN revisions r ON r.id = l.revision_id
                                   WHERE l.path = ?
                                   GROUP BY r.logical_symbol_id
                                   ORDER BY MAX(l.rowid) DESC`),
    getDeletion: db.query("SELECT 1 FROM transitions WHERE repository_id = ? AND from_revision_id = ? AND commit_oid = ? AND kind = 'deleted' LIMIT 1"),
    getPriorDeletion: db.query("SELECT 1 FROM transitions WHERE from_revision_id = ? AND kind = 'deleted' ORDER BY id DESC LIMIT 1"),
    getPrior: db.query("SELECT r.id, r.structural_hash FROM revisions r WHERE r.logical_symbol_id = ? ORDER BY rowid DESC LIMIT 1"),
    getLatestLocation: db.query("SELECT path FROM locations WHERE revision_id = ? ORDER BY rowid DESC LIMIT 1"),
    insertLogical: db.query("INSERT OR IGNORE INTO logical_symbols(id, repository_id, language, qualified_name, kind) VALUES (?, ?, ?, ?, ?)"),
    insertRevision: db.query("INSERT OR IGNORE INTO revisions(id, logical_symbol_id, structural_hash, source_hash, first_commit_oid, last_commit_oid) VALUES (?, ?, ?, ?, ?, ?)"),
    insertStructure: db.query(`INSERT INTO revision_structures(revision_id, shape_hash, shape_json, node_count, depth, arity, feature_json)
                               VALUES (?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(revision_id) DO UPDATE SET shape_hash = excluded.shape_hash,
                                 shape_json = excluded.shape_json, node_count = excluded.node_count,
                                 depth = excluded.depth, arity = excluded.arity, feature_json = excluded.feature_json`),
    touchRevision: db.query("UPDATE revisions SET last_commit_oid = ? WHERE id = ?"),
    insertLocation: db.query("INSERT OR REPLACE INTO locations(revision_id, commit_oid, path, range_json, selection_range_json) VALUES (?, ?, ?, ?, ?)"),
    insertTransition: db.query("INSERT INTO transitions(repository_id, from_revision_id, to_revision_id, commit_oid, kind, confidence, evidence_json) VALUES (?, ?, ?, ?, ?, 1, ?)"),
    insertReference: db.query(`INSERT INTO "references"(revision_id, commit_oid, kind, target_text, target_qualified_name, resolution, confidence, range_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  };
}

export function createAnalysisPersister(db) {
  const statements = createStatements(db);
  const searchWriter = createSearchWriter(db);
  const revisionWriter = createRevisionDocumentWriter(db);
  return (options) => persistAnalysis(db, { ...options, statements, searchWriter, revisionWriter });
}

export function persistAnalysis(db, { repositoryId, commitOid, path, analysis, analyzerFingerprint, config = {}, statements = createStatements(db), searchWriter = createSearchWriter(db), revisionWriter = createRevisionDocumentWriter(db) }) {
  const configHash = hash(config);
  statements.insertRun.run(repositoryId, analysis.file.blob_oid, analyzerFingerprint, configHash);
  const run = statements.getRun.get(repositoryId, analysis.file.blob_oid, analyzerFingerprint, configHash);
  const existingFile = statements.getFile.get(run.id, path);
  if (!existingFile) {
    statements.insertFile.run(run.id, path, analysis.file.language, JSON.stringify(analysis));
  }
  const fileAnalysis = statements.getFile.get(run.id, path);
  const firstSymbol = analysis.symbols[0];
  if (!firstSymbol) return { analyzerRunId: run.id, fileAnalysisId: fileAnalysis.id, skipped: true, symbolCount: 0, referenceCount: 0 };
  const firstLogicalId = logicalSymbolId(repositoryId, firstSymbol);
  if (statements.getLocation.get(firstLogicalId, commitOid, path)) {
    return { analyzerRunId: run.id, fileAnalysisId: fileAnalysis.id, skipped: true, symbolCount: 0, referenceCount: 0 };
  }
  for (const symbol of analysis.symbols) {
    const logicalId = logicalSymbolId(repositoryId, symbol);
    const revision = revisionId(logicalId, symbol);
    const prior = statements.getPrior.get(logicalId);
    const priorLocation = prior ? statements.getLatestLocation.get(prior.id) : null;
    statements.insertLogical
      .run(logicalId, repositoryId, analysis.file.language, symbol.qualified_name ?? symbol.name, symbol.kind);
    statements.insertRevision
      .run(revision, logicalId, symbol.structural_hash, symbol.source_hash, commitOid, commitOid);
    const features = symbol.structural_features;
    if (features?.shape_hash) {
      statements.insertStructure.run(revision, features.shape_hash, features.shape ?? "", features.node_count ?? 0,
                                     features.depth ?? 0, features.arity ?? 0, JSON.stringify(features.features ?? []));
    }
    statements.touchRevision.run(commitOid, revision);
    statements.insertLocation
      .run(revision, commitOid, path, JSON.stringify(symbol.range), JSON.stringify(symbol.selection_range));
    revisionWriter({
      revisionId: revision,
      logicalSymbolId: logicalId,
      name: symbol.name,
      qualifiedName: symbol.qualified_name,
      kind: symbol.kind,
      language: analysis.file.language,
      path,
      firstCommitOid: commitOid,
      lastCommitOid: commitOid,
      content: [symbol.name, symbol.signature, JSON.stringify(symbol.structure ?? {})].filter(Boolean).join(" ")
    });
    const transitionKind = !prior
      ? "introduced"
      : statements.getPriorDeletion.get(prior.id)
        ? "resurrected"
      : prior.structural_hash !== symbol.structural_hash
        ? "modified"
        : priorLocation?.path !== path
          ? "moved"
          : "unchanged";
    statements.insertTransition
      .run(repositoryId, prior?.id ?? null, revision, commitOid, transitionKind, JSON.stringify({ exact: true }));
    if (!prior || prior.structural_hash !== symbol.structural_hash || priorLocation?.path !== path) {
      searchWriter({ symbolId: logicalId, name: symbol.name, qualifiedName: symbol.qualified_name, path, language: analysis.file.language, kind: symbol.kind, content: symbol.structure?.normalized ?? symbol.name });
    }
  }
  for (const reference of analysis.references) {
    const owner = analysis.symbols.find((symbol) => symbol.local_id === reference.source_symbol_local_id);
    const ownerId = owner ? revisionId(logicalSymbolId(repositoryId, owner), owner) : null;
    statements.insertReference
      .run(ownerId, commitOid, reference.kind, reference.target_text ?? null, reference.target_qualified_name ?? null, reference.resolution, reference.confidence, JSON.stringify(reference.range));
  }
  return { analyzerRunId: run.id, fileAnalysisId: fileAnalysis.id, symbolCount: analysis.symbols.length, referenceCount: analysis.references.length };
}

export function persistDeletions(db, { repositoryId, commitOid, paths, statements = createStatements(db) }) {
  let deleted = 0;
  for (const path of new Set(paths)) {
    for (const location of statements.getLocationsForPath.all(path)) {
      if (statements.getDeletion.get(repositoryId, location.revision_id, commitOid)) continue;
      statements.insertTransition
        .run(repositoryId, location.revision_id, null, commitOid, "deleted", JSON.stringify({ exact: true, path }));
      deleted += 1;
    }
  }
  return deleted;
}
