import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface VaultRootMigrationOptions {
  vaultRoot: string;
  sourceName: string;
  destinationName: string;
  receiptName: string;
}

export interface VaultRootMigrationResult {
  status: 'migrated' | 'already-migrated' | 'not-needed';
  fileCount: number;
  totalBytes: number;
  digest: string;
}

interface ManifestEntry {
  relativePath: string;
  size: number;
  sha256: string;
}

interface MigrationReceipt {
  version: 1;
  fileCount: number;
  totalBytes: number;
  digest: string;
}

function isExcludedSourcePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  if (normalized === '.git' || normalized.startsWith('.git/')) return true;
  if (
    normalized === '.claude-plugin' ||
    normalized.startsWith('.claude-plugin/')
  ) return true;
  return !normalized.includes('/') && normalized.startsWith('claudian-settings.json');
}

function moveKey(
  data: Record<string, unknown>,
  sourceKey: string,
  destinationKey: string,
): void {
  if (!(sourceKey in data)) return;
  if (
    destinationKey in data &&
    JSON.stringify(data[sourceKey]) !== JSON.stringify(data[destinationKey])
  ) {
    throw new Error(`settings conflict: ${destinationKey}`);
  }
  data[destinationKey] = data[sourceKey];
  delete data[sourceKey];
}

function transformPluginOwnedContent(
  relativePath: string,
  content: Buffer,
): Buffer {
  const normalized = relativePath.split(path.sep).join('/');
  const basename = path.posix.basename(normalized);
  if (basename.startsWith('codian-settings.json')) {
    const settings = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
    moveKey(settings, 'claudeCliPath', 'codexCliPath');
    moveKey(settings, 'claudeCliPathsByHost', 'codexCliPathsByHost');
    moveKey(settings, 'lastClaudeModel', 'lastCodexModel');
    delete settings.loadUserClaudeSettings;
    delete settings.enableChrome;
    return Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  if (normalized === 'mcp.json') {
    const mcp = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
    moveKey(mcp, '_claudian', '_codian');
    return Buffer.from(`${JSON.stringify(mcp, null, 2)}\n`, 'utf8');
  }

  return content;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function collectManifest(
  root: string,
  receiptName?: string,
  transformSource = false,
): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];

  async function walk(directory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.relative(root, absolutePath);
      if (transformSource && isExcludedSourcePath(relativePath)) continue;
      const stat = await fs.lstat(absolutePath);

      if (stat.isSymbolicLink()) {
        const target = Buffer.from(await fs.readlink(absolutePath), 'utf8');
        entries.push({
          relativePath,
          size: target.length,
          sha256: createHash('sha256').update(target).digest('hex'),
        });
        continue;
      }
      if (stat.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`unsupported entry: ${relativePath}`);
      }
      if (relativePath === receiptName) continue;

      const originalContent = await fs.readFile(absolutePath);
      const content = transformSource
        ? transformPluginOwnedContent(relativePath, originalContent)
        : originalContent;
      entries.push({
        relativePath,
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  }

  await walk(root);
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function summarize(entries: ManifestEntry[]): Omit<VaultRootMigrationResult, 'status'> {
  const digestInput = entries
    .map(entry => `${entry.relativePath}\0${entry.size}\0${entry.sha256}\n`)
    .join('');
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    digest: createHash('sha256').update(digestInput).digest('hex'),
  };
}

async function copyTree(
  source: string,
  destination: string,
  sourceRoot = source,
): Promise<void> {
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error('source root must be a directory');
  }

  await fs.mkdir(destination, { recursive: false, mode: sourceStat.mode });
  const children = await fs.readdir(source, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));

  for (const child of children) {
    const sourcePath = path.join(source, child.name);
    const destinationPath = path.join(destination, child.name);
    const relativePath = path.relative(sourceRoot, sourcePath);
    if (isExcludedSourcePath(relativePath)) continue;
    const stat = await fs.lstat(sourcePath);

    if (stat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(sourcePath), destinationPath);
      continue;
    }
    if (stat.isDirectory()) {
      await copyTree(sourcePath, destinationPath, sourceRoot);
      await fs.utimes(destinationPath, stat.atime, stat.mtime);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`unsupported entry: ${path.relative(source, sourcePath)}`);
    }

    const originalContent = await fs.readFile(sourcePath);
    const content = transformPluginOwnedContent(relativePath, originalContent);
    await fs.writeFile(destinationPath, content);
    await fs.chmod(destinationPath, stat.mode);
    await fs.utimes(destinationPath, stat.atime, stat.mtime);
  }
}

function sameSummary(
  left: Omit<VaultRootMigrationResult, 'status'>,
  right: Omit<VaultRootMigrationResult, 'status'>,
): boolean {
  return left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    left.digest === right.digest;
}

export async function migrateVaultRoot(
  options: VaultRootMigrationOptions,
): Promise<VaultRootMigrationResult> {
  const source = path.join(options.vaultRoot, options.sourceName);
  const destination = path.join(options.vaultRoot, options.destinationName);

  if (!(await pathExists(source))) {
    return { status: 'not-needed', fileCount: 0, totalBytes: 0, digest: '' };
  }

  const sourceSummary = summarize(await collectManifest(source, undefined, true));
  if (await pathExists(destination)) {
    const receiptPath = path.join(destination, options.receiptName);
    try {
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')) as MigrationReceipt;
      const destinationSummary = summarize(
        await collectManifest(destination, options.receiptName),
      );
      if (
        receipt.version === 1 &&
        sameSummary(receipt, sourceSummary) &&
        sameSummary(destinationSummary, sourceSummary)
      ) {
        return { status: 'already-migrated', ...sourceSummary };
      }
    } catch {
      // A missing or malformed receipt is a destination conflict.
    }
    throw new Error('destination conflict: existing destination is not a verified copy');
  }

  const staging = `${destination}.migrating-${randomUUID()}`;
  try {
    await copyTree(source, staging);
    const stagingSummary = summarize(await collectManifest(staging));
    if (!sameSummary(stagingSummary, sourceSummary)) {
      throw new Error('migration verification failed');
    }

    const receipt: MigrationReceipt = { version: 1, ...sourceSummary };
    await fs.writeFile(
      path.join(staging, options.receiptName),
      `${JSON.stringify(receipt, null, 2)}\n`,
      'utf8',
    );
    await fs.rename(staging, destination);
    return { status: 'migrated', ...sourceSummary };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
