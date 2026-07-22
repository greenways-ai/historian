function tokens(symbol) {
  return new Set(`${symbol.name} ${symbol.qualified_name ?? ""} ${symbol.signature ?? ""}`.split(/[^A-Za-z0-9_!?*-]+/).filter(Boolean));
}

function overlap(left, right) {
  const a = tokens(left); const b = tokens(right);
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

export function scoreCandidate(previous, current) {
  const name = previous.name === current.name ? 0.35 : 0;
  const kind = previous.kind === current.kind ? 0.2 : 0;
  const structure = previous.structural_hash === current.structural_hash ? 0.3 : 0;
  const tokenScore = overlap(previous, current) * 0.15;
  return Number((name + kind + structure + tokenScore).toFixed(6));
}

export function fuzzyCandidates(previous, current, { threshold = 0.45, ambiguityDelta = 0.05 } = {}) {
  const candidates = [];
  for (const from of previous) {
    for (const to of current) {
      const confidence = scoreCandidate(from, to);
      if (confidence >= threshold) candidates.push({ from, to, confidence });
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence || a.from.name.localeCompare(b.from.name) || a.to.name.localeCompare(b.to.name));
  const byFrom = new Map();
  for (const candidate of candidates) {
    const list = byFrom.get(candidate.from) ?? [];
    list.push(candidate);
    byFrom.set(candidate.from, list);
  }
  return candidates.map((candidate) => {
    const alternatives = byFrom.get(candidate.from).filter((other) => other !== candidate);
    const ambiguous = alternatives.some((other) => candidate.confidence - other.confidence < ambiguityDelta);
    return { ...candidate, resolution: ambiguous ? "candidate" : "resolved" };
  });
}

export function fuzzyTransitions(previous, current, commitOid, options) {
  return fuzzyCandidates(previous, current, options).map(({ from, to, confidence, resolution }) => ({
    kind: from.name === to.name ? "modified" : "moved",
    from,
    to,
    commitOid,
    confidence,
    resolution,
    evidence: { token_overlap: overlap(from, to) }
  }));
}
