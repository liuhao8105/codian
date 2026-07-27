import type { RewindFilesResult } from '@anthropic-ai/claude-agent-sdk';

import {
  InstructionRefineService,
  type RefineProgressCallback,
} from '../../features/chat/services/InstructionRefineService';
import {
  type TitleGenerationCallback,
  type TitleGenerationResult,
  TitleGenerationService,
} from '../../features/chat/services/TitleGenerationService';
import type CodianPlugin from '../../main';
import type { ApprovalCallback, ApprovalCallbackOptions, QueryOptions } from '../agent';
import type { SubagentHookState } from '../hooks';
import type { McpServerManager } from '../mcp';
import type {
  ChatMessage,
  Conversation,
  ExitPlanModeCallback,
  ImageAttachment,
  SlashCommand,
  StreamChunk,
} from '../types';
import type { InstructionRefineResult } from '../types/settings';
import { CodexAgentRuntime } from './CodexAgentRuntime';
import { DeepSeekRuntime } from './DeepSeekRuntime';

export interface AgentRuntime {
  onReadyStateChange(listener: (ready: boolean) => void): () => void;
  setPendingResumeAt(uuid: string | undefined): void;
  applyForkState(conv: Pick<Conversation, 'sessionId' | 'sdkSessionId' | 'forkSource'>): string | null;
  reloadMcpServers(): Promise<void>;
  ensureReady(options?: {
    sessionId?: string;
    externalContextPaths?: string[];
    force?: boolean;
    preserveHandlers?: boolean;
  }): Promise<boolean>;
  closePersistentQuery(reason?: string): void;
  query(
    prompt: string,
    images?: ImageAttachment[],
    conversationHistory?: ChatMessage[],
    queryOptions?: QueryOptions
  ): AsyncGenerator<StreamChunk>;
  cancel(): void;
  resetSession(): void;
  getSessionId(): string | null;
  consumeSessionInvalidation(): boolean;
  isReady(): boolean;
  getSupportedCommands(): Promise<SlashCommand[]>;
  setSessionId(id: string | null, externalContextPaths?: string[]): void;
  cleanup(): void;
  rewindFiles(sdkUserUuid: string, dryRun?: boolean): Promise<RewindFilesResult>;
  rewind(sdkUserUuid: string, sdkAssistantUuid: string): Promise<RewindFilesResult>;
  setApprovalCallback(callback: ApprovalCallback | null): void;
  setApprovalDismisser(dismisser: (() => void) | null): void;
  setAskUserQuestionCallback(
    callback: ((input: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, string> | null>) | null
  ): void;
  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void;
  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void;
  setSubagentHookProvider(getState: () => SubagentHookState): void;
  setAutoTurnCallback(callback: ((chunks: StreamChunk[]) => void) | null): void;
}

export interface InstructionRuntime {
  resetConversation(): void;
  refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult>;
  continueConversation(
    message: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult>;
  cancel(): void;
}

export interface TitleRuntime {
  generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback
  ): Promise<void>;
  cancel(): void;
}

export type {
  ApprovalCallback,
  ApprovalCallbackOptions,
  QueryOptions,
  RefineProgressCallback,
  TitleGenerationCallback,
  TitleGenerationResult,
};

export function createAgentRuntime(plugin: CodianPlugin, mcpManager: McpServerManager): AgentRuntime {
  if (plugin.settings.currentProvider === 'deepseek') {
    return new DeepSeekRuntime(plugin, mcpManager);
  }
  return new CodexAgentRuntime(plugin, mcpManager);
}

export function createInstructionRuntime(plugin: CodianPlugin): InstructionRuntime {
  return new InstructionRefineService(plugin);
}

export function createTitleRuntime(plugin: CodianPlugin): TitleRuntime {
  return new TitleGenerationService(plugin);
}
