# Codian 1.3.83 Stability Hardening Design

## Goal

Turn the installed but uncommitted `1.3.82-mcp-on-demand` source into a reproducible, secure-by-default, recoverable, and maintainable release that can run for at least six months without silent permission drift, unbounded local growth, or an undocumented release state.

## Selected Approach

Keep Codian as an independent fork and harden the existing Codex App Server integration. Do not merge the rewritten Claudian 2.x history and do not replace the runtime with another framework. Preserve the 1.3.82 network and MCP recovery behavior, then release the result as `1.3.83-stability-hardening`.

This is lower risk than a wholesale upstream port and more maintainable than continuing to install ignored build artifacts from an uncommitted worktree. Dependency changes are limited to the MCP SDK security update and transitive fixes required by it.

## Architecture

The runtime remains split into Codex App Server, `codex exec` helpers, and the optional DeepSeek adapter. New boundaries are introduced only where a failure currently crosses concerns:

- `CodexAppServerClient` handles both responses and server-initiated requests.
- `CodexAgentRuntime` maps the visible permission mode to App Server approval policy and routes approval requests through the existing UI callback.
- `VaultFileAdapter` owns atomic writes and recoverable backups for vault data.
- A bounded diagnostic logger replaces unconditional append-only logs.
- Session lookup uses a cached index rather than recursively walking all global Codex sessions for every operation.
- Temporary image materialization has explicit lifetime and cleanup.
- UI components that register global listeners expose `dispose()`.
- A local diagnostics snapshot reports version, runtime, storage, and compatibility state without remote telemetry.

## Security and Data Flow

New installations default to `normal`; existing stored `yolo` selections are preserved. `normal` maps to App Server `on-request`, `plan` maps to `on-request` with the existing plan UI, and `yolo` maps to `never`. Server-initiated command and file-change approval requests are translated to the existing approval modal and answered with App Server decisions.

DeepSeek API keys and environment snippets must not be written as plaintext to the iCloud-synced vault. Device-local Electron `safeStorage` is used when available. Plaintext legacy values are migrated on load, verified, and then removed from vault settings. If secure storage is unavailable, secrets remain memory-only and the UI explains that they must be supplied through the process environment.

Settings and session writes use a sibling temporary file, verify the written content, preserve one backup, and rename into place. Automatic retention never deletes user sessions. Diagnostics show storage growth and provide manual archive/export entry points only.

## Failure Handling

- Unsupported App Server request methods receive a JSON-RPC method-not-found response instead of hanging.
- Approval cancellation denies the operation and cancels the turn only when the user explicitly cancels.
- Atomic-write failures retain the original file and surface an error.
- Diagnostic logs rotate by size, retain a small fixed count, and redact paths, URLs, tokens, and environment values.
- Temporary images are removed after the turn and stale files are pruned on startup.
- Session index failures fall back to a bounded scan and rebuild the index.
- CLI compatibility is checked at startup; unsupported versions produce a visible diagnostic warning rather than an unexplained runtime failure.

## Verification

Every behavior change follows red-green-refactor tests. Release gates are:

1. `npm run typecheck`
2. `npm run lint`
3. `npm test -- --runInBand`
4. `npm run build`
5. `git diff --check`
6. official npm production audit with no high or critical vulnerabilities
7. archive integrity and manifest/package/version consistency
8. source/build/installed SHA-256 equality
9. live Obsidian checks for normal approval, yolo execution, MCP on-demand, settings persistence, session resume, and rollback

No database, server, Docker service, new plugin, or paid account is required. GitHub Actions and GitHub Releases are the deployment path.
