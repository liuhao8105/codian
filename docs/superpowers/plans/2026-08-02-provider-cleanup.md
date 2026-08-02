# Codian Provider Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the active vault to Codian-owned storage, then ship and install a Codex/DeepSeek-only release whose current project tree, dependencies, bundle, and installed plugin contain no retired provider implementation or naming.

**Architecture:** A temporary Stage A bridge copies and verifies the current vault data into `.codian` without modifying payloads. After live migration validation, Stage B deletes the bridge and all retired runtime, SDK, compatibility, naming, and path surfaces; neutral local runtime contracts replace third-party types.

**Tech Stack:** TypeScript 5, Obsidian API, Node.js filesystem/crypto APIs, Jest 30, esbuild, npm, GitHub Actions, deterministic ZIP packaging.

## Global Constraints

- Final providers are exactly `codex` and `deepseek`.
- Do not modify the global `~/.claude` directory.
- Preserve user-authored skill text, third-party source/licenses, and historical conversation payloads byte-for-byte.
- Final tracked files, production dependencies, `main.js`, release assets, installed plugin files, plugin-generated paths, filenames, and settings keys must pass the zero-reference audit.
- Migration must reject non-identical conflicts, symlinks, sockets, and unsupported entries without altering the source directory.
- Backups must remain outside `.obsidian/plugins`.
- Use one main Agent and the existing worktree `/Users/liuhao/Documents/Codex/2026-08-02/codian-1.3.86-provider-cleanup`.
- Do not change unrelated Codex or DeepSeek behavior.

---

### Task 1: Add the temporary verified vault-root migration bridge

**Files:**
- Create: `src/core/storage/VaultRootMigration.ts`
- Create: `tests/unit/core/storage/VaultRootMigration.test.ts`
- Modify: `src/main.ts`
- Modify: `tests/integration/main.test.ts`
- Modify: `package.json`
- Modify: `manifest.json`

**Interfaces:**
- Produces: `migrateVaultRoot(options: VaultRootMigrationOptions): Promise<VaultRootMigrationResult>`
- `VaultRootMigrationOptions` contains `vaultRoot`, `sourceName`, `destinationName`, and `receiptName`.
- `VaultRootMigrationResult` contains `status: 'migrated' | 'already-migrated' | 'not-needed'`, `fileCount`, `totalBytes`, and `digest`.
- The bridge copies user payload directories and neutral Codian files, transforms
  plugin-owned settings/MCP JSON keys, and excludes `.git`, the retired plugin
  manifest directory, and retired settings backups from the active destination.
  The excluded entries remain in the external full backup made in Task 7.
- The bridge is temporary and must be deleted in Task 7 after live Stage A validation.

- [ ] **Step 1: Write failing migration tests**

```ts
it('copies every regular file and proves byte parity', async () => {
  await writeFixture(source, {
    'settings.json': '{"provider":"codex"}',
    'skills/example/SKILL.md': 'payload',
  });

  const result = await migrateVaultRoot({
    vaultRoot,
    sourceName: '.legacy-source',
    destinationName: '.codian',
    receiptName: '.migration-receipt.json',
  });

  expect(result.status).toBe('migrated');
  expect(await snapshotTree(destination)).toEqual(await snapshotTree(source));
});

it('rejects a non-identical destination conflict without changing source', async () => {
  await writeFixture(source, { 'settings.json': 'source' });
  await writeFixture(destination, { 'settings.json': 'different' });
  const before = await snapshotTree(source);

  await expect(migrateVaultRoot(options)).rejects.toThrow('destination conflict');
  expect(await snapshotTree(source)).toEqual(before);
});

it('rejects symbolic links before promotion', async () => {
  await fs.symlink(outsideFile, path.join(source, 'link'));
  await expect(migrateVaultRoot(options)).rejects.toThrow('unsupported entry');
  await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps payload bytes but filters retired repository and plugin metadata', async () => {
  await writeFixture(source, {
    'skills/example/SKILL.md': 'user payload',
    '.git/config': 'external history metadata',
    '.legacy-plugin/plugin.json': '{}',
    'retired-settings.json.bak': '{}',
  });
  await migrateVaultRoot(options);
  expect(await fs.readFile(path.join(destination, 'skills/example/SKILL.md'), 'utf8'))
    .toBe('user payload');
  expect(await pathExists(path.join(destination, '.git'))).toBe(false);
  expect(await pathExists(path.join(destination, '.legacy-plugin'))).toBe(false);
  expect(await pathExists(path.join(destination, 'retired-settings.json.bak'))).toBe(false);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/core/storage/VaultRootMigration.test.ts`

