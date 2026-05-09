/**
 * OpenAI-compatible tool definitions for DeepSeekRuntime.
 * P1: Skill, Read, Grep only — all read-only, low risk.
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
];

/** Tools description injected into the system prompt for DeepSeek. */
export const DEEPSEEK_TOOLS_SYSTEM_PROMPT_SECTION = `
## Available Tools (DeepSeek)

You have access to the following tools. Use them when needed to gather information before answering.

### Tool Usage Rules
1. Use tools to gather information — do not guess or fabricate.
2. After receiving tool results, continue your response naturally.
3. Do not mention tool calls in your user-facing answer unless the user asks.
4. You may call multiple tools in a single turn if independent.
5. Maximum 10 tool calls per user message.

### Skill Tool
Invoke skills to load specialized instructions. When a skill is loaded, follow its instructions carefully. Skills are read-only — they provide guidance, not execution capabilities.

### Read Tool
Read files from the vault. Use relative paths from the vault root.

### Grep Tool
Search for patterns in vault files. Returns matching lines with file paths.
`;
