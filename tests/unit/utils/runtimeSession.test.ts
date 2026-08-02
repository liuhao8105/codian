import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';

const mockFindSync = jest.fn<string | null, [string]>();
const mockFind = jest.fn<Promise<string | null>, [string]>();
const mockInvalidate = jest.fn<void, []>();

jest.mock('@/core/runtime/CodexSessionIndex', () => ({
  CodexSessionIndex: jest.fn().mockImplementation(() => ({
    findSync: mockFindSync,
    find: mockFind,
    invalidate: mockInvalidate,
  })),
}));
jest.mock('fs', () => ({ existsSync: jest.fn() }));
jest.mock('fs/promises');

import {
  deleteRuntimeSession,
  extractAgentIdFromToolUseResult,
  extractXmlTag,
  isValidSessionId,
  loadRuntimeSessionMessages,
  resolveToolUseResultStatus,
  runtimeSessionExists,
} from '@/utils/runtimeSession';

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockFsPromises = fsPromises as jest.Mocked<typeof fsPromises>;

describe('runtimeSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isValidSessionId', () => {
    it('accepts normal IDs and rejects traversal or separators', () => {
      expect(isValidSessionId('session-123_abc')).toBe(true);
      expect(isValidSessionId('')).toBe(false);
      expect(isValidSessionId('../etc/passwd')).toBe(false);
      expect(isValidSessionId('session/subdir')).toBe(false);
      expect(isValidSessionId('session\\subdir')).toBe(false);
      expect(isValidSessionId('a'.repeat(129))).toBe(false);
    });
  });

  describe('runtimeSessionExists', () => {
    it('uses only the Codex session index', () => {
      mockFindSync.mockReturnValue('/sessions/rollout-session-1.jsonl');
      expect(runtimeSessionExists('/vault', 'session-1')).toBe(true);
      expect(mockFindSync).toHaveBeenCalledWith('session-1');
    });

    it('does not search invalid IDs', () => {
      expect(runtimeSessionExists('/vault', '../bad')).toBe(false);
      expect(mockFindSync).not.toHaveBeenCalled();
    });
  });

  describe('deleteRuntimeSession', () => {
    it('deletes an indexed Codex session and invalidates the index', async () => {
      mockFind.mockResolvedValue('/sessions/rollout-session-1.jsonl');
      mockExistsSync.mockReturnValue(true);

      await deleteRuntimeSession('/vault', 'session-1');

      expect(mockFsPromises.unlink).toHaveBeenCalledWith('/sessions/rollout-session-1.jsonl');
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
    });

    it('is best effort for missing and invalid sessions', async () => {
      mockFind.mockResolvedValue(null);
      await expect(deleteRuntimeSession('/vault', 'missing')).resolves.toBeUndefined();
      await expect(deleteRuntimeSession('/vault', '../bad')).resolves.toBeUndefined();
      expect(mockFsPromises.unlink).not.toHaveBeenCalled();
    });
  });

  describe('loadRuntimeSessionMessages', () => {
    it('loads Codex user and assistant events and merges adjacent assistant text', async () => {
      mockFind.mockResolvedValue('/sessions/rollout-session-1.jsonl');
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockResolvedValue([
        JSON.stringify({
          timestamp: '2026-08-02T08:00:00Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'hello\n<current_note>\nNotes/test.md\n</current_note>',
          },
        }),
        JSON.stringify({
          timestamp: '2026-08-02T08:00:01Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'first' },
        }),
        JSON.stringify({
          timestamp: '2026-08-02T08:00:02Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'second' },
        }),
        '{broken',
      ].join('\n'));

      const result = await loadRuntimeSessionMessages('/vault', 'session-1');

      expect(result.skippedLines).toBe(1);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toMatchObject({
        role: 'user',
        displayContent: 'hello\n<current_note>\nNotes/test.md\n</current_note>',
        currentNote: 'Notes/test.md',
      });
      expect(result.messages[1]).toMatchObject({
        role: 'assistant',
        content: 'first\n\nsecond',
      });
    });

    it('returns an empty result for a missing or invalid session', async () => {
      mockFind.mockResolvedValue(null);
      expect(await loadRuntimeSessionMessages('/vault', 'missing')).toEqual({
        messages: [],
        skippedLines: 0,
      });
      expect(await loadRuntimeSessionMessages('/vault', '../bad')).toEqual({
        messages: [],
        skippedLines: 0,
      });
    });

    it('returns read failures without throwing', async () => {
      mockFind.mockResolvedValue('/sessions/rollout-session-err.jsonl');
      mockExistsSync.mockReturnValue(true);
      mockFsPromises.readFile.mockRejectedValue(new Error('disk error'));

      const result = await loadRuntimeSessionMessages('/vault', 'session-err');

      expect(result.messages).toEqual([]);
      expect(result.error).toBe('disk error');
    });
  });

  describe('runtime result helpers', () => {
    it('extracts direct and nested agent IDs', () => {
      expect(extractAgentIdFromToolUseResult({ agentId: 'agent-1' })).toBe('agent-1');
      expect(extractAgentIdFromToolUseResult({ data: { agent_id: 'agent-2' } })).toBe('agent-2');
      expect(extractAgentIdFromToolUseResult({})).toBeNull();
    });

    it('normalizes async statuses', () => {
      expect(resolveToolUseResultStatus({ status: 'success' }, 'error')).toBe('completed');
      expect(resolveToolUseResultStatus({ isAsync: true }, 'error')).toBe('running');
      expect(resolveToolUseResultStatus(undefined, 'orphaned')).toBe('orphaned');
    });

    it('extracts XML payload fields safely', () => {
      expect(extractXmlTag('<result> done </result>', 'result')).toBe('done');
      expect(extractXmlTag('<result>done</result>', 'missing')).toBeNull();
    });
  });
});
