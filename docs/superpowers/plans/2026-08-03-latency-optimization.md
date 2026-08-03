# Codian Latency Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make selected Codex reasoning effort effective and reduce repeated prompt overhead without changing conversation data semantics.

**Architecture:** Send stable Codian rules through App Server `developerInstructions` on thread start/resume, and send the selected `thinkingBudget` through `turn/start.effort`. Compact the fixed prompt by retaining only Codian/Obsidian-specific constraints and removing generic Codex tool manuals.

**Tech Stack:** TypeScript, Jest, Obsidian API, Codex App Server JSON-RPC, Node.js release scripts.

## Global Constraints

- Base all changes on `origin/main` version `1.3.88-long-run-safety`.
- Do not add dependencies, API keys, databases, servers, Docker, plugins, Skills, or MCP servers.
- Preserve `data.json`, conversations, attachments, model selection, MCP gating, and permission behavior.
- Use one main Agent and the isolated `codex/1.3.89-latency-optimization` worktree.
- Install only verified `main.js`, `manifest.json`, and `styles.css` after creating an external rollback backup.

---

### Task 1: Lock App Server request behavior with tests

**Files:**
- Modify: `tests/unit/core/runtime/CodexAgentRuntime.test.ts`

**Interfaces:**
- Consumes: `CodexAgentRuntime.query(prompt)` and mocked App Server `request(method, params)`.
- Produces: regression coverage for `developerInstructions`, `effort`, and unwrapped user input.

- [ ] **Step 1: Write failing tests**

Add tests that set `thinkingBudget: 'low'`, call `query('hello')`, and assert:

```ts
expect(threadStartParams.developerInstructions).toContain('Codian');
expect(turnStartParams.effort).toBe('low');
expect(turnInputText).toBe('hello');
```

Add a resumed-thread test asserting `thread/resume` receives `developerInstructions`, and an `off` test asserting `effort` is omitted.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --runInBand tests/unit/core/runtime/CodexAgentRuntime.test.ts`

Expected: FAIL because the runtime currently wraps instructions into user input and omits both protocol fields.

### Task 2: Implement native instructions and reasoning effort

**Files:**
- Modify: `src/core/runtime/CodexAgentRuntime.ts`
- Test: `tests/unit/core/runtime/CodexAgentRuntime.test.ts`

**Interfaces:**
- Consumes: `plugin.settings.thinkingBudget` and `buildSystemPrompt(...)`.
- Produces: App Server requests with `developerInstructions?: string` and `effort?: string`.

- [ ] **Step 1: Implement minimal protocol mapping**

Build developer instructions once per query attempt. Pass them to `thread/start` and `thread/resume`. Pass `thinkingBudget` to every `turn/start` as `effort` when it is not `off`. Send the rebuilt request directly through `buildInput` without XML-wrapping the fixed instructions.

Start the App Server child process with the Obsidian vault root as `cwd`; cover this with `CodexAppServerClient.test.ts` so the CLI installation directory cannot become the project context again.

- [ ] **Step 2: Verify GREEN**

Run: `npm test -- --runInBand tests/unit/core/runtime/CodexAgentRuntime.test.ts`

Expected: PASS.

### Task 3: Compact the fixed Codian prompt

**Files:**
- Modify: `src/core/prompts/mainAgent.ts`
- Modify: `tests/unit/core/prompts/systemPrompt.test.ts`

**Interfaces:**
- Consumes: `SystemPromptSettings`.
- Produces: `buildSystemPrompt(settings): string` with all Codian-specific invariants and less generic text.

- [ ] **Step 1: Add a failing size and invariant test**

Assert the default prompt retains identity, path rules, context tags, vault-only web boundary, file-link format, image handling, and tool-action safety while staying below `9_000` characters.

- [ ] **Step 2: Verify RED**

Run: `npm test -- --runInBand tests/unit/core/prompts/systemPrompt.test.ts`

Expected: FAIL because the current prompt is larger than the cap.

- [ ] **Step 3: Remove duplicated generic manuals**

Delete the verbose Codex-generic Read/Edit/Bash, Agent, TaskOutput, TodoWrite, and Skills sections. Rewrite the remaining rules concisely without weakening vault/export/external path boundaries, current-note semantics, web-search restrictions, or Obsidian link/media behavior.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --runInBand tests/unit/core/prompts/systemPrompt.test.ts`

Expected: PASS.

### Task 4: Release and live installation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `versions.json`
- Modify: `CHANGELOG.md`
- Create: `docs/releases/v1.3.89-latency-optimization.md`

**Interfaces:**
- Consumes: verified source and known-good rollback directory.
- Produces: versioned release assets and a verified installed Obsidian plugin.

- [ ] **Step 1: Run source verification**

Run full tests, `npm run typecheck`, `npm run lint`, `npm run build`, production audit, and full development audit.

- [ ] **Step 2: Bump and package version**

Set all version surfaces to `1.3.89-latency-optimization`, build, package with the known-good `1.3.88` rollback directory, and run `npm run verify:release`.

- [ ] **Step 3: Back up and install**

Create an external timestamped backup of installed runtime assets and `data.json`. Replace only `main.js`, `manifest.json`, and `styles.css`; verify `data.json` SHA-256 is unchanged.

- [ ] **Step 4: Restart and verify live behavior**

Restart Obsidian, confirm loaded version/provider and installed hashes, then send a short greeting. Record startup, first activity, reasoning, first text, and total latency from fresh runtime logs.

- [ ] **Step 5: Commit and push**

Review the diff, commit the scoped changes on `codex/1.3.89-latency-optimization`, and push without force.
