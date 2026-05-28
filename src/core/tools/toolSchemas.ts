/**
 * OpenAI-compatible tool definitions for DeepSeekRuntime.
 * P1: Skill, Read, Grep (read-only)
 * P2: Write, Edit, Undo (with user confirmation)
 */

export interface DeepSeekToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const DEEPSEEK_P1_TOOLS: DeepSeekToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'Skill',
      description:
        'Invoke a reusable skill/capability module. Use this when the user asks for a task that matches a skill description. The skill content provides detailed instructions on how to complete the task. This is read-only — it loads the skill instructions into the conversation context.',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'The name of the skill to invoke (e.g., "eagle-photo-organizer", "brainstorming").',
          },
        },
        required: ['skill'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description:
        'Read a file from the Obsidian vault. Returns the full content of the specified file. Path is relative to the vault root.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file relative to the vault root (e.g., "notes/my-note.md").',
          },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description:
        'Search for a regex pattern in vault files. Returns matching lines with file paths and line numbers. Only searches Markdown (.md) files by default.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The regex pattern to search for.',
          },
          path: {
            type: 'string',
            description:
              'Optional. A subdirectory or file path relative to the vault root to limit the search scope.',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description:
        'Create a new file or completely overwrite an existing file in the vault. Path must be relative to the vault root. REQUIRES USER CONFIRMATION before the file is modified. You will see a diff preview before the change is applied.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path relative to the vault root (e.g., "notes/new-note.md").',
          },
          content: {
            type: 'string',
            description: 'The full Markdown content to write to the file.',
          },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description:
        'Make a targeted string replacement in an existing vault file. The old_string must match exactly (including whitespace). REQUIRES USER CONFIRMATION before the edit is applied. You will see a before/after preview.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path relative to the vault root.',
          },
          old_string: {
            type: 'string',
            description: 'The exact text to find and replace. Must match character-for-character.',
          },
          new_string: {
            type: 'string',
            description: 'The replacement text.',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Undo',
      description:
        'Undo the most recent Write or Edit operation. Only operations recorded in the current session can be undone. REQUIRES USER CONFIRMATION. Shows what will be restored before applying.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

export const DEEPSEEK_BASH_TOOL: DeepSeekToolDefinition = {
  type: 'function',
  function: {
    name: 'Bash',
    description:
      'Execute a local shell command inside the Obsidian vault working directory. Use this only when a loaded skill requires local commands such as python, yt-dlp, ffmpeg, or other installed CLI tools. The command is subject to Codian security settings and command blocklist.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        description: {
          type: 'string',
          description: 'Brief reason for running this command.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional timeout in milliseconds. Maximum is 600000.',
        },
      },
      required: ['command'],
    },
  },
};

/** Tools description injected into the system prompt for DeepSeek. */
export function getDeepSeekToolsSystemPromptSection(enableBash: boolean): string {
  const bashSection = enableBash
    ? `
### Local Command Tool
- **Bash**: Execute local shell commands from the vault working directory. Use it when a loaded skill requires Python scripts, yt-dlp, ffmpeg, transcription commands, or other local CLI tools. Commands run without a separate approval prompt, but they are still subject to Codian security settings and the command blocklist.
`
    : `
### Local Command Tool
- **Bash**: Disabled in settings. Do not claim you can run Python, yt-dlp, ffmpeg, or shell commands unless Bash is enabled for DeepSeek.
`;

  return `
## Available Tools (DeepSeek)

You have access to the following tools. Use them when needed.

### Tool Usage Rules
1. Use tools to gather information — do not guess or fabricate.
2. After receiving tool results, continue your response naturally.
3. Do not mention tool calls in your user-facing answer unless the user asks.
4. You may call multiple tools in a single turn if independent.
5. Maximum 10 tool calls per user message.

### Execution Behavior
- Execution override: these tool execution rules take precedence over style or persona rules when the user has already asked you to act.
- If the user explicitly asks you to update, organize, execute, write, continue, or proceed, continue the task with the available tools; do not stop after presenting a plan.
- Do not ask the user to choose work mode or confirm the plan again when their latest message already says to continue or execute.
- Do not let style rules such as first provide an outline prevent tool execution; provide the outline briefly and then call the needed tools in the same turn.
- Ask for confirmation only when required information is missing, the requested write is risky or ambiguous, or a tool approval is needed.
- A brief plan is acceptable for complex work, but it must be followed by execution in the same turn when the user has already asked you to act.
- Do not say you are starting, updating, writing, or refreshing a file unless you immediately call Write or Edit in the same response turn.
- Do not claim a file was updated unless a Write or Edit tool call has completed successfully.
- If you have enough information to update a file, call Write or Edit next instead of ending with a status sentence.

### Markdown Output Rules
- Produce valid, renderable Markdown in every user-facing response.
- Headings must include a space after the # characters, for example "## 当前状态", not "##当前状态".
- Put blank lines before and after headings, lists, and tables.
- Tables must be separated from surrounding text by blank lines and must include a complete header separator row.
- Do not concatenate headings, paragraphs, tables, or list items onto the same line.

### Read-Only Tools
- **Skill**: Load skill instructions into context (read-only).
- **Read**: Read files from the vault (read-only).
- **Grep**: Search for patterns in vault files (read-only).

### File Modification Tools (REQUIRE USER CONFIRMATION)
- **Write**: Create or overwrite a vault file. The user will be asked to confirm before any changes are made. A diff preview is shown.
- **Edit**: Replace text in a vault file. The user will be asked to confirm. A before/after preview is shown.
- **Undo**: Revert the most recent Write or Edit in this session. The user must confirm.
${bashSection}

### Safety Rules
1. NEVER write outside the vault directory.
2. NEVER write to .git/, node_modules/, .obsidian/plugins/, .obsidian/themes/, or hidden directories.
3. Always Read a file before Editing it to ensure old_string matches.
4. If old_string is not found, report the error — do not guess.
5. For new files, use Write. For targeted changes, use Edit.
`;
}
