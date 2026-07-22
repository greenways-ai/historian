import { createHash } from "node:crypto";
import { processTreeMemory } from "./process-memory.js";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceBytes(source) {
  return new TextEncoder().encode(source).byteLength;
}

class AnalyzerWorker {
  constructor(command) {
    this.command = command;
    this.process = null;
    this.reader = null;
    this.buffer = "";
  }

  async start() {
    this.process = Bun.spawn(this.command, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.reader = this.process.stdout.getReader();
  }

  async readResponse() {
    const read = async () => {
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          return JSON.parse(line);
        }
        const { done, value } = await this.reader.read();
        if (done) throw new Error("analyzer worker exited before responding");
        this.buffer += new TextDecoder().decode(value, { stream: true });
      }
    };
    return Promise.race([
      read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("analyzer request timeout")), REQUEST_TIMEOUT_MS))
    ]);
  }

  async request(payload) {
    if (!this.process) await this.start();
    await this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    return this.readResponse();
  }

  async stop() {
    if (!this.process) return;
    try { await this.process.stdin.write('{"protocol_version":"1.0","request_id":"shutdown","op":"shutdown"}\n'); } catch {}
    await this.process.exited;
    this.reader?.releaseLock();
    this.process = null;
  }
}

export class AnalyzerPool {
  constructor({ commands, concurrency = 1, config = {}, cacheLimit = 256 } = {}) {
    this.commands = commands ?? {};
    this.config = config;
    this.workers = [];
    this.queue = [];
    this.running = 0;
    this.cache = new Map();
    this.cacheLimit = Math.max(0, cacheLimit);
    this.concurrency = Math.max(1, concurrency);
    this.roundRobin = new Map();
    this.starting = new Map();
    this.memory = { samples: 0, peakRssKb: 0, peakPids: 0, last: null };
  }

  commandFor(language, path) {
    const configured = this.commands[language];
    if (!configured) return null;
    if (Array.isArray(configured)) return configured;
    const extension = `.${path.split(".").at(-1)}`;
    return configured.command ?? configured[extension] ?? null;
  }

  async workerFor(command) {
    const key = JSON.stringify(command);
    const existing = this.workers.filter((worker) => JSON.stringify(worker.command) === key);
    if (existing.length >= this.concurrency) {
      const index = this.roundRobin.get(key) ?? 0;
      this.roundRobin.set(key, index + 1);
      return existing[index % existing.length];
    }
    if (this.starting.has(key)) {
      await this.starting.get(key);
      return this.workerFor(command);
    }
    const start = (async () => {
      const worker = new AnalyzerWorker(command);
      await worker.start();
      this.workers.push(worker);
    })();
    this.starting.set(key, start);
    try { await start; }
    finally { this.starting.delete(key); }
    return this.workerFor(command);
  }

  async perform({ language, path, blob_oid, source, config = this.config }) {
    if (sourceBytes(source) > MAX_SOURCE_BYTES) return { skipped: true, reason: "oversized" };
    const command = this.commandFor(language, path);
    if (!command) return { skipped: true, reason: "unsupported-language" };
    const key = hash({ blob_oid, analyzer: command, config });
    if (this.cache.has(key)) {
      const response = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, response);
      return response;
    }
    const request = { protocol_version: "1.0", request_id: key, op: "analyze", language, path, blob_oid, source, config };
    const worker = await this.workerFor(command);
    let response;
    try {
      response = await worker.request(request);
    } catch (firstError) {
      await worker.stop();
      this.workers = this.workers.filter((candidate) => candidate !== worker);
      const retry = await this.workerFor(command);
      try { response = await retry.request(request); }
      catch (secondError) { return { skipped: true, reason: "worker-failed", error: secondError.message, cause: firstError.message }; }
    }
    if (this.cacheLimit > 0) {
      this.cache.set(key, response);
      while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
    }
    return response;
  }

  drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      this.running += 1;
      this.perform(item.payload)
        .then(item.resolve, item.reject)
        .finally(() => { this.running -= 1; this.drain(); });
    }
  }

  analyze(payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this.drain();
    });
  }

  observeMemory() {
    try {
      const snapshot = processTreeMemory();
      this.memory.samples += 1;
      this.memory.last = snapshot;
      this.memory.peakRssKb = Math.max(this.memory.peakRssKb, snapshot.rssKb);
      this.memory.peakPids = Math.max(this.memory.peakPids, snapshot.pids.length);
    } catch {}
    return this.memory;
  }

  memoryStats() {
    return { ...this.memory, last: this.memory.last ? { ...this.memory.last } : null };
  }

  async close() {
    await Promise.all(this.workers.map((worker) => worker.stop()));
    this.workers = [];
  }
}
