export function traceGraph(db, startRevisionId, { maxDepth = 8, maxPaths = 50, sinks = [] } = {}) {
  const queue = [{ revisionId: startRevisionId, path: [], depth: 0 }];
  const paths = [];
  const visited = new Set();
  while (queue.length && paths.length < maxPaths) {
    const current = queue.shift();
    const key = `${current.revisionId}:${current.depth}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const references = db.query(`SELECT target_qualified_name, target_text, resolution, confidence, range_json FROM "references" WHERE revision_id = ? ORDER BY id`).all(current.revisionId);
    for (const reference of references) {
      const step = { ...reference, range: JSON.parse(reference.range_json) };
      const nextPath = [...current.path, step];
      if (sinks.some((sink) => step.target_qualified_name === sink || step.target_text === sink)) paths.push(nextPath);
      if (current.depth < maxDepth && step.resolution !== "dynamic" && step.target_qualified_name) {
        const next = db.query("SELECT r.id FROM revisions r JOIN logical_symbols s ON s.id = r.logical_symbol_id WHERE r.id = ? OR s.qualified_name = ? LIMIT 1").get(step.target_qualified_name, step.target_qualified_name);
        if (next) queue.push({ revisionId: next.id, path: nextPath, depth: current.depth + 1 });
      }
    }
  }
  return paths;
}
