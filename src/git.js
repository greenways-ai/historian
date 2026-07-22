const decoder = new TextDecoder();

async function spawnGit(repository, args, options = {}) {
  const process = Bun.spawn(["git", "-C", repository, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...options
  });
  return process;
}

async function* linesFrom(stream) {
  const reader = stream.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        yield buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

export async function repositoryObjectFormat(repository) {
  const process = await spawnGit(repository, ["rev-parse", "--show-object-format"]);
  const output = (await new Response(process.stdout).text()).trim();
  const error = (await new Response(process.stderr).text()).trim();
  if (await process.exited !== 0) throw new Error(error || "unable to determine Git object format");
  return output;
}

export async function* walkCommits(repository, refs = ["HEAD"]) {
  const shallowCheck = await spawnGit(repository, ["rev-parse", "--is-shallow-repository"]);
  const shallow = (await new Response(shallowCheck.stdout).text()).trim();
  const shallowError = (await new Response(shallowCheck.stderr).text()).trim();
  if (await shallowCheck.exited !== 0) throw new Error(shallowError || "unable to determine whether Git repository is shallow");
  if (shallow === "true") throw new Error("Git repository is shallow; complete history is required");
  const process = await spawnGit(repository, ["rev-list", "--parents", "--topo-order", "--reverse", ...refs]);
  for await (const line of linesFrom(process.stdout)) {
    if (!line) continue;
    const [oid, ...parents] = line.split(" ");
    yield { oid, parents };
  }
  const error = (await new Response(process.stderr).text()).trim();
  if (await process.exited !== 0) {
    throw new Error(error || "Git history traversal failed; repository may be shallow or missing objects");
  }
}

export async function commitMetadata(repository, oid) {
  const process = await spawnGit(repository, ["show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B", oid]);
  const output = await new Response(process.stdout).text();
  const error = (await new Response(process.stderr).text()).trim();
  if (await process.exited !== 0) throw new Error(error || `unable to read commit ${oid}`);
  const [commitOid, parentText, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, ...message] = output.split("\0");
  return { oid: commitOid, parents: parentText ? parentText.split(" ") : [], authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, message: message.join("\0").trim() };
}

export async function changedPaths(repository, oid, parent = null) {
  const base = parent ? [parent, oid] : ["--root", oid];
  const process = await spawnGit(repository, ["diff-tree", "--no-commit-id", "--raw", "-r", "-z", "-M", "-C", ...base, "--"]);
  const data = new Uint8Array(await new Response(process.stdout).arrayBuffer());
  const records = decoder.decode(data).split("\0").filter(Boolean);
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const fields = records[index].trim().split(/\s+/);
    const status = fields.at(-1) ?? "M";
    const path = records[++index];
    if (!path) continue;
    const change = { status: status[0], oldMode: fields[0].slice(1), newMode: fields[1], oldBlobOid: fields[2], newBlobOid: fields[3], path };
    if ((status[0] === "R" || status[0] === "C") && records[index + 1]) change.newPath = records[++index];
    changes.push(change);
  }
  const error = (await new Response(process.stderr).text()).trim();
  if (await process.exited !== 0) throw new Error(error || `unable to read changes for ${oid}`);
  return changes;
}

export class GitObjectReader {
  constructor(repository) {
    this.process = Bun.spawn(["git", "-C", repository, "cat-file", "--batch-command"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.reader = this.process.stdout.getReader();
    this.buffer = new Uint8Array(0);
  }

  async readBytes(count) {
    while (this.buffer.length < count) {
      const { done, value } = await this.reader.read();
      if (done) throw new Error("Git object reader closed unexpectedly");
      const joined = new Uint8Array(this.buffer.length + value.length);
      joined.set(this.buffer); joined.set(value, this.buffer.length); this.buffer = joined;
    }
    const bytes = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    return bytes;
  }

  async readLine() {
    while (true) {
      const newline = this.buffer.indexOf(10);
      if (newline >= 0) {
        const line = decoder.decode(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      const { done, value } = await this.reader.read();
      if (done) throw new Error("Git object reader closed unexpectedly");
      const joined = new Uint8Array(this.buffer.length + value.length);
      joined.set(this.buffer); joined.set(value, this.buffer.length); this.buffer = joined;
    }
  }

  async read(oid) {
    await this.process.stdin.write(`contents ${oid}\n`);
    const [returnedOid, type, sizeText] = (await this.readLine()).split(" ");
    if (type === "missing") throw new Error(`missing Git object ${oid}`);
    const size = Number(sizeText);
    const bytes = await this.readBytes(size);
    await this.readBytes(1);
    return { oid: returnedOid, type, size, bytes };
  }

  async close() {
    await this.process.stdin.write("quit\n");
    await this.process.exited;
    this.reader.releaseLock();
  }
}
