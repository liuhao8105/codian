/** Codex session history loader and runtime result helpers. */

import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { CodexSessionIndex } from '../core/runtime/CodexSessionIndex';
import type { AsyncSubagentStatus, ChatMessage, ImageAttachment } from '../core/types';
import { extractContentBeforeXmlContext } from './context';

interface CodexSessionEntry {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface CodexSessionReadResult {
  entries: CodexSessionEntry[];
  skippedLines: number;
  error?: string;
}

export interface RuntimeSessionLoadResult {
  messages: ChatMessage[];
  skippedLines: number;
  error?: string;
}

function getCodexSessionsPath(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

let codexSessionIndex: CodexSessionIndex | null = null;
let codexSessionIndexRoot: string | null = null;

function getCodexSessionIndex(): CodexSessionIndex {
  const root = getCodexSessionsPath();
  if (!codexSessionIndex || codexSessionIndexRoot !== root) {
    codexSessionIndex = new CodexSessionIndex(root);
    codexSessionIndexRoot = root;
  }
  return codexSessionIndex;
}

function findCodexSessionPathSync(sessionId: string): string | null {
  return getCodexSessionIndex().findSync(sessionId);
}

async function findCodexSessionPath(sessionId: string): Promise<string | null> {
  return getCodexSessionIndex().find(sessionId);
}

export function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || sessionId.length > 128) return false;
  if (sessionId.includes('..') || sessionId.includes('/') || sessionId.includes('\\')) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(sessionId);
}

export function runtimeSessionExists(_vaultPath: string, sessionId: string): boolean {
  return isValidSessionId(sessionId) && !!findCodexSessionPathSync(sessionId);
}

export async function deleteRuntimeSession(_vaultPath: string, sessionId: string): Promise<void> {
  if (!isValidSessionId(sessionId)) return;

  try {
    const sessionPath = await findCodexSessionPath(sessionId);
    if (sessionPath && existsSync(sessionPath)) {
      await fs.unlink(sessionPath);
      getCodexSessionIndex().invalidate();
    }
  } catch {
    // Best-effort deletion.
  }
}

