function parseJson(value, fallback) {
  try { return JSON.parse(value); }
  catch { return fallback; }
}

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(0, Math.floor(number)));
}

function revisionSummary(db, revisionId, commitOid = null) {
  const revision = db.query(`
    SELECT r.id AS revision_id, r.logical_symbol_id, r.first_commit_oid, r.last_commit_oid,
           s.qualified_name, s.kind, s.language,
           l.commit_oid AS location_commit_oid, l.path, l.range_json, l.selection_range_json,
           c.oid AS commit_context_oid, c.committed_at, c.message
    FROM revisions r
    JOIN logical_symbols s ON s.id = r.logical_symbol_id
    LEFT JOIN locations l ON l.revision_id = r.id
      AND (? IS NULL OR l.commit_oid = ?)
    LEFT JOIN commits c ON c.oid = COALESCE(l.commit_oid, r.last_commit_oid)
    WHERE r.id = ?
    ORDER BY CASE WHEN l.revision_id IS NULL THEN 1 ELSE 0 END, c.committed_at DESC
    LIMIT 1
  `).get(commitOid, commitOid, revisionId);
  if (!revision) return null;
  return {
    revision_id: revision.revision_id,
    logical_symbol_id: revision.logical_symbol_id,
    qualified_name: revision.qualified_name,
    kind: revision.kind,
    language: revision.language,
    path: revision.path ?? null,
    range: parseJson(revision.range_json, null),
    selection_range: parseJson(revision.selection_range_json, null),
    commit: revision.commit_context_oid
      ? { oid: revision.commit_context_oid, committed_at: revision.committed_at, message: revision.message }
      : null,
    first_commit_oid: revision.first_commit_oid,
    last_commit_oid: revision.last_commit_oid
  };
}

function resolveStarts(db, query, limit = 20) {
  const value = String(query ?? "").trim();
  if (!value) return [];
  return db.query(`
    SELECT DISTINCT r.id AS revision_id, r.logical_symbol_id, s.qualified_name, s.kind, s.language,
           r.first_commit_oid, r.last_commit_oid
    FROM revisions r
    JOIN logical_symbols s ON s.id = r.logical_symbol_id
    LEFT JOIN locations l ON l.revision_id = r.id
    WHERE r.id = ? OR s.qualified_name = ? OR s.qualified_name LIKE ? OR l.path LIKE ?
    ORDER BY CASE
      WHEN r.id = ? THEN 0
      WHEN s.qualified_name = ? THEN 1
      WHEN s.qualified_name LIKE ? THEN 2
      ELSE 3
    END, r.last_commit_oid DESC, r.id
    LIMIT ?
  `).all(value, value, `%${value}%`, `%${value}%`, value, value, `${value}%`, limit)
    .map((start) => revisionSummary(db, start.revision_id));
}

function resolveTarget(db, reference, commitOid) {
  const target = reference.target_qualified_name ?? reference.target_text;
  if (!target || reference.resolution === "dynamic") return null;
  const exactAtCommit = db.query(`
    SELECT r.id
    FROM revisions r
    JOIN logical_symbols s ON s.id = r.logical_symbol_id
    JOIN locations l ON l.revision_id = r.id AND l.commit_oid = ?
    WHERE r.id = ? OR s.qualified_name = ?
    ORDER BY CASE WHEN r.id = ? THEN 0 ELSE 1 END, r.id
    LIMIT 1
  `).get(commitOid, target, target, target);
  if (exactAtCommit) return revisionSummary(db, exactAtCommit.id, commitOid);
  const latest = db.query(`
    SELECT r.id
    FROM revisions r
    JOIN logical_symbols s ON s.id = r.logical_symbol_id
    WHERE r.id = ? OR s.qualified_name = ?
    ORDER BY CASE WHEN r.id = ? THEN 0 ELSE 1 END, r.last_commit_oid DESC, r.id
    LIMIT 1
  `).get(target, target, target);
  return latest ? revisionSummary(db, latest.id, commitOid) : null;
}

function referenceStep(db, revisionId, reference) {
  const source = revisionSummary(db, revisionId, reference.commit_oid);
  const target = resolveTarget(db, reference, reference.commit_oid);
  let uncertainty = { kind: "none", reason: null };
  if (reference.resolution === "dynamic") {
    uncertainty = { kind: "dynamic", reason: "the analyzer marked this reference dynamic" };
  } else if (!target) {
    uncertainty = { kind: "unresolved", reason: "no indexed target matched this reference" };
  } else if (reference.resolution !== "resolved" && reference.resolution !== "exact") {
    uncertainty = { kind: "inferred", reason: `analyzer resolution=${reference.resolution}` };
  }
  return {
    reference_id: reference.id,
    kind: reference.kind,
    target_text: reference.target_text,
    target_qualified_name: reference.target_qualified_name,
    resolution: reference.resolution,
    confidence: reference.confidence,
    range: parseJson(reference.range_json, null),
    source,
    target,
    uncertainty
  };
}

function terminal(kind, reason) {
  return { kind, reason };
}

export function traceGraph(db, query, { maxDepth = 8, maxPaths = 50, sinks = [], startLimit = 20 } = {}) {
  const depthLimit = boundedInteger(maxDepth, 8, 1000);
  const pathLimit = boundedInteger(maxPaths, 50, 10000);
  const starts = resolveStarts(db, query, boundedInteger(startLimit, 20, 1000));
  const paths = [];
  const queue = starts.map((start) => ({ revisionId: start.revision_id, start, steps: [], seen: new Set([start.revision_id]), depth: 0 }));

  while (queue.length && paths.length < pathLimit) {
    const current = queue.shift();
    if (current.depth >= depthLimit) {
      paths.push({ start: current.start, steps: current.steps, terminal: terminal("max-depth", `maximum depth ${depthLimit} reached`) });
      continue;
    }
    const references = db.query(`
      SELECT id, commit_oid, kind, target_text, target_qualified_name, resolution, confidence, range_json
      FROM "references" WHERE revision_id = ? ORDER BY id
    `).all(current.revisionId);
    if (references.length === 0) {
      paths.push({ start: current.start, steps: current.steps, terminal: terminal("leaf", "no indexed outgoing references") });
      continue;
    }

    for (const reference of references) {
      if (paths.length >= pathLimit) break;
      const step = referenceStep(db, current.revisionId, reference);
      const nextPath = [...current.steps, step];
      const targetName = step.target?.qualified_name ?? step.target_qualified_name ?? step.target_text;
      const sink = sinks.some((configured) => configured === targetName || configured === step.target_text);
      if (sink) {
        paths.push({ start: current.start, steps: nextPath, terminal: terminal("sink", `configured sink ${targetName}`) });
      } else if (step.uncertainty.kind !== "none") {
        paths.push({ start: current.start, steps: nextPath, terminal: terminal(step.uncertainty.kind, step.uncertainty.reason) });
      } else if (!step.target) {
        paths.push({ start: current.start, steps: nextPath, terminal: terminal("unresolved", "target resolution returned no indexed revision") });
      } else if (current.seen.has(step.target.revision_id)) {
        paths.push({ start: current.start, steps: nextPath, terminal: terminal("cycle", `target revision ${step.target.revision_id} already visited`) });
      } else {
        queue.push({ revisionId: step.target.revision_id, start: current.start, steps: nextPath, seen: new Set([...current.seen, step.target.revision_id]), depth: current.depth + 1 });
      }
    }
  }

  return {
    query,
    starts,
    paths,
    limits: { max_depth: depthLimit, max_paths: pathLimit },
    truncated: queue.length > 0
  };
}
