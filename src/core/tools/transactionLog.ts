/**
 * TransactionLog for DeepSeekRuntime Write/Edit/Undo.
 * Stores pre-action snapshots and action metadata for undo support.
 * In-memory only (not persisted across sessions).
 */

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
  /** Maximum entries before pruning. Oldest reverted entries are pruned first. */
  private static readonly MAX_ENTRIES = 50;

  /** Record a new action entry. Auto-prunes oldest reverted entries if over limit. */
  record(
    toolName: 'Write' | 'Edit',
    filePath: string,
    action: 'create' | 'overwrite' | 'modify',
    snapshotContent: string | null,
    newContent: string,
  ): ToolActionEntry {
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

    // Prune if over max: remove oldest reverted first, then oldest non-reverted
    while (this.entries.length > TransactionLog.MAX_ENTRIES) {
      const oldestReverted = this.entries.findIndex((e) => e.reverted);
      if (oldestReverted >= 0) {
        this.entries.splice(oldestReverted, 1);
      } else {
        this.entries.shift(); // no reverted entries — drop oldest
      }
    }

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

}
