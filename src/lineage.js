import { createHash } from "node:crypto";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function logicalSymbolId(repositoryId, symbol) {
  return digest([repositoryId, symbol.kind, symbol.qualified_name ?? symbol.name]);
}

export function revisionId(logicalId, symbol) {
  return digest([logicalId, symbol.structural_hash]);
}

function identityKey(symbol) {
  return [symbol.kind, symbol.qualified_name ?? symbol.name].join("\0");
}

export function exactLineage(repositoryId, previous, current, commitOid) {
  const previousByIdentity = new Map(previous.map((symbol) => [identityKey(symbol), symbol]));
  const transitions = [];
  const revisions = [];
  const seen = new Set();
  for (const symbol of current) {
    const logicalId = logicalSymbolId(repositoryId, symbol);
    const revision = revisionId(logicalId, symbol);
    revisions.push({ id: revision, logicalId, symbol });
    const prior = previousByIdentity.get(identityKey(symbol));
    if (!prior) {
      transitions.push({ kind: "introduced", from: null, to: revision, commitOid, confidence: 1, evidence: { exact: true } });
    } else {
      const priorRevision = revisionId(logicalId, prior);
      seen.add(identityKey(prior));
      if (prior.structural_hash === symbol.structural_hash) {
        transitions.push({ kind: "unchanged", from: priorRevision, to: revision, commitOid, confidence: 1, evidence: { exact: true } });
      } else {
        transitions.push({ kind: "modified", from: priorRevision, to: revision, commitOid, confidence: 1, evidence: { exact: true } });
      }
    }
  }
  for (const prior of previous) {
    if (!seen.has(identityKey(prior)) && !current.some((symbol) => identityKey(symbol) === identityKey(prior))) {
      const logicalId = logicalSymbolId(repositoryId, prior);
      transitions.push({ kind: "deleted", from: revisionId(logicalId, prior), to: null, commitOid, confidence: 1, evidence: { exact: true } });
    }
  }
  return { revisions, transitions };
}
