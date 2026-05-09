/**
 * ToolExecutor for DeepSeekRuntime P1.
 * Executes Skill, Read, and Grep tools.
 * All P1 tools are read-only and low-risk.
 */

import { exec } from 'child_process';
import * as path from 'path';

import type CodianPlugin from '../../main';
import { getVaultPath } from '../../utils/path';

export interface ToolExecutionContext {
  plugin: CodianPlugin;
}

/**
 * Execute a single tool call and return the result string to feed back to the LLM.
 */
export async function executeDeepSeekToolCall(
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  context: ToolExecutionContext,
): Promise<string> {
  switch (toolCall.name) {
    case 'Skill':
      return executeSkill(toolCall.arguments, context);
    case 'Read':
      return executeRead(toolCall.arguments, context);
    case 'Grep':
      return executeGrep(toolCall.arguments, context);
    default:
      return `Error: Unknown tool '${toolCall.name}'. Available tools: Skill, Read, Grep.`;
  }
}

async function executeSkill(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const skillName = String(args.skill || '');
  if (!skillName.trim()) {
    return 'Error: No skill name provided. Please specify a skill name to invoke.';
  }

  let skills;
  try {
    skills = await context.plugin.storage.skills.loadAll();
  } catch (error) {
    return `Error loading skills: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Match by name or by skill-<name> id
  const skill = skills.find(
    (s) => s.name === skillName.trim() || s.id === `skill-${skillName.trim()}`,
  );

  if (!skill) {
    const available = skills.map((s) => s.name).join(', ');
    return `Skill '${skillName}' not found. Available skills: ${available || '(none)'}`;
  }

  return [
    `Skill '${skill.name}' loaded successfully.`,
    `Description: ${skill.description || '(no description)'}`,
    '',
    '--- Skill Instructions ---',
    skill.content,
    '--- End of Skill ---',
  ].join('\n');
}

async function executeRead(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const filePath = String(args.file_path || '');
  if (!filePath.trim()) {
    return 'Error: No file_path provided. Please specify a file path relative to the vault root.';
  }

  const file = context.plugin.app.vault.getFileByPath(filePath.trim());
  if (!file) {
    return `Error: File not found at "${filePath}". Make sure the path is relative to the vault root.`;
  }

  try {
    const content = await context.plugin.app.vault.cachedRead(file);
    if (!content) {
      return `File "${filePath}" is empty.`;
    }
    return content;
  } catch (error) {
    return `Error reading file "${filePath}": ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function executeGrep(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const pattern = String(args.pattern || '');
  if (!pattern.trim()) {
    return 'Error: No pattern provided. Please specify a regex pattern to search for.';
  }

  const vaultPath = getVaultPath(context.plugin.app);
  if (!vaultPath) {
    return 'Error: Cannot determine vault path.';
  }

  const searchPath = args.path
    ? path.resolve(vaultPath, String(args.path))
    : vaultPath;

  // Escape single quotes in the pattern for shell safety
  const safePattern = pattern.replace(/'/g, "'\\''");

  return new Promise<string>((resolve) => {
    exec(
      `grep -rn --include='*.md' '${safePattern}' '${searchPath}'`,
      { timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error && error.code !== 1) {
          // code 1 = no matches (not an error)
          resolve(`Grep error: ${error.message}`);
        } else if (!stdout.trim()) {
          resolve('No matches found.');
        } else {
          // Truncate very large results
          const lines = stdout.trim().split('\n');
          if (lines.length > 200) {
            resolve(
              lines.slice(0, 200).join('\n') +
                `\n\n... (${lines.length - 200} more matches truncated)`,
            );
          } else {
            resolve(stdout.trim());
          }
        }
      },
    );
  });
}
