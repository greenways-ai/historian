# Operations Guide

## Environment

Run the check before indexing:

```bash
gw-historian doctor
```

The required runtime is Bun, Git, and an analyzer runtime for the languages in
use. Clojure analysis additionally requires Babashka and clj-kondo; the doctor
command verifies that Babashka can load the bundled `rewrite-clj` dependency.

## Install and configure

The npm package distributes the CLI and analyzer assets:

```bash
npm install -g @greenways-ai/historian
gw-historian doctor
```

The command runs on Bun because the SQLite driver is `bun:sqlite`. Use `bunx`
or a compiled Bun binary when Bun is already managed by the host environment.

Start from `greenways-historian.example.json`. The configuration selects Git
refs and analyzer commands; it does not require a database server, embedding
model, or retrieval service.

## Index lifecycle

```bash
gw-historian init
gw-historian index /path/to/repository
gw-historian update /path/to/repository
gw-historian doctor recovery /path/to/repository .greenways-historian/index.sqlite
```

`index` walks the configured history from the beginning. `update` resumes from
the checkpoint and processes only newly reachable commits and changed blobs.
Git remains authoritative for content and ancestry; SQLite stores normalized
facts, revisions, transitions, references, diagnostics, and retrieval indexes.

Useful queries are:

```bash
gw-historian search "qualified symbol"
gw-historian retrieve "historical context"
gw-historian similar "example.core/answer"
gw-historian changes "parser rename"
gw-historian history "example.core/answer"
gw-historian trace "revision-id" --max-depth 8 --max-paths 32
```

Similarity combines lexical and structural evidence. It is a ranking signal,
not proof that two symbols are equivalent. Trace results are bounded and mark
unresolved, dynamic, cyclic, and depth-limited paths explicitly.

## Database placement and backups

The default database is `.greenways-historian/index.sqlite` in the current
working directory. For multiple repositories, use one database per canonical
repository identity, for example:

```text
~/.local/share/greenways-historian/repos/
  foundation-base--<identity-hash>/history.sqlite
  another-project--<identity-hash>/history.sqlite
```

Do not merge repositories into one index. Stop active indexing before copying
SQLite files. For a consistent backup with the SQLite CLI installed:

```bash
sqlite3 .greenways-historian/index.sqlite \
  "VACUUM INTO '/backups/foundation-base-history.sqlite'"
```

Keep Git available for source recovery. SQLite is a derived, rebuildable index;
the backup is useful for preserving analysis work and query state, not for
replacing the repository.

## Recovery and maintenance

`doctor recovery` reports shallow history, rewritten refs, interrupted jobs,
SQLite integrity, and foreign-key consistency. A shallow clone is rejected
because it cannot provide complete ancestry. A failed analyzer batch remains
retryable and does not advance the checkpoint.

Use `repair` after correcting an analyzer or environment problem, and `gc`
only when explicitly removing unreachable derived rows is intended. Keep the
database and Git checkout on local storage for best update throughput.

## Performance and sizing

Run the deterministic large-history regression fixture with:

```bash
bun run benchmark:validate
```

The standard fixture contains 10,000 commits and reports wall time, process-tree
RSS including Babashka workers, SQLite/WAL size, cache reuse, no-op update
latency, and host metadata. `HISTORIAN_MAX_RSS_KB` controls the RSS gate; wall
time is reported but not treated as a hardware-independent pass/fail threshold.

## Troubleshooting

- `missing bb` or `missing clj-kondo`: install the runtime required by the configured analyzer and rerun `gw-historian doctor`.
- `rewrite-clj` failed to load: verify the packaged `bb.edn` is present and run the doctor command from the package environment.
- `shallow history`: fetch complete ancestry or index a non-shallow clone.
- `analysis batch failed`: fix the analyzer error and rerun `gw-historian update`; the failed commit remains resumable.
- `unresolved` or `dynamic` trace terminals: treat them as explicit analysis uncertainty, not as evidence that the target does not exist.
- high downstream memory: set analyzer concurrency deliberately and inspect the process-tree RSS reported by benchmark and recovery workflows.

