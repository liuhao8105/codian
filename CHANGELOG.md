# Changelog

## 1.3.90-deepseek-latency

- Prevented ordinary DeepSeek chat turns from waiting for external MCP discovery before the API request starts.
- Limited explicit DeepSeek MCP discovery to servers selected through an `@server-name` mention or the MCP selector.
- Preserved DeepSeek's built-in vault tools and existing MCP configurations without enabling, disabling, or deleting servers.
- Added regression coverage for both ordinary chat and explicitly selected MCP turns.

## 1.3.89-latency-optimization

- Applied the selected Codex reasoning effort to every App Server turn instead of leaving the selector disconnected from runtime behavior.
- Moved stable Codian rules into native App Server developer instructions for new and resumed threads.
- Started Codex App Server from the Obsidian vault instead of the CLI installation directory, preventing unrelated project-config discovery.
- Reduced the default fixed prompt while preserving Obsidian, path, safety, context, web, link, and image boundaries.
- Kept model selection, conversation history, current-note behavior, MCP gating, permissions, settings, and user data unchanged.

## 1.3.87-settings-sanitization

- Restricted persisted settings to the currently supported schema.
- Restricted provider configuration to Codex and DeepSeek entries.
- Prevented removed compatibility fields from being loaded and written back.

## 1.3.86-provider-cleanup

- Consolidated execution on the Codex App Server and the optional DeepSeek provider.
- Moved all plugin-owned vault data under `.codian/` with verified, recoverable migration.
- Removed retired compatibility settings, dependencies, UI controls, runtime adapters, and documentation.
- Added release checks that reject retired provider markers from source, filenames, dependencies, and the production bundle.

## Unreleased

### What changed

- Synced Codian's built-in model catalog with Codex CLI `0.144.5`: GPT-5.6 Sol, Terra, Luna, GPT-5.5, GPT-5.4, and GPT-5.4 Mini.
- Added automatic `model/list` discovery so the selector reflects the models available to the current Codex account, with a five-second timeout and a built-in fallback catalog.
- New installations now default to GPT-5.6 Sol; retired GPT-5.2 and GPT-5.3-Codex selections migrate safely while supported and custom selections remain unchanged.
- Synced default thinking levels with the values reported by the Codex CLI.
- Improved final Codex connection failures: retryable App Server events remain hidden while Codex reconnects, and exhausted ChatGPT transport retries now show a concise Chinese recovery message instead of the raw backend endpoint error.
- Model changes now preserve chat history while clearing the old Codex session binding and rebuilding open-tab runtimes, preventing a conversation created with one model from being resumed with another model.
- User-configured global Codex MCP servers now use on-demand startup: ordinary chat disables them, while an explicit `@server-name` request enables only the named server for that turn.
- Added a startup watchdog that rebuilds a turn once when an MCP remains stuck before any model or tool activity, then returns an actionable error instead of waiting forever if recovery also stalls.
- MCP discovery reads only sanitized section names from the local Codex configuration; transport configuration, environment variables, headers, and credentials are never persisted or logged by Codian.
- Added a local-memory system inspired by [`supermemoryai/supermemory`](https://github.com/supermemoryai/supermemory)'s `memory / recall / context / profile` model, implemented entirely inside the local Obsidian vault.
- Added `.codian/local-memory/memories.jsonl` for structured local memories and `.codian/local-memory/profile.md` as a stable profile placeholder.
- Added `/remember [要记住的内容]` to save a local memory and `/recall [搜索关键词]` to search local memories.
- Added automatic local-memory recall during normal chat turns, injecting relevant memories as hidden background context.
- Added settings for enabling local memory and configuring the vault-relative local-memory directory.
- Localized built-in slash command descriptions and argument hints to Chinese.
- Clarified that the local-memory implementation only references Supermemory's product logic.
- No Supermemory cloud API, MCP endpoint, API key, remote database, or third-party cloud memory service is used by this local implementation.
- Fixed streamed reply rendering so multi-part Codex answers are separated into visible paragraphs instead of being merged into one long block.
- Fixed image input for the `Codex App Server` adapter by sending the correct `localImage` item type.
- Added automatic stale-thread recovery: when an old conversation thread cannot continue, `Codian` now rebuilds the request history into a fresh thread and retries once.

## 1.3.84-long-run-completion

### What changed

- Added secret redaction, a hard per-entry size limit, and three-generation rotation for local diagnostic logs.
- Replaced repeated Codex session-tree searches with a deterministic index capped at 20,000 visited entries per rebuild.
- Added a persistent, atomic DeepSeek Write/Edit recovery journal that remains available after restart and requires explicit user approval for Undo.
- Refuses recovery when the target changed after the recorded operation, preventing an old snapshot from overwriting newer edits.
- Added a local diagnostics command that copies only bounded aggregate health data and never includes secrets, usernames, absolute paths, file content, telemetry, or network submission.
- Added deterministic install and rollback archives, exact archive-content validation, cross-file version checks, and SHA-256 verification.

### Compatibility and limits

- No new runtime dependency, API key, database, server, Docker service, paid account, or telemetry.
- Persistent recovery covers Codian-owned DeepSeek Write/Edit operations. Codex App Server, Bash, and external MCP actions cannot be universally rolled back because complete pre-action state is not available.
- Obsidian minimum version remains `1.4.5`.

## 1.3.67

Initial public Codian release.

### What changed

- Established the `Codian` plugin identity and integrated the Codex runtime.
- Switched the main chat runtime to `Codex App Server` with real streaming output.
- Added image understanding for pasted, dropped, and embedded note images.
- Fixed conversation recovery, current-note context restore, and history reload after restarting Obsidian.
- Cleaned up the settings UI so migration compatibility items are folded away from the main workflow.

### Notes

- The repository license notice is preserved.
- GitHub Actions workflow files are not included in this initial push because the current GitHub token does not have `workflow` scope.
