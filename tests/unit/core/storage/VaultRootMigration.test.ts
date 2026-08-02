import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import {
  migrateVaultRoot,
  type VaultRootMigrationOptions,
} from '@/core/storage/VaultRootMigration';

interface FileSnapshot {
  size: number;
  sha256: string;
}

describe('migrateVaultRoot', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(path.join(tmpdir(), 'codian-root-migration-'));
  });

  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  function options(): VaultRootMigrationOptions {
    return {
      vaultRoot,
      sourceName: '.claude',
      destinationName: '.codian',
      receiptName: '.migration-receipt.json',
    };
  }

  async function write(relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(vaultRoot, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
  }

  async function exists(relativePath: string): Promise<boolean> {
    try {
      await fs.lstat(path.join(vaultRoot, relativePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async function snapshot(relativeRoot: string): Promise<Record<string, FileSnapshot>> {
    const root = path.join(vaultRoot, relativeRoot);
    const result: Record<string, FileSnapshot> = {};

    async function walk(directory: string): Promise<void> {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const relativePath = path.relative(root, absolutePath);
        if (relativePath === '.migration-receipt.json') continue;
        const content = await fs.readFile(absolutePath);
        result[relativePath] = {
          size: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
        };
      }
    }

    await walk(root);
    return result;
  }

  it('copies nested regular files and proves byte parity', async () => {
    await write('.claude/notes/info.txt', '{"provider":"codex"}');
    await write('.claude/skills/example/SKILL.md', 'user payload');

    const sourceBefore = await snapshot('.claude');
    const result = await migrateVaultRoot(options());

    expect(result).toMatchObject({
      status: 'migrated',
      fileCount: 2,
      totalBytes: 32,
    });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await snapshot('.codian')).toEqual(sourceBefore);
    expect(await fs.readFile(path.join(vaultRoot, '.claude/skills/example/SKILL.md'), 'utf8'))
      .toBe('user payload');
  });

  it('rejects a non-identical destination conflict without changing source', async () => {
    await write('.claude/data.txt', 'source');
    await write('.codian/data.txt', 'different');
    const sourceBefore = await snapshot('.claude');

    await expect(migrateVaultRoot(options())).rejects.toThrow('destination conflict');

    expect(await snapshot('.claude')).toEqual(sourceBefore);
    expect(await fs.readFile(path.join(vaultRoot, '.codian/data.txt'), 'utf8'))
      .toBe('different');
  });

  it('preserves symbolic links without following their targets', async () => {
    await write('outside.txt', 'outside');
    await fs.mkdir(path.join(vaultRoot, '.claude'), { recursive: true });
    await fs.symlink(
      path.join(vaultRoot, 'outside.txt'),
      path.join(vaultRoot, '.claude/link'),
    );

    await expect(migrateVaultRoot(options())).resolves.toMatchObject({
      status: 'migrated',
      fileCount: 1,
    });

    expect(await fs.readlink(path.join(vaultRoot, '.codian/link')))
      .toBe(path.join(vaultRoot, 'outside.txt'));
    expect(await fs.readFile(path.join(vaultRoot, 'outside.txt'), 'utf8')).toBe('outside');
  });

  it('returns not-needed when the source directory does not exist', async () => {
    await expect(migrateVaultRoot(options())).resolves.toEqual({
      status: 'not-needed',
      fileCount: 0,
      totalBytes: 0,
      digest: '',
    });
  });

  it('returns already-migrated when the verified receipt matches the source', async () => {
    await write('.claude/skills/example/SKILL.md', 'user payload');
    const first = await migrateVaultRoot(options());

    await expect(migrateVaultRoot(options())).resolves.toEqual({
      ...first,
      status: 'already-migrated',
    });
  });

  it('keeps user payloads but excludes retired repository and plugin metadata', async () => {
    await write('.claude/skills/example/SKILL.md', 'user payload');
    await write('.claude/.git/config', 'repository metadata');
    await write('.claude/.claude-plugin/plugin.json', '{"name":"legacy"}');
    await write('.claude/claudian-settings.json.bak', '{"legacy":true}');

    await migrateVaultRoot(options());

    expect(await fs.readFile(
      path.join(vaultRoot, '.codian/skills/example/SKILL.md'),
      'utf8',
    )).toBe('user payload');
    expect(await exists('.codian/.git')).toBe(false);
    expect(await exists('.codian/.claude-plugin')).toBe(false);
    expect(await exists('.codian/claudian-settings.json.bak')).toBe(false);
  });

  it('renames plugin-owned settings keys and removes retired compatibility switches', async () => {
    await write('.claude/codian-settings.json', JSON.stringify({
      claudeCliPath: '/Applications/Codex.app/Contents/Resources/codex',
      claudeCliPathsByHost: { workstation: '/usr/local/bin/codex' },
      lastClaudeModel: 'gpt-5.6-sol',
      loadUserClaudeSettings: true,
      enableChrome: true,
      currentProvider: 'codex',
    }));

    await migrateVaultRoot(options());

    const migrated = JSON.parse(await fs.readFile(
      path.join(vaultRoot, '.codian/codian-settings.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(migrated).toEqual({
      codexCliPath: '/Applications/Codex.app/Contents/Resources/codex',
      codexCliPathsByHost: { workstation: '/usr/local/bin/codex' },
      lastCodexModel: 'gpt-5.6-sol',
      currentProvider: 'codex',
    });
  });

  it('renames only the plugin metadata key in MCP configuration', async () => {
    await write('.claude/mcp.json', JSON.stringify({
      _claudian: { contextSavingMode: true },
      mcpServers: { github: { command: 'github-mcp-server' } },
    }));

    await migrateVaultRoot(options());

    const migrated = JSON.parse(await fs.readFile(
      path.join(vaultRoot, '.codian/mcp.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(migrated).toEqual({
      _codian: { contextSavingMode: true },
      mcpServers: { github: { command: 'github-mcp-server' } },
    });
  });
});
