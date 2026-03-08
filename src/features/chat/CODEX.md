# Chat Feature

Main sidebar chat interface. `CodianView` is a thin shell; logic lives in controllers and services.

## Architecture

```
CodianView (lifecycle + assembly)
├── ChatState (centralized state)
├── Controllers
│   ├── ConversationController  # History, session switching
│   ├── StreamController        # Streaming, auto-scroll, abort
│   ├── InputController         # Text input, file context, images
│   ├── SelectionController     # Editor selection awareness
│   └── NavigationController    # Keyboard navigation (vim-style)
├── Services
│   ├── TitleGenerationService   # Auto-generate conversation titles
│   ├── SubagentManager          # Unified sync/async subagent lifecycle
│   ├── InstructionRefineService # "#" instruction mode
│   └── BangBashService          # Direct bash execution ("!" mode)
├── Rendering
│   ├── MessageRenderer         # Main rendering orchestrator
│   ├── ToolCallRenderer        # Tool use blocks
│   ├── ThinkingBlockRenderer   # Extended thinking
│   ├── WriteEditRenderer       # File write/edit with diff
│   ├── DiffRenderer            # Inline diff display
│   ├── TodoListRenderer        # Todo panel
│   ├── SubagentRenderer        # Subagent status panel
│   ├── InlineExitPlanMode      # Plan mode approval card
│   ├── InlineAskUserQuestion   # AskUserQuestion inline card
│   └── collapsible             # Collapsible block utility
├── Tabs
│   ├── TabManager              # Multi-tab orchestration
│   ├── TabBar                  # Tab UI component
│   └── Tab                     # Individual tab state + fork request handling
└── UI Components
    ├── InputToolbar            # Model selector, thinking, permissions, context meter
    ├── FileContext             # @-mention chips and dropdown
    ├── ImageContext            # Image attachments
    ├── StatusPanel             # Todo/subagent/command output panels container
    ├── InstructionModeManager  # "#" mode UI
    └── BangBashModeManager     # "!" bash mode UI
```

## State Flow

```
User Input → InputController → AgentRuntime.query()
                                    ↓
                            StreamController (handle chunks)
                                    ↓
                            MessageRenderer (update DOM)
                                    ↓
                            ChatState (persist)
```

## Controllers

| Controller | Responsibility |
|------------|----------------|
| `ConversationController` | Load/save sessions, history panel, session switching, fork session setup |
| `StreamController` | Process streamed chunks, auto-scroll, streaming UI state |
| `InputController` | Input textarea, file/image attachments, slash commands |
| `SelectionController` | Poll editor selection (250ms), CM6 decoration |
| `NavigationController` | Vim-style keyboard navigation (j/k scroll, i focus) |

## Rendering Pipeline

| Renderer | Handles |
|----------|---------|
| `MessageRenderer` | Orchestrates all rendering, manages message containers, fork button on user messages |
| `ToolCallRenderer` | Tool use blocks with status, input display |
| `ThinkingBlockRenderer` | Extended thinking with collapse/expand |
| `WriteEditRenderer` | File operations with before/after diff |
| `DiffRenderer` | Hunked inline diffs (del/ins highlighting) |
| `InlineExitPlanMode` | Plan mode approval card (approve/feedback/new session) |
| `InlineAskUserQuestion` | AskUserQuestion inline card |
| `TodoListRenderer` | Todo items with status icons |
| `SubagentRenderer` | Background agent progress |

## Key Patterns

### Lazy Tab Initialization
```typescript
// Runtime created on first query, not on tab creation
tab.ensureService();
```

### Message Rendering
```typescript
for await (const chunk of agentRuntime.query(prompt, images, history, queryOptions)) {
  await streamController.handleStreamChunk(chunk, assistantMessage);
}
```

### Auto-Scroll
- Enabled by default during streaming
- User scroll-up disables; scroll-to-bottom re-enables
- Resets to setting value on new query

## Gotchas

- `CodexAgentRuntime` now streams through `Codex App Server`, not the old Claude SDK.
- `CodianView.onClose()` must abort all tabs and dispose services.
- Tab switching preserves scroll position per-tab.
- `ChatState` is per-tab; `TabManager` coordinates across tabs.
- Title generation runs concurrently per conversation.
- `/compact`, plan mode, bang-bash mode, and fork still contain legacy compatibility paths; change them carefully.
