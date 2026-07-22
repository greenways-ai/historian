# Greenways Historian

Git-native temporal code indexing, history, lineage, and structural similarity.

Greenways Historian walks a repository's commit DAG, analyzes changed blobs
once, tracks symbol lineage, and stores deterministic retrieval documents in
SQLite. Git remains the source of truth. No LLM, MCP server, Ollama, Qdrant, or
embedding service is required for the core workflow.

## Requirements

- Bun 1.2.18 or newer
- Git 2.43 or newer
- Babashka 1.12.218 or newer for Clojure analysis
- clj-kondo for the primary Clojure analyzer

`rewrite-clj` is a Clojure library distributed through Maven and declared in
`bb.edn`. Babashka loads it when the rewrite-based analyzer is used; it is not a
separate executable. The environment check verifies that Babashka can load it.

## Install

The npm package is a Bun package. npm is the distribution channel, but the CLI
still runs on Bun because it uses `bun:sqlite`.

```bash
npm install -g @greenways-ai/greenways-historian
greenways-historian doctor
```

Or run it without a global install:

```bash
bunx @greenways-ai/greenways-historian doctor
```

For a self-contained executable, build a platform-specific Bun binary:

```bash
bun build --compile src/cli.js --outfile dist/greenways-historian
```

The npm package includes the CLI source, Babashka analyzers, `bb.edn`, specs,
and the agent skill. Publishing is configured for the public npm registry and
is performed by pushing a `v*` tag through GitHub Actions.

## Quick start

```bash
cp greenways-historian.example.json greenways-historian.json
greenways-historian doctor
greenways-historian init
greenways-historian index /path/to/repository
greenways-historian update /path/to/repository
```

Query the indexed history:

```bash
greenways-historian search "qualified symbol"
greenways-historian retrieve "historical context"
greenways-historian similar "example.core/answer"
greenways-historian changes "parser rename"
greenways-historian history "example.core/answer"
greenways-historian trace "revision-id"
```

The database is stored at `.greenways-historian/index.sqlite` by default. It
uses SQLite WAL mode and content-addressed analyzer results. Re-running
`update` processes only new commits and changed blobs.

## Multiple repositories

Keep one database per repository, preferably outside the checkout:

```text
~/.local/share/greenways-historian/repos/
  foundation-base--<identity-hash>/history.sqlite
  another-project--<identity-hash>/history.sqlite
```

Use a checkout-local `.greenways-historian/` directory when the index should
travel with the project. Repository identity should be based on the canonical
remote URL rather than only the directory name.

## Agent skills

The portable skill is
[`skills/greenways-historian-agent/SKILL.md`](skills/greenways-historian-agent/SKILL.md).
It tells Codex, Kimi, or another agent how to initialize, update, query, and
report provenance from the SQLite index.

### Codex

Install it as a user skill:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/greenways-historian-agent "${CODEX_HOME:-$HOME/.codex}/skills/"
```

It can also be installed at project scope under `.codex/skills/`.

### Kimi Code CLI

Install it in Kimi's shared skill directory:

```bash
mkdir -p "${KIMI_CODE_HOME:-$HOME/.kimi-code}/skills"
cp -R skills/greenways-historian-agent "${KIMI_CODE_HOME:-$HOME/.kimi-code}/skills/"
```

For a project-only skill, use `.kimi-code/skills/greenways-historian-agent/`.
Start a new session and invoke it with `/skill:greenways-historian-agent` when
manual invocation is preferred.

Kimi documentation: <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html>

## Development

```bash
bun run doctor
bun run check
bun run conformance
bun run fixture:large /tmp/greenways-historian-large-fixture 250
bun run fixture:validate /tmp/greenways-historian-large-fixture /tmp/greenways-historian-large.sqlite 250
```

The internal `code_historian.*` Babashka namespaces are retained as analyzer
protocol identifiers for compatibility. They are not the public package or
CLI name.

## License

Apache-2.0
