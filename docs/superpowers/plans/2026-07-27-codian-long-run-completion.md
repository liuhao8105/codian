# Codian 1.3.84 Long-Run Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the recovery, diagnostics, bounded-growth, release-verification, and live-validation requirements left open after the verified 1.3.83 stability release.

**Architecture:** Preserve the released 1.3.83 runtime and add small local-only modules at existing boundaries. Persist DeepSeek recovery snapshots through the existing atomic vault adapter, replace repeated Codex session tree scans with a bounded index, strengthen diagnostic log redaction and rotation, expose a secret-free local health snapshot, and make release archives mechanically reproducible.

**Tech Stack:** TypeScript, Jest, Obsidian API, Node.js, esbuild, macOS Keychain, GitHub Actions, GitHub Releases.

## Global Constraints

- Work only in the isolated worktree on `codex/codian-1.3.84-long-run-completion`.
- Never edit or commit directly on `main`.
- Do not delete user notes, sessions, secrets, or the published 1.3.83 release.
- Recovery is manual and user-approved; no automatic restore or deletion.
- Do not claim universal rollback for Codex App Server/Bash changes because the current App Server does not expose complete pre-write file contents and deprecated `thread/rollback` does not restore local files.
- Keep DeepSeek optional and add no dependency, API Key, database, server, Docker service, plugin, paid account, or telemetry.
- Use TDD for every behavior change.
- Version all new release surfaces as `1.3.84-long-run-completion`.

---

### Task 1: Strengthen Bounded Diagnostic Logs

**Files:**
- Modify: `src/utils/boundedLog.ts`
- Modify: `tests/unit/utils/boundedLog.test.ts`

**Interfaces:**
- Produces: `redactDiagnosticText(message: string): string`
- Produces: `appendBoundedLog(filePath, message, maxBytes?, rotations?)`
- Produces: `appendBoundedLogSync(filePath, message, maxBytes?, rotations?)`

- [ ] **Step 1: Write failing redaction tests**

Require bearer tokens, API keys, URL credentials/query secrets, environment assignments, and home-directory paths to be replaced while ordinary error text remains readable.

- [ ] **Step 2: Write failing multi-rotation tests**

Require a fixed maximum of three backups and verify that a fourth rotation removes only the oldest diagnostic backup.

- [ ] **Step 3: Verify the focused suite fails**

Run `npx jest --runInBand --runTestsByPath tests/unit/utils/boundedLog.test.ts`.

- [ ] **Step 4: Implement minimal redaction and rotation**

Redact before byte counting and writing. Rotate from the highest suffix downward and never read, modify, or delete files outside the exact diagnostic path family.

- [ ] **Step 5: Verify and commit**

Run the focused suite, typecheck, lint, and `git diff --check`; commit only the two files.

### Task 2: Add a Bounded Codex Session Index

**Files:**
- Create: `src/core/runtime/CodexSessionIndex.ts`
- Create: `tests/unit/core/runtime/CodexSessionIndex.test.ts`
- Modify: `src/utils/sdkSession.ts`
- Modify: `tests/unit/utils/sdkSession.test.ts`

**Interfaces:**
- Produces: `CodexSessionIndex.find(sessionId): Promise<string | null>`
- Produces: `CodexSessionIndex.findSync(sessionId): string | null`
- Produces: `CodexSessionIndex.invalidate(sessionId): void`
- Consumes: `~/.codex/sessions`, with a hard cap of 20,000 visited entries per rebuild

- [ ] **Step 1: Write failing index tests**

Require one scan for repeated hits and misses, deterministic duplicate handling, stale-hit invalidation, and termination at the visit cap.

- [ ] **Step 2: Verify failure**

Run only the new index suite and confirm the module or behavior is missing.

- [ ] **Step 3: Implement the index**

Build one map per root, cache misses, rebuild once when a cached path disappears, and never delete session files.

- [ ] **Step 4: Replace recursive lookup helpers**

Use one module-level index in `sdkSession.ts`; invalidate it after successful session deletion.

- [ ] **Step 5: Verify and commit**

Run the new index suite, `sdkSession` suite, typecheck, lint, and diff check.

### Task 3: Persist Manual Recovery for DeepSeek Writes

**Files:**
- Create: `src/core/storage/RecoveryJournal.ts`
- Create: `tests/unit/core/storage/RecoveryJournal.test.ts`
- Modify: `src/core/storage/StorageService.ts`
- Modify: `src/core/storage/index.ts`
- Modify: `src/core/tools/toolExecutor.ts`
- Modify: `src/core/runtime/DeepSeekRuntime.ts`
- Modify: `tests/unit/core/tools/toolExecutor.test.ts`

**Interfaces:**
- Produces: `RecoveryJournal.recordPending(input): Promise<RecoveryEntry>`
- Produces: `RecoveryJournal.markApplied(id): Promise<void>`
- Produces: `RecoveryJournal.markRestored(id): Promise<void>`
- Produces: `RecoveryJournal.latestRestorable(): Promise<RecoveryEntry | null>`
- Stores: `.claude/recovery-journal.json`, maximum 50 entries and maximum 1 MiB per snapshot

- [ ] **Step 1: Write failing journal tests**

Require atomic persistence, bounded entries, full before-state capture, create/overwrite/modify actions, pending-crash recoverability, restored-state persistence, and refusal to persist oversized snapshots.