Expected: FAIL because `VaultRootMigration` does not exist.

- [ ] **Step 3: Implement staged copy, SHA-256 verification, conflict rejection, and atomic promotion**

Use `lstat`, never follow symlinks, sort relative paths before hashing, copy into `${destinationName}.migrating-<uuid>`, compare size and SHA-256 for every file, then rename the staging directory. The receipt is written only after parity succeeds.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/core/storage/VaultRootMigration.test.ts`

Expected: PASS with all migration cases green.

- [ ] **Step 5: Add failing plugin-start integration test**

```ts
it('runs the vault-root bridge before StorageService initialization', async () => {
  const events: string[] = [];
  migrateVaultRoot.mockImplementation(async () => { events.push('migration'); });
  StorageService.prototype.initialize.mockImplementation(async () => {
    events.push('storage');
    return defaultCombinedSettings;
  });
  await plugin.onload();
  expect(events.slice(0, 2)).toEqual(['migration', 'storage']);
});
```

- [ ] **Step 6: Verify RED, wire Stage A startup, then verify GREEN**

Run: `npm test -- --selectProjects integration --runTestsByPath tests/integration/main.test.ts`

Expected RED: bridge was not called. After the minimal startup call is added, expected GREEN: integration suite passes.

- [ ] **Step 7: Set temporary Stage A version and commit**

Set package and manifest version to `1.3.85-data-migration`, run `npm run typecheck`, then commit:

```bash
git add src/core/storage/VaultRootMigration.ts tests/unit/core/storage/VaultRootMigration.test.ts src/main.ts tests/integration/main.test.ts package.json package-lock.json manifest.json
git commit -m "feat: add verified Codian data migration bridge"
```

---

### Task 2: Replace third-party SDK types with Codian runtime contracts

**Files:**
- Create: `src/core/runtime/contracts.ts`
- Create: `tests/unit/core/runtime/contracts.test.ts`
- Modify: `src/core/runtime/index.ts`
- Modify: `src/core/runtime/CodexAgentRuntime.ts`
- Modify: `src/core/runtime/DeepSeekRuntime.ts`
- Modify: `src/core/security/ApprovalManager.ts`
- Modify: `src/core/hooks/SecurityHooks.ts`
- Modify: `src/core/hooks/SubagentHooks.ts`
- Modify: `src/features/inline-edit/InlineEditService.ts`
- Modify: `src/core/types/models.ts`
- Delete: `src/core/types/sdk.ts`
- Delete: `tests/__mocks__/claude-agent-sdk.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces neutral `RuntimeMessage`, `RuntimeUserMessage`, `RewindFilesResult`, `HookCallbackMatcher`, `PermissionUpdate`, `PermissionUpdateDestination`, `RuntimeBeta`, `ApprovalCallback`, `ApprovalCallbackOptions`, and `QueryOptions`.
- Existing `AgentRuntime` public method signatures remain behaviorally equivalent.

- [ ] **Step 1: Write failing contract-shape tests**

```ts
it('represents successful and failed rewind outcomes', () => {
  const ok: RewindFilesResult = { canRewind: true, filesChanged: [] };
  const denied: RewindFilesResult = { canRewind: false, error: 'not available' };
  expect(ok.canRewind).toBe(true);
  expect(denied.canRewind).toBe(false);
});

it('keeps permission updates destination-safe', () => {
  const update: PermissionUpdate = {
    type: 'addRules',
    destination: 'projectSettings',
    rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
  };
  expect(update.destination).toBe('projectSettings');
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/core/runtime/contracts.test.ts`

Expected: FAIL because local contracts do not exist.

- [ ] **Step 3: Implement the minimum local contracts and switch consumers**

Move only shapes actually used by Codex and DeepSeek. Do not reproduce unused vendor APIs.

- [ ] **Step 4: Remove the SDK dependency and verify GREEN**

Run: `npm uninstall @anthropic-ai/claude-agent-sdk`

