function processRows() {
  const result = Bun.spawnSync(["ps", "-e", "-o", "pid=,ppid=,rss=,args="], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return [];
  const text = new TextDecoder().decode(result.stdout);
  return text.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] }] : [];
  });
}

export function processTreeMemory(rootPid = process.pid) {
  const rows = processRows();
  const byParent = new Map();
  for (const row of rows) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const selected = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((candidate) => candidate.pid === pid);
    if (row) selected.push(row);
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return {
    rootPid,
    pids: selected.map((row) => row.pid),
    rssKb: selected.reduce((total, row) => total + row.rssKb, 0),
    workers: selected.filter((row) => row.pid !== rootPid).map(({ pid, ppid, rssKb, command }) => ({ pid, ppid, rssKb, command }))
  };
}
