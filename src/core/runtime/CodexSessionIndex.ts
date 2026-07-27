import { existsSync, readdirSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

export const DEFAULT_CODEX_SESSION_INDEX_LIMIT = 20_000;

export interface CodexSessionIndexEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface CodexSessionIndexFileSystem {
  existsSync(candidate: string): boolean;
  readDirSync(directoryPath: string): readonly CodexSessionIndexEntry[];
  readDir(directoryPath: string): Promise<readonly CodexSessionIndexEntry[]>;
}

export interface CodexSessionIndexStats {
  scanCount: number;
  visitedEntries: number;
  indexedFiles: number;
  truncated: boolean;
}

interface CodexSessionIndexOptions {
  fileSystem?: CodexSessionIndexFileSystem;
  maxVisitedEntries?: number;
}

const nodeFileSystem: CodexSessionIndexFileSystem = {
  existsSync,
  readDirSync(directoryPath) {
    return readdirSync(directoryPath, { withFileTypes: true });
  },
  async readDir(directoryPath) {
    return fs.readdir(directoryPath, { withFileTypes: true });
  },
};

/**
 * Bounded, reusable index for Codex JSONL sessions.
 *
 * A completed scan caches both successful and unsuccessful lookups. Call
 * invalidate() when an external operation may have created or removed sessions.
 */
export class CodexSessionIndex {
  private readonly fileSystem: CodexSessionIndexFileSystem;
  private readonly maxVisitedEntries: number;
  private indexedFiles: string[] | null = null;
  private readonly lookupCache = new Map<string, string | null>();
  private stats: CodexSessionIndexStats = {
    scanCount: 0,
    visitedEntries: 0,
    indexedFiles: 0,
    truncated: false,
  };

  constructor(
    private readonly root: string,
    options: CodexSessionIndexOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.maxVisitedEntries = Math.max(
      1,
      Math.floor(options.maxVisitedEntries ?? DEFAULT_CODEX_SESSION_INDEX_LIMIT),
    );
  }

  findSync(sessionId: string): string | null {
    const cached = this.getValidCachedPath(sessionId);
    if (cached.hit) return cached.path;

    if (!this.indexedFiles) this.scanSync();
    return this.resolveFromIndex(sessionId);
  }

  async find(sessionId: string): Promise<string | null> {
    const cached = this.getValidCachedPath(sessionId);
    if (cached.hit) return cached.path;

    if (!this.indexedFiles) await this.scan();
    return this.resolveFromIndex(sessionId);
  }

  invalidate(): void {
    this.indexedFiles = null;
    this.lookupCache.clear();
  }

  getStats(): Readonly<CodexSessionIndexStats> {
    return { ...this.stats };
  }

  private getValidCachedPath(sessionId: string): { hit: boolean; path: string | null } {
    if (!this.lookupCache.has(sessionId)) return { hit: false, path: null };

    const cached = this.lookupCache.get(sessionId) ?? null;
    if (!cached || this.safeExists(cached)) return { hit: true, path: cached };

    // The tree changed underneath us. Rebuild at most once for this lookup.
    this.invalidate();
    return { hit: false, path: null };
  }

  private resolveFromIndex(sessionId: string): string | null {
    const match =
      this.indexedFiles?.find(
        candidate => candidate.endsWith('.jsonl') && path.basename(candidate).includes(sessionId),
      ) ?? null;
    this.lookupCache.set(sessionId, match);
    return match;
  }

  private scanSync(): void {
    this.beginScan();
    if (!this.safeExists(this.root)) {
      this.finishScan([]);
      return;
    }

    const files: string[] = [];
    const directories = [this.root];
    while (directories.length > 0 && !this.stats.truncated) {
      const current = directories.shift()!;
      let entries: readonly CodexSessionIndexEntry[];
      try {
        entries = this.fileSystem.readDirSync(current);
      } catch {
        continue;
      }
      this.collectEntries(current, entries, directories, files);
    }
    this.finishScan(files);
  }

  private async scan(): Promise<void> {
    this.beginScan();
    if (!this.safeExists(this.root)) {
      this.finishScan([]);
      return;
    }

    const files: string[] = [];
    const directories = [this.root];
    while (directories.length > 0 && !this.stats.truncated) {
      const current = directories.shift()!;
      let entries: readonly CodexSessionIndexEntry[];
      try {
        entries = await this.fileSystem.readDir(current);
      } catch {
        continue;
      }
      this.collectEntries(current, entries, directories, files);
    }
    this.finishScan(files);
  }

  private beginScan(): void {
    this.lookupCache.clear();
    this.stats = {
      scanCount: this.stats.scanCount + 1,
      visitedEntries: 0,
      indexedFiles: 0,
      truncated: false,
    };
  }

  private collectEntries(
    current: string,
    entries: readonly CodexSessionIndexEntry[],
    directories: string[],
    files: string[],
  ): void {
    const sortedEntries = [...entries].sort((left, right) =>
      String(left.name).localeCompare(String(right.name)),
    );

    for (const entry of sortedEntries) {
      if (this.stats.visitedEntries >= this.maxVisitedEntries) {
        this.stats.truncated = true;
        break;
      }

      this.stats.visitedEntries += 1;
      const fullPath = path.join(current, String(entry.name));
      if (entry.isDirectory()) {
        directories.push(fullPath);
      } else if (entry.isFile() && String(entry.name).endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
    directories.sort((left, right) => left.localeCompare(right));
  }

  private finishScan(files: string[]): void {
    files.sort((left, right) => left.localeCompare(right));
    this.indexedFiles = files;
    this.stats.indexedFiles = files.length;
  }

  private safeExists(candidate: string): boolean {
    try {
      return this.fileSystem.existsSync(candidate);
    } catch {
      return false;
    }
  }
}