Run: `npm run typecheck && npm test -- --selectProjects unit --runTestsByPath tests/unit/core/runtime/contracts.test.ts tests/unit/core/security/ApprovalManager.test.ts tests/unit/core/runtime/CodexAgentRuntime.test.ts tests/unit/core/runtime/DeepSeekRuntime.test.ts`

Expected: dependency absent and focused suites pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src tests
git commit -m "refactor: own runtime contracts"
```

---

### Task 3: Remove the dormant provider runtime and legacy helper graph

**Files:**
- Modify: `src/core/runtime/contracts.ts`
- Modify: `src/core/runtime/CodexAgentRuntime.ts`
- Modify: `src/core/runtime/DeepSeekRuntime.ts`
- Modify: `src/core/runtime/index.ts`
- Modify: `src/core/tools/toolExecutor.ts`
- Delete: `src/core/agent/ClaudianService.ts`
- Delete: `src/core/agent/MessageChannel.ts`
- Delete: `src/core/agent/QueryOptionsBuilder.ts`
- Delete: `src/core/agent/SessionManager.ts`
- Delete: `src/core/agent/customSpawn.ts`
- Delete or reduce: `src/core/agent/index.ts`
- Delete mirrored tests under `tests/unit/core/agent/` and `tests/integration/core/agent/` that exercise only the dormant runtime.

**Interfaces:**
- `ApprovalCallback`, `ApprovalCallbackOptions`, and `QueryOptions` move to `src/core/runtime/contracts.ts`.
- No production import may resolve through `src/core/agent` after this task.

- [ ] **Step 1: Add a failing architecture policy test**

Add to `tests/unit/release/packagePolicy.test.ts`:

```ts
it('has no dormant provider runtime or imports', () => {
  expect(trackedFiles()).not.toContain('src/core/agent/ClaudianService.ts');
  expect(sourceText()).not.toMatch(/from ['"].*core\/agent/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/release/packagePolicy.test.ts`

Expected: FAIL on the existing service and imports.

- [ ] **Step 3: Move live contracts, delete dormant modules, and repair imports**

Keep only behavior reached by `createAgentRuntime`; delete tests for unreachable implementation rather than porting dead behavior.

- [ ] **Step 4: Run focused runtime and UI suites**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/release/packagePolicy.test.ts tests/unit/core/runtime/CodexAgentRuntime.test.ts tests/unit/core/runtime/DeepSeekRuntime.test.ts tests/unit/features/chat/controllers/StreamController.test.ts tests/unit/features/chat/tabs/Tab.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/core/agent src/core/runtime src/core/tools tests
git commit -m "refactor: remove dormant provider runtime"
```

---

### Task 4: Make CLI settings and model names Codex-native

**Files:**
- Create: `src/utils/codexCli.ts`
- Create: `tests/unit/utils/codexCli.test.ts`
- Delete: `src/utils/claudeCli.ts`
- Delete: `tests/unit/utils/claudeCli.test.ts`
- Modify: `src/utils/path.ts`
- Modify: `src/utils/env.ts`
- Modify: `src/core/runtime/codexExec.ts`
- Modify: `src/core/types/models.ts`
- Modify: `src/core/types/settings.ts`
- Modify: `src/main.ts`
- Modify: `src/features/settings/CodianSettings.ts`
- Modify: all affected model, environment, CLI, and main integration tests.

**Interfaces:**
- Produces `CodexCliResolver.resolve(pathsByHost, legacyPath, envText): string | null`.
- Produces `findCodexCliPath(pathValue?: string): string | null`.
- Settings fields become `codexCliPath`, `codexCliPathsByHost`, `lastCodexModel`, and neutral `AgentModel` names.

- [ ] **Step 1: Write failing Codex-only resolver tests**

```ts
it('finds codex and ignores unrelated executables', () => {
  mockFiles(['/custom/bin/codex', '/custom/bin/other']);
  expect(findCodexCliPath('/custom/bin')).toBe('/custom/bin/codex');
});

it('never searches retired application directories', () => {
  findCodexCliPath('/custom/bin');
  expect(searchedPaths()).toEqual(expect.not.arrayContaining([
    expect.stringMatching(/retired-provider/i),
  ]));
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/utils/codexCli.test.ts`

Expected: FAIL because the Codex resolver does not exist.

- [ ] **Step 3: Implement Codex-only discovery and migrate live setting names**

During Stage A only, map the installed `data.json` value into the neutral field if it resolves to a valid Codex executable. Do not retain vendor-specific auto-detection.

- [ ] **Step 4: Remove obsolete environment/model keys and verify GREEN**

Run: `npm run typecheck`

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/utils/codexCli.test.ts tests/unit/utils/env.test.ts tests/unit/utils/path.test.ts tests/unit/mainModelCatalog.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src/utils src/core/types src/core/runtime src/features/settings src/main.ts tests
git commit -m "refactor: make CLI settings Codex-native"
```

---

### Task 5: Move all Codian-owned vault storage to `.codian`

**Files:**
- Rename: `src/core/storage/CCSettingsStorage.ts` → `src/core/storage/RuntimeSettingsStorage.ts`
- Rename: `src/core/storage/ClaudianSettingsStorage.ts` → `src/core/storage/CodianSettingsStorage.ts`
- Rename corresponding tests.
- Modify: every file under `src/core/storage/`.
- Modify: `src/core/agents/AgentManager.ts`
- Modify: `src/core/types/chat.ts`
- Modify: `src/core/types/settings.ts`
- Modify: `src/utils/session.ts`
- Modify: `src/utils/slashCommand.ts`
- Modify: `src/utils/sdkSession.ts` or replace it with a Codex session reader.
- Modify: storage, agent, session, slash-command, MCP, recovery, and integration tests.

**Interfaces:**
- `CODIAN_ROOT = '.codian'` is the only plugin-owned vault root.
- `RuntimeSettingsStorage` owns `.codian/settings.json`.
- `CodianSettingsStorage` owns `.codian/codian-settings.json`.
- Commands, skills, agents, sessions, local memory, MCP, and recovery paths are children of `.codian`.

- [ ] **Step 1: Write failing path-policy tests**

```ts
it.each([
  ['settings', RUNTIME_SETTINGS_PATH, '.codian/settings.json'],
  ['sessions', SESSIONS_PATH, '.codian/sessions'],
  ['skills', SKILLS_PATH, '.codian/skills'],
  ['commands', COMMANDS_PATH, '.codian/commands'],
  ['agents', AGENTS_PATH, '.codian/agents'],
])('%s uses Codian storage', (_name, actual, expected) => {
  expect(actual).toBe(expected);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/core/storage/storage.test.ts tests/unit/core/storage/SessionStorage.test.ts tests/unit/core/storage/SkillStorage.test.ts tests/unit/core/storage/SlashCommandStorage.test.ts tests/unit/core/storage/AgentVaultStorage.test.ts`

Expected: FAIL because current paths use the old root.

- [ ] **Step 3: Rename storage classes and change every live path**

Keep data formats stable unless a field itself encodes retired provider support.
Stage A must perform explicit structured transformations:

- rename the MCP metadata key to `_codian` without changing `mcpServers`;
- map the configured executable path only when it is a valid Codex binary;
- map the last selected model to the neutral Codex field;
- remove the user-level legacy-settings and browser-compatibility switches;
- omit retired settings backup filenames from the active destination while the
  external full backup retains them.

- [ ] **Step 4: Replace global legacy discovery with Codian/Codex sources**

Vault agents, skills, and commands load from `.codian`; optional global Codian content loads from `~/.codian`. Do not read `~/.claude`.

- [ ] **Step 5: Run storage and integration suites**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/core/storage tests/unit/core/agents tests/unit/utils/session.test.ts tests/unit/utils/slashCommand.test.ts`

Run: `npm test -- --selectProjects integration --runTestsByPath tests/integration/main.test.ts tests/integration/core/mcp/mcp.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src/core/storage src/core/agents src/core/types src/utils tests
git commit -m "refactor: move vault storage to Codian root"
```

---

### Task 6: Remove compatibility UI, plugin discovery, SDK transforms, and retired naming

**Files:**
- Delete: `src/core/plugins/PluginManager.ts` and plugin-only tests if no neutral consumer remains.
- Delete: `src/core/sdk/` and SDK-only tests if no Codex consumer remains.
- Delete: `src/features/chat/ClaudianView.ts`.
- Delete: `src/features/settings/ClaudianSettings.ts`.
- Modify: `src/features/chat/CodianView.ts`.
- Modify: `src/features/settings/CodianSettings.ts`.
- Modify: `src/main.ts`.
- Modify: all locale JSON files and `src/i18n/types.ts`.
- Modify: CSS selectors and remaining source/test names.

**Interfaces:**
- No legacy plugin manager or user-level legacy settings loader remains.
- Settings UI contains no retired provider, plugin, or browser compatibility controls.
- View identifier becomes `VIEW_TYPE_CODIAN` without compatibility alias.

- [ ] **Step 1: Add failing UI and module policy tests**

```ts
it('exports only the Codian view identifier', () => {
  expect(VIEW_TYPE_CODIAN).toBe('codian-view');
});

it('does not expose legacy compatibility settings', () => {
  renderSettings();
  expect(container.textContent).not.toContain('legacy compatibility');
  expect(container.querySelector('[data-compatibility-provider]')).toBeNull();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/features/settings/AgentSettings.test.ts tests/unit/core/agent/index.test.ts tests/unit/core/plugins/index.test.ts`

Expected: FAIL on existing aliases/modules or obsolete UI.

- [ ] **Step 3: Delete compatibility modules and repair neutral consumers**

Delete behavior that only loads old provider plugins/settings. Preserve MCP, Codex-native skills, Codian agents, and approval behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run typecheck`

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/features/settings tests/unit/features/chat tests/unit/core/agents tests/unit/core/mcp`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "refactor: remove legacy compatibility surfaces"
```

---

### Task 7: Install Stage A and migrate the active vault safely

**Files and external state:**
- Build from the worktree.
- Backup active plugin to `/Users/liuhao/Documents/Codex/2026-08-02/codian-release-backups/stage-a-active-plugin`.
- Source data: active vault legacy directory.
- Destination data: active vault `.codian`.
- External verified data backup: `/Users/liuhao/Documents/Codex/2026-08-02/codian-data-backups/codian-data-before-provider-cleanup`.

**Interfaces:**
- Stage A diagnostics must report version `1.3.85-data-migration`, provider, storage root, migration status, file count, and warnings without secrets or absolute paths.

- [ ] **Step 1: Run Stage A verification before installation**

Run: `npm run typecheck && npm run lint && npm test && npm run build && git diff --check`

Expected: all commands pass.

- [ ] **Step 2: Snapshot the source tree without exposing contents**

Create a sorted manifest of relative path, entry type, size, and SHA-256 for regular files. Store it only in the external timestamped backup directory.

- [ ] **Step 3: Back up and install only `main.js`, `manifest.json`, and `styles.css`**

Preserve installed `data.json` byte-for-byte. Keep the backup outside `.obsidian/plugins`.

- [ ] **Step 4: Restart Obsidian and verify live Stage A migration**

Check running diagnostics, Codex provider, commands, skills, agents, sessions, MCP configuration, recovery journal, and no warnings.

- [ ] **Step 5: Compare source/destination manifests**

Expected: all user/third-party payload files match byte-for-byte; only documented plugin-owned structured metadata transformations differ.

- [ ] **Step 6: Move the source directory to external backup**

After validation, quit Obsidian, move the source directory to the exact external
timestamped backup path, and relaunch only after the move completes. Confirm the
active vault contains `.codian` and no old root. This move is recoverable and
must not erase the external copy.

- [ ] **Step 7: Record evidence in the task log, not the final source tree**

Do not add a migration report containing retired terms to the final tracked project tree.

---

### Task 8: Produce the final zero-reference Stage B tree

**Files:**
- Delete: `src/core/storage/VaultRootMigration.ts` and its test.
- Delete: the confirmed design and implementation plan documents before final audit.
- Modify/delete: all current documentation and historical in-tree release/plan files containing forbidden names.
- Modify: `.gitignore`, `.eslintrc.cjs`, `jest.config.js`, scripts, package metadata, source, tests, locales, and comments found by the audit.
- Modify: `package.json`, `package-lock.json`, `manifest.json`, `versions.json`, `CHANGELOG.md`, `README.md`, `README.zh-CN.md`, `CODEX.md`.
- Create: `docs/releases/v1.3.86-provider-cleanup.md` using neutral wording only.
- Modify: `tests/unit/release/packagePolicy.test.ts`.

**Interfaces:**
- Final version: `1.3.86-provider-cleanup`.
- `assertProviderCleanup(root): void` fails if tracked content, filenames, package dependency names, or the production bundle contain any forbidden marker.
- The final audit patterns are case-insensitive and cover the three retired brand/vendor terms defined only inside the test via byte arrays so the final source does not contain their literal spellings.

- [ ] **Step 1: Write the failing final package-policy test**

```ts
it('contains no forbidden provider artifacts', () => {
  expect(() => assertProviderCleanup(projectRoot)).not.toThrow();
});
```

The implementation must inspect `git ls-files`, file basenames, text content, `package.json`, `package-lock.json`, and `main.js`.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/release/packagePolicy.test.ts`

Expected: FAIL with a complete list of remaining files/markers.

- [ ] **Step 3: Remove every reported current-tree artifact**

Do not weaken the audit or add exclusions for tracked project files. The only excluded surfaces are `.git`, `node_modules`, generated external backups, and user/third-party payload content outside the project.

- [ ] **Step 4: Delete Stage A bridge and planning documents**

The final current tree must not contain the migration source path, retired type names, or this plan's explanatory text.

- [ ] **Step 5: Set final version, rebuild lockfile, and verify GREEN**

Run: `npm install --package-lock-only`

Run: `npm test -- --selectProjects unit --runTestsByPath tests/unit/release/packagePolicy.test.ts`

Expected: PASS with zero reported artifacts.

- [ ] **Step 6: Run full verification**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm test`

Run: `npm run build`

Run: `git diff --check`

Run: `npm audit --omit=dev --registry=https://registry.npmjs.org`

Expected: all pass and production audit reports zero vulnerabilities.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "release: prepare Codian 1.3.86 provider cleanup"
```

---

### Task 9: Package, install, validate, publish, and audit completion

**Files and external state:**
- Generate deterministic install/rollback ZIPs and SHA-256 metadata under ignored `outputs/`.
- Install in the active Obsidian plugin directory.
- Push branch, open PR, wait for CI, merge, tag, and publish a non-draft GitHub release.

**Interfaces:**
- Release tag: `v1.3.86-provider-cleanup`.
- Installed runtime diagnostics report the final version, `.codian` storage, provider, secure-storage status, recovery counts, and zero warnings without secrets or paths.

- [ ] **Step 1: Package with a verified rollback directory**

Run: `npm run package:release -- --rollback-dir /Users/liuhao/Documents/Codex/2026-08-02/codian-release-backups/stage-a-active-plugin`

Run: `npm run verify:release`

Expected: install and rollback archives pass integrity checks and all assets have SHA-256 entries.

- [ ] **Step 2: Back up and install final assets**

Preserve `data.json`; replace only `main.js`, `manifest.json`, and `styles.css`; compare installed hashes to packaged assets.

- [ ] **Step 3: Restart Obsidian and perform live acceptance**

Verify:

- loaded version `1.3.86-provider-cleanup`;
- only one active Codian plugin directory;
- storage root `.codian` and old active root absent;
- normal Codex conversation returns an exact probe token;
- DeepSeek configuration/provider selection remains available;
- explicit MCP read succeeds without mutation;
- local diagnostics return zero warnings and no sensitive markers;
- commands, skills, agents, sessions, local memory, and recovery data remain visible.

- [ ] **Step 4: Run final installed-package zero-reference audit**

Scan installed `main.js`, `manifest.json`, `styles.css`, and `data.json`, plus installed filenames. Expected: zero forbidden artifacts. Do not scan preserved user/third-party payload prose.

- [ ] **Step 5: Push, create PR, wait for CI, and merge**

Use branch `codex/codian-1.3.86-provider-cleanup`. Do not merge if CI, package policy, or release verifier fails.

- [ ] **Step 6: Tag and publish the final release**

Tag the exact merged `main` commit and upload six assets: three plugin files, install ZIP, rollback ZIP, and checksum file.

- [ ] **Step 7: Download remote assets and compare bytes**

Expected: remote asset digests exactly match local SHA-256 values and the tag peels to the merged commit.

- [ ] **Step 8: Completion audit against every design requirement**

Check the live repository, release, installed plugin, active vault paths, external backups, and runtime behavior. Mark the goal complete only when every requirement has authoritative evidence and no required work remains.
