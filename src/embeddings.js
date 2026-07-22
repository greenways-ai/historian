import { createHash } from "node:crypto";

export function chunkText(text, { size = 16 * 1024, overlap = 1024 } = {}) {
  if (size <= overlap) throw new Error("chunk size must be greater than overlap");
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  let start = 0;
  while (start < bytes.length || (bytes.length === 0 && chunks.length === 0)) {
    const end = Math.min(bytes.length, start + size);
    const value = new TextDecoder().decode(bytes.slice(start, end));
    chunks.push({ index: chunks.length, startByte: start, endByte: end, text: value });
    if (end >= bytes.length) break;
    start = end - overlap;
  }
  return chunks;
}

export function deterministicVector(text, dimensions = 1536) {
  const vector = new Array(dimensions).fill(0);
  for (let offset = 0; offset < text.length; offset += 64) {
    const digest = createHash("sha256").update(`${offset}:${text.slice(offset, offset + 64)}`).digest();
    for (let index = 0; index < digest.length; index += 1) vector[(offset + index) % dimensions] += (digest[index] - 127.5) / 127.5;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export class EmbeddingAdapter {
  constructor({ baseUrl, apiKey, model, dimensions = 1536, offline = false } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
    this.offline = offline;
  }

  fingerprint() {
    return createHash("sha256").update(JSON.stringify({ baseUrl: this.baseUrl, model: this.model, dimensions: this.dimensions, offline: this.offline })).digest("hex");
  }

  async embed(inputs) {
    if (this.offline) return inputs.map((input) => deterministicVector(input, this.dimensions));
    if (!this.baseUrl || !this.model) throw new Error("embedding provider is not configured");
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, input: inputs })
    });
    if (!response.ok) throw new Error(`embedding provider returned ${response.status}`);
    const body = await response.json();
    return body.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}

export class QdrantClient {
  constructor({ url, fetchImpl = fetch } = {}) { this.url = url?.replace(/\/$/, ""); this.fetch = fetchImpl; }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.url}${path}`, { headers: { "content-type": "application/json" }, ...options });
    if (!response.ok) throw new Error(`Qdrant ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async ensureCollection(name, dimensions) {
    return this.request(`/collections/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ vectors: { size: dimensions, distance: "Cosine" } }) });
  }

  async upsert(name, points) {
    return this.request(`/collections/${encodeURIComponent(name)}/points?wait=true`, { method: "PUT", body: JSON.stringify({ points }) });
  }

  async search(name, vector, { limit = 50, filter = undefined } = {}) {
    const body = { vector, limit, with_payload: true };
    if (filter) body.filter = filter;
    const response = await this.request(`/collections/${encodeURIComponent(name)}/points/search`, { method: "POST", body: JSON.stringify(body) });
    return response.result ?? [];
  }
}
