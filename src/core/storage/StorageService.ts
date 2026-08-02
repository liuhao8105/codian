/**
 * StorageService - Main coordinator for distributed storage system.
 *
 * Manages:
 * - CC settings in .claude/settings.json (CC-compatible, shareable)
 * - Claudian settings in .claude/claudian-settings.json (Claudian-specific)
 * - Slash commands in .claude/commands/*.md
 * - Chat sessions in .claude/sessions/*.jsonl
 * - MCP configs in .claude/mcp.json
 * - Local memories in .claude/local-memory/
 *
 * Handles migration from legacy formats:
 * - Old settings.json with Claudian fields → split into CC + Claudian files
 * - Old .claudian/claudian-settings.json → .claude/claudian-settings.json
 * - Old permissions array → CC permissions object
 * - data.json state → claudian-settings.json
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
  CCPermissions,
  CCSettings,
  Conversation,
  LegacyPermission,
  SlashCommand,
} from '../types';
import {
  createPermissionRule,
  DEFAULT_CC_PERMISSIONS,
  DEFAULT_SETTINGS,
  legacyPermissionsToCCPermissions,
} from '../types';
import { AGENTS_PATH, AgentVaultStorage } from './AgentVaultStorage';
import { CC_SETTINGS_PATH, CCSettingsStorage, isLegacyPermissionsFormat } from './CCSettingsStorage';
import {
  CODIAN_SETTINGS_PATH,
  CodianSettingsStorage,
  normalizeBlockedCommands,
  type StoredCodianSettings,
} from './ClaudianSettingsStorage';
import { LOCAL_MEMORY_PATH, LocalMemoryStorage } from './LocalMemoryStorage';
import { McpStorage } from './McpStorage';
import {
  CLAUDIAN_ONLY_FIELDS,
  convertEnvObjectToString,
  mergeEnvironmentVariables,
} from './migrationConstants';
import { RecoveryJournal } from './RecoveryJournal';
import { SESSIONS_PATH, SessionStorage } from './SessionStorage';
import { SKILLS_PATH, SkillStorage } from './SkillStorage';
import { COMMANDS_PATH, SlashCommandStorage } from './SlashCommandStorage';
import { VaultFileAdapter } from './VaultFileAdapter';

/** Base path for all Claudian storage. */
export const CLAUDE_PATH = '.claude';

/** Legacy Claudian/Codian settings path used by older builds. */
export const LEGACY_CLAUDIAN_SETTINGS_PATH = '.claudian/claudian-settings.json';

/** Legacy settings path (now CC settings). */
export const SETTINGS_PATH = CC_SETTINGS_PATH;

/**
 * Combined settings for the application.
 * Merges CC settings (permissions) with Claudian settings.
 */
export interface CombinedSettings {
  /** CC-compatible settings (permissions, etc.) */
  cc: CCSettings;
  /** Claudian-specific settings */
  claudian: StoredCodianSettings;
}

export interface CodianSecretStorageStatus extends SecretStorageStatus {
  retainedLegacyPlaintext: boolean;
}

/** Legacy data format (pre-split migration). */
interface LegacySettingsJson {
  // Old Claudian fields that were in settings.json
  userName?: string;
  enableBlocklist?: boolean;
  blockedCommands?: unknown;
  model?: string;
  thinkingBudget?: string;
  permissionMode?: string;
  lastNonPlanPermissionMode?: string;
  permissions?: LegacyPermission[];
  excludedTags?: string[];
  mediaFolder?: string;
  environmentVariables?: string;
  envSnippets?: unknown[];
  systemPrompt?: string;
  strongRulesFilePath?: string;
  strongRulesPrompt?: string;
  memoryFilePath?: string;
  enableLocalMemory?: boolean;
  localMemoryPath?: string;
  allowedExportPaths?: string[];
  keyboardNavigation?: unknown;
  claudeCliPath?: string;
  claudeCliPaths?: unknown;
  loadUserClaudeSettings?: boolean;
  enableAutoTitleGeneration?: boolean;
  titleGenerationModel?: string;

  // CC fields
  $schema?: string;
  env?: Record<string, string>;
}

/** Legacy data.json format. */
interface LegacyDataJson {
  activeConversationId?: string | null;
  lastEnvHash?: string;
  lastClaudeModel?: AgentModel;
  lastCustomModel?: AgentModel;
  conversations?: Conversation[];
  slashCommands?: SlashCommand[];
  migrationVersion?: number;
  // May also contain old settings if not yet migrated
  [key: string]: unknown;
}

// CLAUDIAN_ONLY_FIELDS is imported from ./migrationConstants

export class StorageService {
  readonly ccSettings: CCSettingsStorage;
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
    this.ccSettings = new CCSettingsStorage(this.adapter);
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

    const cc = await this.ccSettings.load();
    let claudian = await this.codianSettings.load();
    if (!(await this.adapter.exists(CODIAN_SETTINGS_PATH))) {
      await this.codianSettings.save(claudian);
    }
    claudian = await this.hydrateAndMigrateSecrets(claudian);

