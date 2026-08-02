/**
 * ToolExecutor for DeepSeekRuntime.
 * P1: Skill, Read, Grep (read-only, no confirmation needed)
 * P2: Write, Edit (require user approval), Undo
 */

import { exec } from 'child_process';
import * as path from 'path';

import type CodianPlugin from '../../main';
import { getEnhancedPath } from '../../utils/env';
import { getPathAccessType, getVaultPath, isPathWithinVault } from '../../utils/path';
import type { McpServerManager } from '../mcp';
import type { ApprovalCallbackOptions } from '../runtime/contracts';
import { findBashCommandPathViolation } from '../security/BashPathValidator';
import { isCommandBlocked } from '../security/BlocklistChecker';
import {
  hashRecoveryContent,
  type RecoveryJournal,
  type RecoveryJournalEntry,
} from '../storage/RecoveryJournal';
import { getBashToolBlockedCommands } from '../types';
import { callMcpTool, classifyMcpToolRisk } from './mcpBridge';
import type { TransactionLog } from './transactionLog';

export interface ToolExecutionContext {
  plugin: CodianPlugin;
  /** Returns true if the user approved the action. */
  requestApproval: (
    toolName: string,
    description: string,
    input: Record<string, unknown>,
    options?: ApprovalCallbackOptions,
  ) => Promise<boolean>;
  transactionLog: TransactionLog;
  recoveryJournal?: RecoveryJournal;
  mcpManager?: McpServerManager;
  abortSignal?: AbortSignal;
}

const DEEPSEEK_BASH_DEFAULT_TIMEOUT_MS = 120_000;
const DEEPSEEK_BASH_MAX_TIMEOUT_MS = 600_000;
const DEEPSEEK_BASH_MAX_BUFFER = 10 * 1024 * 1024;

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
    case 'Bash':
      return executeBash(toolCall.arguments, context);
    default:
      // MCP bridge: mcp__<serverName>__<toolName>
      if (toolCall.name.startsWith('mcp__')) {
        return executeMcpCall(toolCall, context);
      }
      return `Error: Unknown tool '${toolCall.name}'. Available tools: Skill, Read, Grep, Write, Edit, Undo, Bash when enabled, and MCP tools.`;
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

