import type { Plugin } from 'obsidian';

import {
  extractSensitiveSettings,
  hydrateSensitiveSettings,
  sanitizeSensitiveSettings,
  type SecretStorageBackend,
  SecureSecretStorage,
} from '@/core/security/SecureSecretStorage';
import { DEFAULT_SETTINGS } from '@/core/types';

function createBackend(available = true): SecretStorageBackend {
  return {
    isEncryptionAvailable: jest.fn(() => available),
    encryptString: jest.fn(value => Buffer.from(`encrypted:${value}`, 'utf8')),
    decryptString: jest.fn(value => value.toString('utf8').replace(/^encrypted:/, '')),
  };
}

function createPlugin(data: Record<string, unknown> | null = null) {
  let currentData = data;
  const plugin = {
    loadData: jest.fn(async () => currentData),
    saveData: jest.fn(async (next: Record<string, unknown>) => {
      currentData = next;
    }),
  } as unknown as Plugin;
  return { plugin, getData: () => currentData };
}

function createSettings() {
  return {
    ...DEFAULT_SETTINGS,
    providerConfigs: {
      ...DEFAULT_SETTINGS.providerConfigs,
      deepseek: {
        ...DEFAULT_SETTINGS.providerConfigs.deepseek,
        apiKey: 'sk-deepseek-secret',
      },
    },
    environmentVariables: 'OPENAI_API_KEY=sk-openai-secret\nSAFE_FLAG=1',
    envSnippets: [
      {
        id: 'snippet-1',
        name: 'Private',
        description: '',
        envVars: 'TOKEN=snippet-secret',
      },
    ],
  };
}

describe('SecureSecretStorage', () => {
  it('stores one encrypted payload without plaintext secret values', async () => {
    const { plugin, getData } = createPlugin({ tabManagerState: { activeTabId: 'tab-1' } });
    const storage = new SecureSecretStorage(plugin, createBackend());

    await expect(storage.save(extractSensitiveSettings(createSettings()))).resolves.toBe(true);

    const serialized = JSON.stringify(getData());
    expect(serialized).not.toContain('sk-deepseek-secret');
    expect(serialized).not.toContain('sk-openai-secret');
    expect(serialized).not.toContain('snippet-secret');
    expect(serialized).toContain('secureSecrets');
    expect(serialized).toContain('tabManagerState');
  });

  it('decrypts a previously stored payload', async () => {
    const backend = createBackend();
    const first = createPlugin();
    const writer = new SecureSecretStorage(first.plugin, backend);
    const payload = extractSensitiveSettings(createSettings());
    await writer.save(payload);

    const reader = new SecureSecretStorage(createPlugin(first.getData()).plugin, backend);
    await expect(reader.load()).resolves.toEqual(payload);
  });

  it('reports only availability and readability without exposing secret values', async () => {
    const backend = createBackend();
    const target = createPlugin();
    const storage = new SecureSecretStorage(target.plugin, backend);
    await storage.save(extractSensitiveSettings(createSettings()));

    const status = await storage.getStatus();

    expect(status).toEqual({ available: true, stored: true, readable: true });
    expect(JSON.stringify(status)).not.toContain('secret');
  });

  it('does not persist plaintext when OS encryption is unavailable', async () => {
    const { plugin } = createPlugin();
    const storage = new SecureSecretStorage(plugin, createBackend(false));

    await expect(storage.save(extractSensitiveSettings(createSettings()))).resolves.toBe(false);
    expect(plugin.saveData).not.toHaveBeenCalled();
    await expect(storage.getStatus()).resolves.toEqual({
      available: false,
      stored: false,
      readable: false,
    });
  });

  it('degrades safely when plugin data cannot be read', async () => {
    const plugin = {
      loadData: jest.fn().mockRejectedValue(new Error('read failed')),
      saveData: jest.fn(),
    } as unknown as Plugin;
    const storage = new SecureSecretStorage(plugin, createBackend());

    await expect(storage.load()).resolves.toBeNull();
  });

  it('sanitizes vault settings and hydrates them only in memory', () => {
    const settings = createSettings();
    const payload = extractSensitiveSettings(settings);
    const sanitized = sanitizeSensitiveSettings(settings);

    expect(sanitized.providerConfigs.deepseek.apiKey).toBe('');
    expect(sanitized.environmentVariables).toBe('');
    expect(sanitized.envSnippets[0].envVars).toBe('');
    expect(hydrateSensitiveSettings(sanitized, payload)).toEqual(settings);
  });
});
