/**
 * ToolExecutor for DeepSeekRuntime.
 * P1: Skill, Read, Grep (read-only, no confirmation needed)
 * P2: Write, Edit (require user approval), Undo
 */

import { exec } from 'child_process';
import * as path from 'path';

import type { TFile } from 'obsidian';

import type CodianPlugin from '../../main';
import type { McpServerManager } from '../mcp';
import { getVaultPath, isPathWithinVault } from '../../utils/path';
import type { TransactionLog } from './transactionLog';
import { callMcpTool } from './mcpBridge';

export interface ToolExecutionContext {
  plugin: CodianPlugin;
  /** Returns true if the user approved the action. */
  requestApproval: (toolName: string, description: string, input: Record<string, unknown>) => Promise<boolean>;
  transactionLog: TransactionLog;
  mcpManager?: McpServerManager;
  abortSignal?: AbortSignal;
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
    case 'Write':
      return executeWrite(toolCall.arguments, context);
    case 'Edit':
      return executeEdit(toolCall.arguments, context);
    case 'Undo':
      return executeUndo(toolCall.arguments, context);
    default:
      // MCP bridge: mcp__<serverName>__<toolName>
      if (toolCall.name.startsWith('mcp__')) {
        return executeMcpCall(toolCall, context);
      }
      return `Error: Unknown tool '${toolCall.name}'. Available tools: Skill, Read, Grep, Write, Edit, Undo, and MCP tools.`;
  }
}

// ── Read-only tools (no approval needed) ──

async function executeSkill(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const skillName = String(args.skill || '');
  if (!skillName.trim()) {
    return 'Error: No skill name provided.';
  }

  let skills;
  try {
    skills = await context.plugin.storage.skills.loadAll();
  } catch (error) {
    return `Error loading skills: ${error instanceof Error ? error.message : String(error)}`;
  }

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
    return 'Error: No file_path provided.';
  }

  const file = context.plugin.app.vault.getFileByPath(filePath.trim());
  if (!file) {
    return `Error: File not found at "${filePath}". Make sure the path is relative to the vault root.`;
  }

  try {
    const content = await context.plugin.app.vault.cachedRead(file);
    return content || `File "${filePath}" is empty.`;
  } catch (error) {
    return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function executeGrep(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const pattern = String(args.pattern || '');
  if (!pattern.trim()) return 'Error: No pattern provided.';

  const vaultPath = getVaultPath(context.plugin.app);
  if (!vaultPath) return 'Error: Cannot determine vault path.';

  const searchPath = args.path
    ? path.resolve(vaultPath, String(args.path))
    : vaultPath;

  const safePattern = pattern.replace(/'/g, "'\\''");

  return new Promise<string>((resolve) => {
    exec(
      `grep -rn --include='*.md' '${safePattern}' '${searchPath}'`,
      { timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error && error.code !== 1) {
          resolve(`Grep error: ${error.message}`);
        } else if (!stdout.trim()) {
          resolve('No matches found.');
        } else {
          const lines = stdout.trim().split('\n');
          if (lines.length > 200) {
            resolve(lines.slice(0, 200).join('\n') + `\n\n... (${lines.length - 200} more matches truncated)`);
          } else {
            resolve(stdout.trim());
          }
        }
      },
    );
  });
}

// ── Path validation ──

interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

function validateWriteTarget(filePath: string, vaultPath: string): ValidationResult {
  // Must be within vault
  if (!isPathWithinVault(filePath, vaultPath)) {
    return { allowed: false, reason: `路径 "${filePath}" 不在 Obsidian vault 内。` };
  }

  // Block dangerous directories
  const BLOCKED_PREFIXES = [
    '.git/', '.git',
    'node_modules/', 'node_modules',
    '.obsidian/plugins/', '.obsidian/plugins',
    '.obsidian/themes/', '.obsidian/themes',
    '.obsidian/snippets/', '.obsidian/snippets',
    '.trash/', '.trash',
  ];
  const normalized = filePath.replace(/\\/g, '/');
  for (const prefix of BLOCKED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix)) {
      return { allowed: false, reason: `不允许写入 "${prefix}" 目录。` };
    }
  }

  // Block hidden directories (except .claude/)
  const hiddenDirMatch = normalized.match(/(^|\/)\.(?!claude\/)([^/]+)/);
  if (hiddenDirMatch) {
    return { allowed: false, reason: `不允许写入隐藏目录 ".${hiddenDirMatch[2]}/"。` };
  }

  return { allowed: true };
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

