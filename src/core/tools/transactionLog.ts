/**
 * TransactionLog for DeepSeekRuntime Write/Edit/Undo.
 * Stores pre-action snapshots and action metadata for undo support.
 * In-memory only (not persisted across sessions).
 */

import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

export interface ToolActionEntry {
  id: string;
  timestamp: number;
  toolName: 'Write' | 'Edit';
  filePath: string; // vault-relative
  action: 'create' | 'overwrite' | 'modify';
  snapshotContent: string | null; // null = file was newly created
  newContent: string;
  reverted: boolean;
}

function generateEntryId(): string {
  return `txn-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export class TransactionLog {
  private entries: ToolActionEntry[] = [];
  private snapshotDir: string;

  constructor() {
    this.snapshotDir = path.join(os.tmpdir(), 'codian-snapshots');
  }

  private async ensureSnapshotDir(): Promise<void> {
    await fs.mkdir(this.snapshotDir, { recursive: true });
  }

  /** Save pre-action content as a snapshot file. Returns the file path. */
  async saveSnapshot(entryId: string, content: string | null): Promise<string | null> {
    if (content === null) return null;
    await this.ensureSnapshotDir();
    const filePath = path.join(this.snapshotDir, `${entryId}.snap`);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  /** Read a snapshot back from disk. */
  async readSnapshot(snapshotPath: string | null): Promise<string | null> {
    if (!snapshotPath) return null;
    try {
      return await fs.readFile(snapshotPath, 'utf8');
    } catch {
      return null;
    }
  }

  /** Record a new action entry. Returns the entry. */
  async record(
    toolName: 'Write' | 'Edit',
    filePath: string,
    action: 'create' | 'overwrite' | 'modify',
    snapshotContent: string | null,
    newContent: string,
  ): Promise<ToolActionEntry> {
    const entry: ToolActionEntry = {
      id: generateEntryId(),
      timestamp: Date.now(),
      toolName,
      filePath,
      action,
      snapshotContent,
      newContent,
      reverted: false,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Get the most recent non-reverted entry. */
  getLastNonReverted(): ToolActionEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (!this.entries[i].reverted) return this.entries[i];
    }
    return undefined;
  }

  /** Mark an entry as reverted. */
  markReverted(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) entry.reverted = true;
  }

  /** Get all entries (for diagnostics). */
  getAll(): ReadonlyArray<ToolActionEntry> {
    return this.entries;
  }

  /** Clear all entries and snapshots. */
  async clear(): Promise<void> {
    for (const entry of this.entries) {
      try {
        const snapPath = path.join(this.snapshotDir, `${entry.id}.snap`);
        await fs.unlink(snapPath);
      } catch {
        // ignore
      }
    }
    this.entries = [];
  }
}