async function readCodexSession(sessionId: string): Promise<CodexSessionReadResult> {
  try {
    const sessionPath = await findCodexSessionPath(sessionId);
    if (!sessionPath || !existsSync(sessionPath)) {
      return { entries: [], skippedLines: 0 };
    }

    const content = await fs.readFile(sessionPath, 'utf8');
    const entries: CodexSessionEntry[] = [];
    let skippedLines = 0;

    for (const line of content.split('\n').filter(value => value.trim())) {
      try {
        entries.push(JSON.parse(line) as CodexSessionEntry);
      } catch {
        skippedLines++;
      }
    }
    return { entries, skippedLines };
  } catch (error) {
    return {
      entries: [],
      skippedLines: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseTimestamp(timestamp: string | undefined): number {
  if (!timestamp) return Date.now();
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function extractCurrentNote(text: string): string | undefined {
  const match = text.match(/<current_note>\n([\s\S]*?)\n<\/current_note>/);
  return match?.[1]?.trim() || undefined;
}

async function loadLocalImages(
  localImages: unknown,
  timestamp: number,
): Promise<ImageAttachment[] | undefined> {
  if (!Array.isArray(localImages) || localImages.length === 0) return undefined;

  const attachments: ImageAttachment[] = [];
  for (let index = 0; index < localImages.length; index++) {
    const item = localImages[index];
    const imagePath = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && typeof (item as { path?: unknown }).path === 'string'
        ? (item as { path: string }).path
        : null;
    if (!imagePath) continue;

    const extension = path.extname(imagePath).toLowerCase();
    const mediaType = extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.png'
        ? 'image/png'
        : extension === '.gif'
          ? 'image/gif'
          : extension === '.webp'
            ? 'image/webp'
            : null;
    if (!mediaType) continue;

    try {
      const buffer = await fs.readFile(imagePath);
      const stat = await fs.stat(imagePath);
      attachments.push({
        id: `codex-image-${timestamp}-${index}`,
        name: path.basename(imagePath),
        mediaType,
        data: buffer.toString('base64'),
        size: stat.size,
        source: 'file',
      });
    } catch {
      // Text history remains usable when a referenced image is unavailable.
    }
  }
  return attachments.length > 0 ? attachments : undefined;
}

function mergeAssistantMessage(target: ChatMessage, source: ChatMessage): void {
  if (!source.content) return;
  target.content = target.content ? `${target.content}\n\n${source.content}` : source.content;
}

export async function loadRuntimeSessionMessages(
  _vaultPath: string,
  sessionId: string,
  _resumeSessionAt?: string,
): Promise<RuntimeSessionLoadResult> {
  if (!isValidSessionId(sessionId)) {
    return { messages: [], skippedLines: 0 };
  }

  const result = await readCodexSession(sessionId);
  if (result.error) {
    return { messages: [], skippedLines: result.skippedLines, error: result.error };
  }

  const messages: ChatMessage[] = [];
  let pendingAssistant: ChatMessage | null = null;

  for (let index = 0; index < result.entries.length; index++) {
    const entry = result.entries[index];
    if (entry.type !== 'event_msg' || !entry.payload) continue;

    const payloadType = typeof entry.payload.type === 'string' ? entry.payload.type : '';
    const timestamp = parseTimestamp(entry.timestamp);
    let message: ChatMessage | null = null;

    if (payloadType === 'user_message') {
      const content = typeof entry.payload.message === 'string'
        ? entry.payload.message.trim()
        : '';
      if (!content) continue;
      message = {
        id: `codex-user-${sessionId}-${index}`,
        role: 'user',
        content,
        displayContent: extractContentBeforeXmlContext(content) ?? content,
        timestamp,
        currentNote: extractCurrentNote(content),
        images: await loadLocalImages(entry.payload.local_images, timestamp),
      };
    } else if (payloadType === 'agent_message') {
      const content = typeof entry.payload.message === 'string'
        ? entry.payload.message.trim()
        : '';
      if (!content) continue;
      message = {
        id: `codex-assistant-${sessionId}-${index}`,
        role: 'assistant',
        content,
        timestamp,
      };
    }

    if (!message) continue;
    if (message.role === 'assistant') {
      if (pendingAssistant) mergeAssistantMessage(pendingAssistant, message);
      else pendingAssistant = message;
      continue;
    }

    if (pendingAssistant) {
      messages.push(pendingAssistant);
      pendingAssistant = null;
    }
    messages.push(message);
  }

  if (pendingAssistant) messages.push(pendingAssistant);
  messages.sort((left, right) => left.timestamp - right.timestamp);
  return { messages, skippedLines: result.skippedLines };
}

export function extractAgentIdFromToolUseResult(toolUseResult: unknown): string | null {
  if (!toolUseResult || typeof toolUseResult !== 'object') return null;
  const record = toolUseResult as Record<string, unknown>;
  const directAgentId = record.agentId ?? record.agent_id;
  if (typeof directAgentId === 'string' && directAgentId.length > 0) return directAgentId;

  const data = record.data;
  if (data && typeof data === 'object') {
    const nested = data as Record<string, unknown>;
    const nestedAgentId = nested.agent_id ?? nested.agentId;
    if (typeof nestedAgentId === 'string' && nestedAgentId.length > 0) return nestedAgentId;
  }
  return null;
}

export type ResolvedAsyncStatus = Exclude<AsyncSubagentStatus, 'pending'>;

export function resolveToolUseResultStatus(
  toolUseResult: unknown,
  fallbackStatus: ResolvedAsyncStatus,
): ResolvedAsyncStatus {
  if (!toolUseResult || typeof toolUseResult !== 'object') return fallbackStatus;
  const record = toolUseResult as Record<string, unknown>;
  const rawStatus = record.retrieval_status ?? record.status;
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';

  if (status === 'error') return 'error';
  if (status === 'completed' || status === 'success') return 'completed';
  if (record.isAsync === true || status === 'async_launched') return 'running';
  return fallbackStatus;
}

export function extractXmlTag(content: string, tagName: string): string | null {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`));
  return match?.[1]?.trim() ?? null;
}
