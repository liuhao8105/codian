import { CodianDiagnostics } from '@/core/diagnostics/CodianDiagnostics';
import type CodianPlugin from '@/main';

describe('CodianDiagnostics', () => {
  it('builds a bounded local snapshot without paths, usernames, or secrets', async () => {
    const secretPath = '/Users/private-person/Vault/.codian/sessions/session-1.jsonl';
    const plugin = {
      manifest: { version: '1.3.84-test' },
      settings: {
        currentProvider: 'deepseek',
        permissionMode: 'normal',
        providerConfigs: { deepseek: { apiKey: 'sk-private-value' } },
      },
      storage: {
        getSecretStorageStatus: jest.fn(async () => ({
          available: true,
          stored: true,
          readable: true,
          retainedLegacyPlaintext: false,
        })),
        recovery: {
          getAll: jest.fn(async () => [
            { state: 'pending' },
            { state: 'reverted' },
          ]),
        },
      },
      app: {
        vault: {
          adapter: {
            exists: jest.fn(async () => true),
            list: jest.fn(async (folder: string) => folder === '.codian'
              ? { files: [secretPath], folders: [] }
              : { files: [], folders: [] }),
            stat: jest.fn(async () => ({ type: 'file', ctime: 0, mtime: 0, size: 123 })),
          },
        },
      },
    } as unknown as CodianPlugin;

    const snapshot = await new CodianDiagnostics(plugin).buildSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      plugin: { version: '1.3.84-test' },
      runtime: { provider: 'deepseek', permissionMode: 'normal' },
      storage: {
        root: '.codian',
        codian: { files: 1, bytes: 123, truncated: false },
        recovery: { total: 2, pending: 1, reverted: 1 },
      },
    });
    expect(serialized).not.toContain('private-person');
    expect(serialized).not.toContain(secretPath);
    expect(serialized).not.toContain('sk-private-value');
  });

  it('emits machine-readable warnings when secure storage is unsafe', async () => {
    const plugin = {
      manifest: { version: 'test' },
      settings: { currentProvider: 'codex', permissionMode: 'normal' },
      storage: {
        getSecretStorageStatus: jest.fn(async () => ({
          available: false,
          stored: false,
          readable: false,
          retainedLegacyPlaintext: true,
        })),
        recovery: { getAll: jest.fn(async () => []) },
      },
      app: {
        vault: {
          adapter: {
            exists: jest.fn(async () => false),
            list: jest.fn(),
            stat: jest.fn(),
          },
        },
      },
    } as unknown as CodianPlugin;

    const snapshot = await new CodianDiagnostics(plugin).buildSnapshot();

    expect(snapshot.warnings).toEqual(
      expect.arrayContaining(['secure-storage-unavailable', 'legacy-plaintext-retained']),
    );
  });

  it('warns on large long-run storage and counts installed backup directories without exposing names', async () => {
    const files = Array.from({ length: 10_000 }, (_, index) => `.codian/item-${index}.json`);
    const privateBackupName = '.obsidian/plugins/codian/.backup-private-name';
    const plugin = {
      manifest: { version: 'test' },
      settings: { currentProvider: 'codex', permissionMode: 'normal' },
      storage: {
        getSecretStorageStatus: jest.fn(async () => ({
          available: true,
          stored: false,
          readable: false,
          retainedLegacyPlaintext: false,
        })),
        recovery: { getAll: jest.fn(async () => []) },
      },
      app: {
        vault: {
          adapter: {
            exists: jest.fn(async () => true),
            list: jest.fn(async (folder: string) => {
              if (folder === '.codian') return { files, folders: [] };
              if (folder === '.obsidian/plugins/codian') {
                return { files: [], folders: [privateBackupName] };
              }
              return { files: [], folders: [] };
            }),
            stat: jest.fn(async () => ({ type: 'file', ctime: 0, mtime: 0, size: 64 * 1024 })),
          },
        },
      },
    } as unknown as CodianPlugin;

    const snapshot = await new CodianDiagnostics(plugin).buildSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toMatchObject({
      installation: { historicalBackupDirectories: 1 },
      storage: { codian: { files: 10_000 } },
    });
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      'storage-large',
      'storage-file-count-large',
      'installed-backups-present',
    ]));
    expect(serialized).not.toContain('private-name');
    expect(serialized).not.toContain('.obsidian/plugins');
  });
});
