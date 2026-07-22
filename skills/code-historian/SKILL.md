---
name: code-historian
description: Use when answering questions about a repository's symbol history, structural similarity, commit changes, lineage, or historical code context. Uses the local Code Historian CLI and SQLite index; does not require MCP, an LLM, embeddings, Qdrant, or Ollama.
---

# Code Historian

Use Code Historian as a deterministic, shell-backed skill for repository history. Git is the source of truth and SQLite is the searchable index. Do not infer historical claims from the current checkout when the index can provide commit and revision provenance.

## Workflow

1. From the repository root, initialize or update the index:

```bash
code-historian init
code-historian index .
code-historian update .
```

2. Select the narrowest query:

```bash
code-historian retrieve "query terms"
code-historian similar "namespace/qualified-name"
code-historian changes "commit or path terms"
code-historian history "namespace/qualified-name"
code-historian trace "revision-id"
```

3. Use `retrieve` for broad historical context. It returns deduplicated symbol revisions and commit-change documents with `provenance`, locations, path changes, and lineage transitions.

4. Use `similar` when the question asks for analogous symbols. Treat `similarity` as a ranking signal composed of lexical, name, kind, namespace, and normalized AST-shape scores, not as proof of equivalence.

5. Use `history` for chronological symbol transitions and `trace` for reference traversal. Preserve revision IDs, commit OIDs, paths, and transition kinds in the answer.

## Clojure analysis

For a source tree that is not being indexed through Git history:

```bash
bb ingest:kondo /path/to/src
code-historian ingest /tmp/analysis.jsonl /path/to/repository
```

The Babashka clj-kondo analyzer emits symbols, references, diagnostics, and normalized structural features. Historical indexing skips submodule gitlinks and resumes from SQLite checkpoints.

## Reporting rules

- State when a result comes from the indexed history and include its commit or revision identifiers.
- Distinguish `introduced`, `modified`, `unchanged`, and `deleted` transitions.
- Prefer exact locations and path changes over prose summaries.
- Report when no indexed result exists instead of fabricating a historical answer.
- Refresh the index with `code-historian update .` when the repository has advanced.

## Validation

Use the repository's deterministic checks when changing the skill or indexer:

```bash
bun run check
bun run conformance
bun run fixture:large /tmp/code-historian-large-fixture 250
bun run fixture:validate /tmp/code-historian-large-fixture /tmp/code-historian-large.sqlite 250
```
