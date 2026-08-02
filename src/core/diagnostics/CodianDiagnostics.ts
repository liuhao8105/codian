import type CodianPlugin from '../../main';
import type { RecoveryState } from '../storage/RecoveryJournal';

const MAX_DIAGNOSTIC_SCAN_ENTRIES = 20_000;
const LARGE_STORAGE_BYTES = 512 * 1024 * 1024;
const LARGE_STORAGE_FILE_COUNT = 10_000;

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
  installation: {
    historicalBackupDirectories: number;
  };
  storage: {
    root: '.codian';
    codian: StorageTotals;
    migration: {
      status: 'verified' | 'not-needed' | 'unknown';
      fileCount: number;
    };
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
    const [secureStorage, codian, migration, recoveryEntries, historicalBackupDirectories] = await Promise.all([
      this.plugin.storage.getSecretStorageStatus(),
      this.scanCodianStorage(),
      this.readMigrationStatus(),
      this.plugin.storage.recovery.getAll(),
      this.countHistoricalPluginBackups(),
    ]);
    const recovery = countRecoveryStates(recoveryEntries.map(entry => entry.state));
    const warnings: string[] = [];

    if (!secureStorage.available) warnings.push('secure-storage-unavailable');
    if (secureStorage.stored && !secureStorage.readable) warnings.push('secure-record-unreadable');
    if (secureStorage.retainedLegacyPlaintext) warnings.push('legacy-plaintext-retained');
    if (codian.truncated) warnings.push('storage-scan-truncated');
    if (codian.bytes >= LARGE_STORAGE_BYTES) warnings.push('storage-large');
    if (codian.files >= LARGE_STORAGE_FILE_COUNT) warnings.push('storage-file-count-large');
    if (historicalBackupDirectories > 0) warnings.push('installed-backups-present');
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
      installation: {
        historicalBackupDirectories,
      },
      storage: {
        root: '.codian',
        codian,
        migration,
        recovery,
      },
      warnings,
    };
  }

  private async readMigrationStatus(): Promise<CodianDiagnosticsSnapshot['storage']['migration']> {
    const adapter = this.plugin.app.vault.adapter;
    const receiptPath = '.codian/.migration-receipt.json';
    try {
      if (await adapter.exists(receiptPath)) {
        const receipt = JSON.parse(await adapter.read(receiptPath)) as { fileCount?: unknown };
        return {
          status: 'verified',
          fileCount: typeof receipt.fileCount === 'number' ? receipt.fileCount : 0,
        };
      }
      return {
        status: await adapter.exists('.codian') ? 'not-needed' : 'unknown',
        fileCount: 0,
      };
    } catch {
      return { status: 'unknown', fileCount: 0 };
    }
  }

  private async scanCodianStorage(): Promise<StorageTotals> {
    const adapter = this.plugin.app.vault.adapter;
    try {
      if (!(await adapter.exists('.codian'))) return emptyStorageTotals();

      const totals = emptyStorageTotals();
      const folders = ['.codian'];
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

  private async countHistoricalPluginBackups(): Promise<number> {
    const adapter = this.plugin.app.vault.adapter;
    const pluginDirectory = '.obsidian/plugins/codian';
    try {
      if (!(await adapter.exists(pluginDirectory))) return 0;
      const listing = await adapter.list(pluginDirectory);
      return listing.folders.filter((folder) => {
        const normalized = folder.replace(/\\/g, '/');
        return normalized.slice(normalized.lastIndexOf('/') + 1).startsWith('.backup-');
      }).length;
    } catch {
      return 0;
    }
  }
}
