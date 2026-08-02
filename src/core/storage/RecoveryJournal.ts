import { createHash } from 'crypto';

import type { VaultFileAdapter } from './VaultFileAdapter';

export const RECOVERY_JOURNAL_PATH = '.codian/recovery-journal.json';
export const MAX_RECOVERY_SNAPSHOT_BYTES = 1024 * 1024;
export const MAX_RECOVERY_JOURNAL_BYTES = 8 * 1024 * 1024;
export const MAX_RECOVERY_ENTRIES = 50;

export type RecoveryState = 'pending' | 'applied' | 'reverted' | 'failed';

export interface RecoveryJournalEntry {
  id: string;
  timestamp: number;
  toolName: 'Write' | 'Edit';
  filePath: string;
  action: 'create' | 'overwrite' | 'modify';
  snapshotContent: string | null;
  newContentHash: string;
  state: RecoveryState;
}

interface RecoveryJournalDocument {
  version: 1;
  entries: RecoveryJournalEntry[];
}

function isRecoveryEntry(value: unknown): value is RecoveryJournalEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<RecoveryJournalEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.timestamp === 'number' &&
    (entry.toolName === 'Write' || entry.toolName === 'Edit') &&
    typeof entry.filePath === 'string' &&
    (entry.action === 'create' || entry.action === 'overwrite' || entry.action === 'modify') &&
    (entry.snapshotContent === null || typeof entry.snapshotContent === 'string') &&
    typeof entry.newContentHash === 'string' &&
    (
      entry.state === 'pending' ||
      entry.state === 'applied' ||
      entry.state === 'reverted' ||
      entry.state === 'failed'
    )
  );
}

function parseDocument(raw: string): RecoveryJournalDocument | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryJournalDocument>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return null;
    if (!parsed.entries.every(isRecoveryEntry)) return null;
    return { version: 1, entries: parsed.entries };
  } catch {
    return null;
  }
}

function generateRecoveryId(): string {
  return `recovery-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function hashRecoveryContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isTerminal(entry: RecoveryJournalEntry): boolean {
  return entry.state === 'reverted' || entry.state === 'failed';
}

/**
 * Persistent, local recovery metadata for user-approved DeepSeek writes.
 *
 * The journal stores only the pre-write snapshot and a hash of the new
 * content. It never restores files automatically.
 */
export class RecoveryJournal {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: VaultFileAdapter) {}

  prepare(
    toolName: 'Write' | 'Edit',
    filePath: string,
    action: 'create' | 'overwrite' | 'modify',
    snapshotContent: string | null,
    newContent: string,
  ): Promise<RecoveryJournalEntry> {
    return this.exclusive(async () => {
      if (
        snapshotContent !== null &&
        Buffer.byteLength(snapshotContent, 'utf8') > MAX_RECOVERY_SNAPSHOT_BYTES
      ) {
        throw new Error(
          `恢复快照超过 ${MAX_RECOVERY_SNAPSHOT_BYTES} bytes 安全上限，写入已中止。`,
        );
      }

      const document = await this.load();
      const entry: RecoveryJournalEntry = {
        id: generateRecoveryId(),
        timestamp: Date.now(),
        toolName,
        filePath,
        action,
        snapshotContent,
        newContentHash: hashRecoveryContent(newContent),
        state: 'pending',
      };
      document.entries.push(entry);
      await this.saveWithinBounds(document);
      return entry;
    });
  }

  markApplied(id: string): Promise<void> {
    return this.updateState(id, 'applied');
  }

  markReverted(id: string): Promise<void> {
    return this.updateState(id, 'reverted');
  }

  markFailed(id: string): Promise<void> {
    return this.updateState(id, 'failed');
  }

  getLastRecoverable(): Promise<RecoveryJournalEntry | undefined> {
    return this.exclusive(async () => {
      const entries = (await this.load()).entries;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].state === 'pending' || entries[index].state === 'applied') {
          return { ...entries[index] };
        }
      }
      return undefined;
    });
  }

  getAll(): Promise<ReadonlyArray<RecoveryJournalEntry>> {
    return this.exclusive(async () => (await this.load()).entries.map(entry => ({ ...entry })));
  }

  private updateState(id: string, state: RecoveryState): Promise<void> {
    return this.exclusive(async () => {
      const document = await this.load();
      const entry = document.entries.find(candidate => candidate.id === id);
      if (!entry) throw new Error(`Recovery entry not found: ${id}`);
      entry.state = state;
      await this.saveWithinBounds(document);
    });
  }

  private async load(): Promise<RecoveryJournalDocument> {
    const primaryExists = await this.adapter.exists(RECOVERY_JOURNAL_PATH);
    if (primaryExists) {
      const primary = parseDocument(await this.adapter.read(RECOVERY_JOURNAL_PATH));
      if (primary) return primary;
    }

    const backupPath = `${RECOVERY_JOURNAL_PATH}.bak`;
    if (await this.adapter.exists(backupPath)) {
      const backupRaw = await this.adapter.read(backupPath);
      const backup = parseDocument(backupRaw);
      if (backup) {
        await this.adapter.restoreFromBackup(RECOVERY_JOURNAL_PATH, backupRaw);
        return backup;
      }
    }

    if (primaryExists) {
      throw new Error('恢复日志及其备份均已损坏；为避免覆盖可恢复数据，写入已中止。');
    }
    return { version: 1, entries: [] };
  }

  private async saveWithinBounds(document: RecoveryJournalDocument): Promise<void> {
    while (document.entries.length > MAX_RECOVERY_ENTRIES) {
      const terminalIndex = document.entries.findIndex(isTerminal);
      if (terminalIndex < 0) {
        throw new Error(`已有 ${MAX_RECOVERY_ENTRIES} 条待恢复记录；请先使用 Undo 清理。`);
      }
      document.entries.splice(terminalIndex, 1);
    }

    let serialized = JSON.stringify(document, null, 2);
    while (Buffer.byteLength(serialized, 'utf8') > MAX_RECOVERY_JOURNAL_BYTES) {
      const terminalIndex = document.entries.findIndex(isTerminal);
      if (terminalIndex < 0) {
        throw new Error('恢复日志已达到 8 MiB 安全上限；请先使用 Undo 清理。');
      }
      document.entries.splice(terminalIndex, 1);
      serialized = JSON.stringify(document, null, 2);
    }

    await this.adapter.write(RECOVERY_JOURNAL_PATH, serialized);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
