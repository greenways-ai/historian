const PROTOCOL_VERSION = "1.0";
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

function utf8Size(value) {
  return new TextEncoder().encode(value).byteLength;
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function result(ok, name, details = {}) {
  return { ok, name, ...details };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function start(command) {
  if (command.length === 0) throw new Error("missing analyzer command");
  const process = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = process.stdout.getReader();
  let buffer = "";
  async function readResponse(timeoutMs = 30000) {
    const read = async () => {
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          return JSON.parse(line);
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("analyzer closed stdout before responding");
        buffer += new TextDecoder().decode(value, { stream: true });
        if (utf8Size(buffer) > MAX_MESSAGE_BYTES) throw new Error("analyzer response exceeded 10 MiB");
      }
    };
    return await Promise.race([
      read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`response timeout after ${timeoutMs}ms`)), timeoutMs))
    ]);
  }
  async function request(request) {
    const line = jsonLine(request);
    assert(utf8Size(line) <= MAX_MESSAGE_BYTES, "request exceeded 10 MiB");
    await process.stdin.write(line);
    return await readResponse();
  }
  return { process, request };
}

function validateEnvelope(response, requestId, op) {
  assert(response.protocol_version === PROTOCOL_VERSION, "wrong response protocol version");
  assert(response.request_id === requestId, "response request_id mismatch");
  assert(response.op === op, "response operation mismatch");
  assert(("result" in response) !== ("error" in response), "response must contain exactly one body");
}

async function run(command, fixturePath = "spec/conformance/clojure.json") {
  const analyzer = await start(command);
  const fixture = await Bun.file(fixturePath).json();
  const checks = [];
  const check = async (name, fn) => {
    try { checks.push(result(true, name, await fn())); }
    catch (error) { checks.push(result(false, name, { error: error.message })); }
  };

  let nextId = 1;
  const request = (op, fields = {}) => ({ protocol_version: PROTOCOL_VERSION, request_id: `conformance-${nextId++}`, op, ...fields });
  await check("describe", async () => {
    const req = request("describe");
    const response = await analyzer.request(req);
    validateEnvelope(response, req.request_id, req.op);
    assert(response.result?.name && Array.isArray(response.result.languages), "invalid describe result");
    assert(typeof response.result.fingerprint === "string", "describe fingerprint missing");
    return { analyzer: response.result.name };
  });
  await check("ping", async () => {
    const req = request("ping");
    const response = await analyzer.request(req);
    validateEnvelope(response, req.request_id, req.op);
    assert(response.result?.ok === true, "ping was not acknowledged");
  });
  const analyzeFields = { language: fixture.language, path: fixture.path, blob_oid: "fixture-unicode", source: fixture.source, config: {} };
  let firstAnalysis;
  await check("analyze-schema-and-utf8", async () => {
    const req = request("analyze", analyzeFields);
    const response = await analyzer.request(req);
    validateEnvelope(response, req.request_id, req.op);
    assert(response.result?.file?.source_bytes === utf8Size(analyzeFields.source), "source byte count is not UTF-8 based");
    assert(Array.isArray(response.result.symbols) && Array.isArray(response.result.references), "analyze arrays missing");
    assert(response.result.symbols.some((symbol) => fixture.expected.symbol_names.includes(symbol.qualified_name)), "fixture symbol expectation not met");
    assert(response.result.references.some((reference) => fixture.expected.reference_targets.includes(reference.target_text)), "fixture reference expectation not met");
    firstAnalysis = JSON.stringify(response.result);
  });
  await check("deterministic-output", async () => {
    const req = request("analyze", analyzeFields);
    const response = await analyzer.request(req);
    validateEnvelope(response, req.request_id, req.op);
    assert(JSON.stringify(response.result) === firstAnalysis, "same input produced different output");
  });
  await check("malformed-request-recovery", async () => {
    const malformedRequest = request("explode");
    const malformed = await analyzer.request(malformedRequest);
    validateEnvelope(malformed, malformedRequest.request_id, malformedRequest.op);
    assert(malformed.error?.code === "unsupported_operation", "invalid operation was not rejected");
    const recoveryRequest = request("ping");
    const recovery = await analyzer.request(recoveryRequest);
    validateEnvelope(recovery, recoveryRequest.request_id, recoveryRequest.op);
    assert(recovery.result?.ok === true, "analyzer did not recover after malformed input");
  });
  await check("shutdown-and-clean-exit", async () => {
    const req = request("shutdown");
    const response = await analyzer.request(req);
    validateEnvelope(response, req.request_id, req.op);
    assert(response.result?.ok === true, "shutdown was not acknowledged");
    assert(await analyzer.process.exited === 0, `analyzer exited with ${await analyzer.process.exited}`);
  });
  return checks;
}

export async function runAnalyzerConformance(command) {
  const fixtureFlag = command.indexOf("--fixture");
  const fixturePath = fixtureFlag >= 0 ? command[fixtureFlag + 1] : "spec/conformance/clojure.json";
  const analyzerCommand = fixtureFlag >= 0 ? [...command.slice(0, fixtureFlag), ...command.slice(fixtureFlag + 2)] : command;
  const output = { command: analyzerCommand, fixture: fixturePath, checks: [] };
  try { output.checks = await run(analyzerCommand, fixturePath); }
  catch (error) { output.checks = [result(false, "startup", { error: error.message })]; }
  output.ok = output.checks.every((check) => check.ok);
  console.log(JSON.stringify(output, null, 2));
  return output.ok ? 0 : 1;
}
