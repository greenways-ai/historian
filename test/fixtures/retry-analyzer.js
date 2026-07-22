import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.argv[2];
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.op === "analyze" && !existsSync(marker)) {
    writeFileSync(marker, "crashed");
    process.exit(1);
  }
  const result = request.op === "analyze"
    ? { file: { language: request.language, path: request.path, blob_oid: request.blob_oid, source_bytes: new TextEncoder().encode(request.source).byteLength }, symbols: [], references: [], diagnostics: [] }
    : { ok: true };
  process.stdout.write(`${JSON.stringify({ protocol_version: "1.0", request_id: request.request_id, op: request.op, result })}\n`);
  if (request.op === "shutdown") {
    input.close();
    break;
  }
}
