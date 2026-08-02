# Codian 1.3.88 Long-Run Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship and install Codian `1.3.88-long-run-safety` with verified Vault isolation, bounded DeepSeek resource use, network liveness, secret-free diagnostics, clean installation layout, and six-month maintenance gates.

**Architecture:** Keep the existing Codex, DeepSeek, MCP, and Obsidian view architecture. Add small pure limit/search/diagnostic helpers, wire them into the existing runtimes, and enforce the same invariants in unit tests, release verification, installation verification, and live Obsidian checks.

**Tech Stack:** TypeScript 5, Obsidian desktop API, Node.js 20, Jest 30, esbuild, npm, GitHub Actions, GitHub Releases.

## Global Constraints

- Release version is exactly `1.3.88-long-run-safety`.
- One main agent only; no subagents.
- Source edits occur only in `/Users/liuhao/Documents/Codex/2026-08-02/codian-1.3.88-long-run-safety`.
- Do not delete or rewrite user notes, sessions, skills, settings, licenses, or recovery records.
- Historical plugin backups are moved to a verified archive outside the Vault, never deleted.
- No database, server, Docker service, telemetry backend, paid service, account, or new API key.
- Preserve `data.json` byte-for-byte across installation.
- Production and full-development dependency audits are separate gates.
- No raw protocol parameters, tool arguments, file content, absolute user paths, environment values, base URLs, or JavaScript stacks in persistent diagnostics.
- No automatic replay after DeepSeek file writes, Bash commands, or MCP actions.

---

## File Map

- Create `src/core/runtime/deepseekLimits.ts` for pure capacity helpers and constants.
- Create `src/core/tools/vaultGrep.ts` for bounded Vault-only Markdown search.
- Modify `src/core/runtime/DeepSeekRuntime.ts` for bounded history/request/stream handling and liveness timeouts.
- Modify `src/core/tools/toolExecutor.ts` for safe Grep and common result bounding.
- Modify `src/core/tools/mcpBridge.ts` to reuse the common tool-result bound.
- Modify `src/core/runtime/CodexAgentRuntime.ts` for safe logging and expiring MCP discovery.
- Modify `src/core/runtime/CodexAppServerClient.ts` for minimal persistent diagnostics.
- Modify `src/core/diagnostics/CodianDiagnostics.ts` for long-run warnings and installed-backup count.
- Modify `src/main.ts` for activity-triggered model refresh.
- Create `scripts/verify-installed-plugin.mjs` for installed-file/version/hash/layout checks.
- Modify `.github/workflows/ci.yml` and create `.github/dependabot.yml`.
- Modify `package.json`, `package-lock.json`, `manifest.json`, and `versions.json` for version and patched dependency policy.
- Create `docs/releases/v1.3.88-long-run-safety.md` for release boundaries and verification evidence.

### Task 1: Pure DeepSeek capacity helpers

**Files:**
- Create: `src/core/runtime/deepseekLimits.ts`
- Test: `tests/unit/core/runtime/deepseekLimits.test.ts`

**Interfaces:**
- Produces: `boundText(value: string, maxChars: number, label: string): string`
- Produces: `boundConversationHistory(messages: ChatMessage[]): ChatMessage[]`
- Produces: `assertPromptWithinLimit(prompt: string): void`
- Produces: `assertSerializedRequestWithinLimit(body: unknown): void`
- Produces constants for 80,000 history characters, 20,000 per message, 200,000 prompt characters, 50,000 tool-result characters, 2 MiB request bytes, and 1 MiB stream buffers.

- [x] **Step 1: Write failing limit tests**

```ts
expect(boundText('x'.repeat(50_001), 50_000, 'tool result')).toContain('truncated');
expect(boundConversationHistory(oldestToNewest).at(-1)?.content).toBe('newest');
expect(() => assertPromptWithinLimit('x'.repeat(200_001))).toThrow('200000');
expect(() => assertSerializedRequestWithinLimit({ input: 'x'.repeat(2 * 1024 * 1024) })).toThrow('2 MiB');
```

