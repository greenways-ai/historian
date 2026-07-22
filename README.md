# Code Historian

Git-native temporal code indexing, history, and tracing.

Code Historian walks a repository's commit DAG, analyzes changed blobs once,
tracks symbol lineage, and stores deterministic retrieval documents in SQLite.
Git remains the source of truth. Qdrant is optional and is not required by the
CLI or the agent skill.

## Status

Early development. The first analyzer targets Clojure and runs on Babashka.
The core CLI runs on Bun.

## Requirements

- Bun 1.2.18 or newer
- Babashka 1.12.218 or newer
- Git 2.43 or newer

## Quick start

```bash
cp code-historian.example.json code-historian.json
bun run doctor
bun run check
bun run conformance
```

Run the analyzer protocol directly:

```bash
printf '%s\n' '{"protocol_version":"1.0","request_id":"1","op":"describe"}' |
  bb -cp analyzers/clojure/src -m code-historian.analyzer
```

Index a repository and inspect the local state:

```bash
code-historian init
code-historian index /path/to/repository
code-historian update /path/to/repository
code-historian search "qualified symbol"
code-historian retrieve "historical context"
code-historian similar "example.core/answer"
code-historian changes "parser rename"
code-historian doctor recovery
code-historian history "example.core/answer"
code-historian trace "revision-id"
```

Run language-neutral analyzer conformance checks:

```bash
code-historian analyzer check bb -cp analyzers/clojure/src -m code-historian.analyzer
bun run conformance
bun run benchmark /path/to/repository
```

The index stores Git, analyzer metadata, deduplicated symbol revisions, commit
changes, and structural features in SQLite with WAL enabled. Qdrant remains a
rebuildable optional projection; Git and SQLite remain authoritative.
Analyzer workers must use JSONL on stdout, keep logs on stderr, avoid executing
source, and return deterministic results for the same blob and fingerprint.

## Agent skill

The portable agent workflow is in
[`skills/code-historian/SKILL.md`](skills/code-historian/SKILL.md). It is a
shell-backed skill for Kimi, Codex, or another agent host. It does not require
an MCP server or an LLM: the agent invokes the CLI and reports SQLite
provenance from the returned JSON.

Validate a large Git fixture with:

```bash
bun run fixture:large /tmp/code-historian-large-fixture 250
bun run fixture:validate /tmp/code-historian-large-fixture /tmp/code-historian-large.sqlite 250
```

## Design

- [Analyzer protocol](spec/analyzer-protocol.md)
- [Temporal index architecture](spec/temporal-index.md)
- [Analyzer JSON Schemas](spec/schema)

## License

Apache-2.0
