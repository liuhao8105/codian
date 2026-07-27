import { spawn } from 'child_process';
import { createHash } from 'crypto';
import type { Plugin } from 'obsidian';

import type { EnvSnippet, ProviderConfigs } from '../types';

const SECURE_SECRETS_KEY = 'secureSecrets';
const SECURE_SECRETS_VERSION = 1;
const MACOS_KEYCHAIN_SERVICE = 'com.liuhao8105.codian.secrets';

export interface SecretStorageBackend {
  isEncryptionAvailable(): boolean | Promise<boolean>;
  encryptString(value: string): Buffer | Promise<Buffer>;
  decryptString(value: Buffer): string | Promise<string>;
}

export interface SensitiveSettingsPayload {
  deepseekApiKey: string;
  environmentVariables: string;
  envSnippetValues: Record<string, string>;
}

export interface SecretStorageStatus {
  available: boolean;
  stored: boolean;
  readable: boolean;
}

interface SensitiveSettingsShape {
  providerConfigs: ProviderConfigs;
  environmentVariables: string;
  envSnippets: EnvSnippet[];
}

interface StoredSecureSecrets {
  version: number;
  ciphertext: string;
}

interface MacKeychainReference {
  backend: 'macos-keychain';
  account: string;
}

function createUnavailableBackend(): SecretStorageBackend {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('OS-backed encryption is unavailable.');
    },
    decryptString: () => {
      throw new Error('OS-backed encryption is unavailable.');
    },
  };
}

function createSystemBackend(): SecretStorageBackend {
  try {
    // Electron is available only inside Obsidian; keeping this lazy also makes
    // non-Electron tooling and unit tests degrade safely.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: SecretStorageBackend };
    return electron.safeStorage ?? createUnavailableBackend();
  } catch {
    return createUnavailableBackend();
  }
}

function getVaultIdentity(plugin: Pick<Plugin, 'loadData' | 'saveData'>): string {
  const candidate = plugin as Pick<Plugin, 'loadData' | 'saveData'> & {
    app?: {
      vault?: {
        adapter?: {
          basePath?: unknown;
          getBasePath?: () => unknown;
        };
      };
    };
    manifest?: { id?: unknown };
  };
  const adapter = candidate.app?.vault?.adapter;
  const basePath = adapter?.basePath ?? adapter?.getBasePath?.();
  if (typeof basePath === 'string' && basePath.length > 0) {
    return basePath;
  }
  const pluginId = candidate.manifest?.id;
  return typeof pluginId === 'string' && pluginId.length > 0 ? pluginId : 'codian';
}

function runMacSecurity(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8').replace(/\r?\n$/, ''));
        return;
      }
      const message = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(message || `macOS Keychain command failed with code ${code ?? 'unknown'}.`));
    });

    // `security add-generic-password -w` prompts for the value twice when no
    // argument is provided. Supplying both lines keeps the secret out of argv.
    child.stdin.end(input === undefined ? undefined : `${input}\n${input}\n`);
  });
}

function createMacKeychainBackend(
  plugin: Pick<Plugin, 'loadData' | 'saveData'>,
): SecretStorageBackend {
  const account = createHash('sha256')
    .update(getVaultIdentity(plugin))
    .digest('hex');

  return {
    isEncryptionAvailable: () => process.platform === 'darwin',
    encryptString: async value => {
      await runMacSecurity([
        'add-generic-password',
        '-U',
        '-a',
        account,
        '-s',
        MACOS_KEYCHAIN_SERVICE,
        '-w',
      ], value);
      return Buffer.from(JSON.stringify({
        backend: 'macos-keychain',
        account,
      } satisfies MacKeychainReference), 'utf8');
    },
    decryptString: async value => {
      const reference = JSON.parse(value.toString('utf8')) as Partial<MacKeychainReference>;
      if (reference.backend !== 'macos-keychain' || reference.account !== account) {
        throw new Error('Invalid macOS Keychain reference.');
      }
      return runMacSecurity([
        'find-generic-password',
        '-a',
        account,
        '-s',
        MACOS_KEYCHAIN_SERVICE,
        '-w',
      ]);
    },
  };
}

