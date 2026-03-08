# Codian Migration Design

## Goal

Build a self-use Obsidian plugin that keeps the existing Claudian UI and interaction model, while replacing the Claude-specific execution layer with a Codex-based implementation.

## V1 Scope

- Keep the Obsidian plugin structure.
- Keep chat, conversation tabs, inline edit, slash commands, and settings UI.
- Replace user-facing branding from Claude/Claudian to Codex/Codian.
- Introduce a future adapter boundary for the agent runtime.

## Phase Plan

1. Phase 1: rebrand plugin metadata and key UI wording so the project can be installed as `Codian`.
2. Phase 2: isolate Claude-bound services behind a runtime adapter interface.
3. Phase 3: implement the Codex runtime adapter and restore chat and inline edit flows.
4. Phase 4: remove or replace remaining Claude-specific settings, docs, and compatibility shims.

## Constraints

- Do not rewrite the UI unless required.
- Do not pretend Claude-specific code already works with Codex.
- Each phase must stay buildable so the plugin can be tested incrementally.
