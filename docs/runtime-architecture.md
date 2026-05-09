# Codian Runtime Architecture

## 1. Provider Dispatch

Codian selects the runtime based on `plugin.settings.currentProvider`:

```
plugin.settings.currentProvider
  ├─ "codex"    → new CodexAgentRuntime(plugin, mcpManager)
  └─ "deepseek" → new DeepSeekRuntime(plugin, mcpManager)
```

**Entry point:** `src/core/runtime/index.ts` → `createAgentRuntime()`

The runtime is created per-tab via `initializeTabService()` in `src/features/chat/tabs/Tab.ts`. When the user switches provider in settings, the runtime is rebuilt on the next query via `ensureServiceInitialized()`.

**Isolation guarantee:** CodexAgentRuntime and DeepSeekRuntime share only the `AgentRuntime` interface. No code paths cross between them. Switching providers does not require an Obsidian restart.

---

## 2. Codex Runtime

### CodexAgentRuntime

**File:** `src/core/runtime/CodexAgentRuntime.ts`

Spawns the Codex CLI as a child process and communicates via JSON-RPC over stdio.

```
User Input
  → CodexAgentRuntime.query()
    → applyInstructionsToPrompt() — injects system prompt
    → CodexAppServerClient — spawns `codex app-server --listen stdio://`
    → JSON-RPC notifications (item/started, item/agentMessage/delta, ...)
    → Maps notifications → StreamChunk (text, tool_use, tool_result, ...)
  → StreamController.handleStreamChunk() — renders in UI
```

### CodexAppServerClient

**File:** `src/core/runtime/CodexAppServerClient.ts`

Manages the Codex CLI child process lifecycle:
- `spawn()` with environment variables and config overrides
- JSON-RPC request/response with `thread/start`, `turn/start`, `thread/resume`
- Server-to-client notifications via `readline` on stdout
- Abort via `AbortController` signal

### Tool/MCP/Skill Execution

All tool execution happens **inside the Codex CLI process**. The CLI:
- Has built-in definitions for all tools (Read, Write, Bash, Skill, MCP, Agent, etc.)
- Receives the Codian system prompt (which lists Skills, MCP servers, usage guidelines)
- Makes tool-calling decisions via the LLM
- Executes tools internally
- Reports results back as JSON-RPC notifications

Codian's `StreamController` **renders** tool calls but never **executes** them.

---

## 3. DeepSeek Runtime

### DeepSeekRuntime

**File:** `src/core/runtime/DeepSeekRuntime.ts`

A standalone runtime that communicates with the DeepSeek API via HTTP, using OpenAI-compatible chat completions with function calling.

```
User Input
  → DeepSeekRuntime.query()
    → buildSystemPromptContent() — reuses shared system prompt
    → POST /chat/completions { stream: true, tools: [...], tool_choice: "auto" }
    → parseSSEStream() — reads SSE from response.body
    → consumeSSEToResult() — buffers/yields text, accumulates tool_calls + reasoning
    → If tool_calls → executeDeepSeekToolCall() → add to messages → loop
    → If no tool_calls → yield { type: 'done' }
```

### API Integration

- **Endpoint:** `{baseUrl}/chat/completions`
- **Auth:** `Authorization: Bearer {apiKey}`
- **Streaming:** `stream: true` with SSE parsing
- **Tool format:** OpenAI function-calling (`tools` array + `tool_choice: "auto"`)

### SSE Streaming Pipeline

```
fetch() response.body
  → ReadableStream.getReader()
  → TextDecoder.decode()
  → Split by \n
  → Filter data: lines
  → JSON.parse()
  → Yield SSEChoice { delta: { content, reasoning_content, tool_calls }, finish_reason }
```

**Chunk buffering** (`consumeSSEToResult`):

| Trigger | Condition | Purpose |
|---------|-----------|---------|
| Sentence end | `。！？\n` in buffer | Natural paragraph breaks |
| Clause end | `，；：,;:` in buffer ≥ 40 chars | Readable clause breaks |
| Size limit | Buffer ≥ 80 chars | Prevent runaway buffer |
| Time limit | 150ms since last flush | Responsiveness floor |
| Final flush | Stream complete | No text loss |

---

## 4. Tool Loop

### DeepSeek Tool Loop Flow

```
while (round < MAX_TOOL_ROUNDS):
  1. POST /chat/completions (stream: true, with tools)
  2. Parse SSE → accumulate text, reasoning, tool_calls
  3. If no tool_calls → done (yield text was already streamed)
  4. If tool_calls:
     a. Push assistant message (with reasoning_content + tool_calls) to history
     b. For each tool_call:
        - Check duplicate (same Read file / Grep pattern)
        - Execute via ToolExecutor
        - Push tool result to history
        - Check no-progress
     c. Check stop conditions → force-summarize or continue
