# Codian 1.3.88 Long-Run Safety Design

## Status

Approved by the user on 2026-08-02. Implementation is authorized through release, Obsidian reinstall, and live verification.

## Goal

Keep Codian stable for at least six months of normal desktop use by closing verified security, resource-boundary, network-stall, diagnostics-privacy, installation-hygiene, and dependency-monitoring gaps without rewriting the runtime architecture or deleting user data.

## Current Evidence

- Installed version: `1.3.87-settings-sanitization`.
- Source baseline: remote `main` at `4b2e3d7d70a4ecd8a96490ce3d5b98be83227160`.
- Baseline tests: 141 suites and 3,907 tests pass.
- Production dependency audit: zero vulnerabilities using the official npm registry.
- Development dependency audit: one high-severity `brace-expansion` advisory.
- Active `.codian` storage: about 13 MiB; session storage: 42 files and about 2.7 MiB.
- Installed plugin folder contains 25 historical `.backup-*` directories totaling about 64 MiB.
- DeepSeek `Grep` accepts an unchecked resolved path and interpolates it into a shell command.
- DeepSeek fetch/SSE reads have no connection or inactivity timeout.
- DeepSeek conversation history and ordinary `Read` results have no common capacity bound.
- Runtime diagnostics persist full notification parameter objects in some paths.
- CI runs on pushes and pull requests only; Dependabot is not configured.
- Repository immutable releases are disabled, and GitHub reports the latest release as mutable.

## Chosen Approach

Use targeted hardening on the current Codex/DeepSeek/MCP architecture. Do not introduce a database, server, Docker service, telemetry backend, new API key, or automatic deletion policy. Preserve existing user sessions, settings, skills, notes, and recovery records.

The rejected alternatives are:

1. Operations-only cleanup, because it leaves current runtime vulnerabilities and indefinite-wait paths unchanged.
2. A runtime rewrite with workers, a database, and telemetry, because it adds more failure modes and maintenance cost than this release needs.

## Architecture

### 1. Vault-only search

Replace the DeepSeek shell-based `Grep` implementation with an Obsidian-Vault-backed search helper. It must:

- reject absolute paths, traversal segments, and paths outside the Vault;
- search Markdown files only;
- compile the user pattern as a regular expression and return a clear error for invalid expressions;
- scan at most 10,000 files, 64 MiB of source text, or 10 seconds;
- return at most 200 matches;
- identify truncation explicitly;
- never execute a shell command.

### 2. Shared DeepSeek capacity boundaries

Add pure helpers for deterministic limits:

- conversation history: newest-first selection up to 80,000 characters, with a 20,000-character maximum per message;
- current prompt: reject above 200,000 characters rather than silently truncating it;
- tool results: 50,000 characters with an explicit truncation suffix;
- serialized API request: 2 MiB maximum;
- SSE incomplete-line buffer: 1 MiB maximum;
- accumulated response text, reasoning, and tool-call argument payloads: 1 MiB each.

The current user prompt and completed write/edit results must never be silently discarded. Older conversation history is the first data removed when constructing a bounded request.

### 3. DeepSeek network liveness

Use a request-scoped abort controller linked to the active user cancellation signal.

- response-header timeout: 30 seconds;
- SSE inactivity timeout: 90 seconds, reset after every received chunk;
- cleanup: remove listeners, clear timers, cancel the reader, and release its lock;
- timeout failures produce a specific retryable user-facing error;
- do not automatically replay a tool round after a file write, Bash command, or MCP action.

### 4. Minimal diagnostics

Persist only bounded, redacted operational metadata:

- notification method;
- error category and bounded message;
- retry flag;
- status and counts;
- configured/not-configured booleans.

Do not persist notification parameter objects, tool arguments, absolute executable paths, environment values, base URLs, user content, file content, or JavaScript stacks. Remove MCP argument logging from the renderer console.

### 5. Long-lived configuration freshness

- Cache directly configured Codex MCP server names for at most 60 seconds.
- Explicit runtime reload invalidates the cache immediately.
- Refresh the Codex model catalog when Codian is opened and the last successful refresh is older than six hours.
- Failed refreshes keep the last verified catalog and do not block opening the view.
- Avoid recurring background timers; refresh is activity-triggered.