- [x] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- --runTestsByPath tests/unit/core/runtime/deepseekLimits.test.ts`

Expected: FAIL because `deepseekLimits.ts` does not exist.

- [x] **Step 3: Implement pure deterministic helpers**

Use byte length for the serialized request and character length for text bounds. Select history from newest to oldest, truncate each selected message with an explicit suffix, then restore chronological order. Never mutate the input array.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- --runTestsByPath tests/unit/core/runtime/deepseekLimits.test.ts`

Expected: all capacity tests pass.

- [x] **Step 5: Commit**

```bash
git add src/core/runtime/deepseekLimits.ts tests/unit/core/runtime/deepseekLimits.test.ts
git commit -m "feat: bound deepseek request capacity"
```

### Task 2: Vault-only Grep and common tool-result bounds

**Files:**
- Create: `src/core/tools/vaultGrep.ts`
- Modify: `src/core/tools/toolExecutor.ts`
- Modify: `src/core/tools/mcpBridge.ts`
- Test: `tests/unit/core/tools/vaultGrep.test.ts`
- Test: `tests/unit/core/tools/toolExecutor.test.ts`

**Interfaces:**
- Produces: `searchVaultMarkdown(app: App, pattern: string, relativePath?: string, options?: VaultGrepOptions): Promise<string>`
- Consumes: `boundText` and `MAX_TOOL_RESULT_CHARS` from Task 1.

- [x] **Step 1: Write failing security and capacity tests**

```ts
await expect(searchVaultMarkdown(app, 'token', '../outside')).resolves.toContain('outside the vault');
await expect(searchVaultMarkdown(app, "x'; touch /tmp/pwned; echo '")).resolves.not.toContain('executed');
await expect(searchVaultMarkdown(app, '[')).resolves.toContain('Invalid regular expression');
expect((await searchVaultMarkdown(app, 'hit')).match(/note-/g)?.length).toBeLessThanOrEqual(200);
expect(await executeDeepSeekToolCall(readOfLargeFile, context)).toContain('truncated');
```

- [x] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- --runTestsByPath tests/unit/core/tools/vaultGrep.test.ts tests/unit/core/tools/toolExecutor.test.ts`

Expected: traversal is not rejected and large Read output is unbounded.

- [x] **Step 3: Implement shell-free search**

Use `app.vault.getMarkdownFiles()`, normalized Vault-relative prefixes, `cachedRead`, `RegExp`, `performance.now()`, and counters. Stop at 10,000 files, 64 MiB read, 10 seconds, or 200 matches and append one deterministic truncation line. Do not import `child_process` for Grep.

- [x] **Step 4: Bound every DeepSeek tool result**

Wrap the return value of `executeDeepSeekToolCall` with `boundText(..., MAX_TOOL_RESULT_CHARS, 'tool result')`. Keep existing MCP-specific 50,000-character behavior but call the shared helper so all paths use one suffix and limit.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run: `npm test -- --runTestsByPath tests/unit/core/tools/vaultGrep.test.ts tests/unit/core/tools/toolExecutor.test.ts tests/unit/core/mcp/mcp.test.ts`

Expected: traversal, injection-shaped input, invalid regex, caps, and existing MCP calls pass.

- [x] **Step 6: Commit**

```bash
git add src/core/tools/vaultGrep.ts src/core/tools/toolExecutor.ts src/core/tools/mcpBridge.ts tests/unit/core/tools/vaultGrep.test.ts tests/unit/core/tools/toolExecutor.test.ts
git commit -m "fix: isolate deepseek search to the vault"
```

### Task 3: DeepSeek connection and stream liveness

**Files:**
- Modify: `src/core/runtime/DeepSeekRuntime.ts`
- Test: `tests/unit/core/runtime/DeepSeekRuntime.test.ts`

**Interfaces:**
- Consumes Task 1 limits.
- Produces: `readSseChunkWithTimeout(reader, signal, timeoutMs): Promise<ReadableStreamReadResult<Uint8Array>>`
- Produces timeout messages `DeepSeek API connection timed out after 30000ms.` and `DeepSeek stream was idle for 90000ms.` for deterministic tests.

- [x] **Step 1: Add failing fake-timer tests**

Test a fetch promise that never resolves, a response reader whose second `read()` never resolves, user cancellation before timeout, timer cleanup after success, a malformed 1 MiB SSE line, and an accumulated payload above 1 MiB.

- [x] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- --runTestsByPath tests/unit/core/runtime/DeepSeekRuntime.test.ts`

