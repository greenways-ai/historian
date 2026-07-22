# Code Historian Analyzer Protocol 1.0

Status: Normative specification

## Purpose

An analyzer converts one source blob into language-specific structural facts.
It does not read Git history, assign repository-wide identities, generate
embeddings, or infer changes. This separation makes analyzer results cacheable
by blob OID and analyzer fingerprint.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

## Transport

The historian starts an analyzer as a persistent subprocess. Requests and
responses are UTF-8 JSON objects separated by a single LF byte (JSONL).

- stdin contains requests only.
- stdout contains responses only, one response for every request.
- stderr is available for human-readable logs.
- Messages may arrive sequentially in 1.0. An analyzer MUST preserve response
  order. Future protocol versions may negotiate multiplexing.
- A message MUST be no larger than 10 MiB unless both peers negotiate another
  limit through `describe`.
- The historian terminates a request after 30 seconds by default.
- Unknown fields MUST be ignored. Unknown operations MUST return an error.

## Envelope

Every request contains:

```json
{
  "protocol_version": "1.0",
  "request_id": "opaque-id",
  "op": "describe"
}
```

Every response repeats `protocol_version`, `request_id`, and `op`, and contains
exactly one of `result` or `error`. Errors use a stable `code`, human-readable
`message`, and optional JSON `details`.

Defined error codes are `invalid_request`, `unsupported_operation`,
`unsupported_language`, `too_large`, `parse_error`, `timeout`, and
`internal_error`. A source parse failure is a successful `analyze` response
with diagnostics when partial analysis is possible; `parse_error` is reserved
for inputs from which no useful structure can be produced.

## Operations

### `describe`

Returns analyzer name, semantic version, supported protocol versions,
languages, extensions, capabilities, maximum message size, and a deterministic
`fingerprint`. The fingerprint MUST change whenever the same input could
produce different output, including parser or configuration changes.

### `analyze`

The request result-independent inputs are:

```json
{
  "language": "clojure",
  "path": "src/example/core.clj",
  "blob_oid": "git-object-id",
  "source": "(ns example.core)\n(defn answer [] 42)\n",
  "config": {}
}
```

`source` MUST be UTF-8 text. The analyzer MUST NOT access a checkout to resolve
the path. Given the same request and analyzer fingerprint, it MUST return the
same structural result byte-for-byte after canonical JSON key ordering.

The result contains:

- `file`: language, namespace/module, imports, and source byte count.
- `symbols`: definitions ordered by start byte.
- `references`: calls, reads, writes, imports, type references, inheritance,
  implementations, and macro expansion sites when statically observable.
- `diagnostics`: parser/analyzer messages ordered by source position.

### `ping` and `shutdown`

`ping` returns `{ "ok": true }`. `shutdown` acknowledges the request and exits
zero after flushing stdout.

## Source Coordinates

Every range is half-open and contains:

```json
{
  "start_byte": 0,
  "end_byte": 17,
  "start": { "line": 1, "column": 1 },
  "end": { "line": 1, "column": 18 }
}
```

Byte offsets count UTF-8 bytes from zero. Lines and columns count Unicode code
points from one. Consumers MUST use byte offsets for slicing and line/column
only for display. Empty ranges are allowed for inferred facts.

## Symbols

Each symbol contains:

- `local_id`: unique and stable within this response.
- optional `parent_local_id` for lexical containment.
- `kind`: a value from the shared vocabulary or `language:<value>`.
- `name` and optional `qualified_name`.
- `range` for the whole definition and `selection_range` for its name.
- optional `signature`, `documentation`, `modifiers`, and `metadata`.
- `source_hash`: SHA-256 of the exact ranged UTF-8 bytes.
- `structural_hash`: SHA-256 of the analyzer's normalized representation.
- optional `structure`: deterministic language-neutral or language-specific
  JSON used by lineage matching.

Shared kinds are `namespace`, `module`, `class`, `interface`, `protocol`,
`record`, `type`, `function`, `method`, `macro`, `multimethod`, `variable`,
`constant`, `field`, and `test`.

Formatting, comments outside documentation, and source coordinates MUST NOT
affect `structural_hash`. Publicly visible names and signatures SHOULD affect
it. Local binding names MAY be normalized by language analyzers.

## References

A reference contains its `kind`, source `range`, optional
`source_symbol_local_id`, original `target_text`, and optional resolved
`target_qualified_name`. Resolution is `resolved`, `candidate`, `dynamic`, or
`unresolved`, accompanied by confidence from 0.0 through 1.0. Analyzers MUST
not claim `resolved` when runtime dispatch is required.

## Determinism And Safety

- Symbols, references, imports, and diagnostics MUST use deterministic ordering.
- An analyzer MUST NOT execute analyzed source.
- Network access MUST NOT be required.
- Analyzer output MUST contain no secrets beyond text already supplied in the
  request.
- A malformed request MUST NOT terminate the persistent worker.
- The conformance suite is authoritative for framing and schema behavior; the
  prose specification is authoritative for semantics.


## Schema and compatibility

The canonical schemas are spec/schema/request.schema.json,
spec/schema/response.schema.json, and spec/schema/result.schema.json.
Examples in spec/schema/examples are compatibility fixtures. Minor releases may
add optional fields and enum values; consumers must ignore unknown fields.
Minor releases must not remove or change existing field semantics. Major
releases may change required fields or semantics and use a new protocol version.
