/**
 * Chat and conversation type definitions.
 */

import type { RuntimeToolUseResult } from './diff';
import type { SubagentInfo, SubagentMode, ToolCallInfo } from './tools';

/** Fork origin reference: identifies the source session and resume point. */
export interface ForkSource {
  sessionId: string;
  resumeAt: string;
}

/** View type identifier for Obsidian. */
export const VIEW_TYPE_CODIAN = 'codian-view';

/** Supported image media types for attachments. */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Image attachment metadata. */
export interface ImageAttachment {
  id: string;
  name: string;
  mediaType: ImageMediaType;
  /** Base64 encoded image data - single source of truth. */
  data: string;
  width?: number;
  height?: number;
  size: number;
  source: 'file' | 'paste' | 'drop';
}

/** Content block for preserving streaming order in messages. */
export type ContentBlock =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolId: string }
  | { type: 'thinking'; content: string; durationSeconds?: number }
  | {
      type: 'plan';
      blockId: string;
      explanation?: string | null;
      steps: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>;
    }
  | {
      type: 'command';
      blockId: string;
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number;
      status: 'running' | 'completed' | 'error';
    }
  | { type: 'subagent'; subagentId: string; mode?: SubagentMode }
  | { type: 'compact_boundary' };

/** Chat message with content, tool calls, and attachments. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Display-only content (e.g., "/tests" when content is the expanded prompt). */
  displayContent?: string;
  timestamp: number;
  toolCalls?: ToolCallInfo[];
  contentBlocks?: ContentBlock[];
  currentNote?: string;
  images?: ImageAttachment[];
  /** True if this message represents a user interrupt (from Runtime storage). */
  isInterrupt?: boolean;
  /** True if this message is rebuilt context sent to Runtime on session reset (should be hidden). */
  isRebuiltContext?: boolean;
  /** Duration in seconds from user send to response completion. */
  durationSeconds?: number;
  /** Flavor word used for duration display (e.g., "Baked", "Cooked"). */
  durationFlavorWord?: string;
  /** Runtime user message UUID for rewind. */
  runtimeUserUuid?: string;
  /** Runtime assistant message UUID for resumeSessionAt. */
  runtimeAssistantUuid?: string;
}

/** Persisted conversation with messages and session state. */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Timestamp when the last agent response completed. */
  lastResponseAt?: number;
  sessionId: string | null;
  /**
   * Current Runtime session ID for native sessions.
   * May differ from sessionId when Runtime creates a new session (session expired, API key changed).
   * Used for loading messages from Runtime storage. Falls back to sessionId if not set.
   */
  runtimeSessionId?: string;
  /**
   * Previous Runtime session IDs from session rebuilds.
   * When resume fails and Runtime creates a new session, the old runtimeSessionId is moved here.
   * Used to load and merge messages from all session files for display.
   */
  previousRuntimeSessionIds?: string[];
  messages: ChatMessage[];
  currentNote?: string;
  attachedFiles?: string[];
  /** Session-specific external context paths (directories with full access). Resets on new session. */
  externalContextPaths?: string[];
  /** Context window usage information. */
  usage?: UsageInfo;
  /** Status of AI title generation. */
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
  /** UI-enabled MCP servers for this session (context-saving servers activated via selector). */
  enabledMcpServers?: string[];
  /** True if this conversation is backed by a Codex session under ~/.codex/sessions/. */
  isNative?: boolean;
  /** Timestamp of the last legacy JSONL message (used to merge Runtime history). */
  legacyCutoffAt?: number;
  /** Internal flag to avoid reloading Runtime history repeatedly. */
  runtimeMessagesLoaded?: boolean;
  /**
   * Cached subagent data for Task tool operations.
   * Loaded from metadata for native sessions to restore tool count and status on reload.
   */
  subagentData?: Record<string, SubagentInfo>;
  /** Assistant UUID for resumeSessionAt after rewind. */
  resumeSessionAt?: string;
  /** Fork origin: source session to resume + fork from. Cleared after first Runtime session init. */
  forkSource?: ForkSource;
}

/** Lightweight conversation metadata for the history dropdown. */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Timestamp when the last agent response completed. */
  lastResponseAt?: number;
  messageCount: number;
  preview: string;
  /** Status of AI title generation. */
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
  /** True if this conversation uses Runtime-native storage. */
  isNative?: boolean;
}

/**
 * Session metadata overlay for Runtime-native storage.
 * Stored in vault/.codian/sessions/{id}.meta.json
 * Runtime handles message storage; this stores UI-only state.
 */
export interface SessionMetadata {
  id: string;
  title: string;
  titleGenerationStatus?: 'pending' | 'success' | 'failed';
  createdAt: number;
  updatedAt: number;
  lastResponseAt?: number;
  /** Session ID used for Runtime resume (may be cleared when invalidated). */
  sessionId?: string | null;
  /**
   * Current Runtime session ID. May differ from id when Runtime creates a new session.
   * Used to locate the correct Runtime session file for message loading.
   */
  runtimeSessionId?: string;
  /**
   * Previous Runtime session IDs from session rebuilds.
   * When resume fails and Runtime creates a new session, the old runtimeSessionId is moved here.
   * Used to load and merge messages from all session files for display.
   */
  previousRuntimeSessionIds?: string[];
  currentNote?: string;
  attachedFiles?: string[];
  externalContextPaths?: string[];
  enabledMcpServers?: string[];
  usage?: UsageInfo;
  /** Timestamp of the last legacy JSONL message (used to merge Runtime history). */
  legacyCutoffAt?: number;
  /**
   * Subagent data for Task tool operations.
   * Maps toolUseId to subagent info (tool count, status, result).
   * Stored here because Runtime session files don't preserve this Codian-specific data.
   */
  subagentData?: Record<string, SubagentInfo>;
  /** Assistant UUID for resumeSessionAt after rewind. */
  resumeSessionAt?: string;
  /** Fork origin: source session to resume + fork from. Cleared after first Runtime session init. */
  forkSource?: ForkSource;
}

/** Normalized stream chunk from the Codex Agent Runtime. */
export type StreamChunk =
  | { type: 'text'; content: string; parentToolUseId?: string | null }
  | { type: 'thinking'; content: string; parentToolUseId?: string | null }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; parentToolUseId?: string | null }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean; parentToolUseId?: string | null; toolUseResult?: RuntimeToolUseResult }
  | {
      type: 'plan_update';
      explanation?: string | null;
      steps: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>;
    }
  | {
      type: 'command_start';
      id: string;
      command: string;
      cwd?: string;
    }
  | {
      type: 'command_progress';
      id: string;
      delta: string;
    }
  | {
      type: 'command_complete';
      id: string;
      output: string;
      exitCode?: number;
      status: 'completed' | 'error';
    }
  | { type: 'error'; content: string }
  | { type: 'blocked'; content: string }
  | { type: 'done' }
  | { type: 'usage'; usage: UsageInfo; sessionId?: string | null }
  | { type: 'compact_boundary' }
  | { type: 'runtime_user_uuid'; uuid: string }
  | { type: 'runtime_user_sent'; uuid: string }
  | { type: 'runtime_assistant_uuid'; uuid: string };

/** Context window usage information. */
export interface UsageInfo {
  model?: string;
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextWindow: number;
  contextTokens: number;
  percentage: number;
}
