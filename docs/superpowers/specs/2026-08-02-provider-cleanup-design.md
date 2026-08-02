# Codian Provider Cleanup Design

## Goal

Ship a final Codian release whose current source tree, dependency graph, built
plugin, settings UI, documentation, and installed files contain no Claude Code,
Claudian, or Anthropic SDK implementation or naming, while preserving the
user's existing Codian settings, skills, commands, agents, sessions, MCP data,
local memory, and recovery journal.

## Scope and completion boundary

The final product supports only the `codex` and `deepseek` providers. The
following surfaces must be clean:

- tracked source, tests, documentation, manifests, lockfiles, and scripts;
- the production dependency graph and compiled `main.js`;
- the installed Obsidian plugin directory and its `data.json`;
- plugin-generated paths, filenames, setting keys, and migration metadata in the
  active vault's Codian-owned data directory;
- current branch and release naming.

Git history and the user's global `~/.claude` directory are outside the cleanup
boundary. The global directory may belong to a separately installed program and
must not be modified. User-authored skill text, third-party source and license
text, and historical conversation payloads are migrated byte-for-byte and are
not rewritten merely because their content discusses another provider. Those
files are user data, not Codian implementation or support.

## Chosen architecture: two-stage migration

A single release cannot both contain a readable legacy migration path and pass
the final zero-reference audit. The work therefore has two explicit stages.

### Stage A: migration bridge

Create a temporary migration build that:

1. recognizes the existing vault `.claude` directory;
2. creates a sibling `.codian` directory through a temporary staging path;
3. copies every file without following symlinks;
4. rejects destination conflicts unless bytes are identical;
5. verifies relative path, file size, and SHA-256 for every regular file;
6. atomically promotes the staging directory;
7. records a versioned migration receipt in `.codian`;
8. leaves the source directory intact until application-level validation passes.

The bridge is installed only on the active vault. After Obsidian loads it, the
following are verified from the running application: provider, settings,
commands, skills, agents, session metadata, MCP configuration, recovery state,
and diagnostics. A filesystem audit then proves file-count and hash parity.

Only after those checks pass is the old vault directory moved to the external,
timestamped backup location under `~/Documents/Codex/2026-08-02/`. It is not
permanently erased during the migration step.

### Stage B: final clean release

Starting from the migrated state, remove the bridge and all legacy provider
implementation and compatibility code. The final runtime reads and writes only
`.codian`, supports only Codex and DeepSeek, and contains neutral Codian-owned
types for messages, approvals, hooks, rewinds, and tool results.

## Code structure

### Runtime and types

- Delete the dormant `ClaudianService` and its query/options/session/spawn
  helpers when no final runtime consumer remains.
- Replace imported Anthropic SDK types with focused local interfaces under
  `src/core/types/`.
- Keep the existing `AgentRuntime` interface stable for Codex and DeepSeek.
- Remove SDK transforms that are only useful for legacy session formats.

### CLI resolution

- Replace the legacy resolver and settings fields with `CodexCliResolver`,
  `codexCliPath`, and `codexCliPathsByHost`.
- Auto-detection searches only Codex executables.
- The migration bridge maps the current configured path into the neutral field
  only when the executable is a valid Codex binary.

### Storage

- Change all Codian-owned vault paths from `.claude` to `.codian`.
- Rename settings storage and constants to Codian terminology.
- Remove user-level legacy settings loading, legacy plugin discovery, and the
  old Chrome compatibility switch.
- Preserve the actual contents of skills, commands, agents, sessions, local
  memory, MCP configuration, and recovery journal byte-for-byte during Stage A.
- Transform only plugin-owned structured metadata keys whose meaning is part of
  the retired compatibility layer. Never rewrite user prose, third-party source,
  licenses, or historical messages.

### UI and documentation

- Remove legacy compatibility settings and obsolete provider/model copy.
- Rename files, classes, CSS selectors, test descriptions, and comments that
  carry the retired names.
- Rewrite current documentation for Codex and DeepSeek only.
- Remove historical in-tree documents that prevent the final current-tree
  audit; release history remains available in Git history and GitHub releases.

## Error handling and rollback

- Migration never overwrites a non-identical destination file.
- Symlinks, sockets, or unsupported filesystem entries stop migration before
  promotion.
- A failed migration leaves the source directory unchanged and removes only its
  own temporary staging directory.
- The active plugin is backed up outside `.obsidian/plugins` before each install.
- If Stage B validation fails, restore the Stage A plugin and the external data
  backup without changing vault notes.

## Testing

Development follows red-green-refactor. Required automated coverage includes:

- migration copies regular files and verifies SHA-256 parity;
- migration rejects conflicts and unsupported entries;
- migration is idempotent after a verified receipt;
- Codex CLI resolution never discovers a retired executable;
- settings load/save and all storage classes use `.codian`;
- Codex and DeepSeek runtime behavior remains intact;
- final package policy rejects forbidden names, dependency names, path strings,
  and compiled-bundle markers.

The zero-reference source audit covers tracked project files, package metadata,
the compiled plugin, and installed plugin files. The data-migration audit checks
that the active directory and plugin-owned structured metadata use Codian names,
while separately proving byte parity for user-authored and third-party payloads.

Final verification requires full tests, typecheck, lint, build, release package
verification, production dependency audit, source/lockfile/package/bundle scan,
installed-file hash comparison, Obsidian restart, diagnostics, a normal Codex
conversation, a DeepSeek configuration smoke check, explicit MCP read, and
confirmation that only one active plugin directory exists.

## Release and installation

- Stage A is a temporary local migration build and is not the final public
  release.
- Stage B becomes `1.3.86-provider-cleanup` with deterministic install and
  rollback archives and SHA-256 metadata.
- The final release is pushed through a review branch and CI, then installed in
  the active Obsidian vault with `data.json` preserved.

## Explicit non-goals

- Do not uninstall or alter an independently installed Claude Code application.
- Do not modify `~/.claude`.
- Do not rewrite Git history.
- Do not refactor unrelated Codex or DeepSeek behavior.
