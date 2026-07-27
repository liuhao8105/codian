import type { Plugin } from 'obsidian';

import {
  type SecretStorageBackend,
  SecureSecretStorage,
} from '@/core/security/SecureSecretStorage';
import { StorageService } from '@/core/storage';
import { DEFAULT_SETTINGS } from '@/core/types';

function createBackend(available = true): SecretStorageBackend {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').replace(/^encrypted:/, ''),
  };
}

function createPlugin(initialSettings: Record<string, unknown>) {
  const files = new Map<string, string>([
    ['.claude/codian-settings.json', JSON.stringify(initialSettings)],
  ]);
  const folders = new Set<string>(['.claude']);
  let pluginData: Record<string, unknown> = {};
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
    read: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing ${path}`);
      return value;
    }),
    write: jest.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
    remove: jest.fn(async (path: string) => {
      files.delete(path);
    }),
    mkdir: jest.fn(async (path: string) => {
      folders.add(path);
    }),
    list: jest.fn(async () => ({ files: [], folders: [] })),
    rename: jest.fn(async (from: string, to: string) => {
      const value = files.get(from);
      if (value !== undefined) {
        files.delete(from);
        files.set(to, value);
      }
    }),
    stat: jest.fn(async () => null),
  };
  const plugin = {
    app: { vault: { adapter } },
    loadData: jest.fn(async () => pluginData),
    saveData: jest.fn(async (data: Record<string, unknown>) => {
      pluginData = data;
    }),
  } as unknown as Plugin;
  return { plugin, files, getPluginData: () => pluginData };
}

function sensitiveSettings() {
  const { slashCommands: _, ...defaults } = DEFAULT_SETTINGS;
  return {
    ...defaults,
    providerConfigs: {
      ...defaults.providerConfigs,
      deepseek: {
        ...defaults.providerConfigs.deepseek,
        apiKey: 'sk-legacy',
      },
    },
    environmentVariables: 'TOKEN=legacy-token',
    envSnippets: [{
      id: 'snippet-1',
      name: 'Private',
      description: '',
      envVars: 'SNIPPET=legacy-snippet',
    }],
  };
}

describe('StorageService secure settings', () => {
  it('migrates legacy plaintext secrets only after encrypted storage succeeds', async () => {
    const { plugin, files, getPluginData } = createPlugin(sensitiveSettings());
    const secureStorage = new SecureSecretStorage(plugin, createBackend());
    const storage = new StorageService(plugin, secureStorage);

    const initialized = await storage.initialize();

    expect(initialized.claudian.providerConfigs.deepseek.apiKey).toBe('sk-legacy');
    expect(initialized.claudian.environmentVariables).toBe('TOKEN=legacy-token');
    const vaultSettings = JSON.parse(files.get('.claude/codian-settings.json')!);
    expect(vaultSettings.providerConfigs.deepseek.apiKey).toBe('');
    expect(vaultSettings.environmentVariables).toBe('');
    expect(vaultSettings.envSnippets[0].envVars).toBe('');
    expect(files.get('.claude/codian-settings.json.bak')).not.toContain('sk-legacy');
    expect(files.get('.claude/codian-settings.json.bak')).not.toContain('legacy-token');
    expect(files.get('.claude/codian-settings.json.bak')).not.toContain('legacy-snippet');
    expect(JSON.stringify(getPluginData())).not.toContain('sk-legacy');
    expect(JSON.stringify(getPluginData())).not.toContain('legacy-token');
  });

  it('never writes newly saved secrets into the vault settings file', async () => {
    const { plugin, files } = createPlugin(sensitiveSettings());
    const storage = new StorageService(
      plugin,
      new SecureSecretStorage(plugin, createBackend()),
    );
    const initialized = await storage.initialize();
    initialized.claudian.environmentVariables = 'NEW_TOKEN=new-secret';

    await storage.saveCodianSettings(initialized.claudian);

    expect(files.get('.claude/codian-settings.json')).not.toContain('new-secret');
    await expect(storage.loadCodianSettings()).resolves.toEqual(
      expect.objectContaining({ environmentVariables: 'NEW_TOKEN=new-secret' })
    );
  });

  it('retains legacy plaintext when encryption is unavailable to prevent data loss', async () => {
    const { plugin, files } = createPlugin(sensitiveSettings());
    const storage = new StorageService(
      plugin,
      new SecureSecretStorage(plugin, createBackend(false)),
    );

    const initialized = await storage.initialize();

    expect(initialized.claudian.environmentVariables).toBe('TOKEN=legacy-token');
    expect(files.get('.claude/codian-settings.json')).toContain('legacy-token');
  });
});
