import type { ChatMessage } from '../types';

export const MAX_HISTORY_CHARS = 80_000;
export const MAX_HISTORY_MESSAGE_CHARS = 20_000;
export const MAX_PROMPT_CHARS = 200_000;
export const MAX_TOOL_RESULT_CHARS = 50_000;
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_SSE_BUFFER_CHARS = 1024 * 1024;
export const MAX_STREAM_ACCUMULATED_CHARS = 1024 * 1024;

export function boundText(value: string, maxChars: number, label: string): string {
  if (value.length <= maxChars) return value;

  const suffix = `\n\n... (${label} truncated at ${maxChars} characters)`;
  if (suffix.length >= maxChars) {
    return suffix.slice(0, maxChars);
  }
  return value.slice(0, maxChars - suffix.length) + suffix;
}

export function boundConversationHistory(messages: ChatMessage[]): ChatMessage[] {
  const selected: ChatMessage[] = [];
  let totalChars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = boundText(message.content, MAX_HISTORY_MESSAGE_CHARS, 'history message');
    if (totalChars + content.length > MAX_HISTORY_CHARS) break;

    selected.unshift({ ...message, content });
    totalChars += content.length;
  }

  return selected;
}

export function assertPromptWithinLimit(prompt: string): void {
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`DeepSeek prompt exceeds ${MAX_PROMPT_CHARS} characters.`);
  }
}

export function assertSerializedRequestWithinLimit(body: unknown): void {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('DeepSeek request exceeds 2 MiB after serialization.');
  }
}
