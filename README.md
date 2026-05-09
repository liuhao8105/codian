# Codian

[中文说明](README.zh-CN.md)

![GitHub stars](https://img.shields.io/github/stars/liuhao8105/codian?style=social)
![GitHub release](https://img.shields.io/github/v/release/liuhao8105/codian)
![License](https://img.shields.io/github/license/liuhao8105/codian)

![Preview](Preview.png)

An Obsidian plugin for using `Codex` and `DeepSeek` inside your vault with a `Codian` Obsidian experience.

## Attribution

This project is a derivative work based on the open-source project
[`YishenTu/claudian`](https://github.com/YishenTu/claudian), adapted for `Codex`
and the `Codian` plugin experience. The upstream project is licensed under MIT,
and the original license notice is preserved in this repository.

## Current Status

- Plugin identity, installation metadata, and key user-facing wording now target `Codex`.
- Main chat, inline edit, title generation, and instruction refinement now run through a `Codex CLI` adapter.
- **v1.3.75**: DeepSeek provider with SSE streaming, tool loop (Skill/Read/Grep/Write/Edit/Undo), read-only MCP bridge, user approval, transaction log, vault sandbox, and DSML protocol filtering.
- Some legacy settings and docs from the upstream project are still being cleaned up.

## Providers

Codian supports two AI providers with independent runtime implementations:

| Provider | Runtime | Capabilities |
|----------|---------|--------------|
| **Codex** | `CodexAgentRuntime` | Full Agent: all tools, skills, MCP (via Codex CLI), subagents, rewind, fork, plan mode, Bash, Write |
| **DeepSeek** | `DeepSeekRuntime` | Chat + Tool Loop: streaming, Skill/Read/Grep/Write/Edit/Undo, read-only MCP bridge, user approval, transaction log |

### DeepSeek Provider

**Current capabilities (v1.3.75):**

- SSE streaming chat (natural paragraph-by-paragraph output, DSML protocol filtering)
- Multi-turn tool loop with duplicate/no-progress detection and auto-summarization
- **Read-only tools**: Skill (load skill instructions), Read (read vault files), Grep (search vault files)
- **File modification tools** (with mandatory user confirmation): Write (create/overwrite files), Edit (targeted string replacement), Undo (revert last Write/Edit)
- **Read-only MCP bridge**: automatically discovers and calls read-only MCP tools from configured servers (e.g., Eagle search, database queries)
- **TransactionLog**: per-session action journal for undo support
- **Vault sandbox**: path validation blocks `.git/`, `node_modules/`, `.obsidian/plugins/`, hidden directories
- Reasoning content preservation (DeepSeek thinking models)
- Esc interruption

**MCP support:**

| Provider | MCP Source | Scope |
|----------|-----------|-------|
| **Codex** | Codex CLI (built-in) | Full MCP: all tools, including write/delete/execute |
| **DeepSeek** | Codian MCP bridge | Read-only MCP: query/search/list/get tools only |

**Current limitations:**

- No image attachment support
- No Bash execution
- No Delete tool (trash-based undo only)
- **MCP write/delete/update not supported** — DeepSeek MCP bridge only allows read-only tools
- No subagent (Agent/Task) support
- No rewind/fork support
- No session resume across restarts

**Configuration:**

1. Open Codian settings → Provider tab
2. Select "DeepSeek" as the current provider
3. Enter your DeepSeek API key
4. Set Base URL (default: `https://api.deepseek.com/v1`)
5. Choose model (`deepseek-chat` or `deepseek-reasoner`)

> Read the full architecture documentation: [docs/runtime-architecture.md](docs/runtime-architecture.md)

## Features

- **Full Agentic Capabilities**: Use Codex to read, write, and edit files, search, and execute bash commands inside your Obsidian vault.
- **Context-Aware**: Automatically attach the focused note, mention files with `@`, exclude notes by tag, include editor selection (Highlight), and access external directories for additional context.
- **Vision Support**: Analyze images by sending them via drag-and-drop, paste, or file path.
- **Inline Edit**: Edit selected text or insert content at cursor position directly in notes with word-level diff preview and read-only tool access for context.
- **Instruction Mode (`#`)**: Add refined custom instructions to your system prompt directly from the chat input, with review/edit in a modal.
- **Slash Commands**: Create reusable prompt templates triggered by `/command`, with argument placeholders, `@file` references, and optional inline bash substitutions.
- **Skills**: Extend Codian with reusable capability modules that are automatically invoked based on context.
- **Custom Agents**: Define custom subagents that Codian can invoke, with support for tool restrictions and model overrides.
- **Legacy Plugin Compatibility**: Keep compatibility with some upstream plugin settings discovered from `~/.claude/plugins`.
- **MCP Support**: Connect external tools and data sources via Model Context Protocol servers (stdio, SSE, HTTP) with context-saving mode and `@`-mention activation.
- **Advanced Model Control**: Select between Haiku, Sonnet, and Opus, configure custom models via environment variables, fine-tune thinking budget, and enable Sonnet with 1M context window (requires Max subscription).
- **Plan Mode**: Toggle plan mode via Shift+Tab in the chat input. Codian explores and designs before implementing, presenting a plan for approval with options to approve in a new session, continue in the current session, or provide feedback.
- **Security**: Permission modes (YOLO/Safe/Plan), safety blocklist, and vault confinement with symlink-safe checks.
- **Chrome Compatibility**: Keep compatibility with the `claude-in-chrome` extension where available.

## Requirements

- **Codex provider**: `Codex CLI` installed and available on your machine
- **DeepSeek provider**: A DeepSeek API key (no local CLI required)
- Obsidian v1.8.9+
- Desktop only (macOS, Linux, Windows)

## Installation

### From GitHub Release (recommended)

1. Build or download `main.js`, `manifest.json`, and `styles.css`
2. Create a folder called `codian` in your vault's plugins folder:
   ```
   /path/to/vault/.obsidian/plugins/codian/
   ```
3. Copy the files into the `codian` folder
4. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Codian"

### Using BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewers Auto-update Tester) allows you to install and automatically update plugins directly from GitHub.

1. Install the BRAT plugin from Obsidian Community Plugins
2. Enable BRAT in Settings → Community plugins
3. Open BRAT settings and click "Add Beta plugin"
4. Enter the repository URL: `https://github.com/liuhao8105/codian`
5. Click "Add Plugin" and BRAT will install Codian automatically
6. Enable Codian in Settings → Community plugins

> **Tip**: BRAT will automatically check for updates and notify you when a new version is available.

### From source (development)

1. Clone this repository into your vault's plugins folder:
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/liuhao8105/codian.git
   cd codian
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Enable the plugin in Obsidian:
   - Settings → Community plugins → Enable "Codian"

### Development

```bash
# Watch mode
npm run dev

# Production build
npm run build
```

> **Tip**: Copy `.env.local.example` to `.env.local` or `npm install` and setup your vault path to auto-copy files during development.

## Usage

**Two modes:**
1. Click the bot icon in ribbon or use command palette to open chat
2. Select text + hotkey for inline edit

Use it like Codex in Obsidian: read, write, edit, and search files in your vault.

### Context

- **File**: Auto-attaches focused note; type `@` to attach other files
- **@-mention dropdown**: Type `@` to see MCP servers, agents, external contexts, and vault files
  - `@Agents/` shows custom agents for selection
  - `@mcp-server` enables context-saving MCP servers
  - `@folder/` filters to files from that external context (e.g., `@workspace/`)
  - Vault files shown by default
- **Selection**: Select text in editor, or elements in canvas, then chat—selection included automatically
- **Images**: Drag-drop, paste, or type path; configure media folder for `![[image]]` embeds
- **External contexts**: Click folder icon in toolbar for access to directories outside vault

### Features

- **Inline Edit**: Select text + hotkey to edit directly in notes with word-level diff preview
- **Instruction Mode**: Type `#` to add refined instructions to system prompt
- **Slash Commands**: Type `/` for custom prompt templates or skills
- **Skills**: Add `skill/SKILL.md` files to `~/.claude/skills/` or `{vault}/.claude/skills/`
- **Custom Agents**: Add `agent.md` files to `~/.claude/agents/` (global) or `{vault}/.claude/agents/` (vault-specific); select via `@Agents/` in chat, or prompt Codian to invoke agents
- **Legacy Plugin Compatibility**: Review compatibility entries via Settings → Legacy Plugin Compatibility
- **MCP**: Add external tools via Settings → MCP Servers; use `@mcp-server` in chat to activate

## Configuration

### Settings

**Customization**
- **User name**: Your name for personalized greetings
- **Excluded tags**: Tags that prevent notes from auto-loading (e.g., `sensitive`, `private`)
- **Media folder**: Configure where vault stores attachments for embedded image support (e.g., `attachments`)
- **Custom system prompt**: Additional instructions appended to the default system prompt (Instruction Mode `#` saves here)
- **Enable auto-scroll**: Toggle automatic scrolling to bottom during streaming (default: on)
- **Auto-generate conversation titles**: Toggle AI-powered title generation after the first user message is sent
- **Title generation model**: Model used for auto-generating conversation titles (default: Auto/Haiku)
- **Vim-style navigation mappings**: Configure key bindings with lines like `map w scrollUp`, `map s scrollDown`, `map i focusInput`

**Hotkeys**
- **Inline edit hotkey**: Hotkey to trigger inline edit on selected text
- **Open chat hotkey**: Hotkey to open the chat sidebar

**Slash Commands**
- Create/edit/import/export custom `/commands` (optionally override model and allowed tools)

**MCP Servers**
- Add/edit/verify/delete MCP server configurations with context-saving mode

**Legacy Plugin Compatibility**
- Review or toggle compatible legacy plugin entries discovered from `~/.claude/plugins`
- User-scoped plugins are available in all vaults; project-scoped plugins only in matching vaults

**Safety**
- **Load legacy settings**: Load `~/.claude/settings.json` (legacy permission rules may bypass Safe mode)
- **Enable command blocklist**: Block dangerous bash commands (default: on)
- **Blocked commands**: Patterns to block (supports regex, platform-specific)
- **Allowed export paths**: Paths outside the vault where files can be exported (default: `~/Desktop`, `~/Downloads`). Supports `~`, `$VAR`, `${VAR}`, and `%VAR%` (Windows).

**Environment**
- **Custom variables**: Environment variables for the current Codex runtime (KEY=VALUE format, supports `export ` prefix)
- **Environment snippets**: Save and restore environment variable configurations

**Advanced**
- **Codex CLI path**: Custom path to the Codex CLI (leave empty for auto-detection)

## Safety and Permissions

| Scope | Access |
|-------|--------|
| **Vault** | Full read/write (symlink-safe via `realpath`) |
| **Export paths** | Write-only (e.g., `~/Desktop`, `~/Downloads`) |
| **External contexts** | Full read/write (session-only, added via folder icon) |

- **YOLO mode**: No approval prompts; all tool calls execute automatically (default)
- **Safe mode**: Approval prompt per tool call; Bash requires exact match, file tools allow prefix match
- **Plan mode**: Explores and designs a plan before implementing. Toggle via Shift+Tab in the chat input

## Privacy & Data Use

- **Sent to API**: Your input, attached files, images, and tool call outputs. Default: Anthropic; custom endpoint via `ANTHROPIC_BASE_URL`.
- **Local storage**: Settings, session metadata, and commands stored in `vault/.claude/`; session messages in `~/.claude/projects/` (SDK-native); legacy sessions in `vault/.claude/sessions/`.
- **No telemetry**: No tracking beyond your configured API provider.

## Troubleshooting

### Codex CLI not found

If you encounter a Codex CLI not found error, the plugin can't auto-detect your Codex installation.

**Solution**: Find your CLI path and set it in Settings → Advanced → Codex CLI path.

| Platform | Command | Example Path |
|----------|---------|--------------|
| macOS/Linux | `which codex` | `/Applications/Codex.app/Contents/Resources/codex` |
| Windows | `where.exe codex` | `C:\Path\To\codex.exe` |

> **Note**: On Windows, use the actual Codex executable path.

**Alternative**: Add your Node.js bin directory to PATH in Settings → Environment → Custom variables.

### npm CLI and Node.js not in same directory

If using a PATH-installed CLI, check whether `codex` and `node` are available from your environment:
```bash
which codex
dirname $(which node)
```

If different, GUI apps like Obsidian may not find Node.js.

**Solutions**:
1. Install native binary (recommended)
2. Add Node.js path to Settings → Environment: `PATH=/path/to/node/bin`

**Still having issues?** [Open a GitHub issue](https://github.com/liuhao8105/codian/issues) with your platform, CLI path, and error message.

## Architecture

```
src/
├── main.ts                      # Plugin entry point
├── core/                        # Core infrastructure
│   ├── agent/                   # Legacy compatibility helpers
│   ├── agents/                  # Custom agent management (AgentManager)
│   ├── commands/                # Slash command management (SlashCommandManager)
│   ├── hooks/                   # PreToolUse/PostToolUse hooks
│   ├── images/                  # Image caching and loading
│   ├── mcp/                     # MCP server config, service, and testing
│   ├── plugins/                 # Upstream plugin compatibility and management
│   ├── prompts/                 # System prompts for agents
│   ├── runtime/                 # Codex Agent Runtime + DeepSeek Runtime
│   ├── sdk/                     # Legacy session/message compatibility utilities
│   ├── security/                # Approval, blocklist, path validation
│   ├── storage/                 # Distributed storage system
│   ├── tools/                   # Tool constants, schemas, and executor
│   └── types/                   # Type definitions
├── features/                    # Feature modules
│   ├── chat/                    # Main chat view + UI, rendering, controllers, tabs
│   ├── inline-edit/             # Inline edit service + UI
│   └── settings/                # Settings tab UI
├── shared/                      # Shared UI components and modals
│   ├── components/              # Input toolbar bits, dropdowns, selection highlight
│   ├── mention/                 # @-mention dropdown controller
│   ├── modals/                  # Instruction modal
│   └── icons.ts                 # Shared SVG icons
├── i18n/                        # Internationalization (10 locales)
├── utils/                       # Modular utility functions
└── style/                       # Modular CSS (→ styles.css)
```

> Full runtime architecture: [docs/runtime-architecture.md](docs/runtime-architecture.md)

## Roadmap

- [x] Upstream plugin compatibility
- [x] Custom agent (subagent) support
- [x] Chrome compatibility support
- [x] `/compact` command
- [x] Plan mode
- [x] `rewind` and `fork` support (including `/fork` command)
- [x] `!command` support
- [x] Tool renderers refinement
- [ ] Hooks and other advanced features
- [ ] More to come!

## License

Licensed under the [MIT License](LICENSE).

## Star History

[![Star History Chart](https://api.star-history.com/image?repos=liuhao8105/codian&type=date&legend=top-left)](https://www.star-history.com/?type=date&legend=top-left&repos=liuhao8105%2Fcodian)

## Acknowledgments

- [Obsidian](https://obsidian.md) for the plugin API
- [OpenAI](https://openai.com) for Codex and the Codex CLI/App Server runtime
- [`YishenTu/claudian`](https://github.com/YishenTu/claudian) as the upstream open-source base project
