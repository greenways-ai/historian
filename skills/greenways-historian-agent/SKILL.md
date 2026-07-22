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
greenways-historian doctor
```

2. Initialize or update the repository index:

```bash
greenways-historian init
greenways-historian index .
greenways-historian update .
```

3. Select the narrowest query:

```bash
greenways-historian retrieve "query terms"
greenways-historian similar "namespace/qualified-name"
greenways-historian changes "commit or path terms"
greenways-historian history "namespace/qualified-name"
greenways-historian trace "revision-id"
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
greenways-historian ingest /tmp/analysis.jsonl /path/to/repository
```

## Reporting

- State that claims come from the indexed history.
- Include commit OIDs, dates, paths, revision IDs, and transition kinds.
- Distinguish `introduced`, `modified`, `unchanged`, `renamed`, `moved`, and `deleted`.
- Treat similarity as a ranking signal, not proof of equivalence.
- Explain when an unchanged structural revision appears across many commits.
- Report missing or failed analysis instead of fabricating symbols.
- Refresh with `greenways-historian update .` when the repository advances.

## Multiple repositories

Keep indexes separate by repository identity. Prefer one database per repository
and do not combine results across repositories unless the user asks for a
cross-repository comparison.

## Scope

Do not introduce MCP, an LLM, Ollama, Qdrant, or an embedding provider for the
core workflow. SQLite, Git, Bun, Babashka, and the configured analyzers are
authoritative for this skill.
