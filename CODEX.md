# CODEX.md

## Project Overview

Codian - An Obsidian plugin that embeds Codex as a sidebar chat interface. The vault directory becomes Codex's working directory, giving it full agentic capabilities: file read/write, bash commands, and multi-step workflows.

## Commands

```bash
npm run dev        # Development (watch mode)
npm run build      # Production build
npm run typecheck  # Type check
npm run lint       # Lint code
npm run lint:fix   # Lint and auto-fix
npm run test       # Run tests
npm run test:watch # Run tests in watch mode
```

## Architecture

| Layer | Purpose | Details |
|-------|---------|---------|
| **core** | Infrastructure (no feature deps) | See [`src/core/CODEX.md`](src/core/CODEX.md) |
| **features/chat** | Main sidebar interface | See [`src/features/chat/CODEX.md`](src/features/chat/CODEX.md) |
| **features/inline-edit** | Inline edit modal | `InlineEditService`, read-only tools |
| **features/settings** | Settings tab | UI components for all settings |
| **shared** | Reusable UI | Dropdowns, instruction modal, fork target modal, @-mention, icons |
| **i18n** | Internationalization | 10 locales |
| **utils** | Utility functions | date, path, env, editor, session, markdown, diff, context, runtimeSession, frontmatter, slashCommand, mcp, codexCli, externalContext, externalContextScanner, fileLink, imageEmbed, inlineEdit |
| **style** | Modular CSS | See [`src/style/CODEX.md`](src/style/CODEX.md) |

## Tests

```bash
npm run test -- --selectProjects unit        # Run unit tests
npm run test -- --selectProjects integration # Run integration tests
npm run test:coverage -- --selectProjects unit # Unit coverage
```

Tests mirror `src/` structure in `tests/unit/` and `tests/integration/`.

## Storage

| File | Contents |
|------|----------|
| `.codian/settings.json` | Runtime permission rules |
| `.codian/codian-settings.json` | Codian-specific settings (model, UI, etc.) |
| `.codian/settings.local.json` | Local overrides (gitignored) |
| `.codian/mcp.json` | MCP server configs |
| `.codian/commands/*.md` | Slash commands (YAML frontmatter) |
| `.codian/agents/*.md` | Custom agents (YAML frontmatter) |
| `.codian/skills/*/SKILL.md` | Skill definitions |
| `.codian/sessions/*.meta.json` | Session metadata |
| `~/.codex/sessions/**/*.jsonl` | Codex CLI session history |

## Development Notes

- **Codex-first**: Prefer native Codex App Server and Codex runtime capabilities over custom reimplementation whenever possible.
- **Runtime exploration**: When developing runtime-related features, call the real Codex runtime to observe response shapes, event sequences, and edge cases. Inspect `~/.codex/` diagnostics and the vault's `.codian/` runtime files before writing implementation or tests.
- **Comments**: Only comment WHY, not WHAT. No JSDoc that restates the function name (`/** Get servers. */` on `getServers()`), no narrating inline comments (`// Create the channel` before `new Channel()`), no module-level docs on barrel `index.ts` files. Keep JSDoc only when it adds non-obvious context (edge cases, constraints, surprising behavior).
- **TDD workflow**: For new functions/modules and bug fixes, follow red-green-refactor:
  1. Write a failing test first in the mirrored path under `tests/unit/` (or `tests/integration/`)
  2. Run it with `npm run test -- --selectProjects unit --testPathPattern <pattern>` to confirm it fails
  3. Write the minimal implementation to make it pass
  4. Refactor, keeping tests green
  - For bug fixes, write a test that reproduces the bug before fixing it
  - Test behavior and public API, not internal implementation details
  - Skip TDD for trivial changes (renaming, moving files, config tweaks) — but still verify existing tests pass
- Run `npm run typecheck && npm run lint && npm run test && npm run build` after editing
- No `console.*` in production code 
  - use Obsidian's notification system if user should be notified
  - use `console.log` for debugging, but remove it before committing
- Generated docs/test scripts go in `dev/`.
