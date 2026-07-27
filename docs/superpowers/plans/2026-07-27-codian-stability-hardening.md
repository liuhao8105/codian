# Codian 1.3.83 Stability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `1.3.83-stability-hardening` as a reproducible, secure-by-default, recoverable Codian release and install and verify it in the active Obsidian vault.

**Architecture:** Preserve the verified 1.3.82 runtime and add focused boundaries for App Server approvals, secure local secrets, atomic storage, bounded diagnostics, session indexing, temporary-file cleanup, and disposable UI listeners. Release automation makes the source commit, package, installed files, and GitHub artifacts independently verifiable.

**Tech Stack:** TypeScript, Jest, Obsidian API, Electron `safeStorage`, Codex App Server JSON-RPC, Node.js, esbuild, GitHub Actions.

## Global Constraints

- Work only in `fix/codian-1.3.79-network-resilience`.
- Preserve all current 1.3.82 source and release changes.
- Do not merge upstream Claudian history.
- Do not delete or automatically expire user sessions, vault files, or secrets before verified migration.
- Do not use `npm audit fix --force` or perform unrelated dependency upgrades.
- Keep DeepSeek optional and require no new database, server, Docker service, plugin, or paid account.
- Use TDD for every behavior change.
- Version all release surfaces as `1.3.83-stability-hardening`.

---

### Task 1: Preserve the 1.3.82 Release Baseline

**Files:**
- Create: `docs/plans/2026-07-27-codian-stability-hardening-design.md`
- Create: `docs/superpowers/plans/2026-07-27-codian-stability-hardening.md`
- Preserve: all current modified and untracked 1.3.82 files

**Interfaces:**
- Consumes: installed 1.3.82 hashes and the existing dirty worktree
- Produces: a committed baseline that can be recovered independently of ignored build artifacts

- [ ] **Step 1: Re-run the seven release suites**

Run the existing 201-test release command and require zero failures.

- [ ] **Step 2: Verify installed hashes**

Compare `main.js`, `manifest.json`, and `styles.css` against the installed plugin with SHA-256.

- [ ] **Step 3: Commit the complete baseline**

Stage only the current 1.3.82 changes and the two plan documents, then commit as `chore: preserve Codian 1.3.82 release source`.

### Task 2: Repair the Quality and Dependency Baseline

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: files reported by ESLint only where required
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: npm lockfile and existing scripts
- Produces: reproducible dependency versions and a CI gate

- [ ] **Step 1: Add a failing dependency-policy test**

Create a test that reads `package.json` and requires a pinned Obsidian development version, no unused `@openai/codex-sdk`, and MCP SDK `>=1.29.0 <2`.

- [ ] **Step 2: Verify the policy test fails**

Run only the new test and confirm it fails on the current dependency declarations.

- [ ] **Step 3: Apply the minimal dependency changes**

Upgrade `@modelcontextprotocol/sdk` to the tested 1.x security-fixed release, remove unused `@openai/codex-sdk`, and pin the Obsidian development API version.

- [ ] **Step 4: Repair existing lint and stale-test failures**

Fix import order, unused symbols, Node/jsdom test environment declarations, obsolete model expectations, and migration expectations without weakening assertions.

- [ ] **Step 5: Add CI**

Run typecheck, lint, full tests, build, version consistency, `git diff --check`, and production audit on pull requests and pushes.

- [ ] **Step 6: Verify**

Run typecheck, lint, full tests, build, and official npm production audit.

### Task 3: Make Permission Modes Real

**Files:**
- Modify: `src/core/runtime/CodexAppServerClient.ts`
- Modify: `src/core/runtime/CodexAgentRuntime.ts`
- Modify: `src/core/types/settings.ts`
- Test: `tests/unit/core/runtime/CodexAppServerClient.test.ts`
- Test: `tests/unit/core/runtime/CodexAgentRuntime.test.ts`

**Interfaces:**
- Produces: `mapPermissionModeToApprovalPolicy(mode): 'on-request' | 'never'`
- Produces: App Server request routing and JSON-RPC responses

- [ ] **Step 1: Write failing policy-mapping tests**

Require `normal` and `plan` to map to `on-request`, `yolo` to map to `never`, and a new installation to default to `normal`.

- [ ] **Step 2: Write failing server-request tests**

