import type { RewindFilesResult } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import type CodianPlugin from '../../main';
import { appendBoundedLog } from '../../utils/boundedLog';
import { stripCurrentNoteContext } from '../../utils/context';
import { isProviderConfigured, parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  getLastUserMessage,
} from '../../utils/session';
import type { ApprovalCallback, QueryOptions } from '../agent';
import type { SubagentHookState } from '../hooks';
import type { McpServerManager } from '../mcp';
import { buildSystemPrompt } from '../prompts/mainAgent';
import { TOOL_EDIT, TOOL_MCP } from '../tools/toolNames';
import type {
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  ImageAttachment,
  SlashCommand,
  StreamChunk,
} from '../types';
import { type AppServerNotification, CodexAppServerClient } from './CodexAppServerClient';
import {
  discoverConfiguredCodexMcpServerNames,
  extractExplicitCodexMcpNames,
  normalizeCodexModelForRuntime,
  resolveCodexCliPath,
} from './codexExec';
import type { AgentRuntime } from './index';

type Waiter = () => void;
const CODIAN_RUNTIME_DIAGNOSTIC_LOG = path.join(os.tmpdir(), 'codian-runtime.log');
const MAX_SUBAGENT_WAIT_TURNS = 3;
const APP_SERVER_STARTUP_TIMEOUT_MS = 30_000;
const MCP_STARTUP_TIMEOUT_MS = 20_000;
const FIRST_TURN_ACTIVITY_TIMEOUT_MS = 90_000;
const MAX_STALL_RECOVERY_ATTEMPTS = 1;
const TEMP_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHATGPT_TRANSPORT_DISCONNECT_MESSAGE =
  'Codex 与 ChatGPT 的连接已中断，自动重试后仍未恢复。请检查网络或代理设置，然后重新发送消息。';
const CODEX_STALL_MESSAGE =
  'Codex 长时间没有返回任何结果，自动重建后仍未恢复。请检查 MCP、网络或代理设置，然后重新发送消息。';
const SUBAGENT_WAIT_PROMPT = `Background subagents are still running.

You must retrieve their results before ending this turn. Use TaskOutput with block=true for each running task, then incorporate the results into the user-facing answer. Do not produce a final answer until no background subagents remain running.`;

async function appendRuntimeDiagnosticLog(message: string): Promise<void> {
  try {
    await appendBoundedLog(
      CODIAN_RUNTIME_DIAGNOSTIC_LOG,
      `[${new Date().toISOString()}] ${message}\n`
    );
  } catch {
    // Ignore logging failures.
  }
}

function createChunkQueue() {
  const chunks: StreamChunk[] = [];
  let finished = false;
  let waiter: Waiter | null = null;

  return {
    push(chunk: StreamChunk) {
      chunks.push(chunk);
      waiter?.();
      waiter = null;
    },
    finish() {
      finished = true;
      waiter?.();
      waiter = null;
    },
    async *drain(): AsyncGenerator<StreamChunk> {
      while (!finished || chunks.length > 0) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
          continue;
        }
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractReadableErrorMessage(rawMessage: string): string {
  const trimmed = rawMessage.trim();
  if (!trimmed) return rawMessage;

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const nested = typeof parsed.error?.message === 'string'
      ? parsed.error.message
      : (typeof parsed.message === 'string' ? parsed.message : null);
    return nested || rawMessage;
  } catch {
    return rawMessage;
  }
}

function formatAppServerErrorMessage(rawMessage: string): string {
  const message = extractReadableErrorMessage(rawMessage);
  const isFinalTransportDisconnect = /stream disconnected before completion/i.test(message)
    && /(chatgpt\.com\/backend-api\/codex\/responses|tls handshake eof)/i.test(message);

  return isFinalTransportDisconnect ? CHATGPT_TRANSPORT_DISCONNECT_MESSAGE : message;
}

function isInputTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Input exceeds the maximum length of \d+ characters/i.test(message);
}

function isRetryableAppServerError(params: Record<string, unknown>): boolean {
  return params.willRetry === true;
}

function getAppServerErrorMessage(params: Record<string, unknown>): string {
  const direct = asString(params.message);
  if (direct) return direct;

  const nested = asRecord(params.error);
  return asString(nested?.message) || 'Codex App Server 执行失败。';
}

function mapPlanStepStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
  switch (value) {
    case 'completed':
      return 'completed';
    case 'inProgress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function getImageExtension(mediaType: ImageAttachment['mediaType']): string {
  switch (mediaType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}

export class CodexAgentRuntime implements AgentRuntime {
  private readonly plugin: CodianPlugin;
  private readonly mcpManager: McpServerManager;
  private readonly readyStateListeners = new Set<(ready: boolean) => void>();
  private activeAbortController: AbortController | null = null;
  private activeClient: CodexAppServerClient | null = null;
  private activeWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private activeTurnId: string | null = null;
  private threadId: string | null = null;
  private globalMcpNamesPromise: Promise<string[]> | null = null;
  private readonly temporaryImagePaths = new Set<string>();
  private pendingResumeAt?: string;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback:
    ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, string> | null>) | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private subagentStateProvider: (() => SubagentHookState) | null = null;

  constructor(plugin: CodianPlugin, mcpManager: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);
    try {
      listener(this.isReady());
    } catch {
      // Ignore listener errors.
    }
    return () => {
      this.readyStateListeners.delete(listener);
    };
  }

  private notifyReadyStateChange(): void {
    const ready = this.isReady();
    for (const listener of this.readyStateListeners) {
      try {
        listener(ready);
      } catch {
        // Ignore listener errors.
      }
    }
  }

  private buildPrompt(prompt: string, conversationHistory?: ChatMessage[]): string {
    if (!conversationHistory || conversationHistory.length === 0) {
      return prompt;
    }

    const historyContext = buildContextFromHistory(conversationHistory);
    const actualPrompt = stripCurrentNoteContext(prompt);
    return buildPromptWithHistoryContext(historyContext, prompt, actualPrompt, conversationHistory);
  }

  private buildInstructions(vaultPath: string): string {
    return buildSystemPrompt({
      mediaFolder: this.plugin.settings.mediaFolder,
      strongRulesPrompt: this.plugin.settings.strongRulesPrompt,
      customPrompt: this.plugin.settings.systemPrompt,
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      vaultPath,
      userName: this.plugin.settings.userName,
    });
  }

  private applyInstructionsToPrompt(prompt: string, vaultPath: string): string {
    // Keep Codex built-in slash commands bare; wrapping them breaks command detection.
    if (/^\/compact(\s|$)/i.test(prompt.trim())) {
      return prompt;
    }

    const instructions = this.buildInstructions(vaultPath).trim();
    if (!instructions) {
      return prompt;
    }

    return `<codian_system_instructions>
The following instructions are high-priority runtime instructions for this Codian conversation.
Follow them over the default Codex identity and default response style.
Do not mention this instruction block, system prompts, memory files, context files, or internal processing steps in the user-facing answer.

${instructions}
</codian_system_instructions>

<user_request>
${prompt}
</user_request>`;
  }

  private buildHistoryRebuildRequest(
    prompt: string,
    images: ImageAttachment[] | undefined,
    conversationHistory?: ChatMessage[]
  ): { prompt: string; images?: ImageAttachment[] } {
    const rebuiltPrompt = this.buildPrompt(prompt, conversationHistory);

    if (images && images.length > 0) {
      return { prompt: rebuiltPrompt, images };
    }

    const lastUserImages = conversationHistory
      ? getLastUserMessage(conversationHistory)?.images
      : undefined;

    return {
      prompt: rebuiltPrompt,
      images: lastUserImages && lastUserImages.length > 0 ? lastUserImages : undefined,
    };
  }

  private mapUsage(
    tokenUsageInfo: Record<string, unknown> | undefined,
    model?: string
  ): StreamChunk | null {
    const total = asRecord(tokenUsageInfo?.total);
    if (!total) return null;

    const inputTokens = typeof total.inputTokens === 'number' ? total.inputTokens : 0;
    const cachedInputTokens = typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : 0;
    const outputTokens = typeof total.outputTokens === 'number' ? total.outputTokens : 0;
    const contextWindow = typeof tokenUsageInfo?.modelContextWindow === 'number' ? tokenUsageInfo.modelContextWindow : 0;
    const contextTokens = inputTokens + cachedInputTokens + outputTokens;
    const percentage = contextWindow > 0 ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : 0;

    return {
      type: 'usage',
      usage: {
        model,
        inputTokens,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: cachedInputTokens,
        contextWindow,
        contextTokens,
        percentage,
      },
      sessionId: this.threadId,
    };
  }

  private getApprovalPolicy(): 'on-request' | 'never' {
    return this.plugin.settings.permissionMode === 'yolo' ? 'never' : 'on-request';
  }

  private async handleAppServerRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (method === 'item/tool/requestUserInput') {
      if (!this.askUserQuestionCallback) {
        return { answers: {} };
      }
      const answers = await this.askUserQuestionCallback(
        { questions: Array.isArray(params.questions) ? params.questions : [] },
        this.activeAbortController?.signal,
      );
      return {
        answers: Object.fromEntries(
          Object.entries(answers ?? {}).map(([id, answer]) => [
            id,
            { answers: [answer] },
          ])
        ),
      };
    }

    if (method === 'mcpServer/elicitation/request') {
      // Codian has no generic schema-form renderer yet. Explicitly decline
      // instead of leaving the App Server request hanging.
      return { action: 'decline' };
    }

    if (method === 'item/permissions/requestApproval') {
      const permissions = asRecord(params.permissions) ?? {};
      if (!this.approvalCallback) {
        return { permissions: {}, scope: 'turn' };
      }
      const decision = await this.approvalCallback(
        'Permissions',
        {
          permissions,
          cwd: asString(params.cwd) || undefined,
        },
        asString(params.reason) || 'Grant additional runtime permissions',
      );
      if (decision === 'allow' || decision === 'allow-always') {
        return {
          permissions,
          scope: decision === 'allow-always' ? 'session' : 'turn',
        };
      }
      return { permissions: {}, scope: 'turn' };
    }

    if (
      method !== 'item/commandExecution/requestApproval' &&
      method !== 'item/fileChange/requestApproval'
    ) {
      return null;
    }

    if (!this.approvalCallback) {
      return { decision: 'decline' };
    }

    const isCommand = method === 'item/commandExecution/requestApproval';
    const command = asString(params.command) || '';
    const reason = asString(params.reason);
    const toolName = isCommand ? 'Bash' : TOOL_EDIT;
    const input = isCommand
      ? { command, cwd: asString(params.cwd) || undefined }
      : { file_path: asString(params.grantRoot) || '(pending file change)' };
    const description = reason || (isCommand
      ? `Run command: ${command || '(unknown command)'}`
      : 'Apply the requested file changes');
    const decision = await this.approvalCallback(toolName, input, description);

    switch (decision) {
      case 'allow':
        return { decision: 'accept' };
      case 'allow-always':
        return { decision: 'acceptForSession' };
      case 'deny':
        return { decision: 'decline' };
      default:
        return { decision: 'cancel' };
    }
  }

  private getThreadSandboxMode(): 'workspace-write' {
    return 'workspace-write';
  }

  private async getGlobalMcpNames(): Promise<string[]> {
    if (this.plugin.settings.currentProvider !== 'codex') return [];
    if (!this.globalMcpNamesPromise) {
      const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
      this.globalMcpNamesPromise = discoverConfiguredCodexMcpServerNames({
        ...process.env,
        ...customEnv,
      });
    }
    return await this.globalMcpNamesPromise;
  }

  private getRequestedMcpServers(queryOptions?: QueryOptions): Record<string, unknown> {
    const mcpMentions = queryOptions?.mcpMentions || new Set<string>();
    const uiEnabledServers = queryOptions?.enabledMcpServers || new Set<string>();
    const combinedMentions = new Set([...mcpMentions, ...uiEnabledServers]);
    return this.mcpManager.getActiveServers(combinedMentions);
  }

  private buildTurnSandboxPolicy(queryOptions?: QueryOptions): Record<string, unknown> {
    const writableRoots = (queryOptions?.externalContextPaths || [])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());

    return {
      type: 'workspaceWrite',
      writableRoots,
      readOnlyAccess: {
        type: 'fullAccess',
      },
      // Codex desktop sessions default to internet-enabled turns. Restricting
      // network only to MCP-backed requests breaks normal link resolution,
      // web lookup, and other first-party networked tasks inside Codian.
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private async materializeImages(images: ImageAttachment[]): Promise<string[]> {
    if (images.length === 0) {
      return [];
    }

    const tempDir = path.join(os.tmpdir(), 'codian-images');
    await fs.mkdir(tempDir, { recursive: true });
    await this.cleanupExpiredImages(tempDir);

    return await Promise.all(images.map(async (image) => {
      const buffer = Buffer.from(image.data, 'base64');
      const hash = createHash('sha256').update(buffer).digest('hex');
      const filePath = path.join(tempDir, `${hash}${getImageExtension(image.mediaType)}`);

      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, buffer);
      }

      this.temporaryImagePaths.add(filePath);
      return filePath;
    }));
  }

  private async cleanupExpiredImages(tempDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(tempDir, { withFileTypes: true });
      const now = Date.now();
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const filePath = path.join(tempDir, entry.name);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > TEMP_IMAGE_MAX_AGE_MS) {
            await fs.unlink(filePath);
          }
        } catch {
          // Best-effort cleanup.
        }
      }));
    } catch {
      // Best-effort cleanup.
    }
  }

  private async cleanupTemporaryImages(): Promise<void> {
    const paths = Array.from(this.temporaryImagePaths);
    this.temporaryImagePaths.clear();
    await Promise.all(paths.map(async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch {
        // The file may already have been removed by the OS or another cleanup.
      }
    }));
  }

  private async buildInput(prompt: string, images: ImageAttachment[] = []): Promise<Array<Record<string, unknown>>> {
    const input: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: prompt,
        text_elements: [],
      },
    ];

    const imagePaths = await this.materializeImages(images);
    for (const imagePath of imagePaths) {
      input.push({
        type: 'localImage',
        path: imagePath,
      });
    }

    return input;
  }

  setPendingResumeAt(uuid: string | undefined): void {
    this.pendingResumeAt = uuid;
  }

  applyForkState(conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>): string | null {
    this.pendingResumeAt = conv.forkSource?.resumeAt;
    this.threadId = conv.sessionId ?? conv.forkSource?.sessionId ?? null;
    return this.threadId;
  }

  async reloadMcpServers(): Promise<void> {
    await this.mcpManager.loadServers();
  }

  async ensureReady(): Promise<boolean> {
    const ready = this.isReady();
    this.notifyReadyStateChange();
    return ready;
  }

  closePersistentQuery(): void {
    this.cancel();
  }

  async *query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      yield { type: 'error', content: '无法确定当前 Obsidian 仓库路径。' };
      return;
    }

    const codexPath = resolveCodexCliPath(this.plugin);
    if (!codexPath) {
      yield { type: 'error', content: '找不到 Codex CLI。请在设置中填写 Codex CLI 路径，或安装 Codex 应用。' };
      return;
    }

    const globalMcpNames = await this.getGlobalMcpNames();
    const explicitlyRequestedMcpNames = new Set([
      ...extractExplicitCodexMcpNames(prompt, globalMcpNames),
      ...(queryOptions?.mcpMentions ?? []),
      ...(queryOptions?.enabledMcpServers ?? []),
    ].map((name) => name.toLocaleLowerCase()));
    const disabledMcpServers = globalMcpNames.filter(
      (name) => !explicitlyRequestedMcpNames.has(name.toLocaleLowerCase())
    );

    const queue = createChunkQueue();
    const selectedModel = queryOptions?.model?.trim() || undefined;
    const requestedModel = this.plugin.settings.currentProvider === 'codex'
      ? (normalizeCodexModelForRuntime(selectedModel ?? this.plugin.settings.model) || undefined)
      : (selectedModel ?? this.plugin.settings.model)?.trim() || undefined;
    void appendRuntimeDiagnosticLog(
      `query provider=${this.plugin.settings.currentProvider} selectedModel=${selectedModel ?? 'null'} requestedModel=${requestedModel ?? 'null'}`
    );
    let request = this.threadId
      ? { prompt, images }
      : this.buildHistoryRebuildRequest(prompt, images, conversationHistory);

    const providerValidation = isProviderConfigured(this.plugin.settings, this.plugin.settings.currentProvider);
    if (!providerValidation.ok) {
      void appendRuntimeDiagnosticLog(`provider-validation-failed ${providerValidation.error}`);
      yield { type: 'error', content: providerValidation.error };
      return;
    }

    this.activeAbortController = new AbortController();

    const textByItemId = new Map<string, string>();
    const commandOutputByItemId = new Map<string, string>();
    let activeAgentMessageItemId: string | null = null;
    let hasStreamedAgentText = false;
    let subagentWaitTurns = 0;
    let attemptGeneration = 0;
    let stallRecoveryAttempts = 0;
    let turnHasActivity = false;
    const startingMcpServers = new Set<string>();
    let armWatchdog: ((generation: number, timeoutOverrideMs?: number) => void) | null = null;

    const clearWatchdog = () => {
      if (this.activeWatchdogTimer) {
        clearTimeout(this.activeWatchdogTimer);
        this.activeWatchdogTimer = null;
      }
    };

    const markTurnActivity = () => {
      if (turnHasActivity) return;
      turnHasActivity = true;
      clearWatchdog();
    };

    const hasRunningSubagents = (): boolean => {
      if (!this.subagentStateProvider) return false;
      try {
        return this.subagentStateProvider().hasRunning;
      } catch {
        return true;
      }
    };

    const startSubagentWaitTurn = async (): Promise<boolean> => {
      if (!hasRunningSubagents()) return false;
      if (subagentWaitTurns >= MAX_SUBAGENT_WAIT_TURNS) {
        void appendRuntimeDiagnosticLog('subagent-wait-max-attempts-reached');
        return false;
      }
      const client = this.activeClient;
      if (!client || !this.threadId) {
        void appendRuntimeDiagnosticLog('subagent-wait-missing-client-or-thread');
        return false;
      }
      subagentWaitTurns += 1;
      void appendRuntimeDiagnosticLog(`subagent-wait-turn-start attempt=${subagentWaitTurns}`);
      try {
        const started = await client.request('turn/start', {
          threadId: this.threadId,
          input: await this.buildInput(SUBAGENT_WAIT_PROMPT, []),
          cwd: vaultPath,
          approvalPolicy: this.getApprovalPolicy(),
          sandboxPolicy: this.buildTurnSandboxPolicy(queryOptions),
          model: requestedModel ?? null,
        });
        const turn = asRecord(started.turn);
        this.activeTurnId = asString(turn?.id);
        void appendRuntimeDiagnosticLog(`subagent-wait-turn-started ${this.activeTurnId ?? 'null'}`);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void appendRuntimeDiagnosticLog(`subagent-wait-turn-failed ${message}`);
        return false;
      }
    };

    const ensureAgentMessageSeparation = (itemId: string) => {
      if (!itemId) return;
      if (activeAgentMessageItemId === itemId) return;
      if (hasStreamedAgentText) {
        queue.push({ type: 'text', content: '\n\n' });
      }
      activeAgentMessageItemId = itemId;
    };

    const pushDelta = (itemId: string, delta: string) => {
      if (!delta) return;
      ensureAgentMessageSeparation(itemId);
      const previous = textByItemId.get(itemId) || '';
      textByItemId.set(itemId, previous + delta);
      queue.push({ type: 'text', content: delta });
      hasStreamedAgentText = true;
    };

    const handleNotification = (notification: AppServerNotification, generation = attemptGeneration) => {
      if (generation !== attemptGeneration) return;
      void appendRuntimeDiagnosticLog(`notification ${notification.method}`);

      if (notification.method === 'mcpServer/startupStatus/updated') {
        const name = asString(notification.params.name);
        const status = asString(notification.params.status);
        if (name) {
          if (status === 'starting') startingMcpServers.add(name);
          else startingMcpServers.delete(name);
          if (this.activeTurnId && !turnHasActivity) {
            armWatchdog?.(generation);
          }
        }
      }

      switch (notification.method) {
        case 'item/started': {
          const item = asRecord(notification.params.item);
          if (item?.type !== 'userMessage') {
            markTurnActivity();
          }
          if (item?.type === 'userMessage') {
            queue.push({ type: 'sdk_user_sent', uuid: asString(item.id) || '' });
          }
          if (item?.type === 'agentMessage') {
            const itemId = asString(item.id);
            if (itemId) {
              ensureAgentMessageSeparation(itemId);
            }
          }
          if (item?.type === 'commandExecution') {
            const itemId = asString(item.id);
            const action = asRecord(item.action);
            const command = asString(action?.command) || '';
            if (itemId && command) {
              commandOutputByItemId.set(itemId, '');
              queue.push({
                type: 'command_start',
                id: itemId,
                command,
                cwd: asString(item.cwd) || undefined,
              });
            }
          }
          if (item?.type === 'mcpToolCall') {
            const itemId = asString(item.id);
            if (itemId) {
              queue.push({
                type: 'tool_use',
                id: itemId,
                name: TOOL_MCP,
                input: {
                  server: asString(item.server) || '',
                  tool: asString(item.tool) || '',
                  arguments: asRecord(item.arguments) || {},
                },
              });
            }
          }
          if (item?.type === 'fileChange') {
            const itemId = asString(item.id);
            const changes = Array.isArray(item.changes) ? item.changes : [];
            const firstChange = asRecord(changes[0]);
            if (itemId) {
              queue.push({
                type: 'tool_use',
                id: itemId,
                name: TOOL_EDIT,
                input: {
                  file_path: asString(firstChange?.path) || '',
                  changes: changes as Record<string, unknown>[],
                },
              });
            }
          }
          break;
        }

        case 'item/agentMessage/delta': {
          markTurnActivity();
          const itemId = asString(notification.params.itemId);
          const delta = asString(notification.params.delta);
          if (itemId && delta) {
            pushDelta(itemId, delta);
          }
          break;
        }

        case 'thread/tokenUsage/updated': {
          const usageChunk = this.mapUsage(asRecord(notification.params.tokenUsage) || undefined, requestedModel);
          if (usageChunk) {
            queue.push(usageChunk);
          }
          break;
        }

        case 'turn/plan/updated': {
          markTurnActivity();
          const plan = Array.isArray(notification.params.plan) ? notification.params.plan : [];
          queue.push({
            type: 'plan_update',
            explanation: asString(notification.params.explanation),
            steps: plan
              .map((entry) => asRecord(entry))
              .filter((entry): entry is Record<string, unknown> => !!entry)
              .map((entry) => ({
                step: asString(entry.step) || '',
                status: mapPlanStepStatus(entry.status),
              }))
              .filter((entry) => entry.step.length > 0),
          });
          break;
        }

        case 'turn/started': {
          const turn = asRecord(notification.params.turn);
          this.activeTurnId = asString(turn?.id);
          break;
        }

        case 'item/commandExecution/outputDelta': {
          markTurnActivity();
          const itemId = asString(notification.params.itemId);
          const delta = asString(notification.params.delta);
          if (itemId && delta) {
            const previous = commandOutputByItemId.get(itemId) || '';
            commandOutputByItemId.set(itemId, previous + delta);
            queue.push({ type: 'command_progress', id: itemId, delta });
          }
          break;
        }

        case 'item/commandExecution/terminalInteraction': {
          markTurnActivity();
          const itemId = asString(notification.params.itemId);
          const stdin = asString(notification.params.stdin);
          if (itemId && stdin) {
            const line = `\n$ ${stdin}`;
            const previous = commandOutputByItemId.get(itemId) || '';
            commandOutputByItemId.set(itemId, previous + line);
            queue.push({ type: 'command_progress', id: itemId, delta: line });
          }
          break;
        }

        case 'item/mcpToolCall/progress': {
          markTurnActivity();
          const itemId = asString(notification.params.itemId);
          const message = asString(notification.params.message);
          if (itemId && message) {
            queue.push({ type: 'tool_result', id: itemId, content: message });
          }
          break;
        }

        case 'item/completed': {
          const item = asRecord(notification.params.item);
          if (item?.type !== 'userMessage') {
            markTurnActivity();
          }
          if (item?.type === 'agentMessage') {
            const itemId = asString(item.id);
            const finalText = asString(item.text) || '';
            const currentText = itemId ? (textByItemId.get(itemId) || '') : '';
            if (itemId && finalText.startsWith(currentText)) {
              const suffix = finalText.slice(currentText.length);
              pushDelta(itemId, suffix);
            } else if (!currentText && finalText) {
              if (itemId) {
                ensureAgentMessageSeparation(itemId);
              }
              queue.push({ type: 'text', content: finalText });
              hasStreamedAgentText = true;
            }
          }
          if (item?.type === 'commandExecution') {
            const itemId = asString(item.id);
            if (itemId) {
              const output = commandOutputByItemId.get(itemId) || '';
              commandOutputByItemId.delete(itemId);
              const exitCode = asNumber(item.exitCode) ?? undefined;
              queue.push({
                type: 'command_complete',
                id: itemId,
                output,
                exitCode,
                status: exitCode === 0 ? 'completed' : 'error',
              });
            }
          }
          if (item?.type === 'mcpToolCall') {
            const itemId = asString(item.id);
            if (itemId) {
              queue.push({
                type: 'tool_result',
                id: itemId,
                content: item.error ? stringifyContent(item.error) : stringifyContent(item.result),
                isError: asString(item.status) === 'failed',
              });
            }
          }
          if (item?.type === 'fileChange') {
            const itemId = asString(item.id);
            if (itemId) {
              queue.push({
                type: 'tool_result',
                id: itemId,
                content: stringifyContent(item.changes),
                isError: asString(item.status) === 'failed',
              });
            }
          }
          break;
        }

        case 'error': {
          const rawMessage = getAppServerErrorMessage(notification.params);
          void appendRuntimeDiagnosticLog(`notification-error raw=${rawMessage} fullParams=${JSON.stringify(notification.params)}`);
          if (isRetryableAppServerError(notification.params)) {
            void appendRuntimeDiagnosticLog('notification-error-retryable-ignored');
            break;
          }
          clearWatchdog();
          const message = formatAppServerErrorMessage(rawMessage);
          queue.push({ type: 'error', content: message });
          queue.finish();
          break;
        }

        case 'turn/completed': {
          clearWatchdog();
          void appendRuntimeDiagnosticLog('notification-turn-completed');
          if (hasRunningSubagents()) {
            void (async () => {
              const started = await startSubagentWaitTurn();
              if (started) return;
              queue.push({
                type: 'blocked',
                content: 'Background subagents are still running, but Codian could not start a follow-up wait turn. Ask Codian to continue and wait for the task results.',
              });
              queue.push({ type: 'done' });
              queue.finish();
            })();
            break;
          }
          queue.push({ type: 'done' });
          queue.finish();
          break;
        }

        case 'warning': {
          void appendRuntimeDiagnosticLog(`notification-warning params=${JSON.stringify(notification.params)}`);
          break;
        }

        default:
          void appendRuntimeDiagnosticLog(`notification-unhandled method=${notification.method} params=${JSON.stringify(notification.params)}`);
          break;
      }
    };

    // Assigned after the watchdog closure so both callbacks can safely reference each other.
    // eslint-disable-next-line prefer-const
    let runAttempt: (attemptDisabledMcpServers: string[], generation: number) => Promise<void>;

    armWatchdog = (generation: number, timeoutOverrideMs?: number) => {
      clearWatchdog();
      if (turnHasActivity || generation !== attemptGeneration) return;

      const timeoutMs = timeoutOverrideMs ?? (
        startingMcpServers.size > 0
          ? MCP_STARTUP_TIMEOUT_MS
          : FIRST_TURN_ACTIVITY_TIMEOUT_MS
      );
      this.activeWatchdogTimer = setTimeout(() => {
        if (
          generation !== attemptGeneration ||
          turnHasActivity ||
          this.activeAbortController?.signal.aborted
        ) {
          return;
        }

        const stalledMcpServers = Array.from(startingMcpServers);
        if (stallRecoveryAttempts < MAX_STALL_RECOVERY_ATTEMPTS) {
          stallRecoveryAttempts += 1;
          attemptGeneration += 1;
          const nextGeneration = attemptGeneration;
          const globallyKnownMcpNames = new Set(globalMcpNames);
          const retryDisabledMcpServers = Array.from(new Set([
            ...disabledMcpServers,
            ...stalledMcpServers.filter((name) => globallyKnownMcpNames.has(name)),
          ])).sort();

          void appendRuntimeDiagnosticLog(
            `stall-recovery attempt=${stallRecoveryAttempts} stalledMcpServers=${stalledMcpServers.join(',') || 'none'} ` +
            `disabledMcpServers=${retryDisabledMcpServers.join(',') || 'none'}`
          );
          this.activeClient?.kill();
          this.activeClient = null;
          this.activeTurnId = null;
          this.threadId = null;
          request = this.buildHistoryRebuildRequest(prompt, images, conversationHistory);
          startingMcpServers.clear();
          turnHasActivity = false;
          void runAttempt(retryDisabledMcpServers, nextGeneration);
          return;
        }

        void appendRuntimeDiagnosticLog(
          `stall-recovery-exhausted stalledMcpServers=${stalledMcpServers.join(',') || 'none'}`
        );
        this.activeClient?.kill();
        this.activeClient = null;
        queue.push({ type: 'error', content: CODEX_STALL_MESSAGE });
        queue.finish();
      }, timeoutMs);
    };

    runAttempt = async (attemptDisabledMcpServers: string[], generation: number) => {
      armWatchdog?.(generation, APP_SERVER_STARTUP_TIMEOUT_MS);
      try {
        const client = new CodexAppServerClient(
          this.plugin,
          (notification) => handleNotification(notification, generation),
          this.activeAbortController?.signal,
          {
            disabledMcpServers: attemptDisabledMcpServers,
            requestHandler: (method, params) => this.handleAppServerRequest(method, params),
          },
        );
        void appendRuntimeDiagnosticLog('client-created');
        this.activeClient = client;

        await client.initialize();
        void appendRuntimeDiagnosticLog('client-initialized');

        if (this.threadId) {
          try {
            await client.request('thread/resume', {
              threadId: this.threadId,
              cwd: vaultPath,
              model: requestedModel ?? null,
              approvalPolicy: this.getApprovalPolicy(),
              sandbox: this.getThreadSandboxMode(),
              persistExtendedHistory: false,
            });
            void appendRuntimeDiagnosticLog(`thread-resumed ${this.threadId ?? 'null'}`);
          } catch {
            void appendRuntimeDiagnosticLog(`thread-resume-failed ${this.threadId ?? 'null'}`);
            this.threadId = null;
            request = this.buildHistoryRebuildRequest(prompt, images, conversationHistory);
          }
        }

        const ensureThreadStarted = async () => {
          if (this.threadId) {
            return;
          }
          const started = await client.request('thread/start', {
            model: requestedModel ?? null,
            cwd: vaultPath,
            approvalPolicy: this.getApprovalPolicy(),
            sandbox: this.getThreadSandboxMode(),
            experimentalRawEvents: true,
            persistExtendedHistory: false,
          });
          const thread = asRecord(started.thread);
          this.threadId = asString(thread?.id);
          void appendRuntimeDiagnosticLog(`thread-started ${this.threadId ?? 'null'}`);
        };

        const startTurn = async () => {
          await ensureThreadStarted();
          return await client.request('turn/start', {
            threadId: this.threadId,
            input: await this.buildInput(
              this.applyInstructionsToPrompt(request.prompt, vaultPath),
              request.images || []
            ),
            cwd: vaultPath,
            approvalPolicy: this.getApprovalPolicy(),
            sandboxPolicy: this.buildTurnSandboxPolicy(queryOptions),
            model: requestedModel ?? null,
          });
        };

        let startedTurn: Record<string, unknown>;
        try {
          startedTurn = await startTurn();
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          void appendRuntimeDiagnosticLog(`turn-start-failed threadId=${this.threadId ?? 'null'} error=${errorMsg}`);
          if (isInputTooLongError(error)) {
            void appendRuntimeDiagnosticLog('turn-start-input-too-long resetting-thread-and-sending-current-request-only');
            this.threadId = null;
            request = {
              prompt,
              images: images && images.length > 0 ? images : undefined,
            };
            startedTurn = await startTurn();
          } else {
            // For any other error, try once more with a fresh thread and
            // current request only (skip history rebuild to isolate the issue).
            this.threadId = null;
            request = {
              prompt,
              images: images && images.length > 0 ? images : undefined,
            };
            startedTurn = await startTurn();
          }
        }

        const turn = asRecord(startedTurn.turn);
        this.activeTurnId = asString(turn?.id);
        void appendRuntimeDiagnosticLog(`turn-started ${this.activeTurnId ?? 'null'}`);
        queue.push({ type: 'sdk_user_sent', uuid: this.activeTurnId || '' });
        armWatchdog?.(generation);
      } catch (error) {
        if (generation !== attemptGeneration || this.activeAbortController?.signal.aborted) {
          return;
        }
        const message = error instanceof Error
          ? error.message || 'Codex App Server 执行失败。'
          : 'Codex App Server 执行失败。';
        void appendRuntimeDiagnosticLog(`query-error ${message}`);
        queue.push({ type: 'error', content: message });
        queue.finish();
      }
    };

    void runAttempt(disabledMcpServers, attemptGeneration);

    try {
      for await (const chunk of queue.drain()) {
        yield chunk;
      }
    } finally {
      clearWatchdog();
      void appendRuntimeDiagnosticLog(`query-finally activeTurnId=${this.activeTurnId ?? 'null'} activeClient=${this.activeClient ? 'present' : 'null'} activeAbortController=${this.activeAbortController ? 'present' : 'null'}`);
      this.activeTurnId = null;
      this.activeClient?.kill();
      this.activeClient = null;
      this.activeAbortController = null;
      await this.cleanupTemporaryImages();
    }
  }

  cancel(): void {
    if (this.activeWatchdogTimer) {
      clearTimeout(this.activeWatchdogTimer);
      this.activeWatchdogTimer = null;
    }
    if (!this.activeAbortController) {
      return;
    }
    void appendRuntimeDiagnosticLog(`cancel called activeTurnId=${this.activeTurnId ?? 'null'} stack=${new Error().stack?.replace(/\n/g, ' ← ') ?? 'none'}`);
    this.activeAbortController.abort();
    this.activeClient?.kill();
    this.activeClient = null;
    this.activeAbortController = null;
    this.activeTurnId = null;
    this.approvalDismisser?.();
  }

  resetSession(): void {
    this.pendingResumeAt = undefined;
    this.threadId = null;
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  consumeSessionInvalidation(): boolean {
    return false;
  }

  isReady(): boolean {
    return resolveCodexCliPath(this.plugin) !== null;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  setSessionId(id: string | null): void {
    this.threadId = id;
  }

  cleanup(): void {
    this.cancel();
    void this.cleanupTemporaryImages();
  }

  async rewindFiles(): Promise<RewindFilesResult> {
    throw new Error('当前 Codex App Server 适配器阶段暂不支持回滚文件。');
  }

  async rewind(): Promise<RewindFilesResult> {
    throw new Error('当前 Codex App Server 适配器阶段暂不支持回滚会话。');
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(
    callback: ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, string> | null>) | null
  ): void {
    this.askUserQuestionCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setSubagentHookProvider(getState: () => SubagentHookState): void {
    this.subagentStateProvider = getState;
  }

  setAutoTurnCallback(_callback: ((chunks: StreamChunk[]) => void) | null): void {
    // Codex runtime currently does not emit SDK auto-turn callbacks.
  }
}