Expected: hanging fetch/reader promises do not settle.

- [x] **Step 3: Implement response-header timeout**

Create a request-scoped controller, forward the active user abort signal, start a 30-second timer, call fetch with the request signal, and clear/remove all resources as soon as headers arrive or the call fails.

- [x] **Step 4: Implement SSE inactivity and buffer limits**

Race each `reader.read()` against a 90-second inactivity timer. Reset it per chunk. On timeout, cancel the reader and throw. Reject an incomplete SSE line above 1 MiB and accumulated text, reasoning, or tool arguments above 1 MiB.

- [x] **Step 5: Wire history, prompt, result, and request limits**

Call `assertPromptWithinLimit` before creating the turn, add only `boundConversationHistory(...)`, and call `assertSerializedRequestWithinLimit(body)` before fetch. Report limit errors as user-facing errors without automatic replay.

- [x] **Step 6: Run focused tests and confirm GREEN**

Run: `npm test -- --runTestsByPath tests/unit/core/runtime/DeepSeekRuntime.test.ts tests/unit/core/runtime/deepseekLimits.test.ts`

Expected: timeout, cancellation, capacity, and existing tool-loop tests pass.

- [x] **Step 7: Commit**

```bash
git add src/core/runtime/DeepSeekRuntime.ts tests/unit/core/runtime/DeepSeekRuntime.test.ts
git commit -m "fix: bound deepseek network waits"
```

### Task 4: Secret-free persistent diagnostics

**Files:**
- Modify: `src/core/runtime/CodexAgentRuntime.ts`
- Modify: `src/core/runtime/CodexAppServerClient.ts`
- Modify: `src/core/tools/toolExecutor.ts`
- Modify: `src/utils/boundedLog.ts`
- Test: `tests/unit/core/runtime/CodexAgentRuntime.test.ts`
- Test: `tests/unit/core/runtime/CodexAppServerClient.test.ts`
- Test: `tests/unit/utils/boundedLog.test.ts`

**Interfaces:**
- Produces: `summarizeNotificationForLog(notification): string`
- Produces: `summarizeStderrForLog(line: string): string`
- Retains existing bounded-log rotation API.

- [x] **Step 1: Write failing redaction tests**

Feed diagnostics objects containing `params.content`, `arguments`, `/Users/example/private.md`, a base URL with a token, environment values, and a stack. Assert none of those values occurs in the persisted log while method, retry flag, and error category remain.