// ── File modification tools (require user approval) ──

async function executeWrite(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const rawPath = String(args.file_path || '');
  const content = String(args.content || '');

  if (!rawPath.trim()) return 'Error: No file_path provided.';
  if (!content) return 'Error: No content provided. Write requires non-empty content.';

  const { plugin } = context;
  const vaultPath = getVaultPath(plugin.app);
  if (!vaultPath) return 'Error: Cannot determine vault path.';

  // Normalize to vault-relative path
  let filePath = rawPath.trim();
  // Remove leading slash if present (absolute vault paths are sometimes passed)
  if (filePath.startsWith('/') && isPathWithinVault(filePath, vaultPath)) {
    filePath = path.relative(vaultPath, filePath);
  }

  const validation = validateWriteTarget(filePath, vaultPath);
  if (!validation.allowed) {
    return `Error: ${validation.reason}`;
  }

  const existingFile = plugin.app.vault.getFileByPath(filePath);
  const action: 'create' | 'overwrite' = existingFile ? 'overwrite' : 'create';
  let oldContent: string | null = null;

  if (existingFile) {
    try { oldContent = await plugin.app.vault.cachedRead(existingFile); } catch { /* ignore */ }
  }

  // Build change summary for user approval
  const newSize = Buffer.byteLength(content, 'utf8');
  const oldSize = oldContent ? Buffer.byteLength(oldContent, 'utf8') : 0;
  const summary = existingFile
    ? `**Write** (覆盖): \`${filePath}\`\n\n旧文件: ${oldSize} bytes → 新内容: ${newSize} bytes\n\n---\n**新内容预览:**\n\`\`\`\n${truncate(content, 500)}\n\`\`\``
    : `**Write** (新建): \`${filePath}\`\n\n新文件: ${newSize} bytes\n\n---\n**预览:**\n\`\`\`\n${truncate(content, 500)}\n\`\`\``;

  // Request user approval
  const approved = await context.requestApproval('Write', summary, args);
  if (!approved) {
    return 'Write 操作已被用户拒绝。';
  }

  // Apply
  try {
    if (existingFile) {
      await plugin.app.vault.modify(existingFile, content);
    } else {
      // Ensure parent folder exists
      const parentDir = filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : '';
      if (parentDir) {
        const parentFolder = plugin.app.vault.getFolderByPath(parentDir);
        if (!parentFolder) {
          await plugin.app.vault.createFolder(parentDir);
        }
      }
      await plugin.app.vault.create(filePath, content);
    }

    // Record to transaction log
    await context.transactionLog.record('Write', filePath, action, oldContent, content);

    return existingFile
      ? `Write 已应用: \`${filePath}\` (${oldSize} → ${newSize} bytes)。可使用 Undo 撤销。`
      : `Write 已应用: 新建文件 \`${filePath}\` (${newSize} bytes)。可使用 Undo 撤销。`;
  } catch (error) {
    return `Write 失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function executeEdit(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const rawPath = String(args.file_path || '');
  const oldString = String(args.old_string || '');
  const newString = String(args.new_string || '');

  if (!rawPath.trim()) return 'Error: No file_path provided.';
  if (!oldString) return 'Error: No old_string provided. Edit requires the exact text to replace.';

  const { plugin } = context;
  const vaultPath = getVaultPath(plugin.app);
  if (!vaultPath) return 'Error: Cannot determine vault path.';

  let filePath = rawPath.trim();
  if (filePath.startsWith('/') && isPathWithinVault(filePath, vaultPath)) {
    filePath = path.relative(vaultPath, filePath);
  }

  const validation = validateWriteTarget(filePath, vaultPath);
  if (!validation.allowed) {
    return `Error: ${validation.reason}`;
  }

  const file = plugin.app.vault.getFileByPath(filePath);
  if (!file) {
    return `Error: File not found at "${filePath}". Use Write to create a new file.`;
  }

  const oldContent = await plugin.app.vault.cachedRead(file);
  if (!oldContent.includes(oldString)) {
    return `Error: old_string 在文件中未找到。文件可能自上次 Read 后已被修改。请重新 Read 文件后再试。`;
  }

  const newContent = oldContent.replace(oldString, newString);
  if (newContent === oldContent) {
    return 'Error: Edit 不会改变文件内容。old_string 和 new_string 相同。';
  }

  // Build diff preview
  const oldPreview = truncate(oldString, 300);
  const newPreview = truncate(newString, 300);
  const summary = `**Edit**: \`${filePath}\`\n\n---\n**将被替换:**\n\`\`\`\n${oldPreview}\n\`\`\`\n**替换为:**\n\`\`\`\n${newPreview}\n\`\`\``;

  // Request user approval
  const approved = await context.requestApproval('Edit', summary, args);
  if (!approved) {
    return 'Edit 操作已被用户拒绝。';
  }

  // Apply
  try {
    await plugin.app.vault.modify(file, newContent);

    // Record to transaction log
    await context.transactionLog.record('Edit', filePath, 'modify', oldContent, newContent);

    return `Edit 已应用: \`${filePath}\`。可使用 Undo 撤销。`;
  } catch (error) {
    return `Edit 失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function executeUndo(
  _args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const entry = context.transactionLog.getLastNonReverted();
  if (!entry) {
    return '没有可撤销的操作。当前 session 中没有 Write 或 Edit 记录。';
  }

  const { plugin } = context;
  const vaultPath = getVaultPath(plugin.app);
  if (!vaultPath) return 'Error: Cannot determine vault path.';

  // Build undo summary
  const summary = `**Undo**: 撤销 ${entry.toolName} 操作\n\n文件: \`${entry.filePath}\`\n操作: ${entry.action}\n时间: ${new Date(entry.timestamp).toLocaleString()}\n\n将恢复到该操作之前的文件状态。`;

  // Request user approval
  const approved = await context.requestApproval('Undo', summary, {});
  if (!approved) {
    return 'Undo 操作已被用户拒绝。';
  }

  // Apply undo
  try {
    if (entry.action === 'create') {
      const file = plugin.app.vault.getFileByPath(entry.filePath);
      if (file) {
        await plugin.app.vault.trash(file, false);
      } else {
        return `Undo 失败: 找不到文件 "${entry.filePath}"（可能已被外部删除）。`;
      }
    } else {
      const file = plugin.app.vault.getFileByPath(entry.filePath);

      if (!file && entry.snapshotContent !== null) {
        const parentDir = entry.filePath.includes('/')
          ? entry.filePath.substring(0, entry.filePath.lastIndexOf('/'))
          : '';
        if (parentDir) {
          const parentFolder = plugin.app.vault.getFolderByPath(parentDir);
          if (!parentFolder) {
            await plugin.app.vault.createFolder(parentDir);
          }
        }
        await plugin.app.vault.create(entry.filePath, entry.snapshotContent);
      } else if (file && entry.snapshotContent !== null) {
        const fullPath = path.join(vaultPath, entry.filePath);
        await plugin.app.vault.adapter.write(fullPath, entry.snapshotContent);
        plugin.app.vault.trigger('modify', file);
      } else if (!file && entry.snapshotContent === null) {
        return `Undo 失败: 文件 "${entry.filePath}" 不存在且没有可恢复的快照。`;
      } else if (file && entry.snapshotContent === null) {
        return `Undo 失败: 没有 "${entry.filePath}" 的快照数据（该文件在 Write 前不存在）。`;
      }
    }

    context.transactionLog.markReverted(entry.id);
    return `Undo 完成: 已撤销对 \`${entry.filePath}\` 的 ${entry.toolName} 操作。`;
  } catch (error) {
    return `Undo 失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── MCP bridge (read-only) ──

async function executeMcpCall(
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  context: ToolExecutionContext,
): Promise<string> {
  if (!context.mcpManager) {
    return 'Error: MCP manager not available. MCP tools require an active MCP configuration.';
  }
  if (!context.abortSignal) {
    return 'Error: No abort signal available for MCP call.';
  }

  return callMcpTool(toolCall.name, toolCall.arguments, context.mcpManager, context.abortSignal);
}
