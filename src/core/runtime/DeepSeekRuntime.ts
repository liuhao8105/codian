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

// ── SSE streaming types ──

interface SSEDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface SSEChoice {
  index: number;
  delta: SSEDelta;
  finish_reason: string | null;
}

interface AccumulatedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface StreamResult {
  accumulatedText: string;
  accumulatedReasoning: string;
  toolCalls: AccumulatedToolCall[];
  finishReason: string;
}

/**
 * Parse an SSE stream from a fetch Response body.
 * Yields parsed SSEChoice objects for each non-empty data line.
 * Resolves when the [DONE] marker is received or the stream ends.
 */
async function* parseSSEStream(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<SSEChoice> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response body is not readable.');
  }

  // Cancel reader on abort
  const onAbort = () => reader.cancel();
  signal.addEventListener('abort', onAbort, { once: true });

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') return;

        try {
          const parsed = JSON.parse(dataStr) as Record<string, unknown>;
          const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
          if (!choices || choices.length === 0) continue;

          for (const choice of choices) {
            const delta = (choice.delta || {}) as SSEDelta;
            yield {
              index: (choice.index as number) ?? 0,
              delta,
              finish_reason: (choice.finish_reason as string) || null,
            };
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/**
 * Consume an SSE stream and accumulate deltas into a StreamResult.
 * Yields text chunks with buffering/throttling for natural reading speed.
 */
async function* consumeSSEToResult(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk, StreamResult> {
  let accumulatedText = '';
  let accumulatedReasoning = '';
  const toolCallsByIndex = new Map<number, AccumulatedToolCall>();
  let finishReason = '';

  // Text buffer for chunk aggregation — tuned for natural paragraph-by-paragraph output
  const FLUSH_SIZE = 80;        // flush when buffer reaches this many chars
  const FLUSH_INTERVAL = 150;   // ms — maximum time before forced flush
  const SENTENCE_END = /[。！？\n]/;   // sentence/paragraph break — flush immediately
  const CLAUSE_END = /[，；：,;:]/;    // clause break — flush if buffer is substantial (>40 chars)
  let textBuffer = '';
  let lastFlushTime = performance.now();

  try {
    for await (const choice of parseSSEStream(response, signal)) {
      const { delta } = choice;

      // Accumulate reasoning_content (not buffered — not displayed, just preserved)
      if (delta.reasoning_content) {
        accumulatedReasoning += delta.reasoning_content;
      }

      // Accumulate tool_calls by index
      if (delta.tool_calls) {
        // Flush any buffered text before processing tools
        if (textBuffer) {
          accumulatedText += textBuffer;
          yield { type: 'text', content: textBuffer };
          textBuffer = '';
        }

        for (const tc of delta.tool_calls) {
          const existing = toolCallsByIndex.get(tc.index);
          if (existing) {
            if (tc.function?.name) existing.function.name += tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          } else {
            toolCallsByIndex.set(tc.index, {
              id: tc.id || '',
              type: tc.type || 'function',
              function: {
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              },
            });
          }
        }
        continue;
      }

      // Buffer text content
      if (delta.content) {
        textBuffer += delta.content;

        const now = performance.now();
        const timeSinceLastFlush = now - lastFlushTime;
        const hasSentenceEnd = SENTENCE_END.test(textBuffer);
        const hasClauseEnd = CLAUSE_END.test(textBuffer) && textBuffer.length >= 40;
        const reachedSize = textBuffer.length >= FLUSH_SIZE;
        const reachedInterval = timeSinceLastFlush >= FLUSH_INTERVAL;

        if (hasSentenceEnd || hasClauseEnd || reachedSize || reachedInterval) {
          accumulatedText += textBuffer;
          yield { type: 'text', content: textBuffer };
          textBuffer = '';
          lastFlushTime = now;
        }
      }

      // Track finish_reason
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  } finally {
    // Final flush — must not lose any remaining buffered text
    if (textBuffer) {
      accumulatedText += textBuffer;
      yield { type: 'text', content: textBuffer };
      textBuffer = '';
    }
  }

  return {
    accumulatedText: accumulatedText.trim(),
    accumulatedReasoning,
    toolCalls: Array.from(toolCallsByIndex.values()),
    finishReason,
  };
}

// ── Runtime ──

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

    return base.trim() + '\n\n' + DEEPSEEK_TOOLS_SYSTEM_PROMPT_SECTION;
  }

  // ── Streaming API call (one round of the tool loop) ──

  /**
   * Makes one streaming API call and consumes the SSE stream.
   * Returns the accumulated result (text, reasoning, tool_calls, finish_reason).
   * Yields text chunks incrementally during streaming.
   */
  private async *streamAPICall(
    baseUrl: string,
    config: { apiKey: string; model: string },
    messages: DeepSeekMessage[],
    includeTools: boolean,
  ): AsyncGenerator<StreamChunk, StreamResult> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
    };
    if (includeTools) {
      body.tools = DEEPSEEK_P1_TOOLS;
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: this.activeAbortController!.signal,
    });

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch { /* ignore */ }
      let errorMsg = `DeepSeek API 返回 HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(errorBody) as Record<string, unknown>;
        const err = (parsed.error as Record<string, unknown> | undefined);
        if (err?.message) errorMsg += `: ${String(err.message)}`;
      } catch {
        if (errorBody) errorMsg += `: ${errorBody.slice(0, 200)}`;
      }
      throw new Error(errorMsg);
    }

    const result = yield* consumeSSEToResult(response, this.activeAbortController!.signal);
    return result;
  }

  // ── Query with streaming tool loop ──

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

    if (images && images.length > 0) {
      yield { type: 'error', content: 'DeepSeek provider 暂不支持图片附件。' };
      return;
    }

    const baseUrl = config.baseUrl.replace(/\/+$/, '');
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
      let totalAccumulatedText = '';

      // Duplicate / no-progress tracking
      const readFiles = new Set<string>();
      const grepPatterns = new Set<string>();
      let duplicateCount = 0;
      let consecutiveNoProgress = 0;
      let lastToolResultSummary = '';

      while (round < MAX_TOOL_ROUNDS) {
        round++;

        // Check for cancellation
        if (this.activeAbortController.signal.aborted) {
          if (totalAccumulatedText) break;
          yield { type: 'error', content: 'DeepSeek 请求已取消。' };
          return;
        }

        // Streaming API call
        let result: StreamResult;
        try {
          const gen = this.streamAPICall(baseUrl, config, messages, true);
          result = yield* gen;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            if (totalAccumulatedText) break;
            yield { type: 'error', content: 'DeepSeek 请求已取消。' };
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          yield { type: 'error', content: message };
          return;
        }

        totalAccumulatedText += result.accumulatedText;

        const hasToolCalls = result.toolCalls.length > 0;

        // If no tool calls, we're done
        if (!hasToolCalls) {
          if (!totalAccumulatedText && result.finishReason === 'length') {
            yield { type: 'error', content: 'DeepSeek 回复被截断（达到最大 token 限制）。' };
            return;
          }
          if (!totalAccumulatedText) {
            yield { type: 'error', content: `DeepSeek 返回空回复 (finish_reason: ${result.finishReason || 'unknown'})。` };
            return;
          }
          break;
        }

        // Process tool calls — add assistant message to history
        const formattedToolCalls = result.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));

        const assistantMsg: DeepSeekMessage = {
          role: 'assistant',
          content: result.accumulatedText || null,
          ...(result.accumulatedReasoning ? { reasoning_content: result.accumulatedReasoning } : {}),
          tool_calls: formattedToolCalls,
        };
        messages.push(assistantMsg);

        // Execute each tool call
        let roundHadNewInfo = false;
        for (const tc of result.toolCalls) {
          let tcArgs: Record<string, unknown> = {};
          try {
            tcArgs = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
          } catch {
            tcArgs = {};
          }

          // Duplicate detection
          const dupKey = buildDuplicateKey(tc.function.name, tcArgs);
          if (dupKey) {
            if (readFiles.has(dupKey) || grepPatterns.has(dupKey)) {
              duplicateCount++;
            } else {
              if (tc.function.name === 'Read') readFiles.add(dupKey);
              if (tc.function.name === 'Grep') grepPatterns.add(dupKey);
            }
          }

          // Yield tool_use chunk
          yield {
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: tcArgs,
          };

          // Execute the tool
          let resultContent: string;
          try {
            resultContent = await executeDeepSeekToolCall(
              { id: tc.id, name: tc.function.name, arguments: tcArgs },
              { plugin: this.plugin },
            );
          } catch (error) {
            resultContent = `Tool execution error: ${error instanceof Error ? error.message : String(error)}`;
          }

          // No-progress detection
          const resultSummary = `${tc.function.name}:${resultContent.slice(0, 200)}`;
          if (resultSummary !== lastToolResultSummary) {
            roundHadNewInfo = true;
          }
          lastToolResultSummary = resultSummary;

          // Yield tool_result chunk
          yield {
            type: 'tool_result',
            id: tc.id,
            content: resultContent,
          };

          // Add tool result to message history
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultContent,
          });
        }

        // Update no-progress counter
        if (roundHadNewInfo) {
          consecutiveNoProgress = 0;
        } else {
          consecutiveNoProgress++;
        }

        // Check stop conditions
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

          // One final streaming call without tools
          try {
            const finalGen = this.streamAPICall(baseUrl, config, messages, false);
            const finalResult = yield* finalGen;
            // (text was already streamed incrementally by yield*)
            totalAccumulatedText += finalResult.accumulatedText;
          } catch {
            // If forced-stop call fails, text from previous rounds was already streamed
          }
          break;
        }
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
