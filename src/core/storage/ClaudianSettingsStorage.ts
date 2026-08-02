/**
 * ClaudianSettingsStorage - Handles claudian-settings.json read/write.
 *
 * Manages the .claude/claudian-settings.json file for Claudian-specific settings.
 * These settings are NOT shared with Claude Code CLI.
 *
 * Includes:
 * - User preferences (userName)
 * - Security (blocklist, permission mode)
 * - Model & thinking settings
 * - Content settings (tags, media, prompts)
 * - Environment (string format, snippets)
 * - UI settings (keyboard navigation)
 * - CLI paths
 * - State (merged from data.json)
 */

import * as os from 'os';
import * as path from 'path';

import { appendBoundedLogSync } from '../../utils/boundedLog';
import type { AgentModel, CodianSettings, PlatformBlockedCommands } from '../types';
import { DEFAULT_SETTINGS, getDefaultBlockedCommands } from '../types';
import type { VaultFileAdapter } from './VaultFileAdapter';

/** Codian isolated settings file path relative to vault root. */
export const CODIAN_SETTINGS_PATH = '.claude/codian-settings.json';
/** Legacy shared settings file path used by Claudian-derived builds. */
export const CLAUDIAN_SETTINGS_PATH = '.claude/claudian-settings.json';

/** Fields that are loaded separately (slash commands from .claude/commands/). */
type SeparatelyLoadedFields = 'slashCommands';

/** Settings stored in .claude/claudian-settings.json. */
export type StoredCodianSettings = Omit<CodianSettings, SeparatelyLoadedFields>;
export type StoredClaudianSettings = StoredCodianSettings;
const SETTINGS_SAVE_DIAGNOSTIC_LOG = path.join(os.tmpdir(), 'codian-settings-save.log');

function appendSettingsDiagnosticLog(message: string): void {
  try {
    appendBoundedLogSync(
      SETTINGS_SAVE_DIAGNOSTIC_LOG,
      `[${new Date().toISOString()}] ${message}\n`
    );
  } catch {
    // Ignore logging failures.
  }
}

function normalizeCommandList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizeBlockedCommands(value: unknown): PlatformBlockedCommands {
  const defaults = getDefaultBlockedCommands();

  // Migrate old string[] format to new platform-keyed structure
  if (Array.isArray(value)) {
    return {
      unix: normalizeCommandList(value, defaults.unix),
      windows: [...defaults.windows],
    };
  }

  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const candidate = value as Record<string, unknown>;
  return {
    unix: normalizeCommandList(candidate.unix, defaults.unix),
    windows: normalizeCommandList(candidate.windows, defaults.windows),
  };
}

function normalizeHostnameCliPaths(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string' && val.trim()) {
      result[key] = val.trim();
    }
  }
  return result;
}

export class CodianSettingsStorage {
  constructor(private adapter: VaultFileAdapter) { }

  /**
  * Load Claudian settings from .claude/claudian-settings.json.
  * Returns default settings if file doesn't exist.
  * Throws if file exists but cannot be read or parsed.
  */
  async load(): Promise<StoredCodianSettings> {
    const activePath = await this.getExistingSettingsPath();
    if (!activePath) {
      return this.getDefaults();
    }

    const stored = await this.readStoredSettings(activePath);
    const { activeConversationId: _activeConversationId, ...storedWithoutLegacy } = stored;

    const blockedCommands = normalizeBlockedCommands(stored.blockedCommands);
    const hostnameCliPaths = normalizeHostnameCliPaths(
      stored.codexCliPathsByHost ?? stored.claudeCliPathsByHost,
    );
    const rawCliPath = stored.codexCliPath ?? stored.claudeCliPath;
    const cliPath = typeof rawCliPath === 'string' ? rawCliPath : '';

    return {
      ...this.getDefaults(),
      ...storedWithoutLegacy,
      blockedCommands,
      codexCliPath: cliPath,
      codexCliPathsByHost: hostnameCliPaths,
    } as StoredCodianSettings;
  }

  async save(settings: StoredCodianSettings): Promise<void> {
    appendSettingsDiagnosticLog(
      `save provider=${settings.currentProvider} model=${settings.model} lastEnvHash=${settings.lastEnvHash || ''}\n` +
      `${new Error().stack || ''}`
    );
    const content = JSON.stringify(settings, null, 2);
    await this.adapter.write(CODIAN_SETTINGS_PATH, content);
  }

  async exists(): Promise<boolean> {
    return (await this.adapter.exists(CODIAN_SETTINGS_PATH)) || (await this.adapter.exists(CLAUDIAN_SETTINGS_PATH));
  }

  async update(updates: Partial<StoredCodianSettings>): Promise<void> {
    const current = await this.load();
    await this.save({ ...current, ...updates });
  }

  /**
   * Read legacy activeConversationId from claudian-settings.json, if present.
   * Used only for one-time migration to tabManagerState.
   */
  async getLegacyActiveConversationId(): Promise<string | null> {
    const activePath = await this.getExistingSettingsPath();
    if (!activePath) {
      return null;
    }

    const content = await this.adapter.read(activePath);
    const stored = JSON.parse(content) as Record<string, unknown>;
    const value = stored.activeConversationId;

    if (typeof value === 'string') {
      return value;
    }

    return null;
  }

  /**
   * Remove legacy activeConversationId from claudian-settings.json.
   */
  async clearLegacyActiveConversationId(): Promise<void> {
    const activePath = await this.getExistingSettingsPath();
    if (!activePath) {
      return;
    }

    const content = await this.adapter.read(activePath);
    const stored = JSON.parse(content) as Record<string, unknown>;

    if (!('activeConversationId' in stored)) {
      return;
    }

    delete stored.activeConversationId;
    const nextContent = JSON.stringify(stored, null, 2);
    await this.adapter.write(activePath, nextContent);
  }

  async setLastModel(model: AgentModel, isCustom: boolean): Promise<void> {
    if (isCustom) {
      await this.update({ lastCustomModel: model });
    } else {
      await this.update({ lastCodexModel: model });
    }
  }

  async setLastEnvHash(hash: string): Promise<void> {
    await this.update({ lastEnvHash: hash });
  }

  /**
   * Get default settings (excluding separately loaded fields).
   */
  private getDefaults(): StoredCodianSettings {
    const {
      slashCommands: _,
      ...defaults
    } = DEFAULT_SETTINGS;

    return defaults;
  }

  private async getExistingSettingsPath(): Promise<string | null> {
    if (await this.adapter.exists(CODIAN_SETTINGS_PATH)) {
      return CODIAN_SETTINGS_PATH;
    }
    if (await this.adapter.exists(CLAUDIAN_SETTINGS_PATH)) {
      return CLAUDIAN_SETTINGS_PATH;
    }
    return null;
  }

  private async readStoredSettings(activePath: string): Promise<Record<string, unknown>> {
    const content = await this.adapter.read(activePath);
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch (primaryError) {
      const backupPath = `${activePath}.bak`;
      if (!(await this.adapter.exists(backupPath))) {
        throw primaryError;
      }

      const backupContent = await this.adapter.read(backupPath);
      const recovered = JSON.parse(backupContent) as Record<string, unknown>;
      await this.adapter.restoreFromBackup(activePath, backupContent);
      appendSettingsDiagnosticLog(`recovered settings from ${backupPath}`);
      return recovered;
    }
  }
}

export { CodianSettingsStorage as ClaudianSettingsStorage };
