# Historian

Git-native temporal code indexing, history, lineage, and structural similarity.

Greenways Historian walks a repository's commit DAG, analyzes changed blobs
once, tracks symbol lineage, and stores deterministic retrieval documents in
SQLite. Git remains the source of truth. No LLM, MCP server, Ollama, Qdrant, or
embedding service is required for the core workflow.

## Requirements

- Bun 1.2.18 or newer
- Git 2.43 or newer
- Python 3.10 or newer for Python analysis (standard library only)
- Babashka 1.12.218 or newer for Clojure analysis
- clj-kondo for the primary Clojure analyzer

`rewrite-clj` is a Clojure library distributed through Maven and declared in
`bb.edn`. Babashka loads it when the rewrite-based analyzer is used; it is not a
separate executable. The environment check verifies that Babashka can load it.

## Install

The npm package is a Bun package. npm is the distribution channel, but the CLI
still runs on Bun because it uses `bun:sqlite`.

```bash
npm install -g @greenways-ai/historian
gw-historian doctor
```

Or run it without a global install:

```bash
bunx @greenways-ai/historian doctor
```

For a self-contained executable, build a platform-specific Bun binary:

```bash
bun build --compile src/cli.js --outfile dist/gw-historian
```

The npm package includes the CLI source, Babashka analyzers, `bb.edn`, specs,
and the agent skill. Publishing uses npm Trusted Publishing through GitHub
Actions, with OIDC authentication and automatic provenance. Configure the npm
package's trusted publisher as `greenways-ai/historian` with workflow filename
`publish.yml`, then publish a version by pushing a matching `v*` tag. The
package must already exist on npm before its Trusted Publisher can be configured;
bootstrap the first release manually if necessary, then use the workflow for
subsequent releases:

```bash
npm version patch
git push origin main --follow-tags
```

The workflow verifies that the tag matches `package.json`, runs the complete
project test suite and TypeScript/Python analyzer conformance, validates the
package contents, and publishes to the public npm registry. No long-lived
`NPM_TOKEN` is required.

## Quick start

```bash
cp greenways-historian.example.json greenways-historian.json
gw-historian doctor
gw-historian init
gw-historian index /path/to/repository
gw-historian update /path/to/repository
```

Query the indexed history:

```bash
gw-historian search "qualified symbol"
gw-historian retrieve "historical context"
gw-historian similar "example.core/answer"
gw-historian changes "parser rename"
gw-historian history "example.core/answer"
gw-historian trace "revision-id"
```

The database is stored at `.greenways-historian/index.sqlite` by default. It
uses SQLite WAL mode and content-addressed analyzer results. Re-running
`update` processes only new commits and changed blobs.

See [`docs/operations.md`](docs/operations.md) for backups, recovery,
performance sizing, and troubleshooting. See
[`docs/analyzer-authoring.md`](docs/analyzer-authoring.md) for the analyzer
protocol and conformance workflow.

## Multiple repositories

The basic operating model is one Git checkout and one Historian SQLite database
per repository. Historian analyzes Python, JavaScript/TypeScript, and Clojure
files automatically based on their extensions.

Use complete clones; shallow clones are rejected because Historian needs the
repository ancestry:

```bash
git clone https://github.com/psf/requests.git ~/src/requests
```

Create a dedicated index directory for each repository. The CLI reads its
configuration from the current directory and stores the default database there:

```bash
mkdir -p ~/.local/share/greenways-historian/requests
cd ~/.local/share/greenways-historian/requests
cp /path/to/historian/greenways-historian.example.json greenways-historian.json
```

When the index directory is separate from the Historian checkout, use absolute
paths for analyzer commands in `greenways-historian.json`:

```json
{
  "analyzers": {
    "python": {
      "command": ["python3", "/path/to/historian/analyzers/python/src/analyzer.py"],
      "extensions": [".py", ".pyi", ".pyw"]
    }
  }
}
```

Keep the JavaScript/TypeScript and Clojure entries too when the repository uses
those languages. Then initialize and index the repository:

```bash
gw-historian doctor
gw-historian init
gw-historian index ~/src/requests
```

Query it from the same index directory:

```bash
gw-historian search "session adapter"
gw-historian similar "Session"
gw-historian history "sessions/Session"
gw-historian changes "authentication"
gw-historian retrieve "how sessions are configured"
gw-historian trace "Session" --max-depth 8 --max-paths 32
```

Python symbols currently use the source file's module basename, so a symbol
may appear as `sessions/Session` rather than a full package import path.

After new commits, update the same index:

```bash
cd ~/.local/share/greenways-historian/requests
gw-historian update ~/src/requests
```

Only newly reachable commits and changed blobs are processed. Add another
repository by giving it a separate index directory and database:

```bash
mkdir -p ~/.local/share/greenways-historian/flask
cd ~/.local/share/greenways-historian/flask
cp /path/to/historian/greenways-historian.example.json greenways-historian.json
gw-historian init
gw-historian index ~/src/flask
```

Do not combine unrelated repositories into one Historian database.

The resulting layout can look like this:

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
bun run conformance:typescript
bun run conformance:python
bun run benchmark:validate
bun run fixture:large /tmp/greenways-historian-large-fixture 250
bun run fixture:validate /tmp/greenways-historian-large-fixture /tmp/greenways-historian-large.sqlite 250
```

The internal `greenways_historian.*` Babashka namespaces are retained as analyzer
protocol identifiers for compatibility. They are not the public package or
CLI name.

## License

Apache-2.0

## JavaScript and TypeScript analysis

Historian can analyze JavaScript and TypeScript blobs with the bundled Bun worker. It supports `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, and `.d.ts` files and emits the same symbol, reference, diagnostic, and structural-feature protocol used by the Clojure analyzer.

The first implementation is intentionally blob-local: it extracts declarations, imports, calls, type references, inheritance, and normalized AST shape without requiring a project build or an LLM. Project-wide module and type resolution can be layered on later without changing the historical storage contract.

## Python analysis

Historian can analyze Python blobs with the bundled `python3` worker. It supports `.py`, `.pyi`, and `.pyw` files and emits declarations, imports, calls, reads, writes, type references, inheritance, diagnostics, and deterministic structural features through the same JSONL analyzer protocol.

The worker uses Python's standard-library `ast` parser and `tokenize` module, so Python analysis does not require installing a third-party AST package. Configure it with `python3 analyzers/python/src/analyzer.py`.
