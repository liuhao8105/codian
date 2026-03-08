import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import type { RewindFilesResult } from '@anthropic-ai/claude-agent-sdk';

import type CodianPlugin from '../../main';
import { stripCurrentNoteContext } from '../../utils/context';
import { getVaultPath } from '../../utils/path';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
  getLastUserMessage,
} from '../../utils/session';
import type { ApprovalCallback, QueryOptions } from '../agent';
import type { McpServerManager } from '../mcp';
import type {
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  ImageAttachment,
  SlashCommand,
  StreamChunk,
} from '../types';
import type { AgentRuntime } from './index';
import { CodexAppServerClient, type AppServerNotification } from './CodexAppServerClient';
import { resolveCodexCliPath } from './codexExec';

type Waiter = () => void;

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
  private activeTurnId: string | null = null;
  private threadId: string | null = null;
  private pendingResumeAt?: string;
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserQuestionCallback:
    ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, string> | null>) | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;

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

  private getApprovalPolicy(): 'never' {
    return 'never';
  }

  private getThreadSandboxMode(): 'workspace-write' {
    return 'workspace-write';
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
      networkAccess: false,
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

    return await Promise.all(images.map(async (image) => {
      const buffer = Buffer.from(image.data, 'base64');
      const hash = createHash('sha256').update(buffer).digest('hex');
      const filePath = path.join(tempDir, `${hash}${getImageExtension(image.mediaType)}`);

      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, buffer);
      }

      return filePath;
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
        type: 'local_image',
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

    if (!resolveCodexCliPath(this.plugin)) {
      yield { type: 'error', content: '找不到 Codex CLI。请在设置中填写 Codex CLI 路径，或安装 Codex 应用。' };
      return;
    }

    const queue = createChunkQueue();
    const selectedModel = queryOptions?.model?.trim() || undefined;
    let request = this.threadId
      ? { prompt, images }
      : this.buildHistoryRebuildRequest(prompt, images, conversationHistory);

    this.activeAbortController = new AbortController();

    const textByItemId = new Map<string, string>();
    let activeAgentMessageItemId: string | null = null;
    let hasStreamedAgentText = false;

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

    const handleNotification = (notification: AppServerNotification) => {
      switch (notification.method) {
        case 'item/started': {
          const item = asRecord(notification.params.item);
          if (item?.type === 'userMessage') {
            queue.push({ type: 'sdk_user_sent', uuid: asString(item.id) || '' });
          }
          if (item?.type === 'agentMessage') {
            const itemId = asString(item.id);
            if (itemId) {
              ensureAgentMessageSeparation(itemId);
            }
          }
          break;
        }

        case 'item/agentMessage/delta': {
          const itemId = asString(notification.params.itemId);
          const delta = asString(notification.params.delta);
          if (itemId && delta) {
            pushDelta(itemId, delta);
          }
          break;
        }

        case 'thread/tokenUsage/updated': {
          const usageChunk = this.mapUsage(asRecord(notification.params.tokenUsage) || undefined, selectedModel);
          if (usageChunk) {
            queue.push(usageChunk);
          }
          break;
        }

        case 'turn/started': {
          const turn = asRecord(notification.params.turn);
          this.activeTurnId = asString(turn?.id);
          break;
        }

        case 'item/completed': {
          const item = asRecord(notification.params.item);
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
          break;
        }

        case 'error': {
          const message = asString(notification.params.message) || 'Codex App Server 执行失败。';
          queue.push({ type: 'error', content: message });
          queue.finish();
          break;
        }

        case 'turn/completed': {
          queue.push({ type: 'done' });
          queue.finish();
          break;
        }

        default:
          break;
      }
    };

    void (async () => {
      try {
        const client = new CodexAppServerClient(
          this.plugin,
          handleNotification,
          this.activeAbortController?.signal
        );
        this.activeClient = client;

        await client.initialize();

        if (this.threadId) {
          try {
            await client.request('thread/resume', {
              threadId: this.threadId,
              cwd: vaultPath,
              model: selectedModel ?? null,
              approvalPolicy: this.getApprovalPolicy(),
              sandbox: this.getThreadSandboxMode(),
              persistExtendedHistory: false,
            });
          } catch {
            this.threadId = null;
            request = this.buildHistoryRebuildRequest(prompt, images, conversationHistory);
          }
        }

        if (!this.threadId) {
          const started = await client.request('thread/start', {
            model: selectedModel ?? null,
            cwd: vaultPath,
            approvalPolicy: this.getApprovalPolicy(),
            sandbox: this.getThreadSandboxMode(),
            experimentalRawEvents: false,
            persistExtendedHistory: false,
          });
          const thread = asRecord(started.thread);
          this.threadId = asString(thread?.id);
        } else {
          // Keep the restored thread id.
        }

        const startedTurn = await client.request('turn/start', {
          threadId: this.threadId,
          input: await this.buildInput(request.prompt, request.images || []),
          cwd: vaultPath,
          approvalPolicy: this.getApprovalPolicy(),
          sandboxPolicy: this.buildTurnSandboxPolicy(queryOptions),
          model: selectedModel ?? null,
        });

        const turn = asRecord(startedTurn.turn);
        this.activeTurnId = asString(turn?.id);
        queue.push({ type: 'sdk_user_sent', uuid: this.activeTurnId || '' });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Codex App Server 执行失败。';
        queue.push({ type: 'error', content: message });
        queue.finish();
      }
    })();

    try {
      for await (const chunk of queue.drain()) {
        yield chunk;
      }
    } finally {
      this.activeTurnId = null;
      this.activeClient?.kill();
      this.activeClient = null;
      this.activeAbortController = null;
    }
  }

  cancel(): void {
    if (!this.activeAbortController) {
      return;
    }
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
}
