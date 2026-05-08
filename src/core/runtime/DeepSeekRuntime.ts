import type { RewindFilesResult } from '@anthropic-ai/claude-agent-sdk';

import type CodianPlugin from '../../main';
import type { ApprovalCallback, QueryOptions } from '../agent';
import type {
  ChatMessage,
  ImageAttachment,
  StreamChunk,
} from '../types';
import type { AgentRuntime } from './index';
import { isProviderConfigured } from '../../utils/env';

export class DeepSeekRuntime implements AgentRuntime {
  private readonly plugin: CodianPlugin;
  private activeAbortController: AbortController | null = null;
  private readonly readyStateListeners = new Set<(ready: boolean) => void>();

  constructor(plugin: CodianPlugin) {
    this.plugin = plugin;
  }

  // ── AgentRuntime interface (stubs for non-applicable methods) ──

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyStateListeners.add(listener);
    try { listener(this.isReady()); } catch { /* ignore */ }
    return () => { this.readyStateListeners.delete(listener); };
  }

  private notifyReadyStateChange(): void {
    const ready = this.isReady();
    for (const listener of this.readyStateListeners) {
      try { listener(ready); } catch { /* ignore */ }
    }
  }

  setPendingResumeAt(_uuid: string | undefined): void {}
  applyForkState(): string | null { return null; }
  async reloadMcpServers(): Promise<void> {}

  async ensureReady(): Promise<boolean> {
    const ready = this.isReady();
    this.notifyReadyStateChange();
    return ready;
  }

  closePersistentQuery(): void {}

  async *query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    _queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk> {
    const config = this.plugin.settings.providerConfigs.deepseek;
    const validation = isProviderConfigured(this.plugin.settings, 'deepseek');
    if (!validation.ok) {
      yield { type: 'error', content: validation.error };
      return;
    }

    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const messages: Array<{ role: string; content: string }> = [];

    // System prompt
    const systemPrompt = this.plugin.settings.systemPrompt?.trim();
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Conversation history
    if (conversationHistory) {
      for (const msg of conversationHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    // Current user prompt
    messages.push({ role: 'user', content: prompt });

    // Images not supported in this minimal implementation
    if (images && images.length > 0) {
      yield { type: 'error', content: 'DeepSeek provider 暂不支持图片附件。' };
      return;
    }

    const turnId = `deepseek-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    yield { type: 'sdk_user_sent', uuid: turnId };

    this.activeAbortController = new AbortController();

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          stream: false,
        }),
        signal: this.activeAbortController.signal,
      });

      if (!response.ok) {
        let errorBody = '';
        try { errorBody = await response.text(); } catch { /* ignore */ }
        let errorMsg = `DeepSeek API 返回 HTTP ${response.status}`;
        try {
          const parsed = JSON.parse(errorBody) as Record<string, unknown>;
          const err = (parsed.error as Record<string, unknown> | undefined);
          if (err?.message) {
            errorMsg += `: ${String(err.message)}`;
          }
          if (err?.type) {
            errorMsg += ` (type: ${String(err.type)})`;
          }
        } catch {
          if (errorBody) {
            errorMsg += `: ${errorBody.slice(0, 200)}`;
          }
        }
        yield { type: 'error', content: errorMsg };
        return;
      }

      const data = await response.json() as Record<string, unknown>;
      const choices = data.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const message = choice?.message as Record<string, unknown> | undefined;
      const content = typeof message?.content === 'string' ? message.content : '';

      if (!content) {
        const finishReason = String(choice?.finish_reason ?? 'unknown');
        if (finishReason === 'length') {
          yield { type: 'error', content: 'DeepSeek 回复被截断（达到最大 token 限制）。' };
        } else {
          yield { type: 'error', content: `DeepSeek 返回空回复 (finish_reason: ${finishReason})。` };
        }
        return;
      }

      yield { type: 'text', content };
      yield { type: 'done' };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        yield { type: 'error', content: 'DeepSeek 请求已取消。' };
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', content: `DeepSeek API 连接失败: ${message}` };
    } finally {
      this.activeAbortController = null;
    }
  }

  cancel(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
  }

  resetSession(): void {}
  getSessionId(): string | null { return null; }
  consumeSessionInvalidation(): boolean { return false; }

  isReady(): boolean {
    const config = this.plugin.settings.providerConfigs.deepseek;
    return !!(config.apiKey?.trim() && config.baseUrl?.trim() && config.model?.trim());
  }

  async getSupportedCommands(): Promise<[]> { return []; }
  setSessionId(_id: string | null, _externalContextPaths?: string[]): void {}
  cleanup(): void { this.cancel(); }

  async rewindFiles(): Promise<RewindFilesResult> {
    return { canRewind: false, error: 'DeepSeek provider 不支持 rewind。' };
  }
  async rewind(): Promise<RewindFilesResult> {
    return { canRewind: false, error: 'DeepSeek provider 不支持 rewind。' };
  }

  setApprovalCallback(_callback: ApprovalCallback | null): void {}
  setApprovalDismisser(_dismisser: (() => void) | null): void {}
  setAskUserQuestionCallback(_callback: ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, string> | null>) | null): void {}
  setExitPlanModeCallback(_callback: ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> | null) | null): void {}
  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}
  setSubagentHookProvider(_getState: () => unknown): void {}
  setAutoTurnCallback(_callback: ((chunks: StreamChunk[]) => void) | null): void {}
}
