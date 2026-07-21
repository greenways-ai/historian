# Code Historian

Git-native temporal code indexing, history, and tracing.

Code Historian walks a repository's commit DAG, analyzes changed blobs once,
tracks symbol lineage, and stores retrieval documents in Qdrant. Git remains
the source of truth; SQLite stores deterministic metadata and lineage.

## Status

Early development. The first analyzer targets Clojure and runs on Babashka.
The core CLI runs on Bun.

## Requirements

- Bun 1.2.18 or newer
- Babashka 1.12.218 or newer
- Git 2.43 or newer
- Docker for local Qdrant

## Quick start

```bash
cp code-historian.example.json code-historian.json
docker compose up -d qdrant
bun run doctor
bun test
bb run analyzer:test
```

Run the analyzer protocol directly:

```bash
printf '%s\n' '{"protocol_version":"1.0","request_id":"1","op":"describe"}' |
  bb -cp analyzers/clojure/src -m code-historian.analyzer
```

## Design

- [Analyzer protocol](spec/analyzer-protocol.md)
- [Temporal index architecture](spec/temporal-index.md)
- [Analyzer JSON Schemas](spec/schema)

## License

Apache-2.0

