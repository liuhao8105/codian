/**
 * Codian - Built-in slash commands
 *
 * System commands that perform actions (not prompt expansions).
 * These are handled separately from user-defined slash commands.
 */

export type BuiltInCommandAction = 'clear' | 'add-dir' | 'resume' | 'fork' | 'remember' | 'recall';

export interface BuiltInCommand {
  name: string;
  aliases?: string[];
  description: string;
  action: BuiltInCommandAction;
  /** Whether this command accepts arguments. */
  hasArgs?: boolean;
  /** Hint for arguments shown in dropdown (e.g., "path"). */
  argumentHint?: string;
}

export interface BuiltInCommandResult {
  command: BuiltInCommand;
  /** Arguments passed to the command (trimmed, after command name). */
  args: string;
}

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  {
    name: 'clear',
    aliases: ['new'],
    description: '新建对话',
    action: 'clear',
  },
  {
    name: 'add-dir',
    description: '添加外部上下文目录',
    action: 'add-dir',
    hasArgs: true,
    argumentHint: '[目录路径]',
  },
  {
    name: 'resume',
    description: '继续之前的对话',
    action: 'resume',
  },
  {
    name: 'fork',
    description: '复制当前完整对话到新会话',
    action: 'fork',
  },
  {
    name: 'remember',
    description: '保存一条本地记忆',
    action: 'remember',
    hasArgs: true,
    argumentHint: '[要记住的内容]',
  },
  {
    name: 'recall',
    description: '搜索本地记忆',
    action: 'recall',
    hasArgs: true,
    argumentHint: '[搜索关键词]',
  },
];

/** Map of command names/aliases to their definitions. */
const commandMap = new Map<string, BuiltInCommand>();

for (const cmd of BUILT_IN_COMMANDS) {
  commandMap.set(cmd.name.toLowerCase(), cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commandMap.set(alias.toLowerCase(), cmd);
    }
  }
}

/**
 * Checks if input is a built-in command.
 * Returns the command and arguments if found, null otherwise.
 */
export function detectBuiltInCommand(input: string): BuiltInCommandResult | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  // Extract command name (first word after /)
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s(.*))?$/);
  if (!match) return null;

  const cmdName = match[1].toLowerCase();
  const command = commandMap.get(cmdName);
  if (!command) return null;

  const args = (match[2] || '').trim();

  return { command, args };
}

/**
 * Gets all built-in commands for dropdown display.
 * Returns commands in a format compatible with SlashCommand interface.
 */
export function getBuiltInCommandsForDropdown(): Array<{
  id: string;
  name: string;
  description: string;
  content: string;
  argumentHint?: string;
}> {
  return BUILT_IN_COMMANDS.map((cmd) => ({
    id: `builtin:${cmd.name}`,
    name: cmd.name,
    description: cmd.description,
    content: '', // Built-in commands don't have prompt content
    argumentHint: cmd.argumentHint,
  }));
}