    return { cc, claudian };
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
    const ccExists = await this.ccSettings.exists();
    const claudianExists = await this.codianSettings.exists();
    const dataJson = await this.loadDataJson();

    if (!claudianExists) {
      await this.migrateFromLegacyClaudianSettings();
    }

    // Check if old settings.json has Claudian fields that need migration
    if (ccExists && !(await this.codianSettings.exists())) {
      await this.migrateFromOldSettingsJson();
    }

    if (dataJson) {
      const hasState = this.hasStateToMigrate(dataJson);
      const hasLegacyContent = this.hasLegacyContentToMigrate(dataJson);

      // Migrate data.json state to claudian-settings.json
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
      data.lastClaudeModel !== undefined ||
      data.lastCustomModel !== undefined
    );
  }

  private hasLegacyContentToMigrate(data: LegacyDataJson): boolean {
    return (
      (data.slashCommands?.length ?? 0) > 0 ||
      (data.conversations?.length ?? 0) > 0
    );
  }

  /**
   * Migrate settings written by older builds under .claudian/.
   *
   * This keeps user-configured memory/rules paths when the plugin moves to the
   * .claude-compatible storage layout.
   */
  private async migrateFromLegacyClaudianSettings(): Promise<void> {
    if (!(await this.adapter.exists(LEGACY_CLAUDIAN_SETTINGS_PATH))) {
      return;
    }

    const content = await this.adapter.read(LEGACY_CLAUDIAN_SETTINGS_PATH);
    const legacy = JSON.parse(content) as Partial<StoredCodianSettings>;
    const { slashCommands: _, ...defaults } = DEFAULT_SETTINGS;

    await this.codianSettings.save({
      ...defaults,
      ...legacy,
      blockedCommands: normalizeBlockedCommands(legacy.blockedCommands),
    } as StoredCodianSettings);
  }

  /**
   * Migrate from old settings.json (with Claudian fields) to split format.
   *
   * Handles:
   * - Legacy Claudian fields (userName, model, etc.) → claudian-settings.json
   * - Legacy permissions array → CC permissions object
   * - CC env object → Claudian environmentVariables string
   * - Preserves existing CC permissions if already in CC format
   */
  private async migrateFromOldSettingsJson(): Promise<void> {
    const content = await this.adapter.read(CC_SETTINGS_PATH);
    const oldSettings = JSON.parse(content) as LegacySettingsJson;

    const hasClaudianFields = Array.from(CLAUDIAN_ONLY_FIELDS).some(
      field => (oldSettings as Record<string, unknown>)[field] !== undefined
    );

    if (!hasClaudianFields) {
      return;
    }

    // Handle environment variables: merge Claudian string format with CC object format
    let environmentVariables = oldSettings.environmentVariables ?? '';
    if (oldSettings.env && typeof oldSettings.env === 'object') {
      const envFromCC = convertEnvObjectToString(oldSettings.env);
      if (envFromCC) {
        environmentVariables = mergeEnvironmentVariables(environmentVariables, envFromCC);
      }
    }

    const claudianFields: Partial<StoredCodianSettings> = {
      userName: oldSettings.userName ?? DEFAULT_SETTINGS.userName,
      enableBlocklist: oldSettings.enableBlocklist ?? DEFAULT_SETTINGS.enableBlocklist,
      blockedCommands: normalizeBlockedCommands(oldSettings.blockedCommands),
      currentProvider: DEFAULT_SETTINGS.currentProvider,
      providerConfigs: DEFAULT_SETTINGS.providerConfigs,
      model: (oldSettings.model as AgentModel) ?? DEFAULT_SETTINGS.model,
      thinkingBudget: (oldSettings.thinkingBudget as StoredCodianSettings['thinkingBudget']) ?? DEFAULT_SETTINGS.thinkingBudget,
      permissionMode: (oldSettings.permissionMode as StoredCodianSettings['permissionMode']) ?? DEFAULT_SETTINGS.permissionMode,
      excludedTags: oldSettings.excludedTags ?? DEFAULT_SETTINGS.excludedTags,
      mediaFolder: oldSettings.mediaFolder ?? DEFAULT_SETTINGS.mediaFolder,
      environmentVariables, // Merged from both sources
      envSnippets: oldSettings.envSnippets as StoredCodianSettings['envSnippets'] ?? DEFAULT_SETTINGS.envSnippets,
      systemPrompt: oldSettings.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
      strongRulesFilePath: oldSettings.strongRulesFilePath ?? DEFAULT_SETTINGS.strongRulesFilePath,
      strongRulesPrompt: oldSettings.strongRulesPrompt ?? DEFAULT_SETTINGS.strongRulesPrompt,
      memoryFilePath: oldSettings.memoryFilePath ?? DEFAULT_SETTINGS.memoryFilePath,
      enableLocalMemory: oldSettings.enableLocalMemory ?? DEFAULT_SETTINGS.enableLocalMemory,
      localMemoryPath: oldSettings.localMemoryPath ?? DEFAULT_SETTINGS.localMemoryPath,
      allowedExportPaths: oldSettings.allowedExportPaths ?? DEFAULT_SETTINGS.allowedExportPaths,
      persistentExternalContextPaths: DEFAULT_SETTINGS.persistentExternalContextPaths,
      keyboardNavigation: oldSettings.keyboardNavigation as StoredCodianSettings['keyboardNavigation'] ?? DEFAULT_SETTINGS.keyboardNavigation,
      codexCliPath: oldSettings.claudeCliPath ?? DEFAULT_SETTINGS.codexCliPath,
      codexCliPathsByHost: DEFAULT_SETTINGS.codexCliPathsByHost,
      enableAutoTitleGeneration: oldSettings.enableAutoTitleGeneration ?? DEFAULT_SETTINGS.enableAutoTitleGeneration,
      titleGenerationModel: oldSettings.titleGenerationModel ?? DEFAULT_SETTINGS.titleGenerationModel,
      lastCodexModel: DEFAULT_SETTINGS.lastCodexModel,
      lastCustomModel: DEFAULT_SETTINGS.lastCustomModel,
      lastEnvHash: DEFAULT_SETTINGS.lastEnvHash,
    };

    // Save Claudian settings FIRST (before stripping from settings.json)
    await this.codianSettings.save(claudianFields as StoredCodianSettings);

    // Verify Claudian settings were saved
    const savedClaudian = await this.codianSettings.load();
    if (!savedClaudian || savedClaudian.userName === undefined) {
      throw new Error('Failed to verify claudian-settings.json was saved correctly');
    }

    // Handle permissions: convert legacy format OR preserve existing CC format
    let ccPermissions: CCPermissions;
    if (isLegacyPermissionsFormat(oldSettings)) {
      ccPermissions = legacyPermissionsToCCPermissions(oldSettings.permissions);
    } else if (oldSettings.permissions && typeof oldSettings.permissions === 'object' && !Array.isArray(oldSettings.permissions)) {
      // Already in CC format - preserve it including defaultMode and additionalDirectories
      const existingPerms = oldSettings.permissions as unknown as CCPermissions;
      ccPermissions = {
        allow: existingPerms.allow ?? [],
        deny: existingPerms.deny ?? [],
        ask: existingPerms.ask ?? [],
        defaultMode: existingPerms.defaultMode,
        additionalDirectories: existingPerms.additionalDirectories,
      };
    } else {
      ccPermissions = { ...DEFAULT_CC_PERMISSIONS };
    }

    // Rewrite settings.json with only CC fields
    const ccSettings: CCSettings = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      permissions: ccPermissions,
    };

    // Pass true to strip Claudian-only fields during migration
    await this.ccSettings.save(ccSettings, true);
  }

  private async migrateFromDataJson(dataJson: LegacyDataJson): Promise<void> {
    const claudian = await this.codianSettings.load();

    // Only migrate if not already set (claudian-settings.json takes precedence)
    if (dataJson.lastEnvHash !== undefined && !claudian.lastEnvHash) {
      claudian.lastEnvHash = dataJson.lastEnvHash;
    }
    if (dataJson.lastClaudeModel !== undefined && !claudian.lastCodexModel) {
      claudian.lastCodexModel = dataJson.lastClaudeModel;
    }
    if (dataJson.lastCustomModel !== undefined && !claudian.lastCustomModel) {
      claudian.lastCustomModel = dataJson.lastCustomModel;
    }

    await this.codianSettings.save(claudian);
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
    delete cleaned.lastClaudeModel;
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
    await this.adapter.ensureFolder(CLAUDE_PATH);
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

  async getPermissions(): Promise<CCPermissions> {
    return this.ccSettings.getPermissions();
  }

  async updatePermissions(permissions: CCPermissions): Promise<void> {
    return this.ccSettings.updatePermissions(permissions);
  }

  async addAllowRule(rule: string): Promise<void> {
    return this.ccSettings.addAllowRule(createPermissionRule(rule));
  }

  async addDenyRule(rule: string): Promise<void> {
    return this.ccSettings.addDenyRule(createPermissionRule(rule));
  }

  /**
   * Remove a permission rule from all lists.
   */
  async removePermissionRule(rule: string): Promise<void> {
    return this.ccSettings.removeRule(createPermissionRule(rule));
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
   * Get legacy activeConversationId from storage (claudian-settings.json or data.json).
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

  async updateClaudianSettings(updates: Partial<StoredCodianSettings>): Promise<void> {
    return this.updateCodianSettings(updates);
  }

  async saveClaudianSettings(settings: StoredCodianSettings): Promise<void> {
    return this.saveCodianSettings(settings);
  }

  async loadClaudianSettings(): Promise<StoredCodianSettings> {
    return this.loadCodianSettings();
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
