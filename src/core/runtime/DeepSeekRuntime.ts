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
import { getVaultPath } from '../../utils/path';
import { buildSystemPrompt } from '../prompts/mainAgent';
import {
  DEEPSEEK_P1_TOOLS,
  DEEPSEEK_TOOLS_SYSTEM_PROMPT_SECTION,
  type DeepSeekToolDefinition,
} from '../tools/toolSchemas';
import { executeDeepSeekToolCall } from '../tools/toolExecutor';
import type { McpServerManager } from '../mcp';

/** Maximum tool-calling rounds per user message (final safety net). */
const MAX_TOOL_ROUNDS = 10;
/** Stop exploration after this many consecutive rounds with no new information. */
const MAX_NO_PROGRESS_ROUNDS = 3;
/** Stop exploration after this many duplicate tool calls (same file/pattern). */
const MAX_DUPLICATE_TOOLS = 3;
/** After this round, require the model to answer based on gathered context. */
const WARN_ROUND = 6;

interface DeepSeekMessage {
  role: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

function generateToolCallId(): string {
  return `deepseek-tc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Build a dedup key for detecting repeated tool calls. Returns null for non-tracking tools. */
function buildDuplicateKey(name: string, args: Record<string, unknown>): string | null {
  switch (name) {
    case 'Read':
      return `read:${String(args.file_path || '')}`;
    case 'Grep':
      return `grep:${String(args.pattern || '')}`;
    default:
      return null;
  }
}

export class DeepSeekRuntime implements AgentRuntime {
  private readonly plugin: CodianPlugin;
  private activeAbortController: AbortController | null = null;
  private readonly readyStateListeners = new Set<(ready: boolean) => void>();

  constructor(plugin: CodianPlugin, _mcpManager?: McpServerManager) {
    this.plugin = plugin;
  }

  // ── AgentRuntime interface ──

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

  // ── System prompt (shared with Codex for consistent identity) ──

  private buildSystemPromptContent(): string {
    const vaultPath = getVaultPath(this.plugin.app) ?? undefined;
    const base = buildSystemPrompt({
      mediaFolder: this.plugin.settings.mediaFolder,
      strongRulesPrompt: this.plugin.settings.strongRulesPrompt,
      customPrompt: this.plugin.settings.systemPrompt,
      allowedExportPaths: this.plugin.settings.allowedExportPaths,
      vaultPath,
      userName: this.plugin.settings.userName,
    });

    // Append DeepSeek-specific tool guidance (keeps the Skill section
    // from the shared prompt, adds concrete tool definitions)
    return base.trim() + '\n\n' + DEEPSEEK_TOOLS_SYSTEM_PROMPT_SECTION;
  }

  // ── Query with tool loop ──

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

    // Images not supported yet
    if (images && images.length > 0) {
      yield { type: 'error', content: 'DeepSeek provider 暂不支持图片附件。' };
      return;
    }

    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const tools = DEEPSEEK_P1_TOOLS;
    const systemPrompt = this.buildSystemPromptContent();

    const messages: DeepSeekMessage[] = [];

    // System prompt
    messages.push({ role: 'system', content: systemPrompt });

    // Conversation history
    if (conversationHistory) {
      for (const msg of conversationHistory) {
        if (msg.role === 'user') {
          messages.push({ role: 'user', content: msg.content });
        } else if (msg.role === 'assistant') {
          // Replay assistant messages from history.
          // Tool calls from previous turns are not replayed — DeepSeek sees
          // them as plain assistant text (the rendered content).
          messages.push({ role: 'assistant', content: msg.content || '(tool output)' });
        }
      }
    }

    // Current user prompt
    messages.push({ role: 'user', content: prompt });

    const turnId = `deepseek-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    yield { type: 'sdk_user_sent', uuid: turnId };

    this.activeAbortController = new AbortController();

    try {
      let round = 0;
      let accumulatedText = '';

      // Duplicate / no-progress tracking to prevent runaway exploration
      const readFiles = new Set<string>();
      const grepPatterns = new Set<string>();
      let duplicateCount = 0;
      let consecutiveNoProgress = 0;
      let lastToolResultSummary = '';

      while (round < MAX_TOOL_ROUNDS) {
        round++;

        // Check for cancellation before each API call
        if (this.activeAbortController.signal.aborted) {
          if (accumulatedText) {
            // Text was already yielded — just stop
            break;
          }
          yield { type: 'error', content: 'DeepSeek 请求已取消。' };
          return;
        }

        let response: Response;
        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: config.model,
              messages,
              tools: tools.length > 0 ? tools : undefined,
              tool_choice: tools.length > 0 ? 'auto' : undefined,
              stream: false,
            }),
            signal: this.activeAbortController.signal,
          });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            if (accumulatedText) break;
            yield { type: 'error', content: 'DeepSeek 请求已取消。' };
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          yield { type: 'error', content: `DeepSeek API 连接失败: ${message}` };
          return;
        }

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

        if (!message) {
          yield { type: 'error', content: 'DeepSeek 返回空响应。' };
          return;
        }

        const finishReason = String(choice?.finish_reason ?? 'unknown');
        const textContent = typeof message.content === 'string' ? message.content?.trim() : '';
        const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : null;
        const rawToolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;

        const hasToolCalls = Array.isArray(rawToolCalls) && rawToolCalls.length > 0;

        // Yield text if present
        if (textContent) {
          accumulatedText += textContent;
          yield { type: 'text', content: textContent };
        }

        // If no tool calls, we're done
        if (!hasToolCalls) {
          if (!accumulatedText && finishReason === 'length') {
            yield { type: 'error', content: 'DeepSeek 回复被截断（达到最大 token 限制）。' };
            return;
          }
          if (!accumulatedText) {
            yield { type: 'error', content: `DeepSeek 返回空回复 (finish_reason: ${finishReason})。` };
            return;
          }
          break;
        }

        // Process tool calls
        // Add assistant message (with tool_calls) to history.
        // Must preserve reasoning_content for DeepSeek thinking models —
        // they require it to be passed back in subsequent turns.
        const assistantMsg: DeepSeekMessage = {
          role: 'assistant',
          content: textContent || null,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          tool_calls: rawToolCalls.map((tc) => ({
            id: String(tc.id || ''),
            type: 'function' as const,
            function: {
              name: String((tc.function as Record<string, unknown>)?.name || ''),
              arguments: String((tc.function as Record<string, unknown>)?.arguments || '{}'),
            },
          })),
        };
        messages.push(assistantMsg);

        // Execute each tool call
        let roundHadNewInfo = false;
        for (const rawTc of rawToolCalls) {
          const tcId = String(rawTc.id || generateToolCallId());
          const tcFunc = rawTc.function as Record<string, unknown> | undefined;
          const tcName = String(tcFunc?.name || '');
          let tcArgs: Record<string, unknown> = {};
          try {
            tcArgs = JSON.parse(String(tcFunc?.arguments || '{}')) as Record<string, unknown>;
          } catch {
            tcArgs = {};
          }

          // Duplicate detection
          const dupKey = buildDuplicateKey(tcName, tcArgs);
          if (dupKey) {
            if (readFiles.has(dupKey) || grepPatterns.has(dupKey)) {
              duplicateCount++;
            } else {
              if (tcName === 'Read') readFiles.add(dupKey);
              if (tcName === 'Grep') grepPatterns.add(dupKey);
            }
          }

          // Yield tool_use chunk (same format as Codex)
          yield {
            type: 'tool_use',
            id: tcId,
            name: tcName,
            input: tcArgs,
          };

          // Execute the tool
          let resultContent: string;
          try {
            resultContent = await executeDeepSeekToolCall(
              { id: tcId, name: tcName, arguments: tcArgs },
              { plugin: this.plugin },
            );
          } catch (error) {
            resultContent = `Tool execution error: ${error instanceof Error ? error.message : String(error)}`;
          }

          // No-progress detection: compare with previous round's results
          const resultSummary = `${tcName}:${resultContent.slice(0, 200)}`;
          if (resultSummary !== lastToolResultSummary) {
            roundHadNewInfo = true;
          }
          lastToolResultSummary = resultSummary;

          // Yield tool_result chunk (same format as Codex)
          yield {
            type: 'tool_result',
            id: tcId,
            content: resultContent,
          };

          // Add tool result to message history
          messages.push({
            role: 'tool',
            tool_call_id: tcId,
            content: resultContent,
          });
        }

        // Update no-progress counter
        if (roundHadNewInfo) {
          consecutiveNoProgress = 0;
        } else {
          consecutiveNoProgress++;
        }

        // Check stop conditions and inject force-answer instruction
        const shouldForceStop =
          duplicateCount >= MAX_DUPLICATE_TOOLS ||
          consecutiveNoProgress >= MAX_NO_PROGRESS_ROUNDS ||
          round >= WARN_ROUND;

        if (shouldForceStop) {
          const reason =
            duplicateCount >= MAX_DUPLICATE_TOOLS
              ? 'You have repeatedly called the same tools. '
              : consecutiveNoProgress >= MAX_NO_PROGRESS_ROUNDS
                ? 'The last tool calls returned no new information. '
                : 'You have made several rounds of tool calls. ';
          messages.push({
            role: 'user',
            content:
              `[System: ${reason}Please answer the user's original question now ` +
              'based on all the information you have gathered so far. ' +
              'Do NOT call any more tools. Provide a complete answer directly.]',
          });
          // One final API call without tools to force a direct answer
          try {
            const finalResponse = await fetch(`${baseUrl}/chat/completions`, {
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

            if (finalResponse.ok) {
              const finalData = await finalResponse.json() as Record<string, unknown>;
              const finalChoice = (finalData.choices as Array<Record<string, unknown>>)?.[0];
              const finalMessage = finalChoice?.message as Record<string, unknown> | undefined;
              const finalContent = typeof finalMessage?.content === 'string' ? finalMessage.content?.trim() : '';
              if (finalContent) {
                accumulatedText += finalContent;
                yield { type: 'text', content: finalContent };
              }
            }
          } catch {
            // If the forced-stop fetch fails (e.g. abort), just end the loop.
            // The model may have already yielded text in a previous round.
          }
          break;
        }

        // Continue loop — LLM will see tool results and may call more tools or respond
      }

      if (round >= MAX_TOOL_ROUNDS) {
        yield { type: 'error', content: '已达到最大工具调用轮次（10轮）。请简化你的请求。' };
        return;
      }

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
