---
name: greenways-historian-agent
description: Use when answering questions about a repository's symbol history, structural similarity, commit changes, lineage, or historical code context. Uses the Greenways Historian CLI and SQLite index; does not require MCP, an LLM, embeddings, Qdrant, or Ollama.
---

# Greenways Historian Agent

Use Greenways Historian as a deterministic, shell-backed skill for repository
history. Git is the source of truth and SQLite is the searchable index. Do not
infer historical claims from the current checkout when the index can provide
commit and revision provenance.

## Workflow

1. From the repository root, check the local environment:

```bash
gw-historian doctor
```

2. Initialize or update the repository index:

```bash
gw-historian init
gw-historian index .
gw-historian update .
```

3. Select the narrowest query:

```bash
gw-historian retrieve "query terms"
gw-historian similar "namespace/qualified-name"
gw-historian changes "commit or path terms"
gw-historian history "namespace/qualified-name"
gw-historian trace "revision-id"
```

Use `retrieve` for broad context, `history` for chronological symbol
transitions, `similar` for analogous structures, and `trace` for reference
traversal.

## Clojure analysis

The primary analyzer is clj-kondo driven through Babashka. `rewrite-clj` is a
Babashka-loaded Maven dependency and is used by the rewrite analyzer/fallback;
do not look for a `rewrite-clj` executable.

For a source tree outside Git history:

```bash
bb ingest:kondo /path/to/src
gw-historian ingest /tmp/analysis.jsonl /path/to/repository
```

## Reporting

- State that claims come from the indexed history.
- Include commit OIDs, dates, paths, revision IDs, and transition kinds.
- Distinguish `introduced`, `modified`, `unchanged`, `renamed`, `moved`, and `deleted`.
- Treat similarity as a ranking signal, not proof of equivalence.
- Explain when an unchanged structural revision appears across many commits.
- Report missing or failed analysis instead of fabricating symbols.
- Refresh with `gw-historian update .` when the repository advances.

## Multiple repositories

Keep indexes separate by repository identity. Prefer one database per repository
and do not combine results across repositories unless the user asks for a
cross-repository comparison.

## Scope

Do not introduce MCP, an LLM, Ollama, Qdrant, or an embedding provider for the
core workflow. SQLite, Git, Bun, Babashka, and the configured analyzers are
authoritative for this skill.

## JavaScript and TypeScript workflow

Configure `javascript` and `typescript` to use `bun analyzers/typescript/src/analyzer.js`. The worker supports `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, and `.d.ts` and emits normalized declaration shapes, structural hashes, imports, calls, type references, and diagnostics through the existing JSONL protocol.

Treat the initial results as blob-local historical facts. Do not infer successful project-wide module or type resolution from an import reference until project-aware indexing is added.

## Python workflow

Configure `python` to use `python3 analyzers/python/src/analyzer.py`. The worker supports `.py`, `.pyi`, and `.pyw`, uses the standard-library `ast` and `tokenize` modules, and emits normalized declarations, structural features, imports, calls, reads, writes, type references, inheritance, and diagnostics through the existing protocol.