- [x] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- --runTestsByPath tests/unit/core/runtime/CodexAgentRuntime.test.ts tests/unit/core/runtime/CodexAppServerClient.test.ts tests/unit/utils/boundedLog.test.ts`

Expected: current `fullParams`, `params`, CLI path, and stack logs violate assertions.

- [x] **Step 3: Implement structured summaries**

Log notification method, sorted top-level key names, retry boolean, bounded error message, status, and counts only. Log `baseUrlConfigured=true|false` and `cliResolved=true|false`, not their values. Remove stack creation from kill/cancel logging. Keep raw stderr only in the in-memory 20-line error context; persist a classified/bounded form.

- [x] **Step 4: Remove MCP argument logging**

Delete the `args=` console output. If a debug line remains, include only tool name and risk class.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run the same focused command from Step 2.

Expected: metadata remains useful and all sensitive values are absent.

- [x] **Step 6: Commit**

```bash
git add src/core/runtime/CodexAgentRuntime.ts src/core/runtime/CodexAppServerClient.ts src/core/tools/toolExecutor.ts src/utils/boundedLog.ts tests/unit/core/runtime/CodexAgentRuntime.test.ts tests/unit/core/runtime/CodexAppServerClient.test.ts tests/unit/utils/boundedLog.test.ts
git commit -m "fix: minimize persistent runtime diagnostics"
```

### Task 5: Configuration freshness without background timers

**Files:**
- Modify: `src/core/runtime/CodexAgentRuntime.ts`
- Modify: `src/main.ts`
- Test: `tests/unit/core/runtime/CodexAgentRuntime.test.ts`
- Test: `tests/unit/mainModelCatalog.test.ts`

**Interfaces:**
- MCP cache TTL: 60,000 ms.
- Model catalog successful-refresh TTL: 21,600,000 ms.
- Explicit `reloadMcpServers()` clears MCP discovery immediately.

- [x] **Step 1: Write failing fake-clock tests**

Assert two MCP reads inside 60 seconds share one discovery, a read after 60 seconds refreshes, explicit reload refreshes immediately, opening Codian inside six hours does not fetch models again, and opening after six hours does.

- [x] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- --runTestsByPath tests/unit/core/runtime/CodexAgentRuntime.test.ts tests/unit/mainModelCatalog.test.ts`

- [x] **Step 3: Implement timestamped cache state**

Store the promise and its creation timestamp. Expire before lookup and clear both fields on reload. Track last successful model refresh only; call refresh from `activateView()` without awaiting it, and keep current models on failure.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run the command from Step 2.

- [x] **Step 5: Commit**

```bash
git add src/core/runtime/CodexAgentRuntime.ts src/main.ts tests/unit/core/runtime/CodexAgentRuntime.test.ts tests/unit/mainModelCatalog.test.ts
git commit -m "fix: refresh long-lived runtime catalogs"
```

### Task 6: Long-run diagnostics and installed-plugin verifier

**Files:**
- Modify: `src/core/diagnostics/CodianDiagnostics.ts`
- Create: `scripts/verify-installed-plugin.mjs`
- Modify: `package.json`
- Test: `tests/unit/core/diagnostics/CodianDiagnostics.test.ts`
- Test: `tests/unit/scripts/verifyInstalledPlugin.test.ts`

**Interfaces:**
- Diagnostic field: `installation.historicalBackupDirectories: number`.
- Warnings: `storage-large`, `storage-file-count-large`, `installed-backups-present`.
- CLI: `node scripts/verify-installed-plugin.mjs --plugin-dir PATH --version VERSION --sha256-file PATH`.

- [x] **Step 1: Write failing diagnostics tests**

Assert warnings at 512 MiB, 10,000 files, and one `.backup-*` directory. Assert returned JSON contains counts only and no filenames or absolute paths.

- [x] **Step 2: Write failing verifier tests**

Create temporary plugin fixtures for a valid four-file install, wrong version, wrong hash, missing file, unexpected top-level file, and `.backup-*` directory. Assert only the valid fixture exits zero.

- [x] **Step 3: Run focused tests and confirm RED**

Run: `npm test -- --runTestsByPath tests/unit/core/diagnostics/CodianDiagnostics.test.ts tests/unit/scripts/verifyInstalledPlugin.test.ts`

- [x] **Step 4: Implement diagnostics and verifier**

Use Vault adapter aggregates for `.codian` and top-level `.obsidian/plugins/codian` names. The verifier parses the existing release checksum format, hashes the three runtime assets, checks version, requires `data.json`, and rejects every extra top-level entry.

- [x] **Step 5: Run focused tests and confirm GREEN**