function createDefaultBackend(
  plugin: Pick<Plugin, 'loadData' | 'saveData'>,
): SecretStorageBackend {
  if (process.env.NODE_ENV === 'test') {
    return createUnavailableBackend();
  }
  return process.platform === 'darwin'
    ? createMacKeychainBackend(plugin)
    : createSystemBackend();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function isStoredSecureSecrets(value: unknown): value is StoredSecureSecrets {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === SECURE_SECRETS_VERSION && typeof candidate.ciphertext === 'string';
}

function isSensitiveSettingsPayload(value: unknown): value is SensitiveSettingsPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deepseekApiKey === 'string' &&
    typeof candidate.environmentVariables === 'string' &&
    !!candidate.envSnippetValues &&
    typeof candidate.envSnippetValues === 'object' &&
    Object.values(candidate.envSnippetValues as Record<string, unknown>)
      .every(item => typeof item === 'string')
  );
}

export function extractSensitiveSettings(
  settings: SensitiveSettingsShape,
): SensitiveSettingsPayload {
  return {
    deepseekApiKey: settings.providerConfigs.deepseek.apiKey,
    environmentVariables: settings.environmentVariables,
    envSnippetValues: Object.fromEntries(
      settings.envSnippets.map(snippet => [snippet.id, snippet.envVars])
    ),
  };
}

export function hasSensitiveSettings(payload: SensitiveSettingsPayload): boolean {
  return (
    payload.deepseekApiKey.length > 0 ||
    payload.environmentVariables.length > 0 ||
    Object.values(payload.envSnippetValues).some(value => value.length > 0)
  );
}

export function sanitizeSensitiveSettings<T extends SensitiveSettingsShape>(settings: T): T {
  return {
    ...settings,
    providerConfigs: {
      ...settings.providerConfigs,
      deepseek: {
        ...settings.providerConfigs.deepseek,
        apiKey: '',
      },
    },
    environmentVariables: '',
    envSnippets: settings.envSnippets.map(snippet => ({ ...snippet, envVars: '' })),
  };
}

export function hydrateSensitiveSettings<T extends SensitiveSettingsShape>(
  settings: T,
  payload: SensitiveSettingsPayload,
): T {
  return {
    ...settings,
    providerConfigs: {
      ...settings.providerConfigs,
      deepseek: {
        ...settings.providerConfigs.deepseek,
        apiKey: payload.deepseekApiKey,
      },
    },
    environmentVariables: payload.environmentVariables,
    envSnippets: settings.envSnippets.map(snippet => ({
      ...snippet,
      envVars: payload.envSnippetValues[snippet.id] ?? '',
    })),
  };
}

/**
 * Persists sensitive settings in Obsidian's device-local plugin data, encrypted
 * by Electron safeStorage. Vault settings remain sync-safe and contain no secrets.
 */
export class SecureSecretStorage {
  constructor(
    private readonly plugin: Pick<Plugin, 'loadData' | 'saveData'>,
    private readonly backend: SecretStorageBackend = createDefaultBackend(plugin),
  ) {}

  async load(): Promise<SensitiveSettingsPayload | null> {
    try {
      if (!(await this.backend.isEncryptionAvailable())) return null;
      const data = asRecord(await this.plugin.loadData());
      const stored = data[SECURE_SECRETS_KEY];
      if (!isStoredSecureSecrets(stored)) return null;
      const plaintext = await this.backend.decryptString(Buffer.from(stored.ciphertext, 'base64'));
      const parsed = JSON.parse(plaintext) as unknown;
      return isSensitiveSettingsPayload(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async getStatus(): Promise<SecretStorageStatus> {
    try {
      const available = await this.backend.isEncryptionAvailable();
      if (!available) return { available: false, stored: false, readable: false };

      const data = asRecord(await this.plugin.loadData());
      const stored = data[SECURE_SECRETS_KEY];
      if (!isStoredSecureSecrets(stored)) {
        return { available: true, stored: false, readable: false };
      }

      try {
        const plaintext = await this.backend.decryptString(
          Buffer.from(stored.ciphertext, 'base64'),
        );
        const readable = isSensitiveSettingsPayload(JSON.parse(plaintext) as unknown);
        return { available: true, stored: true, readable };
      } catch {
        return { available: true, stored: true, readable: false };
      }
    } catch {
      return { available: false, stored: false, readable: false };
    }
  }

  async save(payload: SensitiveSettingsPayload): Promise<boolean> {
    if (!(await this.backend.isEncryptionAvailable())) return false;

    try {
      const encrypted = await this.backend.encryptString(JSON.stringify(payload));
      const ciphertext = encrypted.toString('base64');
      const current = asRecord(await this.plugin.loadData());
      await this.plugin.saveData({
        ...current,
        [SECURE_SECRETS_KEY]: {
          version: SECURE_SECRETS_VERSION,
          ciphertext,
        } satisfies StoredSecureSecrets,
      });
      return true;
    } catch {
      return false;
    }
  }
}