Feed command and file-change approval JSON-RPC requests to the client and require the existing approval callback result to be returned as `accept`, `acceptForSession`, `decline`, or `cancel`.

- [ ] **Step 3: Verify both test groups fail**

Confirm failure is caused by the hard-coded policy and ignored server request.

- [ ] **Step 4: Implement mapping and routing**

Pass an async server-request handler into `CodexAppServerClient`, distinguish requests from responses, route supported approval methods, and return method-not-found for unsupported requests.

- [ ] **Step 5: Preserve existing users**

Only the default changes to normal; loaded explicit values remain unchanged.

- [ ] **Step 6: Verify normal, plan, and yolo behavior**

Run focused runtime and integration suites.

### Task 4: Protect Secrets at Rest

**Files:**
- Create: `src/core/security/SecureSecretStorage.ts`
- Modify: `src/core/storage/StorageService.ts`
- Modify: `src/core/storage/ClaudianSettingsStorage.ts`
- Modify: `src/features/settings/CodianSettings.ts`
- Modify: `src/main.ts`
- Test: `tests/unit/core/security/SecureSecretStorage.test.ts`
- Test: `tests/unit/core/storage/storageService.migration.test.ts`

**Interfaces:**
- Produces: `SecureSecretStorage.load()`, `save()`, `migrateLegacySettings()`
- Consumes: Electron `safeStorage` through an injectable adapter

- [ ] **Step 1: Write failing encryption and migration tests**

Require encrypted round-trip, no plaintext API key or environment snippet in vault JSON, verified legacy migration, and memory-only fallback when encryption is unavailable.

- [ ] **Step 2: Verify tests fail**

Confirm current settings serialization exposes plaintext.

- [ ] **Step 3: Implement secure device-local storage**

Store one encrypted JSON payload in plugin data, keep plaintext only in runtime settings, and sanitize vault serialization.

- [ ] **Step 4: Migrate safely**

Write encrypted data, read it back, then clear plaintext fields and save sanitized settings. Leave original settings untouched if verification fails.

- [ ] **Step 5: Update settings UI**

Explain device-local storage and environment-only fallback without exposing existing secret values.

- [ ] **Step 6: Verify**

Run security, storage migration, settings, runtime environment, and integration tests.

### Task 5: Make Vault Writes Recoverable

**Files:**
- Modify: `src/core/storage/VaultFileAdapter.ts`
- Modify: `src/core/storage/SessionStorage.ts`
- Create: `src/core/storage/RecoveryJournal.ts`
- Test: `tests/unit/core/storage/VaultFileAdapter.test.ts`
- Test: `tests/unit/core/storage/SessionStorage.test.ts`
- Test: `tests/unit/core/storage/RecoveryJournal.test.ts`

**Interfaces:**
- Produces: `atomicWrite(path, content, { backup: true })`
- Produces: bounded recovery journal entries for Codian-originated file changes

- [ ] **Step 1: Write failing atomicity tests**

Require temporary write, read-back verification, backup preservation, rename replacement, and original-file survival on failure.

- [ ] **Step 2: Verify tests fail**

Confirm direct adapter writes do not meet the ordering contract.

- [ ] **Step 3: Implement atomic writes**

Use sibling temporary and backup files with explicit cleanup after successful rename.

- [ ] **Step 4: Add recovery journal tests**

Require bounded entries, before-state capture, restore, and no automatic deletion of user data.

- [ ] **Step 5: Implement recovery journal**

Store recovery data outside normal notes, cap retained entries, and expose restore through existing rewind methods.

- [ ] **Step 6: Verify**

Run all storage, migration, session, rewind, and integration suites.

### Task 6: Bound Runtime Growth

**Files:**
- Create: `src/core/diagnostics/BoundedDiagnosticLogger.ts`
- Create: `src/core/runtime/CodexSessionIndex.ts`
- Modify: runtime and settings log call sites
- Modify: `src/utils/sdkSession.ts`
- Modify: `src/core/runtime/CodexAgentRuntime.ts`
- Test: corresponding unit tests

**Interfaces:**
- Produces: redacted rotating diagnostics
- Produces: cached session ID lookup with bounded rebuild
- Produces: per-turn temporary image cleanup and stale-file pruning