Run the command from Step 3.

- [x] **Step 6: Commit**

```bash
git add src/core/diagnostics/CodianDiagnostics.ts scripts/verify-installed-plugin.mjs package.json tests/unit/core/diagnostics/CodianDiagnostics.test.ts tests/unit/scripts/verifyInstalledPlugin.test.ts
git commit -m "feat: verify long-run installation health"
```

### Task 7: Dependency and CI maintenance gates

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Test: `tests/unit/release/packagePolicy.test.ts`

**Interfaces:**
- npm overrides pin vulnerable 1.x and 2.x `brace-expansion` trees to patched versions compatible with their major line.
- CI triggers: pull request, push to `main`, weekly cron, and manual dispatch.
- Dependabot: weekly npm and GitHub Actions, grouped patch/minor PRs, maximum five open PRs, no auto-merge.

- [x] **Step 1: Add failing package-policy assertions**

Assert the exact versioned overrides exist, CI includes `schedule` and `workflow_dispatch`, CI uses the official npm registry for both audits, and Dependabot includes npm and GitHub Actions.

- [x] **Step 2: Run policy test and confirm RED**

Run: `npm test -- --runTestsByPath tests/unit/release/packagePolicy.test.ts`

- [x] **Step 3: Apply targeted overrides and regenerate lockfile**

Use npm's version-qualified override keys for `<1.1.17` and `>=2.0.0 <2.1.3`, then run `npm install --package-lock-only --registry=https://registry.npmjs.org`.

- [x] **Step 4: Add CI and Dependabot configuration**

Keep production audit as an explicit first gate. Add full-development high-severity audit after install. Add weekly Sunday execution and manual dispatch. Configure grouped, non-automatic dependency PRs.

- [x] **Step 5: Verify dependency trees and audits**

Run:

```bash
npm ci
npm ls brace-expansion --all
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm audit --audit-level=high --registry=https://registry.npmjs.org
npm test -- --runTestsByPath tests/unit/release/packagePolicy.test.ts
```

Expected: both audits report zero high/critical vulnerabilities and policy tests pass.

- [x] **Step 6: Commit**

```bash
git add package.json package-lock.json .github/workflows/ci.yml .github/dependabot.yml tests/unit/release/packagePolicy.test.ts
git commit -m "build: add long-run dependency gates"
```

### Task 8: Version, release documentation, and full local verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `versions.json`
- Create: `docs/releases/v1.3.88-long-run-safety.md`
- Modify: release tests when version-specific assertions require it.

**Interfaces:**
- All version surfaces use `1.3.88-long-run-safety`.
- Release note records exact limits, compatibility changes, data boundaries, and validation commands.

- [x] **Step 1: Update every version surface and release notes**

Run the existing version sync after changing `package.json`, then add the `versions.json` mapping to Obsidian `1.4.5`. Document that oversized inputs now receive explicit errors/truncation and out-of-Vault Grep is rejected.

