/**
 * VaultFileAdapter - Wrapper around Obsidian Vault API for file operations.
 *
 * Provides a consistent interface for file operations using Obsidian's
 * vault adapter instead of Node's fs module.
 */

import type { App } from 'obsidian';

export class VaultFileAdapter {
  private writeQueue: Promise<void> = Promise.resolve();
  private writeSequence = 0;

  constructor(private app: App) {}

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  async read(path: string): Promise<string> {
    return this.app.vault.adapter.read(path);
  }

  async write(path: string, content: string): Promise<void> {
    return this.enqueueWrite(() => this.writeAtomically(path, content));
  }

  /**
   * Restore a validated backup without replacing that backup with the corrupt
   * primary file. The caller is responsible for validating `content`.
   */
  async restoreFromBackup(path: string, content: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await this.ensureParentFolder(path);
      const sequence = this.writeSequence++;
      const temporaryPath = `${path}.restore-${Date.now()}-${sequence}`;

      try {
        await this.app.vault.adapter.write(temporaryPath, content);
        const staged = await this.app.vault.adapter.read(temporaryPath);
        if (staged !== content) {
          throw new Error(`Failed to verify restored content for ${path}`);
        }

        if (await this.exists(path)) {
          await this.app.vault.adapter.remove(path);
        }
        await this.app.vault.adapter.rename(temporaryPath, path);

        const persisted = await this.app.vault.adapter.read(path);
        if (persisted !== content) {
          throw new Error(`Failed to verify restored file for ${path}`);
        }
      } finally {
        if (await this.exists(temporaryPath)) {
          await this.app.vault.adapter.remove(temporaryPath);
        }
      }
    });
  }

  async append(path: string, content: string): Promise<void> {
    await this.ensureParentFolder(path);
    await this.enqueueWrite(async () => {
      if (await this.exists(path)) {
        const existing = await this.read(path);
        await this.writeAtomically(path, existing + content);
      } else {
        await this.writeAtomically(path, content);
      }
    });
  }

  async delete(path: string): Promise<void> {
    if (await this.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }

  /** Fails silently if non-empty or missing. */
  async deleteFolder(path: string): Promise<void> {
    try {
      if (await this.exists(path)) {
        await this.app.vault.adapter.rmdir(path, false);
      }
    } catch {
      // Non-critical: directory may not be empty
    }
  }

  async listFiles(folder: string): Promise<string[]> {
    if (!(await this.exists(folder))) {
      return [];
    }
    const listing = await this.app.vault.adapter.list(folder);
    return listing.files;
  }

  /** List subfolders in a folder. Returns relative paths from the folder. */
  async listFolders(folder: string): Promise<string[]> {
    if (!(await this.exists(folder))) {
      return [];
    }
    const listing = await this.app.vault.adapter.list(folder);
    return listing.folders;
  }

  /** Recursively list all files in a folder and subfolders. */
  async listFilesRecursive(folder: string): Promise<string[]> {
    const allFiles: string[] = [];

    const processFolder = async (currentFolder: string) => {
      if (!(await this.exists(currentFolder))) return;

      const listing = await this.app.vault.adapter.list(currentFolder);
      allFiles.push(...listing.files);

      for (const subfolder of listing.folders) {
        await processFolder(subfolder);
      }
    };

    await processFolder(folder);
    return allFiles;
  }

  private async ensureParentFolder(filePath: string): Promise<void> {
    const folder = filePath.substring(0, filePath.lastIndexOf('/'));
    if (folder && !(await this.exists(folder))) {
      await this.ensureFolder(folder);
    }
  }

  /** Ensure a folder exists, creating it and parent folders if needed. */
  async ensureFolder(path: string): Promise<void> {
    if (await this.exists(path)) return;

    // Create parent folders recursively
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  /** Rename/move a file. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.app.vault.adapter.rename(oldPath, newPath);
  }

  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    try {
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat) return null;
      return { mtime: stat.mtime, size: stat.size };
    } catch {
      return null;
    }
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.catch(() => {
      // Keep later writes usable while preserving this operation's rejection.
    });
    return result;
  }

  private async writeAtomically(path: string, content: string): Promise<void> {
    await this.ensureParentFolder(path);
    const sequence = this.writeSequence++;
    const temporaryPath = `${path}.tmp-${Date.now()}-${sequence}`;
    const backupPath = `${path}.bak`;
    const hadTarget = await this.exists(path);

    try {
      await this.app.vault.adapter.write(temporaryPath, content);
      const staged = await this.app.vault.adapter.read(temporaryPath);
      if (staged !== content) {
        throw new Error(`Failed to verify staged write for ${path}`);
      }

      if (hadTarget) {
        if (await this.exists(backupPath)) {
          await this.app.vault.adapter.remove(backupPath);
        }
        await this.app.vault.adapter.rename(path, backupPath);
      }

      try {
        await this.app.vault.adapter.rename(temporaryPath, path);
        const persisted = await this.app.vault.adapter.read(path);
        if (persisted !== content) {
          throw new Error(`Failed to verify persisted write for ${path}`);
        }
      } catch (error) {
        if (await this.exists(path)) {
          await this.app.vault.adapter.remove(path);
        }
        if (hadTarget && await this.exists(backupPath)) {
          await this.app.vault.adapter.rename(backupPath, path);
        }
        throw error;
      }
    } finally {
      if (await this.exists(temporaryPath)) {
        await this.app.vault.adapter.remove(temporaryPath);
      }
    }
  }
}
