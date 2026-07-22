import { logicalSymbolId, revisionId } from "./lineage.js";
import { matchLineage } from "./fuzzy-lineage.js";

function idFor(repositoryId, symbol) {
  return symbol.revision_id ?? symbol.revisionId ?? revisionId(logicalSymbolId(repositoryId, symbol), symbol);
}

function transitionKey(db, repositoryId, commitOid, kind, fromRevisionId, toRevisionId) {
  return db.query(`SELECT 1 AS present
                   FROM transitions
                   WHERE repository_id = ? AND commit_oid = ? AND kind = ?
                     AND from_revision_id IS ? AND to_revision_id IS ?
                   LIMIT 1`).get(repositoryId, commitOid, kind, fromRevisionId, toRevisionId);
}

export function persistFuzzyLineage(db, { repositoryId, commitOid, previous, current, options = {} }) {
  const result = matchLineage(previous, current, options);
  const insertTransition = db.query(`INSERT INTO transitions(repository_id, from_revision_id, to_revision_id, commit_oid, kind, confidence, evidence_json)
                                     VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertCandidate = db.query(`INSERT OR IGNORE INTO lineage_candidates(repository_id, commit_oid, from_revision_id, to_revision_id, confidence, evidence_json)
                                    VALUES (?, ?, ?, ?, ?, ?)`);
  let transitionCount = 0;
  let candidateCount = 0;
  for (const transition of result.transitions) {
    const fromRevisionId = idFor(repositoryId, transition.from);
    const toRevisionId = idFor(repositoryId, transition.to);
    if (fromRevisionId === toRevisionId || transitionKey(db, repositoryId, commitOid, transition.kind, fromRevisionId, toRevisionId)) continue;
    insertTransition.run(repositoryId, fromRevisionId, toRevisionId, commitOid, transition.kind, transition.confidence,
      JSON.stringify({ ...transition.evidence, fuzzy: true, resolution: transition.resolution }));
    transitionCount += 1;
  }
  for (const candidate of result.candidates.filter((item) => item.resolution === "candidate")) {
    const fromRevisionId = idFor(repositoryId, candidate.from);
    const toRevisionId = idFor(repositoryId, candidate.to);
    insertCandidate.run(repositoryId, commitOid, fromRevisionId, toRevisionId, candidate.confidence,
      JSON.stringify({ ...candidate.evidence, fuzzy: true, resolution: "candidate", alternatives: candidate.alternatives }));
    candidateCount += 1;
  }
  return { ...result, transitionCount, candidateCount };
}