- [x] **Step 2: Run all local gates**

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run package:release
npm run verify:release
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm audit --audit-level=high --registry=https://registry.npmjs.org
git diff --check
```

Expected: every command exits zero; all release assets verify.

- [x] **Step 3: Run fault and soak suites separately**

Run the new DeepSeek timeout, Vault Grep, diagnostics, installed verifier, session-index cap, recovery-journal cap, and bounded-log rotation tests with `--runInBand` and record counts in the release note.

- [x] **Step 4: Commit**

```bash
git add package.json package-lock.json manifest.json versions.json docs/releases/v1.3.88-long-run-safety.md
git commit -m "release: prepare 1.3.88 long-run safety"
```

### Task 9: Archive installed backups and close the local install matrix

**Files:**
- External archive: `/Users/liuhao/Documents/Codex/2026-08-02/codian-release-backups/codian-historical-plugin-backups-<timestamp>/`
- Installed plugin: `/Users/liuhao/Library/Mobile Documents/iCloud~md~obsidian/Documents/.obsidian/plugins/codian/`
- Active data: `/Users/liuhao/Library/Mobile Documents/iCloud~md~obsidian/Documents/.codian/`

**Interfaces:**
- Archive manifest records relative path, type, size, and SHA-256 for every regular file without following symlinks.
- Pre-install backup remains outside the active plugin directory.

- [x] **Step 1: Create immutable evidence before moving**

Record installed version, runtime asset hashes, `data.json` hash, backup-directory count, file count, byte count, symlink count, and aggregate manifest digest. Stop if any target resolves outside the exact Codian plugin folder.

- [x] **Step 2: Copy then verify the archive**

Copy all 25 `.backup-*` directories without following symlinks. Generate the destination manifest and require the aggregate digest to match the source.

- [x] **Step 3: Move source backup directories out of the active plugin folder**

After matching verification, move the original directories into the verified external archive. Do not delete them. Confirm zero `.backup-*` directories remain active.

- [x] **Step 4: Run the installed verifier against the current 1.3.87 install**

Expected: exact runtime layout and current hashes pass after the archive move.

- [x] **Step 5: Record the archive receipt in the external backup folder**

The receipt includes counts and aggregate digest only; it does not alter the Vault.

### Task 10: PR, immutable release, safe reinstall, and live verification

**Files/External State:**
- Branch: `codex/codian-1.3.88-long-run-safety`
- Pull request and GitHub Actions in `liuhao8105/codian`
- Release tag: `v1.3.88-long-run-safety`
- Installed plugin and external backups from Task 9.

**Interfaces:**
- GitHub immutable releases endpoint reports `enabled: true` before publication.
- Release assets match local artifacts byte-for-byte.

- [ ] **Step 1: Push branch and create PR**

Push without force. Create a ready PR summarizing verified risks, fixes, compatibility, data preservation, and complete test evidence.

- [ ] **Step 2: Wait for PR CI and resolve every failure**

Require typecheck, lint, full tests, build, production audit, and full-development audit to pass. Merge only after the current head SHA is green.

- [ ] **Step 3: Verify merged `main` CI**

Require the merge commit's push workflow to pass.

- [ ] **Step 4: Enable immutable releases and verify the setting**

Use the official repository endpoint and confirm `enabled: true`. Do this before publishing because existing releases do not become immutable retroactively.

- [ ] **Step 5: Publish and verify Release**

Tag the merged commit, publish the five intended assets, download them into a fresh temporary directory, verify the checksum file, compare local/remote SHA-256 values, and confirm the release reports immutable.

- [ ] **Step 6: Back up and reinstall**

Back up the current active plugin and `.codian` data outside the Vault. Record `data.json` hash. Replace only `main.js`, `manifest.json`, and `styles.css` from the downloaded release. Confirm `data.json` is unchanged and run the installed verifier.

- [ ] **Step 7: Restart Obsidian and run live checks**

Confirm the running version, send `只回复 CODIAN_1388_OK` through Codex, exercise cancellation/timeout-safe UI behavior, verify MCP discovery, and run a safe DeepSeek read-only probe when configured. If DeepSeek is not configured, record that live external API behavior is unavailable and rely only on configuration validation plus fault-injection tests for that provider.

- [ ] **Step 8: Run final post-runtime audit**

Re-run installed hashes, top-level layout, active settings marker scan, secret-free diagnostics, secure storage status, warning count, runtime error logs, active backup count, process count, and `data.json` validity. Confirm source, release, install, and runtime evidence agree.

- [ ] **Step 9: Mark the goal complete only after every requirement is evidenced**

Record final PR, merge SHA, tag, release URL, asset digests, backup/archive paths, test totals, live responses, and any explicitly unavailable external test. Do not claim six-month stability from test success alone; claim that every identified and controllable failure mode in this audit is resolved and monitored.
