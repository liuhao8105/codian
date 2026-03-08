# Changelog

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
