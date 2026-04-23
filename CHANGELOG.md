# Changelog

## Unreleased

### What changed

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
