# Analyzer Authoring Guide

Historian analyzers are independent JSONL workers. The normative wire contract
is in [`spec/analyzer-protocol.md`](../spec/analyzer-protocol.md); this guide
covers implementation and validation.

## Worker contract

The coordinator starts one long-lived analyzer process and writes one JSON
request per line to stdin. The worker writes exactly one JSON response per
request to stdout. Logs belong on stderr.

Required operations are:

- `describe`: identify the analyzer, supported languages, and extensions.
- `ping`: return a healthy response without analyzing source.
- `analyze`: accept `path`, `language`, `blob_oid`, and UTF-8 `source`.
- `shutdown`: exit cleanly after the response.

The response must preserve deterministic JSON values and include a `file`,
`symbols`, `references`, and `diagnostics` result for a successful analysis.
Malformed source should return partial facts and diagnostics when possible;
malformed requests must return a protocol error without terminating the worker.

## Fact requirements

Each symbol should provide a stable `local_id`, `name`, `qualified_name` when
available, `kind`, `range`, `selection_range`, `source_hash`, and
`structural_hash`. Structural features should include a normalized shape, shape
hash, node count, depth, arity, and feature list when the parser supports them.

References should identify their source owner with `source_symbol_local_id`
when possible, include a target text or qualified name, a resolution state,
confidence, and a source range. Coordinates use UTF-8 byte offsets plus
line/column positions. Selection ranges must be non-empty for emitted symbols.

Do not emit repository-wide claims from a blob-local parser. Imports and type
references can be reported as references with explicit unresolved or dynamic
resolution until a project-aware indexer can prove more.

## JavaScript and TypeScript example

The bundled Bun worker is:

```bash
bun analyzers/typescript/src/analyzer.js
```

Configure both `javascript` and `typescript` extensions to use that worker.
The worker supports `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, and `.d.ts`.

## Clojure and Babashka example

The bundled workers are:

```bash
bb -cp analyzers/clojure/src -m greenways-historian.analyzer
bb -cp analyzers/clojure/src -m greenways-historian.kondo-analyzer
```

The supported V1 scope is `.clj` and `.bb`. `rewrite-clj` is a Maven library
loaded by Babashka through `bb.edn`; it is not a separate executable.

## Conformance

Run the protocol checks before adding an analyzer to a configuration:

```bash
gw-historian analyzer check \
  bun analyzers/typescript/src/analyzer.js \
  --fixture spec/conformance/typescript.json

gw-historian analyzer check \
  bb -cp analyzers/clojure/src -m greenways-historian.analyzer
```

The checks cover `describe`, `ping`, schema and UTF-8 handling, deterministic
output, malformed-request recovery, and clean shutdown. Add a language fixture
under `spec/conformance/` when the shared contract needs language-specific
coverage.

## Compatibility and safety

Keep protocol changes additive and update the schema and conformance fixtures
together. Never write diagnostics or logs to stdout. Bound source size and
internal queues, avoid spawning a process per blob, and make shutdown
idempotent. Historian does not require an LLM, MCP server, Ollama, embeddings,
or a vector database to index or query history.