```

### ToolExecutor

**File:** `src/core/tools/toolExecutor.ts`

| Tool | Implementation | Risk |
|------|---------------|------|
| **Skill** | `plugin.storage.skills.loadAll()` — returns skill content | Read-only |
| **Read** | `plugin.app.vault.cachedRead()` — returns file content | Read-only |
| **Grep** | `child_process.exec('grep -rn')` — returns matching lines | Read-only |

### Stop Conditions

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Max rounds | 10 | Error: simplify request |
| Duplicate tools | 3 repeated calls | Force-summarize |
| No progress | 3 rounds with same results | Force-summarize |
| Early warning | Round ≥ 6 | Force-summarize |

**Force-summarize:** Injects `[System: Please answer based on gathered info...]` + makes one final API call without tools.

---

## 5. Reasoning Content

### Why It Must Be Preserved

DeepSeek reasoning models (`deepseek-reasoner`) return `reasoning_content` in the assistant message. This is the model's internal chain-of-thought. The API **requires** this field to be passed back unchanged in subsequent turns of a multi-turn conversation.

Without it: HTTP 400 — _"The reasoning_content in the thinking mode must be passed back to the API."_

### How It's Preserved

```
SSE chunk: delta.reasoning_content = "Let me think..."
  → accumulatedReasoning += delta.reasoning_content

Tool execution:
  → assistantMsg.reasoning_content = accumulatedReasoning
  → messages.push(assistantMsg)

Next API call:
  → messages includes reasoning_content from previous turn
```

---

## 6. Tab Lifecycle

### Provider Switch

1. User changes provider in settings dropdown
2. `InputToolbar.onProviderChange()` → `plugin.setCurrentProvider()`
3. Next query triggers `ensureServiceInitialized()` → `initializeTabService()`
4. `createAgentRuntime()` creates the appropriate runtime
5. Old runtime is cleaned up via `closePersistentQuery()`

### Stream Reset

1. `cancelStreaming()` → `state.bumpStreamGeneration()` (invalidates active stream)
2. `agentService.cancel()` → `activeAbortController.abort()`
3. `StreamController.resetStreamingState()` — clears DOM state
4. `ChatState.resetStreamingState()` — clears thinking/text/tool state

### Abort Cleanup

```
DeepSeek:
  cancel() → activeAbortController.abort()
  → SSE reader.cancel() via abort event listener
  → reader.releaseLock() in finally block

Codex:
  cancel() → activeAbortController.abort()
  → activeClient.kill()
  → child process terminated
```

---

## 7. StreamChunk Protocol

**File:** `src/core/types/chat.ts`

Both runtimes produce the same `StreamChunk` types. `StreamController` is runtime-agnostic.

| Chunk Type | Codex Source | DeepSeek Source |
|------------|-------------|-----------------|
| `text` | JSON-RPC `item/agentMessage/delta` | SSE `delta.content` |
| `tool_use` | JSON-RPC `item/started` (tool types) | Extracted from accumulated SSE `delta.tool_calls` |
| `tool_result` | JSON-RPC `item/completed` (tool types) | `ToolExecutor` result |
| `done` | JSON-RPC `turn/completed` | Stream end with no tool_calls |
| `error` | JSON-RPC `error` | HTTP error / exception |

---

## 8. Current Limitations

### DeepSeek Provider

| Limitation | Reason |
|------------|--------|
| No image support | Not implemented in DeepSeekRuntime |
| No Bash/Write/Delete | Tool whitelist limited to Skill/Read/Grep (P1) |
| No high-risk MCP | MCP bridge not implemented (planned P3) |
| No subagents | Agent/Task tool not implemented |
| No rewind/fork | Requires session persistence (not implemented) |
| No session resume | Stateless — each query is independent |
| Non-streaming tool results | Tool execution is synchronous, results displayed as blocks |

### Codex Provider

No limitations — full functionality preserved.
