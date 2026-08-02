import {
  assertPromptWithinLimit,
  assertSerializedRequestWithinLimit,
  boundConversationHistory,
  boundText,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_PROMPT_CHARS,
  MAX_REQUEST_BYTES,
  MAX_TOOL_RESULT_CHARS,
} from '@/core/runtime/deepseekLimits';
import type { ChatMessage } from '@/core/types';

function message(id: string, content: string, timestamp: number): ChatMessage {
  return {
    id,
    role: timestamp % 2 === 0 ? 'user' : 'assistant',
    content,
    timestamp,
  };
}

describe('DeepSeek request capacity boundaries', () => {
  it('bounds tool results while preserving an explicit truncation marker', () => {
    const bounded = boundText('x'.repeat(MAX_TOOL_RESULT_CHARS + 1), MAX_TOOL_RESULT_CHARS, 'tool result');

    expect(bounded.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(bounded).toContain('tool result truncated');
  });

  it('keeps the newest history within the total budget without mutating the input', () => {
    const history = Array.from({ length: 5 }, (_, index) =>
      message(`message-${index}`, `${index}:${'x'.repeat(MAX_HISTORY_MESSAGE_CHARS - 2)}`, index),
    );
    const originalContents = history.map((entry) => entry.content);

    const bounded = boundConversationHistory(history);

    expect(bounded.map((entry) => entry.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);
    expect(bounded.reduce((total, entry) => total + entry.content.length, 0)).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    expect(history.map((entry) => entry.content)).toEqual(originalContents);
  });

  it('bounds an individual history message with a visible marker', () => {
    const bounded = boundConversationHistory([
      message('large', 'y'.repeat(MAX_HISTORY_MESSAGE_CHARS + 100), 1),
    ]);

    expect(bounded).toHaveLength(1);
    expect(bounded[0].content.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGE_CHARS);
    expect(bounded[0].content).toContain('history message truncated');
  });

  it('rejects a current prompt above the hard limit instead of silently truncating it', () => {
    expect(() => assertPromptWithinLimit('p'.repeat(MAX_PROMPT_CHARS + 1)))
      .toThrow(`exceeds ${MAX_PROMPT_CHARS} characters`);
  });

  it('accepts a current prompt at the hard limit', () => {
    expect(() => assertPromptWithinLimit('p'.repeat(MAX_PROMPT_CHARS))).not.toThrow();
  });

  it('rejects a serialized request above two MiB', () => {
    const oversized = { input: 'r'.repeat(MAX_REQUEST_BYTES) };

    expect(() => assertSerializedRequestWithinLimit(oversized)).toThrow('exceeds 2 MiB');
  });

  it('accepts a small serialized request', () => {
    expect(() => assertSerializedRequestWithinLimit({ input: 'ok' })).not.toThrow();
  });
});
