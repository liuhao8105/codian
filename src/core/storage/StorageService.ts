/**
 * StorageService - Main coordinator for distributed storage system.
 *
 * Manages:
 * - Runtime permission settings in .codian/settings.json
 * - Codian settings in .codian/codian-settings.json (Codian-specific)
 * - Slash commands in .codian/commands/*.md
 * - Chat sessions in .codian/sessions/*.jsonl
 * - MCP configs in .codian/mcp.json
 * - Local memories in .codian/local-memory/
 *
 * Migrates plugin-owned state from data.json into the distributed files.
 */

import type { App, Plugin } from 'obsidian';
import { Notice } from 'obsidian';

import {
  extractSensitiveSettings,
  hasSensitiveSettings,
  hydrateSensitiveSettings,
  sanitizeSensitiveSettings,
  type SecretStorageStatus,
  SecureSecretStorage,
} from '../security';
import type {
  AgentModel,
  Conversation,
  RuntimePermissions,
  RuntimeSettings,
  SlashCommand,
} from '../types';
import { createPermissionRule } from '../types';
import { AGENTS_PATH, AgentVaultStorage } from './AgentVaultStorage';
import {
  CODIAN_SETTINGS_PATH,
  CodianSettingsStorage,
  type StoredCodianSettings,
} from './CodianSettingsStorage';
import { LOCAL_MEMORY_PATH, LocalMemoryStorage } from './LocalMemoryStorage';
import { McpStorage } from './McpStorage';
import { RecoveryJournal } from './RecoveryJournal';
import { RUNTIME_SETTINGS_PATH, RuntimeSettingsStorage } from './RuntimeSettingsStorage';
import { SESSIONS_PATH, SessionStorage } from './SessionStorage';
import { SKILLS_PATH, SkillStorage } from './SkillStorage';
import { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';
import { VaultFileAdapter } from './VaultFileAdapter';

/** Base path for all Codian storage. */
export const CODIAN_ROOT = '.codian';

/** Legacy settings path (now runtime settings). */
export const SETTINGS_PATH = RUNTIME_SETTINGS_PATH;

/**
 * Combined settings for the application.
 * Merges runtime settings (permissions) with Codian settings.
 */
export interface CombinedSettings {
  /** Runtime permission settings */
  runtime: RuntimeSettings;
  /** Codian-specific settings */
  codian: StoredCodianSettings;
}

export interface CodianSecretStorageStatus extends SecretStorageStatus {
  retainedLegacyPlaintext: boolean;
}


/** Legacy data.json format. */
interface LegacyDataJson {
  activeConversationId?: string | null;
  lastEnvHash?: string;
  lastCodexModel?: AgentModel;
  lastCustomModel?: AgentModel;
  conversations?: Conversation[];
  slashCommands?: SlashCommand[];
  migrationVersion?: number;
  // May also contain old settings if not yet migrated
  [key: string]: unknown;
}

export class StorageService {
  readonly runtimeSettings: RuntimeSettingsStorage;
  readonly codianSettings: CodianSettingsStorage;
  readonly commands: SlashCommandStorage;
  readonly skills: SkillStorage;
  readonly sessions: SessionStorage;
  readonly mcp: McpStorage;
  readonly agents: AgentVaultStorage;
  readonly localMemory: LocalMemoryStorage;
  readonly recovery: RecoveryJournal;

  private adapter: VaultFileAdapter;
  private plugin: Plugin;
  private app: App;
  private secretStorage: SecureSecretStorage;
  private retainedLegacyPlaintext = false;

  constructor(plugin: Plugin, secretStorage = new SecureSecretStorage(plugin)) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.secretStorage = secretStorage;
    this.adapter = new VaultFileAdapter(this.app);
    this.runtimeSettings = new RuntimeSettingsStorage(this.adapter);
    this.codianSettings = new CodianSettingsStorage(this.adapter);
    this.commands = new SlashCommandStorage(this.adapter);
    this.skills = new SkillStorage(this.adapter);
    this.sessions = new SessionStorage(this.adapter);
    this.mcp = new McpStorage(this.adapter);
    this.agents = new AgentVaultStorage(this.adapter);
    this.localMemory = new LocalMemoryStorage(this.adapter);
    this.recovery = new RecoveryJournal(this.adapter);
  }

  async initialize(): Promise<CombinedSettings> {
    await this.ensureDirectories();
    await this.runMigrations();

    const runtime = await this.runtimeSettings.load();
    let codian = await this.codianSettings.load();
    if (!(await this.adapter.exists(CODIAN_SETTINGS_PATH))) {
      await this.codianSettings.save(codian);
    }
    codian = await this.hydrateAndMigrateSecrets(codian);

    return { runtime, codian };
  }

  async getSecretStorageStatus(): Promise<CodianSecretStorageStatus> {
    return {
      ...(await this.secretStorage.getStatus()),
      retainedLegacyPlaintext: this.retainedLegacyPlaintext,
    };
  }

  private async hydrateAndMigrateSecrets(
    settings: StoredCodianSettings,
  ): Promise<StoredCodianSettings> {
    const plaintext = extractSensitiveSettings(settings);
    if (hasSensitiveSettings(plaintext)) {
      const encrypted = await this.secretStorage.save(plaintext);
      if (!encrypted) {
        this.retainedLegacyPlaintext = true;
        new Notice('系统安全存储不可用，旧密钥暂时保留在原设置文件中。');
        return settings;
      }

      const sanitized = sanitizeSensitiveSettings(settings);
      // The first atomic save moves the legacy plaintext primary to `.bak`.
      // Save the sanitized payload a second time so both primary and rollback
      // copies are safe to sync after a successful encrypted migration.
      await this.codianSettings.save(sanitized);
      await this.codianSettings.save(sanitized);
      const verified = await this.secretStorage.load();
      return hydrateSensitiveSettings(sanitized, verified ?? plaintext);
    }

    const encrypted = await this.secretStorage.load();
    return encrypted ? hydrateSensitiveSettings(settings, encrypted) : settings;
  }

  private async runMigrations(): Promise<void> {

    const dataJson = await this.loadDataJson();

    if (dataJson) {
      const hasState = this.hasStateToMigrate(dataJson);
      const hasLegacyContent = this.hasLegacyContentToMigrate(dataJson);

      // Migrate data.json state to codian-settings.json
      if (hasState) {
        await this.migrateFromDataJson(dataJson);
      }

      // Migrate slash commands and conversations from data.json
      let legacyContentHadErrors = false;
      if (hasLegacyContent) {
        const result = await this.migrateLegacyDataJsonContent(dataJson);
        legacyContentHadErrors = result.hadErrors;
      }

      // Clear legacy data.json only after successful migrations
      if ((hasState || hasLegacyContent) && !legacyContentHadErrors) {
        await this.clearLegacyDataJson();
      }
    }
  }

  private hasStateToMigrate(data: LegacyDataJson): boolean {
    return (
      data.lastEnvHash !== undefined ||
      data.lastCodexModel !== undefined ||
      data.lastCustomModel !== undefined
    );
  }

  private hasLegacyContentToMigrate(data: LegacyDataJson): boolean {
    return (
      (data.slashCommands?.length ?? 0) > 0 ||
      (data.conversations?.length ?? 0) > 0
    );
  }

  private async migrateFromDataJson(dataJson: LegacyDataJson): Promise<void> {
    const codian = await this.codianSettings.load();

    // Only migrate if not already set (codian-settings.json takes precedence)
    if (dataJson.lastEnvHash !== undefined && !codian.lastEnvHash) {
      codian.lastEnvHash = dataJson.lastEnvHash;
    }
    if (dataJson.lastCodexModel !== undefined && !codian.lastCodexModel) {
      codian.lastCodexModel = dataJson.lastCodexModel;
    }
    if (dataJson.lastCustomModel !== undefined && !codian.lastCustomModel) {
      codian.lastCustomModel = dataJson.lastCustomModel;
    }

    await this.codianSettings.save(codian);
  }

  private async migrateLegacyDataJsonContent(dataJson: LegacyDataJson): Promise<{ hadErrors: boolean }> {
    let hadErrors = false;

    if (dataJson.slashCommands && dataJson.slashCommands.length > 0) {
      for (const command of dataJson.slashCommands) {
        try {
          const filePath = this.commands.getFilePath(command);
          if (await this.adapter.exists(filePath)) {
            continue;
          }
          await this.commands.save(command);
        } catch {
          hadErrors = true;
        }
      }
    }

    if (dataJson.conversations && dataJson.conversations.length > 0) {
      for (const conversation of dataJson.conversations) {
        try {
          const filePath = this.sessions.getFilePath(conversation.id);
          if (await this.adapter.exists(filePath)) {
            continue;
          }
          await this.sessions.saveConversation(conversation);
        } catch {
          hadErrors = true;
        }
      }
    }

    return { hadErrors };
  }

  private async clearLegacyDataJson(): Promise<void> {
    const dataJson = await this.loadDataJson();
    if (!dataJson) {
      return;
    }

    const cleaned: Record<string, unknown> = { ...dataJson };
    delete cleaned.lastEnvHash;
    delete cleaned.lastCodexModel;
    delete cleaned.lastCustomModel;
    delete cleaned.conversations;
    delete cleaned.slashCommands;
    delete cleaned.migrationVersion;

    if (Object.keys(cleaned).length === 0) {
      await this.plugin.saveData({});
      return;
    }

    await this.plugin.saveData(cleaned);
  }

  private async loadDataJson(): Promise<LegacyDataJson | null> {
    try {
      const data = await this.plugin.loadData();
      return data || null;
    } catch {
      // data.json may not exist on fresh installs
      return null;
    }
  }

  async ensureDirectories(): Promise<void> {
    await this.adapter.ensureFolder(CODIAN_ROOT);
    await this.adapter.ensureFolder(COMMANDS_PATH);
    await this.adapter.ensureFolder(SKILLS_PATH);
    await this.adapter.ensureFolder(SESSIONS_PATH);
    await this.adapter.ensureFolder(AGENTS_PATH);
    await this.adapter.ensureFolder(LOCAL_MEMORY_PATH);
  }

  async loadAllSlashCommands(): Promise<SlashCommand[]> {
    const commands = await this.commands.loadAll();
    const skills = await this.skills.loadAll();
    return [...commands, ...skills];
  }

  getAdapter(): VaultFileAdapter {
    return this.adapter;
  }

  async getPermissions(): Promise<RuntimePermissions> {
    return this.runtimeSettings.getPermissions();
  }

  async updatePermissions(permissions: RuntimePermissions): Promise<void> {
    return this.runtimeSettings.updatePermissions(permissions);
  }

  async addAllowRule(rule: string): Promise<void> {
    return this.runtimeSettings.addAllowRule(createPermissionRule(rule));
  }

  async addDenyRule(rule: string): Promise<void> {
    return this.runtimeSettings.addDenyRule(createPermissionRule(rule));
  }

  /**
   * Remove a permission rule from all lists.
   */
  async removePermissionRule(rule: string): Promise<void> {
    return this.runtimeSettings.removeRule(createPermissionRule(rule));
  }

  async updateCodianSettings(updates: Partial<StoredCodianSettings>): Promise<void> {
    const current = await this.loadCodianSettings();
    return this.saveCodianSettings({ ...current, ...updates });
  }

  async saveCodianSettings(settings: StoredCodianSettings): Promise<void> {
    const payload = extractSensitiveSettings(settings);
    const encrypted = await this.secretStorage.save(payload);
    if (encrypted) {
      this.retainedLegacyPlaintext = false;
      return this.codianSettings.save(sanitizeSensitiveSettings(settings));
    }

    if (hasSensitiveSettings(payload)) {
      new Notice('系统安全存储不可用：本次密钥仅在当前运行期间有效。');
    }
    return this.codianSettings.save(
      this.retainedLegacyPlaintext ? settings : sanitizeSensitiveSettings(settings)
    );
  }

  async loadCodianSettings(): Promise<StoredCodianSettings> {
    const settings = await this.codianSettings.load();
    if (hasSensitiveSettings(extractSensitiveSettings(settings))) {
      return settings;
    }
    const encrypted = await this.secretStorage.load();
    return encrypted ? hydrateSensitiveSettings(settings, encrypted) : settings;
  }

  /**
   * Get legacy activeConversationId from storage (codian-settings.json or data.json).
   */
  async getLegacyActiveConversationId(): Promise<string | null> {
    const fromSettings = await this.codianSettings.getLegacyActiveConversationId();
    if (fromSettings) {
      return fromSettings;
    }

    const dataJson = await this.loadDataJson();
    if (dataJson && typeof dataJson.activeConversationId === 'string') {
      return dataJson.activeConversationId;
    }

    return null;
  }

  /**
   * Remove legacy activeConversationId from storage after migration.
   */
  async clearLegacyActiveConversationId(): Promise<void> {
    await this.codianSettings.clearLegacyActiveConversationId();

    const dataJson = await this.loadDataJson();
    if (!dataJson || !('activeConversationId' in dataJson)) {
      return;
    }

    const cleaned: Record<string, unknown> = { ...dataJson };
    delete cleaned.activeConversationId;
    await this.plugin.saveData(cleaned);
  }

  /**
   * Get tab manager state from data.json with runtime validation.
   */
  async getTabManagerState(): Promise<TabManagerPersistedState | null> {
    try {
      const data = await this.plugin.loadData();
      if (data?.tabManagerState) {
        return this.validateTabManagerState(data.tabManagerState);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Validates and sanitizes tab manager state from storage.
   * Returns null if the data is invalid or corrupted.
   */
  private validateTabManagerState(data: unknown): TabManagerPersistedState | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const state = data as Record<string, unknown>;

    if (!Array.isArray(state.openTabs)) {
      return null;
    }

    const validatedTabs: Array<{ tabId: string; conversationId: string | null }> = [];
    for (const tab of state.openTabs) {
      if (!tab || typeof tab !== 'object') {
        continue; // Skip invalid entries
      }
      const tabObj = tab as Record<string, unknown>;
      if (typeof tabObj.tabId !== 'string') {
        continue; // Skip entries without valid tabId
      }
      validatedTabs.push({
        tabId: tabObj.tabId,
        conversationId:
          typeof tabObj.conversationId === 'string' ? tabObj.conversationId : null,
      });
    }

    const activeTabId =
      typeof state.activeTabId === 'string' ? state.activeTabId : null;

    return {
      openTabs: validatedTabs,
      activeTabId,
    };
  }

  async setTabManagerState(state: TabManagerPersistedState): Promise<void> {
    try {
      const data = (await this.plugin.loadData()) || {};
      data.tabManagerState = state;
      await this.plugin.saveData(data);
    } catch {
      new Notice('Failed to save tab layout');
    }
  }

}

/**
 * Persisted state for the tab manager.
 * Stored in data.json (machine-specific, not shared).
 */
export interface TabManagerPersistedState {
  openTabs: Array<{ tabId: string; conversationId: string | null }>;
  activeTabId: string | null;
}
