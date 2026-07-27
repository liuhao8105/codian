# Changelog

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
- Added `.claude/local-memory/memories.jsonl` for structured local memories and `.claude/local-memory/profile.md` as a stable profile placeholder.
- Added `/remember [要记住的内容]` to save a local memory and `/recall [搜索关键词]` to search local memories.
- Added automatic local-memory recall during normal chat turns, injecting relevant memories as hidden background context.
- Added settings for enabling local memory and configuring the vault-relative local-memory directory.
- Localized built-in slash command descriptions and argument hints to Chinese.
- Clarified that this feature is built in `liuhao8105/codian`, which is derived from [`YishenTu/claudian`](https://github.com/YishenTu/claudian), and only references Supermemory's product logic.
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

- Forked and adapted the open-source [`YishenTu/claudian`](https://github.com/YishenTu/claudian) project for `Codex`.
- Reworked the Obsidian plugin identity from `Claudian / Claude` to `Codian / Codex`.
- Switched the main chat runtime to `Codex App Server` with real streaming output.
- Added image understanding for pasted, dropped, and embedded note images.
- Fixed conversation recovery, current-note context restore, and history reload after restarting Obsidian.
- Cleaned up the settings UI so migration compatibility items are folded away from the main workflow.

### Notes

- This repository preserves the original upstream MIT license notice.
- GitHub Actions workflow files are not included in this initial push because the current GitHub token does not have `workflow` scope.
