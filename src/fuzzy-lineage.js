function asText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(asText).join(" ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function tokens(value) {
  return new Set(asText(value).split(/[^A-Za-z0-9_!?*-]+/).filter(Boolean).map((token) => token.toLowerCase()));
}

function jaccard(left, right) {
  const a = left instanceof Set ? left : tokens(left);
  const b = right instanceof Set ? right : tokens(right);
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function exactOrOverlap(left, right) {
  if (!left && !right) return 0;
  if (left && right && left === right) return 1;
  return jaccard(left, right);
}

function nameScore(previous, current) {
  const left = previous.name ?? previous.qualified_name;
  const right = current.name ?? current.qualified_name;
  if (left && right && left === right) return 1;
  return jaccard(tokens(left), tokens(right));
}

function textScore(previous, current) {
  return jaccard(
    tokens([previous.name, previous.qualified_name, previous.content, previous.structure?.normalized]),
    tokens([current.name, current.qualified_name, current.content, current.structure?.normalized])
  );
}

function signatureScore(previous, current) {
  return exactOrOverlap(previous.signature, current.signature);
}

function referenceValues(symbol) {
  return symbol.references ?? symbol.reference_targets ?? symbol.referenceTargets ?? symbol.outgoing_references ?? [];
}

function pathValues(symbol) {
  return symbol.changed_paths ?? symbol.changedPaths ?? symbol.diff_paths ?? symbol.diffPaths ?? symbol.paths ?? [];
}

function referenceScore(previous, current) {
  return jaccard(tokens(referenceValues(previous)), tokens(referenceValues(current)));
}

function diffScore(previous, current) {
  const left = previous.diff_overlap ?? previous.diffOverlap;
  const right = current.diff_overlap ?? current.diffOverlap;
  if (typeof left === "number" && typeof right === "number") return clamp(1 - Math.abs(left - right));
  return jaccard(tokens(pathValues(previous)), tokens(pathValues(current)));
}

function featureMap(symbol) {
  const features = symbol.structural_features ?? symbol.structuralFeatures ?? symbol.structure ?? {};
  return {
    shape: features.shape_hash ?? features.shapeHash ?? features.shape,
    features: features.features ?? features.feature_list ?? [],
    nodeCount: features.node_count ?? features.nodeCount,
    depth: features.depth,
    arity: features.arity
  };
}

function numericSimilarity(left, right) {
  if (left == null || right == null) return 0;
  return clamp(1 - Math.abs(Number(left) - Number(right)) / Math.max(1, Number(left), Number(right)));
}

function structuralScore(previous, current) {
  if (previous.structural_hash && previous.structural_hash === current.structural_hash) return 1;
  const left = featureMap(previous);
  const right = featureMap(current);
  const shape = left.shape && right.shape && left.shape === right.shape ? 1 : 0;
  const featureOverlap = jaccard(tokens(left.features), tokens(right.features));
  const nodeCount = numericSimilarity(left.nodeCount, right.nodeCount);
  const depth = numericSimilarity(left.depth, right.depth);
  const arity = numericSimilarity(left.arity, right.arity);
  return Number((shape * 0.45 + featureOverlap * 0.3 + nodeCount * 0.1 + depth * 0.1 + arity * 0.05).toFixed(6));
}

const defaultWeights = Object.freeze({
  name: 0.22,
  kind: 0.15,
  structure: 0.28,
  token: 0.12,
  signature: 0.14,
  references: 0.04,
  diff: 0.05
});

export function scoreCandidate(previous, current, { weights = {} } = {}) {
  const evidence = {
    name: nameScore(previous, current),
    kind: previous.kind && current.kind && previous.kind === current.kind ? 1 : 0,
    structure: structuralScore(previous, current),
    token: textScore(previous, current),
    signature: signatureScore(previous, current),
    references: referenceScore(previous, current),
    diff: diffScore(previous, current)
  };
  const applied = { ...defaultWeights, ...weights };
  const totalWeight = Object.values(applied).reduce((sum, value) => sum + value, 0) || 1;
  const confidence = Object.entries(evidence).reduce((sum, [key, value]) => sum + value * (applied[key] ?? 0), 0) / totalWeight;
  return { confidence: Number(confidence.toFixed(6)), evidence };
}

function candidateSort(left, right) {
  return right.confidence - left.confidence
    || (left.from.qualified_name ?? left.from.name).localeCompare(right.from.qualified_name ?? right.from.name)
    || (left.to.qualified_name ?? left.to.name).localeCompare(right.to.qualified_name ?? right.to.name);
}

export function fuzzyCandidates(previous, current, { threshold = 0.45, ambiguityDelta = 0.05, weights } = {}) {
  const candidates = [];
  for (const from of previous) {
    for (const to of current) {
      const score = scoreCandidate(from, to, { weights });
      if (score.confidence >= threshold) candidates.push({ from, to, ...score });
    }
  }
  candidates.sort(candidateSort);
  const byFrom = new Map();
  const byTo = new Map();
  for (const candidate of candidates) {
    byFrom.set(candidate.from, [...(byFrom.get(candidate.from) ?? []), candidate]);
    byTo.set(candidate.to, [...(byTo.get(candidate.to) ?? []), candidate]);
  }
  return candidates.map((candidate) => {
    const fromAlternatives = byFrom.get(candidate.from).filter((other) => other !== candidate);
    const toAlternatives = byTo.get(candidate.to).filter((other) => other !== candidate);
    const fromAmbiguous = fromAlternatives.some((other) => Math.abs(candidate.confidence - other.confidence) < ambiguityDelta);
    const toAmbiguous = toAlternatives.some((other) => Math.abs(candidate.confidence - other.confidence) < ambiguityDelta);
    return {
      ...candidate,
      resolution: fromAmbiguous || toAmbiguous ? "candidate" : "resolved",
      alternatives: {
        from: fromAlternatives.map((other) => ({ name: other.to.name, confidence: other.confidence })),
        to: toAlternatives.map((other) => ({ name: other.from.name, confidence: other.confidence }))
      }
    };
  });
}

export function matchLineage(previous, current, options = {}) {
  const candidates = fuzzyCandidates(previous, current, options);
  const resolved = candidates.filter((candidate) => candidate.resolution === "resolved");
  const multiEdgeThreshold = options.multiEdgeThreshold ?? options.threshold ?? 0.45;
  const strong = resolved.filter((candidate) => candidate.confidence >= multiEdgeThreshold);
  const fromGroups = new Map();
  const toGroups = new Map();
  for (const candidate of strong) {
    fromGroups.set(candidate.from, [...(fromGroups.get(candidate.from) ?? []), candidate]);
    toGroups.set(candidate.to, [...(toGroups.get(candidate.to) ?? []), candidate]);
  }
  const transitions = [];
  const usedFrom = new Set();
  const usedTo = new Set();
  for (const candidate of strong) {
    const split = (fromGroups.get(candidate.from)?.length ?? 0) > 1;
    const merge = (toGroups.get(candidate.to)?.length ?? 0) > 1;
    if (!split && !merge) continue;
    transitions.push({
      ...candidate,
      kind: split && merge ? "split-merge" : split ? "split" : "merge",
      resolution: "resolved"
    });
    usedFrom.add(candidate.from);
    usedTo.add(candidate.to);
  }
  for (const candidate of resolved) {
    if (usedFrom.has(candidate.from) || usedTo.has(candidate.to)) continue;
    usedFrom.add(candidate.from);
    usedTo.add(candidate.to);
    transitions.push({
      ...candidate,
      kind: candidate.from.name === candidate.to.name ? "modified" : "moved",
      resolution: "resolved"
    });
  }
  transitions.sort(candidateSort);
  return {
    candidates,
    transitions,
    unmatchedPrevious: previous.filter((symbol) => !usedFrom.has(symbol)),
    unmatchedCurrent: current.filter((symbol) => !usedTo.has(symbol))
  };
}

export function fuzzyTransitions(previous, current, commitOid, options) {
  return matchLineage(previous, current, options).transitions.map(({ from, to, confidence, resolution, evidence, kind }) => ({
    kind,
    from,
    to,
    commitOid,
    confidence,
    resolution,
    evidence
  }));
}
