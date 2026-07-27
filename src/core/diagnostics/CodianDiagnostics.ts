import type CodianPlugin from '../../main';
import type { RecoveryState } from '../storage/RecoveryJournal';

const MAX_DIAGNOSTIC_SCAN_ENTRIES = 20_000;

interface StorageTotals {
  files: number;
  bytes: number;
  truncated: boolean;
}

interface RecoveryTotals {
  total: number;
  pending: number;
  applied: number;
  reverted: number;
  failed: number;
}

export interface CodianDiagnosticsSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  plugin: {
    version: string;
  };
  runtime: {
    provider: string;
    permissionMode: string;
  };
  secureStorage: {
    available: boolean;
    stored: boolean;
    readable: boolean;
    retainedLegacyPlaintext: boolean;
  };
  storage: {
    claude: StorageTotals;
    recovery: RecoveryTotals;
  };
  warnings: string[];
}

function emptyStorageTotals(): StorageTotals {
  return { files: 0, bytes: 0, truncated: false };
}

function countRecoveryStates(states: RecoveryState[]): RecoveryTotals {
  return {
    total: states.length,
    pending: states.filter(state => state === 'pending').length,
    applied: states.filter(state => state === 'applied').length,
    reverted: states.filter(state => state === 'reverted').length,
    failed: states.filter(state => state === 'failed').length,
  };
}

/**
 * Builds a local, secret-free health snapshot. File paths and file contents are
 * deliberately discarded; only bounded aggregate counts and sizes are kept.
 */
export class CodianDiagnostics {
  constructor(private readonly plugin: CodianPlugin) {}

  async buildSnapshot(): Promise<CodianDiagnosticsSnapshot> {
    const [secureStorage, claude, recoveryEntries] = await Promise.all([
      this.plugin.storage.getSecretStorageStatus(),
      this.scanClaudeStorage(),
      this.plugin.storage.recovery.getAll(),
    ]);
    const recovery = countRecoveryStates(recoveryEntries.map(entry => entry.state));
    const warnings: string[] = [];

    if (!secureStorage.available) warnings.push('secure-storage-unavailable');
    if (secureStorage.stored && !secureStorage.readable) warnings.push('secure-record-unreadable');
    if (secureStorage.retainedLegacyPlaintext) warnings.push('legacy-plaintext-retained');
    if (claude.truncated) warnings.push('storage-scan-truncated');
    if (recovery.pending > 0) warnings.push('recovery-pending');

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      plugin: {
        version: this.plugin.manifest.version,
      },
      runtime: {
        provider: String(this.plugin.settings.currentProvider),
        permissionMode: String(this.plugin.settings.permissionMode),
      },
      secureStorage,
      storage: {
        claude,
        recovery,
      },
      warnings,
    };
  }

  private async scanClaudeStorage(): Promise<StorageTotals> {
    const adapter = this.plugin.app.vault.adapter;
    try {
      if (!(await adapter.exists('.claude'))) return emptyStorageTotals();

      const totals = emptyStorageTotals();
      const folders = ['.claude'];
      let visitedEntries = 0;

      while (folders.length > 0 && !totals.truncated) {
        const folder = folders.shift()!;
        const listing = await adapter.list(folder);
        const files = [...listing.files].sort();
        const childFolders = [...listing.folders].sort();

        for (const file of files) {
          if (visitedEntries >= MAX_DIAGNOSTIC_SCAN_ENTRIES) {
            totals.truncated = true;
            break;
          }
          visitedEntries += 1;
          totals.files += 1;
          const stat = await adapter.stat(file);
          if (stat && Number.isFinite(stat.size)) totals.bytes += Math.max(0, stat.size);
        }

        if (totals.truncated) break;
        for (const childFolder of childFolders) {
          if (visitedEntries >= MAX_DIAGNOSTIC_SCAN_ENTRIES) {
            totals.truncated = true;
            break;
          }
          visitedEntries += 1;
          folders.push(childFolder);
        }
        folders.sort();
      }

      return totals;
    } catch {
      return { ...emptyStorageTotals(), truncated: true };
    }
  }
}