### 6. Health and installation diagnostics

Extend secret-free local diagnostics with:

- installed historical-backup directory count;
- storage warnings at 512 MiB or 10,000 files;
- recovery-journal warnings already present;
- no paths or filenames in the returned snapshot.

Add an installed-plugin verifier that requires exactly `main.js`, `manifest.json`, `styles.css`, and `data.json` as top-level files and rejects `.backup-*` directories. It must accept an expected version and expected SHA-256 values.

### 7. Supply-chain maintenance

- Patch both vulnerable `brace-expansion` major lines through targeted npm overrides compatible with their existing dependents.
- Keep production and full-development audits as separate gates.
- Add weekly and manual CI triggers.
- Add weekly Dependabot checks for npm and GitHub Actions, grouped and limited, without automatic merge.
- Enable GitHub immutable releases before publishing `1.3.88`; this only affects future releases.

### 8. Data and install handling

- Hash and inventory the 25 installed `.backup-*` directories.
- Move them, without deletion, to a timestamped archive under `/Users/liuhao/Documents/Codex/2026-08-02/codian-release-backups/`.
- Verify archive file count, byte count, symlink count, and aggregate digest before and after the move.
- Back up the active plugin and `.codian` data outside the Vault before reinstall.
- Replace only `main.js`, `manifest.json`, and `styles.css`.
- Preserve `data.json` byte-for-byte during installation.
- Restart Obsidian and verify the running plugin, not only disk files.

## File Structure

- `src/core/tools/vaultGrep.ts`: bounded, shell-free Vault search.
- `src/core/runtime/deepseekLimits.ts`: pure request, history, result, and stream limits.
- `src/core/runtime/DeepSeekRuntime.ts`: timeout wiring and use of the limit helpers.
- `src/core/runtime/CodexAgentRuntime.ts`: MCP cache TTL and minimal runtime logging.
- `src/core/runtime/CodexAppServerClient.ts`: safe App Server diagnostics.
- `src/core/diagnostics/CodianDiagnostics.ts`: long-run warnings and backup count.
- `src/core/tools/toolExecutor.ts`: Vault grep integration and bounded tool results.
- `src/core/tools/mcpBridge.ts`: shared result limit use.
- `src/main.ts`: activity-triggered model catalog refresh.
- `scripts/verify-installed-plugin.mjs`: installed asset and hygiene verifier.
- `.github/workflows/ci.yml`: scheduled/manual CI and separated audits.
- `.github/dependabot.yml`: weekly dependency PR policy.
- `package.json`, `package-lock.json`, `manifest.json`, `versions.json`: version and dependency policy.
- `tests/`: unit, integration, soak, fault-injection, and verifier coverage.

## Verification

The release is not complete until all of these pass:

1. Existing full suite plus new tests for traversal, injection-shaped patterns, invalid regex, scan caps, history caps, request caps, connection timeout, SSE inactivity timeout, cancellation cleanup, diagnostics redaction, cache expiry, backup detection, and installed verification.
2. Typecheck, lint, build, release packaging, release verification, production audit, and full-development audit.
3. PR CI and merged `main` CI.
4. Immutable release setting confirmed before release publication.
5. Downloaded release assets match local SHA-256 values.
6. Installed runtime assets match the release and `data.json` is unchanged across installation.
7. Obsidian restart and real Codex conversation.
8. DeepSeek availability and a safe read-only test when configured; otherwise configuration validation and mocked fault tests are reported separately.
9. MCP discovery and timeout path verification.
10. Local diagnostics show the intended version, no unexpected warning, readable secure storage, and zero installed backup directories.

## Costs and Maintenance

- New paid services: none.
- New accounts or API keys: none.
- Database, server, and Docker: none.
- GitHub: existing Actions and Releases only.
- Maintenance difficulty: medium-low; limits and diagnostics are isolated helpers with direct tests.
- Compatibility impact: oversized inputs now fail or truncate with an explicit marker; invalid or out-of-Vault DeepSeek search paths are rejected; otherwise existing behavior remains.

## Agent Boundary

One main agent performs planning, implementation, review, release, installation, and verification. No subagents are used. All source edits occur only in `codex/codian-1.3.88-long-run-safety`; installed plugin and backup changes remain limited to the authorized Codian paths.
