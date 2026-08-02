import type CodianPlugin from '../../main';
import { isProviderConfigured } from '../../utils/env';
import { getVaultPath } from '../../utils/path';
import type { McpServerManager } from '../mcp';
import { buildSystemPrompt } from '../prompts/mainAgent';
import { classifyMcpToolRisk, enumerateMcpToolsForDeepSeek } from '../tools/mcpBridge';
import { executeDeepSeekToolCall, type ToolExecutionContext } from '../tools/toolExecutor';
import {
  DEEPSEEK_BASH_TOOL,
  DEEPSEEK_P1_TOOLS,
  type DeepSeekToolDefinition,
  getDeepSeekToolsSystemPromptSection,
} from '../tools/toolSchemas';
import { TransactionLog } from '../tools/transactionLog';
import type {
  ChatMessage,
  ImageAttachment,
  StreamChunk,
} from '../types';
import type { ApprovalCallback, QueryOptions, RewindFilesResult } from './contracts';
import type { AgentRuntime } from './index';

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

/**
 * Maps a tool name to a session-level approval category.
 * Returns null for tools that should always require confirmation.
 */
function getApprovalCategory(toolName: string): string | null {
  // Low-risk file modifications — can be auto-approved per session
  if (toolName === 'Write') return 'write-file';
  if (toolName === 'Edit') return 'edit-file';
  if (toolName === 'Undo') return 'undo-file';

  // MCP tools: classify by risk level
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const actualToolName = parts.length >= 3 ? parts.slice(2).join('__') : toolName;
    const classification = classifyMcpToolRisk(actualToolName);
    // read-only → approval is skipped entirely by executeMcpCall (no confirm)
    // low-risk-action → session memory, first confirm then auto-allow
    if (classification.level === 'low-risk-action') return 'mcp-action';
    // high-risk-action and blocked → always confirm (null = no session memory)
    return null;
  }

  // Everything else (future: Bash, Delete) requires per-call confirmation
  return null;
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

// ── DSML protocol stripping ──
// DeepSeek models may emit internal DSML tokens in the content stream.
// These must be stripped before rendering to the UI.

/** Regex matching complete DSML tokens: <|TOKEN|...> */
const DSML_COMPLETE = /<\|[^|>]+\|[^>]*>/g;

/** Regex for partial DSML token at the end of a buffer (starts with <| or compact < | | DSML but not closed) */
const DSML_PARTIAL_END = /(?:<\|[^>]*|<\s*(?:\|\s*){0,2}(?:D(?:S(?:M(?:L)?)?)?)?[^<>]*)$/;
const DEEPSEEK_DSML_TOOL_CALLS_START = '<||DSML||tool_calls>';
const DEEPSEEK_DSML_TOOL_CALLS_END = '</||DSML||tool_calls>';

function decodeDSMLText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeDeepSeekDSML(text: string): string {
  return text
    .replace(/｜/g, '|')
    .replace(/<\s*\|\s*\|\s*DSML\s*\|\s*\|/g, '<||DSML||')
    .replace(/<\/\s*\|\s*\|\s*DSML\s*\|\s*\|/g, '</||DSML||')
    .replace(/<\|\|DSML\|\|\s+/g, '<||DSML||')
    .replace(/<\/\|\|DSML\|\|\s+/g, '</||DSML||')
    .replace(/<\|\|DSML\|\|(invoke|parameter)(?=name=)/g, '<||DSML||$1 ')
    .replace(/<\|\|DSML\|\|parameter([^>]*?)(name|s|string)=/g, '<||DSML||parameter$1 $2=')
    .replace(/\s+string=/g, ' string=');
}