async function executeBash(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const command = String(args.command || '').trim();
  if (!command) return 'Error: No command provided.';

  const { plugin } = context;
  if (!plugin.settings.enableDeepSeekBash) {
    return 'Error: DeepSeek Bash execution is disabled in Codian settings.';
  }

  const vaultPath = getVaultPath(plugin.app);
  if (!vaultPath) return 'Error: Cannot determine vault path.';

  const blockedCommands = getBashToolBlockedCommands(plugin.settings.blockedCommands);
  if (isCommandBlocked(command, blockedCommands, plugin.settings.enableBlocklist)) {
    return `Error: Command blocked by blocklist: ${command}`;
  }

  if (!plugin.settings.allowExternalAccess && !plugin.settings.temporaryExternalAccess) {
    const deepSeekBashContextPaths = [
      '~/.codex/skills',
      '~/.agents/skills',
    ];
    const violation = findBashCommandPathViolation(command, {
      getPathAccessType: (p) => getPathAccessType(
        p,
        deepSeekBashContextPaths,
        plugin.settings.allowedExportPaths,
        vaultPath,
      ),
    });
    if (violation) {
      const reason = violation.type === 'export_path_read'
        ? `Command path "${violation.path}" is in an allowed export directory, but export paths are write-only.`
        : `Command path "${violation.path}" is outside the vault.`;
      const approved = await context.requestApproval(
        'Bash',
        `Allow this command to use an external path for this turn?\n${command}`,
        {
          ...args,
          temporaryExternalAccess: true,
          blockedPath: violation.path,
        },
        {
          decisionReason: reason,
          blockedPath: violation.path,
          approvalKind: 'temporaryExternalAccess',
        },
      );

      if (!approved) {
        return `Error: User denied external path access. ${reason}`;
      }

      plugin.settings.temporaryExternalAccess = true;
    }
  }

  const requestedTimeout = Number(args.timeout_ms);
  const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, DEEPSEEK_BASH_MAX_TIMEOUT_MS)
    : DEEPSEEK_BASH_DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve) => {
    const child = exec(command, {
      cwd: vaultPath,
      env: { ...process.env, PATH: getEnhancedPath() },
      timeout,
      maxBuffer: DEEPSEEK_BASH_MAX_BUFFER,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
    }, (error, stdout, stderr) => {
      const exitCode = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
      const errorMessage = error
        ? `\nError: ${error.killed ? `Command timed out after ${timeout}ms` : error.message}`
        : '';
      resolve([
        `Command: ${command}`,
        `Working directory: ${vaultPath}`,
        `Exit code: ${exitCode}`,
        stdout ? `\nstdout:\n${stdout.trim()}` : '',
        stderr ? `\nstderr:\n${stderr.trim()}` : '',
        errorMessage,
      ].filter(Boolean).join('\n'));
    });

    if (context.abortSignal) {
      const abortHandler = () => {
        child.kill();
        resolve(`Command cancelled: ${command}`);
      };
      context.abortSignal.addEventListener('abort', abortHandler, { once: true });
      child.on('exit', () => {
        context.abortSignal?.removeEventListener('abort', abortHandler);
      });
    }
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

  // Block hidden directories except Codian-owned storage.
  const hiddenDirMatch = normalized.match(/(^|\/)\.(?!codian\/)([^/]+)/);
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

  let recoveryEntry: RecoveryJournalEntry | undefined;
  if (context.recoveryJournal) {
    try {
      recoveryEntry = await context.recoveryJournal.prepare(
        'Write',
        filePath,
        action,
        oldContent,
        content,
      );
    } catch (error) {
      return `Write 已中止：无法建立持久恢复记录。${error instanceof Error ? error.message : String(error)}`;
    }
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
    const entry = context.transactionLog.record('Write', filePath, action, oldContent, content);
    console.debug('[Codian Txn] Write recorded id=%s action=%s path=%s total=%d',
      entry.id, entry.action, entry.filePath, context.transactionLog.getAll().length);

    let result = existingFile
      ? `Write 已应用: \`${filePath}\` (${oldSize} → ${newSize} bytes)。可使用 Undo 撤销。`
      : `Write 已应用: 新建文件 \`${filePath}\` (${newSize} bytes)。可使用 Undo 撤销。`;
    if (recoveryEntry) {
      try {
        await context.recoveryJournal!.markApplied(recoveryEntry.id);
      } catch (error) {
        result += ` 恢复记录仍保留为待确认状态：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return result;
  } catch (error) {
    if (recoveryEntry) {
      try {
        await context.recoveryJournal!.markFailed(recoveryEntry.id);
      } catch {
        // Keep the pending record when status persistence is unavailable.
      }
    }
    console.error('[Codian Txn] Write FAILED:', error);
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

  let recoveryEntry: RecoveryJournalEntry | undefined;
  if (context.recoveryJournal) {
    try {
      recoveryEntry = await context.recoveryJournal.prepare(
        'Edit',
        filePath,
        'modify',
        oldContent,
        newContent,
      );
    } catch (error) {
      return `Edit 已中止：无法建立持久恢复记录。${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Apply
  try {
    await plugin.app.vault.modify(file, newContent);

    // Record to transaction log
    const entry = context.transactionLog.record('Edit', filePath, 'modify', oldContent, newContent);
    console.debug('[Codian Txn] Edit recorded id=%s path=%s total=%d',
      entry.id, entry.filePath, context.transactionLog.getAll().length);

    let result = `Edit 已应用: \`${filePath}\`。可使用 Undo 撤销。`;
    if (recoveryEntry) {
      try {
        await context.recoveryJournal!.markApplied(recoveryEntry.id);
      } catch (error) {
        result += ` 恢复记录仍保留为待确认状态：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return result;
  } catch (error) {
    if (recoveryEntry) {
      try {
        await context.recoveryJournal!.markFailed(recoveryEntry.id);
      } catch {
        // Keep the pending record when status persistence is unavailable.
      }
    }
    console.error('[Codian Txn] Edit FAILED:', error);
    return `Edit 失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function executeUndo(
  _args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<string> {
  const allEntries = context.transactionLog.getAll();
  console.debug('[Codian Txn] Undo: %d total entries, %d reverted',
    allEntries.length, allEntries.filter(e => e.reverted).length);

  let persistentEntry: RecoveryJournalEntry | undefined;
  if (context.recoveryJournal) {
    try {
      persistentEntry = await context.recoveryJournal.getLastRecoverable();
    } catch (error) {
      return `Undo 已中止：无法安全读取持久恢复记录。${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const entry = persistentEntry ?? context.transactionLog.getLastNonReverted();
  if (!entry) {
    return `没有可撤销的操作。当前 session 中有 ${allEntries.length} 条记录（${allEntries.filter(e => e.reverted).length} 已撤销）。`;
  }

  const { plugin } = context;
  const vaultPath = getVaultPath(plugin.app);
  if (!vaultPath) return 'Error: Cannot determine vault path.';

  const currentFile = plugin.app.vault.getFileByPath(entry.filePath);
  if (currentFile) {
    const currentContent = await plugin.app.vault.cachedRead(currentFile);
    const expectedCurrentHash = 'newContentHash' in entry
      ? entry.newContentHash
      : hashRecoveryContent(entry.newContent);
    if (hashRecoveryContent(currentContent) !== expectedCurrentHash) {
      return `Undo 已中止：\`${entry.filePath}\` 在该操作后又发生了变化。为避免覆盖后续修改，请手动核对恢复日志。`;
    }
  }

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
        if (persistentEntry) {
          await context.recoveryJournal!.markReverted(persistentEntry.id);
        }
        return `Undo 完成: \`${entry.filePath}\` 已不存在，无需再次删除。`;
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
        await plugin.app.vault.modify(file, entry.snapshotContent);
      } else if (!file && entry.snapshotContent === null) {
        return `Undo 失败: 文件 "${entry.filePath}" 不存在且没有可恢复的快照。`;
      } else if (file && entry.snapshotContent === null) {
        return `Undo 失败: 没有 "${entry.filePath}" 的快照数据（该文件在 Write 前不存在）。`;
      }
    }

    if (persistentEntry) {
      await context.recoveryJournal!.markReverted(persistentEntry.id);
      const memoryEntry = context.transactionLog.getLastNonReverted();
      if (memoryEntry?.filePath === persistentEntry.filePath) {
        context.transactionLog.markReverted(memoryEntry.id);
      }
    } else {
      context.transactionLog.markReverted(entry.id);
    }
    return `Undo 完成: 已撤销对 \`${entry.filePath}\` 的 ${entry.toolName} 操作。`;
  } catch (error) {
    return `Undo 失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── MCP bridge (risk-classified) ──

function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const parts = toolName.split('__');
  if (parts.length < 3 || parts[0] !== 'mcp') return null;
  return { server: parts[1], tool: parts.slice(2).join('__') };
}

async function executeMcpCall(
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
  context: ToolExecutionContext,
): Promise<string> {
  if (!context.mcpManager) {
    return 'Error: MCP manager not available.';
  }
  if (!context.abortSignal) {
    return 'Error: No abort signal available for MCP call.';
  }

  const parsed = parseMcpToolName(toolCall.name);
  const actualToolName = parsed?.tool || toolCall.name;

  // Classify risk
  const classification = classifyMcpToolRisk(actualToolName);

  // Diagnostic: log tool call with arguments
  const argSummary = JSON.stringify(toolCall.arguments);
  console.debug(
    `[Codian MCP] call: ${actualToolName} [${classification.level}] args=${argSummary.slice(0, 300)}`,
  );

  // Blocked tools rejected before execution
  if (classification.level === 'blocked') {
    return `Error: MCP tool "${actualToolName}" is blocked (${classification.reason}).`;
  }

  // Non-read-only tools require user confirmation
  if (classification.level !== 'read-only') {
    const riskLabel =
      classification.level === 'low-risk-action' ? '低风险操作' : '高风险操作（不可自动回退）';
    const summary = [
      `**MCP ${riskLabel}** — \`${actualToolName}\``,
      `Server: ${parsed?.server || 'unknown'}`,
      `Risk: ${classification.level} (${classification.reason})`,
      '',
      '该 MCP 操作将执行外部动作。',
      classification.level === 'high-risk-action' ? '⚠️ 此操作不可自动回退，请确认。' : '',
    ].filter(Boolean).join('\n');

    const approved = await context.requestApproval(toolCall.name, summary, toolCall.arguments);
    if (!approved) {
      return `MCP 操作已被用户拒绝: ${actualToolName}`;
    }
  }

  return callMcpTool(toolCall.name, toolCall.arguments, context.mcpManager, context.abortSignal);
}