- [ ] **Step 1: Write failing logger tests**

Require redaction, maximum size, fixed rotations, and no synchronous stack logging during ordinary settings saves.

- [ ] **Step 2: Write failing index and image-lifetime tests**

Require one scan for repeated lookups, invalidation after deletion, per-turn image cleanup, and stale startup pruning.

- [ ] **Step 3: Verify failures**

Confirm current append-only logs, repeated recursive scans, and persistent temporary images violate the contracts.

- [ ] **Step 4: Implement bounded components**

Keep all limits as exported constants and never delete user session files automatically.

- [ ] **Step 5: Verify**

Run diagnostics, session, image, runtime, and long-repetition tests.

### Task 7: Dispose Global UI Listeners

**Files:**
- Modify: `src/features/chat/ui/InputToolbar.ts`
- Modify: `src/features/chat/tabs/Tab.ts`
- Modify: `src/features/settings/ui/McpSettingsManager.ts`
- Test: `tests/unit/features/chat/ui/InputToolbar.test.ts`
- Test: `tests/unit/features/settings/ui/McpSettingsManager.test.ts`

**Interfaces:**
- Produces: `ProviderSelector.dispose()` and `McpSettingsManager.dispose()`

- [ ] **Step 1: Write failing listener-count tests**

Create and destroy components repeatedly and require matching add/remove calls.

- [ ] **Step 2: Verify tests fail**

Confirm current components leave document listeners registered.

- [ ] **Step 3: Implement disposal**

Use stable handler references and call dispose from tab destruction and settings teardown.

- [ ] **Step 4: Verify**

Run focused UI suites and a repeated open/close integration test.

### Task 8: Add Compatibility Diagnostics and Release Governance

**Files:**
- Create: `src/core/diagnostics/CodianDiagnostics.ts`
- Modify: `src/core/runtime/CodexAppServerClient.ts`
- Modify: `src/features/settings/CodianSettings.ts`
- Modify: `scripts/sync-version.js`
- Create: `scripts/verify-release.mjs`
- Modify: `CHANGELOG.md`
- Modify: `versions.json`
- Create: `docs/releases/v1.3.83-stability-hardening.md`

**Interfaces:**
- Produces: local diagnostics snapshot and release verifier

- [ ] **Step 1: Write failing diagnostics and release tests**

Require actual plugin version in App Server client info, CLI version parsing, supported-version warning, storage-size reporting, and exact version consistency.

- [ ] **Step 2: Verify tests fail**

Confirm hard-coded client version and stale release metadata.

- [ ] **Step 3: Implement diagnostics**

Display local-only health information without telemetry or secret values.

- [ ] **Step 4: Implement release verification**

Check versions, required files, archive contents, and SHA-256 manifest.

- [ ] **Step 5: Update documentation**

Document security migration, permission semantics, backup/recovery, diagnostics, rollback, and upstream policy.

- [ ] **Step 6: Verify**

Run diagnostics tests and the release verifier.

### Task 9: Full Release, Installation, and Live Verification

**Files:**
- Build: `main.js`, `styles.css`
- Package: `outputs/codian-1.3.83-stability-hardening.zip`
- Package: rollback archive
- Install: active vault `.obsidian/plugins/codian/`

**Interfaces:**
- Produces: source commit, release archive, installed plugin, GitHub tag and release

- [ ] **Step 1: Run every release gate**

Require typecheck, zero lint errors, all tests passing, build, diff check, audit, and release verifier.

- [ ] **Step 2: Build and package**

Create the release and rollback archives and verify both with `unzip -t`.

- [ ] **Step 3: Back up and install**

Preserve installed `data.json`, install only `main.js`, `manifest.json`, and `styles.css`, then compare hashes.

- [ ] **Step 4: Restart Obsidian and run live checks**

Verify normal approval, yolo execution, MCP on-demand, model listing, settings persistence, session resume, recovery, and absence of duplicate listeners or runaway processes.

- [ ] **Step 5: Commit, tag, push, and publish**

Commit verified source, create tag `v1.3.83-stability-hardening`, push the branch and tag, and publish the release archive and checksums through GitHub.

- [ ] **Step 6: Completion audit**

Re-read this plan, map every requirement to current evidence, and keep the goal active if any evidence is missing.
