import {
  MAX_RECOVERY_SNAPSHOT_BYTES,
  RECOVERY_JOURNAL_PATH,
  RecoveryJournal,
} from '@/core/storage/RecoveryJournal';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

function createAdapter(initial: Record<string, string> = {}): {
  adapter: VaultFileAdapter;
  files: Map<string, string>;
  restored: string[];
} {
  const files = new Map(Object.entries(initial));
  const restored: string[] = [];
  const adapter = {
    exists: jest.fn(async (candidate: string) => files.has(candidate)),
    read: jest.fn(async (candidate: string) => {
      const content = files.get(candidate);
      if (content === undefined) throw new Error(`Missing ${candidate}`);
      return content;
    }),
    write: jest.fn(async (candidate: string, content: string) => {
      files.set(candidate, content);
    }),
    restoreFromBackup: jest.fn(async (candidate: string, content: string) => {
      files.set(candidate, content);
      restored.push(candidate);
    }),
  } as unknown as VaultFileAdapter;
  return { adapter, files, restored };
}

describe('RecoveryJournal', () => {
  it('persists pending state before marking an action applied', async () => {
    const { adapter, files } = createAdapter();
    const journal = new RecoveryJournal(adapter);

    const entry = await journal.prepare('Write', 'note.md', 'overwrite', 'before', 'after');
    let persisted = JSON.parse(files.get(RECOVERY_JOURNAL_PATH)!);
    expect(persisted.entries[0]).toMatchObject({
      id: entry.id,
      filePath: 'note.md',
      snapshotContent: 'before',
      state: 'pending',
    });

    await journal.markApplied(entry.id);
    persisted = JSON.parse(files.get(RECOVERY_JOURNAL_PATH)!);
    expect(persisted.entries[0].state).toBe('applied');
  });

  it('loads the newest recoverable action after a new instance is created', async () => {
    const { adapter } = createAdapter();
    const first = new RecoveryJournal(adapter);
    await first.prepare('Edit', 'note.md', 'modify', 'before', 'after');

    const restarted = new RecoveryJournal(adapter);
    expect(await restarted.getLastRecoverable()).toMatchObject({
      toolName: 'Edit',
      filePath: 'note.md',
      snapshotContent: 'before',
      state: 'pending',
    });
  });

  it('does not return reverted or failed actions as recoverable', async () => {
    const { adapter } = createAdapter();
    const journal = new RecoveryJournal(adapter);
    const failed = await journal.prepare('Write', 'failed.md', 'create', null, 'new');
    await journal.markFailed(failed.id);
    const reverted = await journal.prepare('Edit', 'done.md', 'modify', 'old', 'new');
    await journal.markReverted(reverted.id);

    expect(await journal.getLastRecoverable()).toBeUndefined();
  });

  it('refuses a snapshot larger than the hard limit before any write', async () => {
    const { adapter, files } = createAdapter();
    const journal = new RecoveryJournal(adapter);
    const oversized = 'x'.repeat(MAX_RECOVERY_SNAPSHOT_BYTES + 1);

    await expect(
      journal.prepare('Edit', 'huge.md', 'modify', oversized, 'new'),
    ).rejects.toThrow('恢复快照超过');
    expect(files.has(RECOVERY_JOURNAL_PATH)).toBe(false);
  });

  it('refuses to discard active recovery records when the entry limit is reached', async () => {
    const { adapter } = createAdapter();
    const journal = new RecoveryJournal(adapter);
    for (let index = 0; index < 50; index += 1) {
      await journal.prepare('Write', `note-${index}.md`, 'create', null, 'new');
    }

    await expect(
      journal.prepare('Write', 'overflow.md', 'create', null, 'new'),
    ).rejects.toThrow('50 条待恢复记录');
    expect(await journal.getAll()).toHaveLength(50);
  });

  it('restores a valid backup when the primary journal is corrupt', async () => {
    const backup = JSON.stringify({
      version: 1,
      entries: [{
        id: 'recovery-1',
        timestamp: 1,
        toolName: 'Write',
        filePath: 'note.md',
        action: 'overwrite',
        snapshotContent: 'old',
        newContentHash: 'hash',
        state: 'applied',
      }],
    });
    const { adapter, restored } = createAdapter({
      [RECOVERY_JOURNAL_PATH]: '{broken',
      [`${RECOVERY_JOURNAL_PATH}.bak`]: backup,
    });
    const journal = new RecoveryJournal(adapter);

    expect(await journal.getLastRecoverable()).toMatchObject({ filePath: 'note.md' });
    expect(restored).toEqual([RECOVERY_JOURNAL_PATH]);
  });
});
