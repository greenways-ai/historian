# Temporal Index Architecture

## Invariants

Git is the authoritative content and ancestry store. SQLite stores extracted
facts and lineage. Qdrant stores disposable retrieval projections. Rebuilding
Qdrant from Git and SQLite MUST produce an equivalent index.

The index MUST NOT store a repository snapshot per commit or a transitive
commit closure. Work and storage scale with commits, changed paths, distinct
blobs, and distinct symbol revisions rather than `commits * repository size`.

## Commit traversal

V1 indexes every commit reachable from the configured default ref. Commits are
streamed parent-before-child using Git's topological order. The database stores
commit OID, tree OID, direct parent OIDs, author/committer metadata, message,
and generation number.

Native Git provides object access and reachability:

```text
git rev-list --topo-order --reverse <ref>
git cat-file --batch-command
git diff-tree -r -M -C <parent> <commit>
git merge-base --is-ancestor <candidate> <commit>
```

No subprocess is started per blob. `cat-file --batch-command` remains alive
for an indexing run. Git's commit graph remains responsible for accelerated
reachability.

## Content-addressed extraction

Analysis is cached by `(blob_oid, analyzer_fingerprint, config_hash)`. A blob
shared by commits or branches is parsed once. Binary, generated, vendored, and
oversized inputs are recorded as skipped with a reason.

A symbol revision is content-addressed from analyzer identity, kind,
normalized structure, signature, documentation, and relevant metadata. Line
movement and unrelated edits do not create semantic revisions. Location
observations are stored separately from semantic revisions.

## Lineage

Repository-wide `symbol_id` represents a logical symbol. Each change creates a
transition between zero or more parent revisions and zero or more child
revisions. Transition types are `introduced`, `unchanged`, `modified`,
`renamed`, `moved`, `renamed_moved`, `split`, `merged`, `deleted`, and
`resurrected`.

Matching proceeds from strongest to weakest evidence:

1. same path, qualified name, and kind
2. Git path rename plus same qualified name
3. identical structural hash across name or path changes
4. weighted structure, tokens, signature, references, name, and diff overlap
5. split/merge overlap across multiple candidates

Every non-exact transition stores confidence and component evidence. Ambiguous
candidates remain candidates; they are never silently promoted to facts.

A merge commit is compared with every parent. Identical child revisions are
deduplicated and a merged revision may have multiple parents. Force-pushed or
deleted refs only alter ref reachability; immutable artifacts remain until
explicit garbage collection.

## Bounded execution

The coordinator uses bounded queues for blob reads, analyzers, embeddings, and
Qdrant writes. SQLite uses WAL mode and one batched writer. A checkpoint is
committed atomically with every batch and records ref head, last completed
commit, analyzer fingerprint, schema version, and embedding fingerprint.

Restart resumes at the last committed batch. A changed fingerprint invalidates
only dependent projections. Peak memory is bounded by queue limits and maximum
artifact size, not history size.

## Retrieval projections

`code_current` contains one point per current symbol chunk. `code_history`
contains immutable semantic revisions and meaningful transitions. Oversized
symbols use deterministic 16 KiB UTF-8 chunks with 1 KiB overlap and repeated
symbol header context.

Qdrant payloads contain repository, symbol, revision, commit, language, kind,
qualified name, path, signature, documentation, chunk position, change type,
and bounded retrieval text. Full source remains in Git.

Dense Qdrant retrieval is fused through reciprocal-rank fusion with SQLite
FTS5 identifier and path retrieval. History and trace results are then expanded
deterministically through SQLite lineage and reference edges.

