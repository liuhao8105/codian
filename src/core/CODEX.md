# Core Infrastructure

Core modules have **no feature dependencies**. Features depend on core, never the reverse.

## Modules

| Module | Purpose | Key Files |
|--------|---------|-----------|
| `agent/` | Legacy query/options helpers retained for compatibility | `QueryOptionsBuilder`, `SessionManager`, `MessageChannel`, `customSpawn` |
| `agents/` | Custom agent discovery | `AgentManager`, `AgentStorage` |
| `commands/` | Built-in command actions | `builtInCommands` |
| `hooks/` | Security hooks | `SecurityHooks` |
| `images/` | Image caching | SHA-256 dedup, base64 encoding |
| `mcp/` | Model Context Protocol | `McpServerManager`, `McpTester` |
| `prompts/` | System prompts | `mainAgent`, `inlineEdit`, `instructionRefine`, `titleGeneration` |
| `runtime/` | Codex execution runtime | `CodexAgentRuntime`, `CodexAppServerClient`, `codexExec` |
| `runtime/` | Legacy session parsing / compatibility transforms | `transformRuntimeMessage`, `typeGuards`, `types` |
| `security/` | Access control | `ApprovalManager` (permission utilities), `BashPathValidator`, `BlocklistChecker` |
| `storage/` | Persistence layer | `StorageService`, `SessionStorage`, `RuntimeSettingsStorage`, `CodianSettingsStorage`, `McpStorage`, `SkillStorage`, `SlashCommandStorage`, `VaultFileAdapter` |
| `tools/` | Tool utilities | `toolNames` (incl. plan mode tools), `toolIcons`, `toolInput`, `todo` |
| `types/` | Type definitions | `settings`, `agent`, `mcp`, `chat`, `tools`, `models`, `runtime`, `plugins`, `diff` |

## Dependency Rules

```
types/ ← (all modules can import)
storage/ ← security/, agent/, mcp/
security/ ← agent/
runtime/ ← agent/
hooks/ ← agent/
prompts/ ← runtime/
runtime/ ← prompts/, mcp/, storage helper types
```

## Key Patterns

### Codex Runtime
```typescript
// One runtime instance per tab (lazy init on first query)
const runtime = new CodexAgentRuntime(plugin, mcpManager);
for await (const chunk of runtime.query(prompt, images, history, queryOptions)) {
  // Stream chunks directly into UI
}
runtime.cancel(); // Stop current turn
```

### App Server Client
```typescript
const client = new CodexAppServerClient(plugin, onNotification, abortSignal);
await client.initialize();
await client.request('thread/start', params);
await client.request('turn/start', params);
```

### Storage
```typescript
// Settings in vault/.codian/settings.json and .codian/codian-settings.json
await RuntimeSettingsStorage.load(vaultPath);
await RuntimeSettingsStorage.save(vaultPath, settings);

// Conversation metadata overlay
await SessionStorage.loadSession(vaultPath, sessionId);
```

### Security
- `BashPathValidator`: Vault-only by default, symlink-safe via `realpath`
- `ApprovalManager`: Permission utility functions (`buildPermissionUpdates`, `matchesRulePattern`, etc.)
- `BlocklistChecker`: Platform-specific dangerous commands

## Gotchas

- `CodexAgentRuntime` currently uses `Codex App Server` for chat streaming and falls back to creating a new thread when resume fails.
- `codexExec` is still used by title generation, instruction refinement, and inline edit.
- Storage paths are encoded: non-alphanumeric → `-`
- `customSpawn` remains for legacy compatibility code paths.
- Plan mode uses dedicated callbacks (`exitPlanModeCallback`, `permissionModeSyncCallback`) that bypass normal approval flow in `canUseTool`.