export function parseDeepSeekDSMLToolCalls(text: string): AccumulatedToolCall[] {
  const normalized = normalizeDeepSeekDSML(text);
  const calls: AccumulatedToolCall[] = [];
  const invokeRegex = /<\|\|DSML\|\|invoke\s+name=(["'])(.*?)\1\s*>([\s\S]*?)<\/\|\|DSML\|\|invoke>/g;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = invokeRegex.exec(normalized)) !== null) {
    const toolName = decodeDSMLText(invokeMatch[2] || '').trim();
    const body = invokeMatch[3] || '';
    if (!toolName) continue;

    const args: Record<string, string> = {};
    const parameterRegex = /<\|\|DSML\|\|parameter\s+name=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/\|\|DSML\|\|parameter>/g;
    let parameterMatch: RegExpExecArray | null;
    while ((parameterMatch = parameterRegex.exec(body)) !== null) {
      const name = decodeDSMLText(parameterMatch[2] || '').trim();
      if (!name) continue;
      args[name] = decodeDSMLText(parameterMatch[3] || '').trim();
    }

    calls.push({
      id: `dsml-${calls.length}`,
      type: 'function',
      function: {
        name: toolName,
        arguments: JSON.stringify(args),
      },
    });
  }

  return calls;
}

export function stripDeepSeekDSMLToolCallBlocks(text: string): string {
  return normalizeDeepSeekDSML(text)
    .replace(/<\|\|DSML\|\|tool_calls>[\s\S]*?<\/\|\|DSML\|\|tool_calls>/g, '')
    .trim();
}

const EXPLICIT_ACTION_PROMPT_RE = /(?:更新|整理|执行|写入|修改|修复|刷新|继续|推进|开始|操作|update|organize|execute|write|edit|modify|fix|refresh|continue|proceed|start)/i;
const PLAN_ONLY_RESPONSE_RE = /(?:更新计划|执行计划|现状分析|当前知识库状态|按这个计划推进|先挑重点|是否继续|需要我|要不要|还是你先|给你一份.*计划|现在开始更新|开始执行|开始整理|开始写入|确认后|你确认|确认一下|要我继续|是否要我|再继续写入|分析完了|现在要读|接下来读|准备读|确保更新准确|开始更新|继续写入|继续更新|确认再继续|需要你确认.*继续|再统一改|继续改)/i;
const POST_WRITE_INCOMPLETE_RESPONSE_RE = /(?:确认再继续|需要你确认.*继续|再统一改|继续改|再继续改|主体更新|主要更新)/i;
const WRITE_EDIT_TOOL_NAMES = new Set(['Write', 'Edit']);

function isExplicitDeepSeekActionRequest(prompt: string): boolean {
  return EXPLICIT_ACTION_PROMPT_RE.test(prompt);
}

export function shouldForceDeepSeekExecutionContinuation(input: {
  originalPrompt: string;
  responseText: string;
  hasCompletedWriteEdit: boolean;
  forcedContinuationCount: number;
}): boolean {
  if (input.hasCompletedWriteEdit) {
    return input.forcedContinuationCount < 2 &&
      isExplicitDeepSeekActionRequest(input.originalPrompt) &&
      POST_WRITE_INCOMPLETE_RESPONSE_RE.test(input.responseText);
  }
  if (input.forcedContinuationCount >= 2) return false;
  if (!isExplicitDeepSeekActionRequest(input.originalPrompt)) return false;
  return PLAN_ONLY_RESPONSE_RE.test(input.responseText);
}

export function shouldForceDeepSeekWriteAfterToolRounds(input: {
  originalPrompt: string;
  hasCompletedWriteEdit: boolean;
  forcedWriteAttemptCount: number;
  round: number;
  duplicateCount: number;
  consecutiveNoProgress: number;
}): boolean {
  if (input.hasCompletedWriteEdit) return false;
  if (input.forcedWriteAttemptCount >= 2) return false;
  if (!isExplicitDeepSeekActionRequest(input.originalPrompt)) return false;
  return (
    input.round >= WARN_ROUND ||
    input.duplicateCount >= MAX_DUPLICATE_TOOLS ||
    input.consecutiveNoProgress >= MAX_NO_PROGRESS_ROUNDS
  );
}

function isSuccessfulWriteOrEditResult(toolName: string, resultContent: string): boolean {
  if (toolName !== 'Write' && toolName !== 'Edit') return false;
  return /(?:Write|Edit) 已应用/.test(resultContent);
}

function getWriteEditTools(tools: DeepSeekToolDefinition[]): DeepSeekToolDefinition[] {
  return tools.filter((tool) => WRITE_EDIT_TOOL_NAMES.has(tool.function.name));
}

/**
 * Strip DSML protocol tokens from text content.
 * Uses a carry-over buffer to handle tokens that span delta boundaries.
 */
function stripDSML(input: string, carryOver: string): { clean: string; carryOver: string } {
  const combined = carryOver + input;
  // Remove complete DSML tokens
  const clean = combined.replace(DSML_COMPLETE, '');
  // Check if there's a partial DSML token at the end
  const partialMatch = clean.match(DSML_PARTIAL_END);
  if (partialMatch && partialMatch.index !== undefined) {
    const carry = clean.slice(partialMatch.index);
    return { clean: clean.slice(0, partialMatch.index), carryOver: carry };
  }
  return { clean, carryOver: '' };
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
  let dsmlCarryOver = '';       // handles DSML tokens that span delta boundaries
  let dsmlToolCallBuffer: string | null = null;

  const appendDSMLFallbackToolCalls = (text: string): void => {
    for (const call of parseDeepSeekDSMLToolCalls(text)) {
      const index = toolCallsByIndex.size;
      toolCallsByIndex.set(index, { ...call, id: `dsml-${index}` });
    }
  };

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
        dsmlCarryOver = '';

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

      // Buffer text content (with DSML stripping)
      if (delta.content) {
        let visibleText = dsmlCarryOver + delta.content;
        dsmlCarryOver = '';
        if (dsmlToolCallBuffer !== null) {
          dsmlToolCallBuffer += visibleText;
          const endIndex = normalizeDeepSeekDSML(dsmlToolCallBuffer).indexOf(DEEPSEEK_DSML_TOOL_CALLS_END);
          if (endIndex === -1) {
            continue;
          }
          appendDSMLFallbackToolCalls(dsmlToolCallBuffer);
          const normalizedBuffer = normalizeDeepSeekDSML(dsmlToolCallBuffer);
          visibleText = normalizedBuffer.slice(endIndex + DEEPSEEK_DSML_TOOL_CALLS_END.length);
          dsmlToolCallBuffer = null;
        }

        const normalizedVisibleText = normalizeDeepSeekDSML(visibleText);
        const dsmlStartIndex = normalizedVisibleText.indexOf(DEEPSEEK_DSML_TOOL_CALLS_START);
        if (dsmlStartIndex !== -1) {
          const beforeDSML = normalizedVisibleText.slice(0, dsmlStartIndex);
          const dsmlAndAfter = normalizedVisibleText.slice(dsmlStartIndex);
          const dsmlEndIndex = dsmlAndAfter.indexOf(DEEPSEEK_DSML_TOOL_CALLS_END);

          textBuffer += stripDeepSeekDSMLToolCallBlocks(beforeDSML);
          if (textBuffer) {
            accumulatedText += textBuffer;
            yield { type: 'text', content: textBuffer };
            textBuffer = '';
          }

          if (dsmlEndIndex === -1) {
            dsmlToolCallBuffer = dsmlAndAfter;
            continue;
          }

          const dsmlBlockEnd = dsmlEndIndex + DEEPSEEK_DSML_TOOL_CALLS_END.length;
          appendDSMLFallbackToolCalls(dsmlAndAfter.slice(0, dsmlBlockEnd));
          visibleText = dsmlAndAfter.slice(dsmlBlockEnd);
        }

        const { clean, carryOver: newCarry } = stripDSML(visibleText, dsmlCarryOver);
        dsmlCarryOver = newCarry;
        textBuffer += stripDeepSeekDSMLToolCallBlocks(clean);

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
  private readonly mcpManager: McpServerManager | undefined;
  private activeAbortController: AbortController | null = null;
  private readonly readyStateListeners = new Set<(ready: boolean) => void>();
  private approvalCallback: ApprovalCallback | null = null;
  private transactionLog = new TransactionLog();
  /** Session-level approval memory: toolName/riskCategory → approved. Cleared on resetSession. */
  private approvalMemory = new Map<string, boolean>();
  constructor(plugin: CodianPlugin, mcpManager?: McpServerManager) {
    this.plugin = plugin;
    this.mcpManager = mcpManager;
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

    return base.trim() + '\n\n' + getDeepSeekToolsSystemPromptSection(this.plugin.settings.enableDeepSeekBash);
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
    tools?: DeepSeekToolDefinition[],
  ): AsyncGenerator<StreamChunk, StreamResult> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const signal = this.activeAbortController?.signal;
    if (!signal) {
      throw new Error('DeepSeek query cancelled — no active AbortController.');
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
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

    const result = yield* consumeSSEToResult(response, signal);
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

    // Enumerate MCP tools (read-only only) and merge with built-in tools
    let mcpTools: DeepSeekToolDefinition[] = [];
    if (this.mcpManager) {
      try {
        const servers = this.mcpManager.getServers();
        console.debug(`[Codian MCP] discovering tools from ${servers.length} servers`);
        mcpTools = await enumerateMcpToolsForDeepSeek(this.mcpManager);
        console.debug(`[Codian MCP] discovery complete: ${mcpTools.length} read-only tools`);
      } catch (err) {
        console.warn('[Codian MCP] discovery failed:', err instanceof Error ? err.message : String(err));
      }
    }
    const allTools = [
      ...DEEPSEEK_P1_TOOLS,
      ...(this.plugin.settings.enableDeepSeekBash ? [DEEPSEEK_BASH_TOOL] : []),
      ...mcpTools,
    ];

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
      let hasCompletedWriteEdit = false;
      let forcedExecutionContinuationCount = 0;
      let forcedWriteAttemptCount = 0;
      let toolsForNextRound = allTools;

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
          const toolsForThisRound = toolsForNextRound;
          toolsForNextRound = allTools;
          const gen = this.streamAPICall(baseUrl, config, messages, toolsForThisRound);
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
          if (shouldForceDeepSeekExecutionContinuation({
            originalPrompt: prompt,
            responseText: result.accumulatedText,
            hasCompletedWriteEdit,
            forcedContinuationCount: forcedExecutionContinuationCount,
          })) {
            forcedExecutionContinuationCount++;
            messages.push({
              role: 'assistant',
              content: result.accumulatedText || null,
            });
            messages.push({
              role: 'user',
              content:
                '[System: The user already asked you to execute this task. Do not ask for confirmation, do not end with a plan, and do not summarize next steps. If you have enough information, call Write or Edit now in this response. If exact file content is missing, call Read first, then Write or Edit. Only state missing information if the task is impossible.]',
            });
            continue;
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
            const execContext: ToolExecutionContext = {
              plugin: this.plugin,
              requestApproval: async (toolName, description, input, options) => {
                // Session-level auto-approval for low-risk tools (Write, Edit, Undo, read-only MCP)
                const category = getApprovalCategory(toolName);
                if (category && this.approvalMemory.has(category)) {
                  return this.approvalMemory.get(category)!;
                }

                if (!this.approvalCallback) {
                  console.warn('[Codian] approval denied: no callback registered for', toolName);
                  return false;
                }
                const decision = await this.approvalCallback(toolName, input, description, options);
                console.debug('[Codian] approval for', toolName, ':', decision);
                const approved = decision === 'allow' || decision === 'allow-always';
                // Remember for this session if approved and category is low-risk
                if (approved && category) {
                  this.approvalMemory.set(category, true);
                }
                return approved;
              },
              transactionLog: this.transactionLog,
              recoveryJournal: this.plugin.storage.recovery,
              mcpManager: this.mcpManager,
              abortSignal: this.activeAbortController.signal,
            };
            resultContent = await executeDeepSeekToolCall(
              { id: tc.id, name: tc.function.name, arguments: tcArgs },
              execContext,
            );
          } catch (error) {
            resultContent = `Tool execution error: ${error instanceof Error ? error.message : String(error)}`;
          }

          if (isSuccessfulWriteOrEditResult(tc.function.name, resultContent)) {
            hasCompletedWriteEdit = true;
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
          if (shouldForceDeepSeekWriteAfterToolRounds({
            originalPrompt: prompt,
            hasCompletedWriteEdit,
            forcedWriteAttemptCount,
            round,
            duplicateCount,
            consecutiveNoProgress,
          })) {
            forcedWriteAttemptCount++;
            toolsForNextRound = getWriteEditTools(allTools);
            messages.push({
              role: 'user',
              content:
                '[System: You have gathered enough context for this explicit update/write task. Do not call Read, Grep, Bash, Skill, or any read-only tool now. Do not answer with a status sentence. You must call Write or Edit in the next response. If you cannot safely edit because an exact old_string is missing, call Write with the full updated file content instead.]',
            });
            continue;
          }

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
            const finalGen = this.streamAPICall(baseUrl, config, messages /* no tools */);
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

  resetSession(): void {
    this.approvalMemory.clear();
    this.transactionLog = new TransactionLog();
  }
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

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }
  setApprovalDismisser(_dismisser: (() => void) | null): void {}
  setAskUserQuestionCallback(_callback: ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, string> | null>) | null): void {}
  setExitPlanModeCallback(_callback: ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> | null) | null): void {}
  setPermissionModeSyncCallback(_callback: ((sdkMode: string) => void) | null): void {}
  setSubagentHookProvider(_getState: () => unknown): void {}
  setAutoTurnCallback(_callback: ((chunks: StreamChunk[]) => void) | null): void {}
}
