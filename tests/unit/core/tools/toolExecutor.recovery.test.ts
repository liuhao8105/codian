import type { RecoveryJournal } from '@/core/storage/RecoveryJournal';
import { hashRecoveryContent } from '@/core/storage/RecoveryJournal';
import { executeDeepSeekToolCall, type ToolExecutionContext } from '@/core/tools/toolExecutor';
import { TransactionLog } from '@/core/tools/transactionLog';
import type CodianPlugin from '@/main';

function createRecoveryContext(currentContent = 'before'): {
  context: ToolExecutionContext;
  modify: jest.Mock;
  requestApproval: jest.Mock;
  recovery: jest.Mocked<RecoveryJournal>;
} {
  const file = { path: 'note.md' };
  let content = currentContent;
  const modify = jest.fn(async (_file, nextContent: string) => {
    content = nextContent;
  });
  const requestApproval = jest.fn(async () => true);
  const recovery = {
    prepare: jest.fn(async (toolName, filePath, action, snapshotContent, newContent) => ({
      id: 'recovery-1',
      timestamp: 1,
      toolName,
      filePath,
      action,
      snapshotContent,
      newContentHash: hashRecoveryContent(newContent),
      state: 'pending' as const,
    })),
    markApplied: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
    markReverted: jest.fn(async () => undefined),
    getLastRecoverable: jest.fn(async () => undefined),
    getAll: jest.fn(async () => []),
  } as unknown as jest.Mocked<RecoveryJournal>;
  const plugin = {
    app: {
      vault: {
        adapter: { basePath: '/vault' },
        getFileByPath: jest.fn((candidate: string) => candidate === 'note.md' ? file : null),
        cachedRead: jest.fn(async () => content),
        modify,
        trash: jest.fn(async () => undefined),
        create: jest.fn(async () => file),
        createFolder: jest.fn(async () => undefined),
        getFolderByPath: jest.fn(() => ({})),
      },
    },
  } as unknown as CodianPlugin;

  return {
    context: {
      plugin,
      requestApproval,
      transactionLog: new TransactionLog(),
      recoveryJournal: recovery,
    },
    modify,
    requestApproval,
    recovery,
  };
}

describe('DeepSeek persistent recovery integration', () => {
  it('persists a pending snapshot before applying Write and then marks it applied', async () => {
    const { context, modify, recovery } = createRecoveryContext();
    const order: string[] = [];
    recovery.prepare.mockImplementation(async (...args) => {
      order.push('prepare');
      return {
        id: 'recovery-1',
        timestamp: 1,
        toolName: args[0],
        filePath: args[1],
        action: args[2],
        snapshotContent: args[3],
        newContentHash: hashRecoveryContent(args[4]),
        state: 'pending',
      };
    });
    modify.mockImplementation(async () => {
      order.push('modify');
    });
    recovery.markApplied.mockImplementation(async () => {
      order.push('applied');
    });

    const result = await executeDeepSeekToolCall(
      { id: 'write-1', name: 'Write', arguments: { file_path: 'note.md', content: 'after' } },
      context,
    );

    expect(result).toContain('Write 已应用');
    expect(order).toEqual(['prepare', 'modify', 'applied']);
    expect(recovery.prepare).toHaveBeenCalledWith(
      'Write',
      'note.md',
      'overwrite',
      'before',
      'after',
    );
  });

  it('does not modify a file when the persistent snapshot cannot be created', async () => {
    const { context, modify, recovery } = createRecoveryContext();
    recovery.prepare.mockRejectedValue(new Error('journal full'));

    const result = await executeDeepSeekToolCall(
      {
        id: 'edit-1',
        name: 'Edit',
        arguments: { file_path: 'note.md', old_string: 'before', new_string: 'after' },
      },
      context,
    );

    expect(result).toContain('Edit 已中止');
    expect(modify).not.toHaveBeenCalled();
  });

  it('restores a persisted action after runtime memory has been reset', async () => {
    const { context, modify, recovery } = createRecoveryContext('after');
    recovery.getLastRecoverable.mockResolvedValue({
      id: 'recovery-older-runtime',
      timestamp: 1,
      toolName: 'Edit',
      filePath: 'note.md',
      action: 'modify',
      snapshotContent: 'before',
      newContentHash: hashRecoveryContent('after'),
      state: 'applied',
    });

    const result = await executeDeepSeekToolCall(
      { id: 'undo-1', name: 'Undo', arguments: {} },
      context,
    );

    expect(result).toContain('Undo 完成');
    expect(modify).toHaveBeenCalledWith(expect.anything(), 'before');
    expect(recovery.markReverted).toHaveBeenCalledWith('recovery-older-runtime');
  });

  it('refuses Undo when the file changed after the recorded action', async () => {
    const { context, modify, requestApproval, recovery } = createRecoveryContext('later change');
    recovery.getLastRecoverable.mockResolvedValue({
      id: 'recovery-conflict',
      timestamp: 1,
      toolName: 'Edit',
      filePath: 'note.md',
      action: 'modify',
      snapshotContent: 'before',
      newContentHash: hashRecoveryContent('after'),
      state: 'applied',
    });

    const result = await executeDeepSeekToolCall(
      { id: 'undo-1', name: 'Undo', arguments: {} },
      context,
    );

    expect(result).toContain('在该操作后又发生了变化');
    expect(requestApproval).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
    expect(recovery.markReverted).not.toHaveBeenCalled();
  });
});