- [ ] **Step 2: Verify failure**

Run only the new journal suite.

- [ ] **Step 3: Implement the journal**

Use `VaultFileAdapter.write`; validate parsed content; keep only journal metadata and before-state snapshots; never automatically restore or delete user files.

- [ ] **Step 4: Write failing executor tests**

Require Write/Edit to persist a pending entry before mutation and mark it applied after success. Require user-approved Undo to fall back to the latest persisted entry after a runtime restart.

- [ ] **Step 5: Integrate with DeepSeek**

Expose `StorageService.recovery`, pass it through `ToolExecutionContext`, and preserve the existing in-memory `TransactionLog` for fast current-session Undo.

- [ ] **Step 6: Verify and commit**

Run recovery, tool executor, DeepSeek runtime, storage, and integration suites.

### Task 4: Add Secret-Free Local Diagnostics

**Files:**
- Create: `src/core/diagnostics/CodianDiagnostics.ts`
- Create: `src/core/diagnostics/index.ts`
- Create: `tests/unit/core/diagnostics/CodianDiagnostics.test.ts`
- Modify: `src/core/security/SecureSecretStorage.ts`
- Modify: `src/core/storage/StorageService.ts`
- Modify: `src/main.ts`
- Modify: `tests/integration/main.test.ts`

**Interfaces:**
- Produces: `collectCodianDiagnostics(input): Promise<CodianDiagnosticsSnapshot>`
- Produces: `SecureSecretStorage.getStatus(): Promise<{ available: boolean; stored: boolean }>`
- Adds command: `codian:copy-local-diagnostics`

- [ ] **Step 1: Write failing diagnostics tests**

Require plugin version, permission mode, provider, secure-storage availability, vault storage counts/sizes, recovery entry count, and compatibility warnings without secrets, absolute paths, usernames, environment values, or telemetry.

- [ ] **Step 2: Verify failure**

Run the new diagnostics suite.

- [ ] **Step 3: Implement snapshot collection**

Use injected stat/list/version providers, hard-cap traversal at 20,000 entries, and return explicit partial warnings instead of hanging or guessing.

- [ ] **Step 4: Add the local command**

Copy formatted JSON to the local clipboard and show a Notice. Do not send it to a model, network endpoint, log, or vault file.

- [ ] **Step 5: Verify and commit**

Run diagnostics, security, main integration, typecheck, lint, and diff check.

### Task 5: Make the Release Reproducible

**Files:**
- Create: `scripts/verify-release.mjs`
- Create: `tests/unit/release/verifyRelease.test.ts`
- Modify: `scripts/build.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `versions.json`
- Modify: `CHANGELOG.md`
- Create: `docs/releases/v1.3.84-long-run-completion.md`

**Interfaces:**
- Produces: `outputs/codian-1.3.84-long-run-completion.zip`
- Produces: `outputs/codian-1.3.84-long-run-completion-rollback.zip`
- Produces: `outputs/codian-1.3.84-long-run-completion-sha256.txt`
- Produces: `npm run verify:release`

- [ ] **Step 1: Write failing release-verifier tests**

Require exact package/manifest/version-map equality, only `main.js`, `manifest.json`, and `styles.css` in the install archive, valid rollback archive contents, and SHA-256 entries matching bytes.

- [ ] **Step 2: Verify failure**

Run only the release verifier suite.

- [ ] **Step 3: Implement packaging and verification**

Use Node standard-library code plus the system `zip`/`unzip` commands already present on macOS. Fail closed on missing, extra, duplicate, or mismatched files.

- [ ] **Step 4: Version and document 1.3.84**

Update every release surface and explicitly document supported recovery scope and the Codex App Server rollback limitation.

- [ ] **Step 5: Verify and commit**

Run build, `npm run verify:release`, `unzip -t` on both archives, tests, typecheck, lint, production audit, and diff check.

### Task 6: Install, Validate, and Publish

**Files:**
- Install: active vault `.obsidian/plugins/codian/`
- Preserve: installed `data.json`
- Publish: GitHub branch, PR, tag, Release, and three install assets plus archives/checksums

**Interfaces:**
- Produces: verified installed `1.3.84-long-run-completion`
- Produces: GitHub tag and non-draft Release

- [ ] **Step 1: Back up and install**

Create a timestamped rollback backup, replace only `main.js`, `manifest.json`, and `styles.css`, and compare SHA-256 hashes.

- [ ] **Step 2: Run live checks**

Verify normal approval deny, a benign yolo write inside a dedicated disposable vault test path followed by manual recovery, MCP on-demand, model listing, settings persistence, session resume, diagnostics command, repeated tab/settings open-close listener cleanup, and no runaway Codex/Obsidian child process.

- [ ] **Step 3: Clean disposable test data**

Remove only the explicitly created probe note through a recoverable trash operation and verify no plaintext secret or temporary image residue.

- [ ] **Step 4: Publish through CI**

Push the branch, open a draft PR, wait for all checks, mark ready, merge, wait for main CI, then tag and publish the immutable release.

- [ ] **Step 5: Completion audit**

Re-read both stability plans, map requirements to current source/runtime/GitHub evidence, record platform limitations, and keep the goal active if any required evidence is missing.
