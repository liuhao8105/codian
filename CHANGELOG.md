# Changelog

## Unreleased

### What changed

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
