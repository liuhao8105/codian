/**
 * Codian - Obsidian plugin entry point
 *
 * Registers the sidebar chat view, settings tab, and commands.
 * Manages conversation persistence and environment variable configuration.
 */

import type { Editor, MarkdownView } from 'obsidian';
import { Notice, Plugin } from 'obsidian';

import { AgentManager } from './core/agents';
import { CodianDiagnostics } from './core/diagnostics/CodianDiagnostics';
import { McpServerManager } from './core/mcp';
import { PluginManager } from './core/plugins';
import { createAgentRuntime } from './core/runtime';
import { CodexAppServerClient } from './core/runtime/CodexAppServerClient';
// CODIAN_ICON_SVG kept in shared/icons.ts for reference
import { normalizeCodexModelForRuntime } from './core/runtime/codexExec';
import { StorageService } from './core/storage';
import { isSubagentToolName, TOOL_TASK } from './core/tools/toolNames';
import type {
  AsyncSubagentStatus,
  ChatMessage,
  CodianSettings,
  Conversation,
  ConversationMeta,
  ProviderId,
  SlashCommand,
  SubagentInfo,
  ToolCallInfo,
} from './core/types';
import {
  DEFAULT_CODEX_MODELS,
  DEFAULT_SETTINGS,
  DEFAULT_THINKING_BUDGET,
  getCliPlatformKey,
  getHostnameKey,
  type ThinkingBudget,
  VIEW_TYPE_CLAUDIAN,
} from './core/types';
import {
  fetchCodexModelCatalog,
  reconcileCodexModelSelection,
} from './core/types/models';
import { CodianView } from './features/chat/CodianView';
import { setupServiceCallbacks } from './features/chat/tabs/Tab';
import { type InlineEditContext, InlineEditModal } from './features/inline-edit/ui/InlineEditModal';
import { CodianSettingTab } from './features/settings/CodianSettings';
import { setLocale } from './i18n';
import { ClaudeCliResolver } from './utils/claudeCli';
import { buildCursorContext } from './utils/editor';
import {
  buildProviderEnvironmentText,
  getCurrentModelFromEnvironment,
  getProviderModels,
  isProviderConfigured,
  parseEnvironmentVariables,
} from './utils/env';
import { filterValidPaths } from './utils/externalContext';
import { getVaultPath } from './utils/path';
import {
  deleteSDKSession,
  loadSDKSessionMessages,
  loadSubagentToolCalls,
  sdkSessionExists,
  type SDKSessionLoadResult,
} from './utils/sdkSession';

// ============================================
// Subagent data merge helpers (pure functions)
// ============================================

function chooseRicherResult(sdkResult?: string, cachedResult?: string): string | undefined {
  const sdkText = typeof sdkResult === 'string' ? sdkResult.trim() : '';
  const cachedText = typeof cachedResult === 'string' ? cachedResult.trim() : '';

  if (sdkText.length === 0 && cachedText.length === 0) return undefined;
  if (sdkText.length === 0) return cachedResult;
  if (cachedText.length === 0) return sdkResult;

  return sdkText.length >= cachedText.length ? sdkResult : cachedResult;
}

function chooseRicherToolCalls(
  sdkToolCalls: ToolCallInfo[] = [],
  cachedToolCalls: ToolCallInfo[] = []
): ToolCallInfo[] {
  if (sdkToolCalls.length >= cachedToolCalls.length) return sdkToolCalls;
  return cachedToolCalls;
}

function normalizeAsyncStatus(
  subagent: SubagentInfo | undefined,
  modeOverride?: SubagentInfo['mode']
): AsyncSubagentStatus | undefined {
  if (!subagent) return undefined;

  const mode = modeOverride ?? subagent.mode;
  if (mode === 'sync') return undefined;
  if (mode === 'async') return subagent.asyncStatus ?? subagent.status;
  return subagent.asyncStatus;
}

function isTerminalAsyncStatus(status: AsyncSubagentStatus | undefined): boolean {
  return status === 'completed' || status === 'error' || status === 'orphaned';
}

function mergeSubagentInfo(
  taskToolCall: ToolCallInfo,
  cachedSubagent: SubagentInfo
): SubagentInfo {
  const sdkSubagent = taskToolCall.subagent;
  const cachedAsyncStatus = normalizeAsyncStatus(cachedSubagent);
  if (!sdkSubagent) {
    return {
      ...cachedSubagent,
      asyncStatus: cachedAsyncStatus,
      result: chooseRicherResult(taskToolCall.result, cachedSubagent.result),
    };
  }

  const sdkAsyncStatus = normalizeAsyncStatus(sdkSubagent);
  const sdkIsTerminal = isTerminalAsyncStatus(sdkAsyncStatus);
  const cachedIsTerminal = isTerminalAsyncStatus(cachedAsyncStatus);
  const sdkResult = taskToolCall.result ?? sdkSubagent.result;

  // Prefer cached data only when it reached a terminal state but SDK hasn't yet
  const preferred = (!sdkIsTerminal && cachedIsTerminal) ? cachedSubagent : sdkSubagent;

  const mergedMode = sdkSubagent.mode
    ?? cachedSubagent.mode
    ?? (taskToolCall.input?.run_in_background === true ? 'async' : undefined);
  const fallbackResult = chooseRicherResult(sdkResult, cachedSubagent.result);
  const mergedResult = preferred === cachedSubagent
    ? (cachedSubagent.result ?? fallbackResult)
    : fallbackResult;
  const mergedAsyncStatus = normalizeAsyncStatus(preferred, mergedMode);

  return {
    ...cachedSubagent,
    ...sdkSubagent,
    description: sdkSubagent.description || cachedSubagent.description,
    prompt: sdkSubagent.prompt || cachedSubagent.prompt,
    mode: mergedMode,
    status: preferred.status,
    asyncStatus: mergedAsyncStatus,
    result: mergedResult,
    toolCalls: chooseRicherToolCalls(sdkSubagent.toolCalls, cachedSubagent.toolCalls),
    agentId: sdkSubagent.agentId || cachedSubagent.agentId,
    outputToolId: sdkSubagent.outputToolId || cachedSubagent.outputToolId,
    startedAt: sdkSubagent.startedAt ?? cachedSubagent.startedAt,
    completedAt: sdkSubagent.completedAt ?? cachedSubagent.completedAt,
    isExpanded: sdkSubagent.isExpanded ?? cachedSubagent.isExpanded,
  };
}

function ensureTaskToolCall(
  msg: ChatMessage,
  subagentId: string,
  subagent: SubagentInfo
): ToolCallInfo {
  msg.toolCalls = msg.toolCalls || [];
  let taskToolCall = msg.toolCalls.find(
    tc => tc.id === subagentId && isSubagentToolName(tc.name)
  );

  if (!taskToolCall) {
    taskToolCall = {
      id: subagentId,
      name: TOOL_TASK,
      input: {
        description: subagent.description,
        prompt: subagent.prompt || '',
        ...(subagent.mode === 'async' ? { run_in_background: true } : {}),
      },
      status: subagent.status,
      result: subagent.result,
      isExpanded: false,
      subagent,
    };
    msg.toolCalls.push(taskToolCall);
    return taskToolCall;
  }

  if (!taskToolCall.input.description) taskToolCall.input.description = subagent.description;
  if (!taskToolCall.input.prompt) taskToolCall.input.prompt = subagent.prompt || '';
  if (subagent.mode === 'async') taskToolCall.input.run_in_background = true;
  const mergedSubagent = mergeSubagentInfo(taskToolCall, subagent);
  taskToolCall.status = mergedSubagent.status;
  if (mergedSubagent.mode === 'async') {
    taskToolCall.input.run_in_background = true;
  }
  if (mergedSubagent.result !== undefined) {
    taskToolCall.result = mergedSubagent.result;
  }
  taskToolCall.subagent = mergedSubagent;
  return taskToolCall;
}

/**
 * Main plugin class for Codian.
 * Handles plugin lifecycle, settings persistence, and conversation management.
 */
export default class CodianPlugin extends Plugin {
  settings: CodianSettings;
  mcpManager: McpServerManager;
  pluginManager: PluginManager;
  agentManager: AgentManager;
  storage: StorageService;
  cliResolver: ClaudeCliResolver;
  private conversations: Conversation[] = [];
  private runtimeEnvironmentVariables = '';
  private codexModels = [...DEFAULT_CODEX_MODELS];
  private codexThinkingBudgets: Record<string, ThinkingBudget> = {
    ...DEFAULT_THINKING_BUDGET,
  };

  async onload() {
    await this.loadSettings();

    this.cliResolver = new ClaudeCliResolver();

    // Initialize MCP manager (shared for agent + UI)
    this.mcpManager = new McpServerManager(this.storage.mcp);
    await this.mcpManager.loadServers();

    // Initialize plugin manager (reads from installed_plugins.json + settings.json)
    const vaultPath = (this.app.vault.adapter as any).basePath;
    this.pluginManager = new PluginManager(vaultPath, this.storage.ccSettings);
    await this.pluginManager.loadPlugins();

    // Initialize agent manager (loads plugin agents from plugin install paths)
    this.agentManager = new AgentManager(vaultPath, this.pluginManager);
    await this.agentManager.loadAgents();

    this.registerView(
      VIEW_TYPE_CLAUDIAN,
      (leaf) => new CodianView(leaf, this)
    );

    this.addRibbonIcon('terminal', 'Open Codian', () => {
      this.activateView();
    });

    this.addCommand({
      id: 'open-view',
      name: 'Open chat view',
      callback: () => {
        this.activateView();
      },
    });

    this.addCommand({
      id: 'copy-local-diagnostics',
      name: 'Copy local diagnostics (secret-free)',
      callback: async () => {
        try {
          const snapshot = await new CodianDiagnostics(this).buildSnapshot();
          await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
          new Notice('Codian 本地诊断已复制；不包含密钥、用户名或文件路径。');
        } catch (error) {
          new Notice(`Codian 诊断生成失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    this.addCommand({
      id: 'inline-edit',
      name: 'Inline edit',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const selectedText = editor.getSelection();
        const notePath = view.file?.path || 'unknown';

        let editContext: InlineEditContext;
        if (selectedText.trim()) {
          editContext = { mode: 'selection', selectedText };
        } else {
          const cursor = editor.getCursor();
          const cursorContext = buildCursorContext(
            (line) => editor.getLine(line),
            editor.lineCount(),
            cursor.line,
            cursor.ch
          );
          editContext = { mode: 'cursor', cursorContext };
        }

        const modal = new InlineEditModal(
          this.app,
          this,
          editor,
          view,
          editContext,
          notePath,
          () => this.getView()?.getActiveTab()?.ui.externalContextSelector?.getExternalContexts() ?? []
        );
        const result = await modal.openAndWait();

        if (result.decision === 'accept' && result.editedText !== undefined) {
          new Notice(editContext.mode === 'cursor' ? 'Inserted' : 'Edit applied');
        }
      },
    });

    this.addCommand({
      id: 'new-tab',
      name: 'New tab',
      checkCallback: (checking: boolean) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
        if (!leaf) return false;

        const view = leaf.view as CodianView;
        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        if (!tabManager.canCreateTab()) return false;

        if (!checking) {
          tabManager.createTab();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'new-session',
      name: 'New session (in current tab)',
      checkCallback: (checking: boolean) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
        if (!leaf) return false;

        const view = leaf.view as CodianView;
        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        const activeTab = tabManager.getActiveTab();
        if (!activeTab) return false;

        if (activeTab.state.isStreaming) return false;

        if (!checking) {
          tabManager.createNewConversation();
        }
        return true;
      },
    });

    this.addCommand({
      id: 'close-current-tab',
      name: 'Close current tab',
      checkCallback: (checking: boolean) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];
        if (!leaf) return false;

        const view = leaf.view as CodianView;
        const tabManager = view.getTabManager();
        if (!tabManager) return false;

        if (!checking) {
          const activeTabId = tabManager.getActiveTabId();
          if (activeTabId) {
            // When closing the last tab, TabManager will create a new empty one
            tabManager.closeTab(activeTabId);
          }
        }
        return true;
      },
    });

    this.addSettingTab(new CodianSettingTab(this.app, this));

    // Refresh asynchronously so a slow or unavailable CLI never blocks plugin loading.
    void this.refreshCodexModelCatalog();
  }

  async onunload() {
    // Ensures state is saved even if Obsidian quits without calling onClose()
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (tabManager) {
        const state = tabManager.getPersistedState();
        await this.storage.setTabManagerState(state);
      }
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN)[0];

    if (!leaf) {
      const newLeaf = this.settings.openInMainTab
        ? workspace.getLeaf('tab')
        : workspace.getRightLeaf(false);
      if (newLeaf) {
        await newLeaf.setViewState({
          type: VIEW_TYPE_CLAUDIAN,
          active: true,
        });
        leaf = newLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /** Loads settings and conversations from persistent storage. */
  async loadSettings() {
    // Initialize storage service (handles migration if needed)
    this.storage = new StorageService(this);
    const { claudian } = await this.storage.initialize();

    const slashCommands = await this.storage.loadAllSlashCommands();

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...claudian,
      slashCommands,
    };
    this.settings.currentProvider ??= DEFAULT_SETTINGS.currentProvider;
    this.settings.providerConfigs = {
      ...DEFAULT_SETTINGS.providerConfigs,
      ...(claudian.providerConfigs || {}),
      codex: {
        ...DEFAULT_SETTINGS.providerConfigs.codex,
        ...(claudian.providerConfigs?.codex || {}),
      },
      deepseek: {
        ...DEFAULT_SETTINGS.providerConfigs.deepseek,
        ...(claudian.providerConfigs?.deepseek || {}),
      },
    };
    const providerValidation = isProviderConfigured(this.settings, this.settings.currentProvider);
    const didFallbackProvider = this.settings.currentProvider === 'deepseek' &&
      (!providerValidation.ok || !this.settings.providerConfigs.deepseek.enabled);
    if (didFallbackProvider) {
      this.settings.currentProvider = 'codex';
      this.settings.model = this.getPreferredModelForProvider('codex');
      this.settings.thinkingBudget = DEFAULT_SETTINGS.thinkingBudget;
    }
    this.settings.model = this.getPreferredModelForProvider(this.settings.currentProvider);
    this.storage.localMemory.setBasePath(this.settings.localMemoryPath || DEFAULT_SETTINGS.localMemoryPath);

    const sanitizedPersistentPaths = filterValidPaths(this.settings.persistentExternalContextPaths || []);
    const didSanitizePersistentPaths =
      sanitizedPersistentPaths.length !== (this.settings.persistentExternalContextPaths || []).length;
    this.settings.persistentExternalContextPaths = sanitizedPersistentPaths;

    // Plan mode is ephemeral — normalize back to normal on load so the app
    // doesn't start stuck in plan mode after a restart (prePlanPermissionMode is lost)
    if (this.settings.permissionMode === 'plan') {
      this.settings.permissionMode = 'normal';
    }

    // Initialize and migrate legacy CLI paths to hostname-based paths
    this.settings.claudeCliPathsByHost ??= {};
    const hostname = getHostnameKey();
    let didMigrateCliPath = false;

    if (!this.settings.claudeCliPathsByHost[hostname]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const platformPaths = (this.settings as any).claudeCliPaths as Record<string, string> | undefined;
      const migratedPath = platformPaths?.[getCliPlatformKey()]?.trim() || this.settings.claudeCliPath?.trim();

      if (migratedPath) {
        this.settings.claudeCliPathsByHost[hostname] = migratedPath;
        this.settings.claudeCliPath = '';
        didMigrateCliPath = true;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (this.settings as any).claudeCliPaths;

    // Load all conversations from session files (legacy JSONL + native metadata)
    const { conversations: legacyConversations, failedCount } = await this.storage.sessions.loadAllConversations();
    const legacyIds = new Set(legacyConversations.map(c => c.id));

    // Overlay native metadata onto legacy conversations if present
    for (const conversation of legacyConversations) {
      const meta = await this.storage.sessions.loadMetadata(conversation.id);
      if (!meta) continue;

      conversation.isNative = true;
      conversation.title = meta.title ?? conversation.title;
      conversation.titleGenerationStatus = meta.titleGenerationStatus ?? conversation.titleGenerationStatus;
      conversation.createdAt = meta.createdAt ?? conversation.createdAt;
      conversation.updatedAt = meta.updatedAt ?? conversation.updatedAt;
      conversation.lastResponseAt = meta.lastResponseAt ?? conversation.lastResponseAt;
      if (meta.sessionId !== undefined) {
        conversation.sessionId = meta.sessionId;
      }
      conversation.currentNote = meta.currentNote ?? conversation.currentNote;
      conversation.attachedFiles = meta.attachedFiles ?? conversation.attachedFiles;
      conversation.externalContextPaths = meta.externalContextPaths ?? conversation.externalContextPaths;
      conversation.enabledMcpServers = meta.enabledMcpServers ?? conversation.enabledMcpServers;
      conversation.usage = meta.usage ?? conversation.usage;
      if (meta.sdkSessionId !== undefined) {
        conversation.sdkSessionId = meta.sdkSessionId;
      } else if (conversation.sdkSessionId === undefined && conversation.sessionId) {
        conversation.sdkSessionId = conversation.sessionId;
      }
      conversation.previousSdkSessionIds = meta.previousSdkSessionIds ?? conversation.previousSdkSessionIds;
      conversation.legacyCutoffAt = meta.legacyCutoffAt ?? conversation.legacyCutoffAt;
      conversation.subagentData = meta.subagentData ?? conversation.subagentData;
      conversation.resumeSessionAt = meta.resumeSessionAt ?? conversation.resumeSessionAt;
      conversation.forkSource = meta.forkSource ?? conversation.forkSource;
    }

    // Also load native session metadata (no legacy JSONL)
    const nativeMetadata = await this.storage.sessions.listNativeMetadata();
    const nativeConversations: Conversation[] = nativeMetadata
      .filter(meta => !legacyIds.has(meta.id))
      .map(meta => {
        const resumeSessionId = meta.sessionId !== undefined ? meta.sessionId : meta.id;
        const sdkSessionId = meta.sdkSessionId !== undefined
          ? meta.sdkSessionId
          : (resumeSessionId ?? undefined);

        return {
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          lastResponseAt: meta.lastResponseAt,
          sessionId: resumeSessionId,
          sdkSessionId,
          previousSdkSessionIds: meta.previousSdkSessionIds,
          messages: [], // Messages are in SDK storage, loaded on demand
          currentNote: meta.currentNote,
          attachedFiles: meta.attachedFiles,
          externalContextPaths: meta.externalContextPaths,
          enabledMcpServers: meta.enabledMcpServers,
          usage: meta.usage,
          titleGenerationStatus: meta.titleGenerationStatus,
          legacyCutoffAt: meta.legacyCutoffAt,
          isNative: true,
          subagentData: meta.subagentData, // Preserve for applying to loaded messages
          resumeSessionAt: meta.resumeSessionAt,
          forkSource: meta.forkSource,
        };
      });

    this.conversations = [...legacyConversations, ...nativeConversations].sort(
      (a, b) => (b.lastResponseAt ?? b.updatedAt) - (a.lastResponseAt ?? a.updatedAt)
    );

    if (failedCount > 0) {
      new Notice(`Failed to load ${failedCount} conversation${failedCount > 1 ? 's' : ''}`);
    }
    if (didFallbackProvider && !providerValidation.ok) {
      new Notice(`DeepSeek 配置已跳过：${providerValidation.error}`);
    }
    setLocale(this.settings.locale);

    const backfilledConversations = this.backfillConversationResponseTimestamps();

    this.runtimeEnvironmentVariables = this.computeRuntimeEnvironmentVariables();
    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment(this.runtimeEnvironmentVariables);

    if (changed || didMigrateCliPath || didSanitizePersistentPaths || didFallbackProvider) {
      await this.saveSettings();
    }

    // Persist backfilled and invalidated conversations to their session files
    const conversationsToSave = new Set([...backfilledConversations, ...invalidatedConversations]);
    for (const conv of conversationsToSave) {
      if (conv.isNative) {
        // Native session: save metadata only
        await this.storage.sessions.saveMetadata(
          this.storage.sessions.toSessionMetadata(conv)
        );
      } else {
        // Legacy session: save full JSONL
        await this.storage.sessions.saveConversation(conv);
      }
    }
  }

  private backfillConversationResponseTimestamps(): Conversation[] {
    const updated: Conversation[] = [];
    for (const conv of this.conversations) {
      if (conv.lastResponseAt != null) continue;
      if (!conv.messages || conv.messages.length === 0) continue;

      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const msg = conv.messages[i];
        if (msg.role === 'assistant') {
          conv.lastResponseAt = msg.timestamp;
          updated.push(conv);
          break;
        }
      }
    }
    return updated;
  }

  /** Persists settings to storage. */
  async saveSettings() {
    // Save settings (excluding slashCommands which are stored separately)
    const {
      slashCommands: _,
      ...settingsToSave
    } = this.settings;

    await this.storage.saveCodianSettings(settingsToSave);
  }

  /** Updates and persists environment variables, restarting processes to apply changes. */
  async applyEnvironmentVariables(envText: string): Promise<void> {
    this.settings.environmentVariables = envText;
    await this.applyRuntimeEnvironmentUpdate('环境变量已应用。', '环境变量已应用，后续消息会重建会话。');
  }

  /** Returns the runtime environment variables (fixed at plugin load). */
  getActiveEnvironmentVariables(): string {
    return this.runtimeEnvironmentVariables;
  }

  getAvailableModelsForCurrentProvider(): { value: string; label: string; description: string }[] {
    const envVars = parseEnvironmentVariables(this.getActiveEnvironmentVariables());
    const providerModels = getProviderModels(this.settings.currentProvider, envVars);
    if (providerModels.length > 0) return providerModels;
    return this.settings.currentProvider === 'codex'
      ? [...this.codexModels]
      : [...DEFAULT_CODEX_MODELS];
  }

  getDefaultThinkingBudgetForModel(model: string): ThinkingBudget | null {
    if (!this.codexModels.some((candidate) => candidate.value === model)) return null;
    return this.codexThinkingBudgets[model] ?? 'off';
  }

  async refreshCodexModelCatalog(): Promise<boolean> {
    const envVars = parseEnvironmentVariables(this.getActiveEnvironmentVariables());
    if (getProviderModels('codex', envVars).length > 0) {
      return false;
    }

    try {
      const catalog = await fetchCodexModelCatalog(
        (signal) => new CodexAppServerClient(this, () => undefined, signal),
      );
      if (catalog.models.length === 0) {
        return false;
      }

      this.codexModels = catalog.models;
      this.codexThinkingBudgets = {
        ...DEFAULT_THINKING_BUDGET,
        ...catalog.thinkingBudgets,
      };

      const selection = reconcileCodexModelSelection(
        this.settings.model,
        catalog.models.map((model) => model.value),
        catalog.defaultModel,
      );
      if (selection.migrated) {
        this.settings.model = selection.model;
        this.settings.thinkingBudget = this.getDefaultThinkingBudgetForModel(selection.model) ?? 'off';
        this.settings.lastClaudeModel = selection.model;
        await this.saveSettings();
        new Notice(`原模型已不可用，已切换到 ${catalog.models.find((model) => model.value === selection.model)?.label ?? selection.model}。`);
      }

      this.getView()?.refreshToolbarState();
      return true;
    } catch {
      return false;
    }
  }

  getEnabledProviders(): ProviderId[] {
    const providers: ProviderId[] = ['codex'];
    if (this.settings.providerConfigs.deepseek.enabled) {
      providers.push('deepseek');
    }
    return providers;
  }

  async setCurrentProvider(provider: ProviderId): Promise<void> {
    if (provider === this.settings.currentProvider) {
      return;
    }

    const validation = isProviderConfigured(this.settings, provider);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    this.settings.currentProvider = provider;
    this.settings.model = this.getPreferredModelForProvider(provider);
    if (provider === 'deepseek') {
      this.settings.providerConfigs.deepseek.enabled = true;
    }
    await this.applyRuntimeEnvironmentUpdate(
      `已切换到 ${provider === 'deepseek' ? 'DeepSeek' : 'Codex'}。`,
      `已切换到 ${provider === 'deepseek' ? 'DeepSeek' : 'Codex'}，后续消息会重建会话。`
    );
  }

  async setCurrentModel(model: string): Promise<void> {
    if (model === this.settings.model) {
      return;
    }

    this.settings.model = model;
    const defaultThinkingBudget = this.getDefaultThinkingBudgetForModel(model);
    if (defaultThinkingBudget) {
      this.settings.thinkingBudget = defaultThinkingBudget;
      this.settings.lastClaudeModel = model;
    } else {
      this.settings.lastCustomModel = model;
    }

    const invalidatedConversations: Conversation[] = [];
    for (const conv of this.conversations) {
      if (conv.sessionId) {
        conv.sessionId = null;
        invalidatedConversations.push(conv);
      }
    }

    await this.saveSettings();
    await this.persistInvalidatedConversations(invalidatedConversations);

    const failedTabs = await this.restartTabsAfterEnvironmentChange(true);
    if (failedTabs > 0) {
      new Notice(`模型已切换，但有 ${failedTabs} 个标签页重启失败。`);
      return;
    }

    new Notice('模型已切换；聊天记录已保留，后续消息会建立新会话。');
  }

  async refreshRuntimeEnvironmentFromSettings(baseNotice = 'Provider 配置已更新。', changedNotice = 'Provider 配置已更新，后续消息会重建会话。'): Promise<void> {
    await this.applyRuntimeEnvironmentUpdate(baseNotice, changedNotice);
  }

  getResolvedClaudeCliPath(): string | null {
    return this.cliResolver.resolve(
      this.settings.claudeCliPathsByHost,  // Per-device paths (preferred)
      this.settings.claudeCliPath,          // Legacy path (fallback)
      this.getActiveEnvironmentVariables()
    );
  }

  private getDefaultModelValues(): string[] {
    return DEFAULT_CODEX_MODELS.map((m) => m.value);
  }

  private computeRuntimeEnvironmentVariables(providerOverride?: ProviderId): string {
    return buildProviderEnvironmentText(this.settings, providerOverride);
  }

  private async persistInvalidatedConversations(invalidatedConversations: Conversation[]): Promise<void> {
    for (const conv of invalidatedConversations) {
      if (conv.isNative) {
        await this.storage.sessions.saveMetadata(
          this.storage.sessions.toSessionMetadata(conv)
        );
      } else {
        await this.storage.sessions.saveConversation(conv);
      }
    }
  }

  private async restartTabsAfterEnvironmentChange(changed: boolean): Promise<number> {
    const view = this.getView();
    const tabManager = view?.getTabManager();
    if (!tabManager) {
      view?.refreshToolbarState();
      return 0;
    }

    for (const tab of tabManager.getAllTabs()) {
      tab.controllers.inputController?.cancelStreaming();
    }

    let failedTabs = 0;
    if (changed) {
      for (const tab of tabManager.getAllTabs()) {
        if (!tab.service || !tab.serviceInitialized) {
          continue;
        }
        try {
          const externalContextPaths = tab.ui.externalContextSelector?.getExternalContexts() ?? [];
          // Rebuild runtime to match current provider (provider switch may
          // require a different AgentRuntime implementation).
          tab.service.cleanup();
          const newService = createAgentRuntime(this, this.mcpManager);
          newService.resetSession();
          await newService.ensureReady({ externalContextPaths });
          tab.service = newService;
          setupServiceCallbacks(tab, this);
          // Reset streaming state so the next query starts clean. A stale
          // generation or stuck isStreaming flag can cause the first query
          // after a provider switch to hang.
          tab.state.resetStreamingState();
          tab.state.bumpStreamGeneration();
        } catch {
          failedTabs++;
        }
      }
    } else {
      try {
        await tabManager.broadcastToAllTabs(
          async (service) => { await service.ensureReady({ force: true }); }
        );
      } catch {
        failedTabs++;
      }
    }

    view?.refreshToolbarState();
    return failedTabs;
  }

  private async applyRuntimeEnvironmentUpdate(baseNotice: string, changedNotice: string): Promise<void> {
    const nextRuntimeEnvironment = this.computeRuntimeEnvironmentVariables();
    const envChanged = nextRuntimeEnvironment !== this.runtimeEnvironmentVariables;
    this.runtimeEnvironmentVariables = nextRuntimeEnvironment;

    const { changed, invalidatedConversations } = this.reconcileModelWithEnvironment(nextRuntimeEnvironment);
    await this.saveSettings();
    await this.persistInvalidatedConversations(invalidatedConversations);

    const failedTabs = await this.restartTabsAfterEnvironmentChange(changed || envChanged);
    if (failedTabs > 0) {
      new Notice(`环境已更新，但有 ${failedTabs} 个标签页重启失败。`);
    }

    new Notice((changed || envChanged) ? changedNotice : baseNotice);
  }

  private getPreferredCustomModel(envVars: Record<string, string>, customModels: { value: string }[]): string {
    const envPreferred = getCurrentModelFromEnvironment(envVars);
    if (envPreferred && customModels.some((m) => m.value === envPreferred)) {
      return envPreferred;
    }
    return customModels[0].value;
  }

  private getPreferredModelForProvider(provider: ProviderId, envText?: string): string {
    if (provider === 'deepseek') {
      const configuredModel = this.settings.providerConfigs.deepseek.model?.trim();
      return configuredModel || 'deepseek-chat';
    }

    const envVars = parseEnvironmentVariables(
      envText ?? this.computeRuntimeEnvironmentVariables(provider)
    );
    const providerModels = getProviderModels(provider, envVars);
    if (providerModels.length > 0) {
      return this.getPreferredCustomModel(envVars, providerModels);
    }

    return normalizeCodexModelForRuntime(this.settings.model) || DEFAULT_CODEX_MODELS[0].value;
  }

  /** Computes a hash of model and provider base URL environment variables for change detection. */
  private computeEnvHash(envText: string): string {
    const envVars = parseEnvironmentVariables(envText || '');
    const modelKeys = [
      'ANTHROPIC_MODEL',
      'OPENAI_MODEL',
      'CODEX_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ];
    const providerKeys = [
      'ANTHROPIC_BASE_URL',
      'OPENAI_BASE_URL',
    ];
    const allKeys = [...modelKeys, ...providerKeys];
    const relevantPairs = allKeys
      .filter(key => envVars[key])
      .map(key => `${key}=${envVars[key]}`)
      .sort()
      .join('|');
    return `${this.settings.currentProvider}|${relevantPairs}`;
  }

  /**
   * Reconciles model with environment.
   * Returns { changed, invalidatedConversations } where changed indicates if
   * settings were modified (requiring save), and invalidatedConversations lists
   * conversations that had their sessionId cleared (also requiring save).
   */
  private reconcileModelWithEnvironment(envText: string): {
    changed: boolean;
    invalidatedConversations: Conversation[];
  } {
    const currentHash = this.computeEnvHash(envText);
    const savedHash = this.settings.lastEnvHash || '';
    const envVars = parseEnvironmentVariables(envText || '');
    const providerModels = getProviderModels(this.settings.currentProvider, envVars);
    const availableModels = providerModels.length > 0
      ? providerModels.map((model) => model.value)
      : this.getDefaultModelValues();

    if (currentHash === savedHash && availableModels.includes(this.settings.model)) {
      return { changed: false, invalidatedConversations: [] };
    }

    // Hash changed - model or provider may have changed.
    // Session invalidation is now handled per-tab by TabManager.
    // Clear resume sessionId from all conversations since they belong to the old provider.
    // Sessions are provider-specific (contain signed thinking blocks, etc.).
    // NOTE: sdkSessionId is retained for loading SDK-stored history.
    const invalidatedConversations: Conversation[] = [];
    for (const conv of this.conversations) {
      if (conv.sessionId) {
        conv.sessionId = null;
        invalidatedConversations.push(conv);
      }
    }

    this.settings.model = this.getPreferredModelForProvider(this.settings.currentProvider, envText);

    this.settings.lastEnvHash = currentHash;
    return { changed: true, invalidatedConversations };
  }

  private generateConversationId(): string {
    return `conv-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  private generateDefaultTitle(): string {
    const now = new Date();
    return now.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private getConversationPreview(conv: Conversation): string {
    const firstUserMsg = conv.messages.find(m => m.role === 'user');
    if (!firstUserMsg) {
      // For native sessions without loaded messages, indicate it's a persisted session
      // rather than "New conversation" which implies no content exists
      return conv.isNative ? 'SDK session' : 'New conversation';
    }
    return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '');
  }

  /** Fork has no owned session yet; still referencing the source session for resume. */
  private isPendingFork(conversation: Conversation): boolean {
    return !!conversation.forkSource &&
      !conversation.sdkSessionId &&
      !conversation.sessionId;
  }

  private async loadSdkMessagesForConversation(conversation: Conversation): Promise<void> {
    if (!conversation.isNative || conversation.sdkMessagesLoaded) return;

    const vaultPath = getVaultPath(this.app);
    if (!vaultPath) return;

    const isPendingFork = this.isPendingFork(conversation);

    const allSessionIds: string[] = isPendingFork
      ? [conversation.forkSource!.sessionId]
      : [
          ...(conversation.previousSdkSessionIds || []),
          conversation.sdkSessionId ?? conversation.sessionId,
        ].filter((id): id is string => !!id);

    if (allSessionIds.length === 0) return;

    const allSdkMessages: ChatMessage[] = [];
    let missingSessionCount = 0;
    let errorCount = 0;
    let successCount = 0;

    const currentSessionId = isPendingFork
      ? conversation.forkSource!.sessionId
      : (conversation.sdkSessionId ?? conversation.sessionId);

    for (const sessionId of allSessionIds) {
      if (!sdkSessionExists(vaultPath, sessionId)) {
        missingSessionCount++;
        continue;
      }

      const isCurrentSession = sessionId === currentSessionId;
      const truncateAt = isCurrentSession
        ? (isPendingFork ? conversation.forkSource!.resumeAt : conversation.resumeSessionAt)
        : undefined;
      const result: SDKSessionLoadResult = await loadSDKSessionMessages(
        vaultPath, sessionId, truncateAt
      );

      if (result.error) {
        errorCount++;
        continue;
      }

      successCount++;
      allSdkMessages.push(...result.messages);
    }

    // Note: We intentionally don't notify users about missing session files.
    // Session files may be missing due to path encoding differences (special characters
    // in vault path) or external deletion. Showing a notification every restart is
    // too intrusive and not actionable for users.

    // Only mark as loaded if at least one session was successfully loaded,
    // or if all sessions were missing (no point retrying non-existent files).
    // If sessions exist but ALL failed to load, allow retry on next view.
    const allSessionsMissing = missingSessionCount === allSessionIds.length;
    const hasLoadErrors = errorCount > 0 && successCount === 0 && !allSessionsMissing;
    if (hasLoadErrors) {
      // Don't mark as loaded - allow retry on next view
      return;
    }

    // Filter out rebuilt context messages (history blobs sent on session reset)
    const filteredSdkMessages = allSdkMessages.filter(msg => !msg.isRebuiltContext);

    // Apply legacy cutoff filter if needed
    const afterCutoff = conversation.legacyCutoffAt != null
      ? filteredSdkMessages.filter(msg => msg.timestamp > conversation.legacyCutoffAt!)
      : filteredSdkMessages;

    const merged = this.dedupeMessages([
      ...conversation.messages,
      ...afterCutoff,
    ]).sort((a, b) => a.timestamp - b.timestamp);

    // Apply cached subagentData to loaded messages (for Agent tool count and status)
    if (conversation.subagentData) {
      await this.enrichAsyncSubagentToolCalls(
        conversation.subagentData,
        vaultPath,
        allSessionIds
      );
      this.applySubagentData(merged, conversation.subagentData);
    }

    conversation.messages = merged;
    if (!conversation.currentNote) {
      const lastUserWithNote = [...merged]
        .reverse()
        .find((message) => message.role === 'user' && !!message.currentNote);
      if (lastUserWithNote?.currentNote) {
        conversation.currentNote = lastUserWithNote.currentNote;
      }
    }
    conversation.sdkMessagesLoaded = true;
  }

  private async enrichAsyncSubagentToolCalls(
    subagentData: Record<string, SubagentInfo>,
    vaultPath: string,
    sessionIds: string[]
  ): Promise<void> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (uniqueSessionIds.length === 0) return;

    const loaderCache = new Map<string, ReturnType<typeof loadSubagentToolCalls>>();

    for (const subagent of Object.values(subagentData)) {
      if (subagent.mode !== 'async') continue;
      if (!subagent.agentId) continue;
      if ((subagent.toolCalls?.length ?? 0) > 0) continue;

      for (const sessionId of uniqueSessionIds) {
        const cacheKey = `${sessionId}:${subagent.agentId}`;

        let loader = loaderCache.get(cacheKey);
        if (!loader) {
          loader = loadSubagentToolCalls(vaultPath, sessionId, subagent.agentId);
          loaderCache.set(cacheKey, loader);
        }

        const recoveredToolCalls = await loader;
        if (recoveredToolCalls.length === 0) continue;

        subagent.toolCalls = recoveredToolCalls.map(toolCall => ({
          ...toolCall,
          input: { ...toolCall.input },
        }));
        break;
      }
    }
  }

  /**
   * Applies cached subagentData to messages.
   * Restores subagent info so Agent tools can show tool count and status.
   * Also updates contentBlocks to properly identify Agent tools as subagents.
   */
  private applySubagentData(messages: ChatMessage[], subagentData: Record<string, SubagentInfo>): void {
    const attachedSubagentIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;

      // Apply subagent data to the message
      for (const [subagentId, subagent] of Object.entries(subagentData)) {
        const hasSubagentBlock = msg.contentBlocks?.some(
          b => (b.type === 'subagent' && b.subagentId === subagentId) ||
               (b.type === 'tool_use' && b.toolId === subagentId)
        );
        const hasTaskToolCall = msg.toolCalls?.some(tc => tc.id === subagentId) ?? false;

        if (!hasSubagentBlock && !hasTaskToolCall) continue;
        ensureTaskToolCall(msg, subagentId, subagent);

        // Update contentBlock from tool_use to subagent, or update existing subagent block with mode
        if (!msg.contentBlocks) {
          msg.contentBlocks = [];
        }

        let hasNormalizedSubagentBlock = false;
        for (let i = 0; i < msg.contentBlocks.length; i++) {
          const block = msg.contentBlocks[i];
          if (block.type === 'tool_use' && block.toolId === subagentId) {
            msg.contentBlocks[i] = {
              type: 'subagent',
              subagentId,
              mode: subagent.mode,
            };
            hasNormalizedSubagentBlock = true;
          } else if (block.type === 'subagent' && block.subagentId === subagentId && !block.mode) {
            block.mode = subagent.mode;
            hasNormalizedSubagentBlock = true;
          } else if (block.type === 'subagent' && block.subagentId === subagentId) {
            hasNormalizedSubagentBlock = true;
          }
        }

        if (!hasNormalizedSubagentBlock && hasTaskToolCall) {
          msg.contentBlocks.push({
            type: 'subagent',
            subagentId,
            mode: subagent.mode,
          });
        }

        attachedSubagentIds.add(subagentId);
      }
    }

    for (const [subagentId, subagent] of Object.entries(subagentData)) {
      if (attachedSubagentIds.has(subagentId)) continue;

      let anchor = [...messages].reverse().find((msg): msg is ChatMessage => msg.role === 'assistant');
      if (!anchor) {
        anchor = {
          id: `subagent-recovery-${subagentId}`,
          role: 'assistant',
          content: '',
          timestamp: subagent.completedAt ?? subagent.startedAt ?? Date.now(),
          contentBlocks: [],
        };
        messages.push(anchor);
      }

      ensureTaskToolCall(anchor, subagentId, subagent);

      anchor.contentBlocks = anchor.contentBlocks || [];
      const hasSubagentBlock = anchor.contentBlocks.some(
        block => block.type === 'subagent' && block.subagentId === subagentId
      );
      if (!hasSubagentBlock) {
        anchor.contentBlocks.push({
          type: 'subagent',
          subagentId,
          mode: subagent.mode,
        });
      }
    }
  }

  private dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
    const seen = new Set<string>();
    const result: ChatMessage[] = [];

    for (const message of messages) {
      // Use message.id as primary key - more reliable than content-based deduplication
      // especially for tool-only messages or messages with identical content
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      result.push(message);
    }

    return result;
  }

  /**
   * Creates a new conversation and sets it as active.
   *
   * New conversations always use SDK-native storage.
   * The session ID may be captured after the first SDK response.
   */
  async createConversation(sessionId?: string): Promise<Conversation> {
    const conversationId = sessionId ?? this.generateConversationId();
    const conversation: Conversation = {
      id: conversationId,
      title: this.generateDefaultTitle(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: sessionId ?? null,
      sdkSessionId: sessionId ?? undefined,
      messages: [],
      isNative: true,
    };

    this.conversations.unshift(conversation);
    // Save new conversation (metadata only - SDK handles messages)
    await this.storage.sessions.saveMetadata(
      this.storage.sessions.toSessionMetadata(conversation)
    );

    return conversation;
  }

  /**
   * Switches to an existing conversation by ID.
   *
   * For native sessions, loads messages from SDK storage if not already loaded.
   */
  async switchConversation(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return null;

    await this.loadSdkMessagesForConversation(conversation);

    return conversation;
  }

  /**
   * Deletes a conversation and resets any tabs using it.
   *
   * For native sessions, deletes the metadata file and SDK session file.
   * For legacy sessions, deletes the JSONL file.
   */
  async deleteConversation(id: string): Promise<void> {
    const index = this.conversations.findIndex(c => c.id === id);
    if (index === -1) return;

    const conversation = this.conversations[index];
    this.conversations.splice(index, 1);

    const vaultPath = getVaultPath(this.app);
    const sdkSessionId = conversation.sdkSessionId ?? conversation.sessionId;
    if (vaultPath && sdkSessionId) {
      await deleteSDKSession(vaultPath, sdkSessionId);
    }

    if (conversation.isNative) {
      // Native session: delete metadata file
      await this.storage.sessions.deleteMetadata(id);
    } else {
      // Legacy session: delete JSONL file
      await this.storage.sessions.deleteConversation(id);
    }

    // Notify all views/tabs that have this conversation open
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      for (const tab of tabManager.getAllTabs()) {
        if (tab.conversationId === id) {
          tab.controllers.inputController?.cancelStreaming();
          await tab.controllers.conversationController?.createNew({ force: true });
        }
      }
    }
  }

  /** Renames a conversation. */
  async renameConversation(id: string, title: string): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    conversation.title = title.trim() || this.generateDefaultTitle();
    conversation.updatedAt = Date.now();

    if (conversation.isNative) {
      // Native session: save metadata only
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conversation)
      );
    } else {
      // Legacy session: save full JSONL
      await this.storage.sessions.saveConversation(conversation);
    }
  }

  /**
   * Updates conversation properties.
   *
   * For native sessions, saves metadata only (SDK handles messages including images).
   * For legacy sessions, saves full JSONL.
   *
   * Image data is cleared from memory after save (SDK/JSONL has persisted it),
   * except for pending fork conversations whose images aren't yet in SDK storage.
   */
  async updateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
    const conversation = this.conversations.find(c => c.id === id);
    if (!conversation) return;

    Object.assign(conversation, updates, { updatedAt: Date.now() });

    if (conversation.isNative) {
      // Native session: save metadata only (SDK handles messages including images)
      await this.storage.sessions.saveMetadata(
        this.storage.sessions.toSessionMetadata(conversation)
      );
    } else {
      // Legacy session: save full JSONL
      await this.storage.sessions.saveConversation(conversation);
    }

    // Clear image data from memory after save (data is persisted by SDK or JSONL).
    // Skip for pending forks: their deep-cloned images aren't in SDK storage yet.
    if (!this.isPendingFork(conversation)) {
      for (const msg of conversation.messages) {
        if (msg.images) {
          for (const img of msg.images) {
            img.data = '';
          }
        }
      }
    }
  }

  /**
   * Gets a conversation by ID from the in-memory cache.
   *
   * For native sessions, loads messages from SDK storage if not already loaded.
   */
  async getConversationById(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.find(c => c.id === id) || null;

    if (conversation) {
      await this.loadSdkMessagesForConversation(conversation);
    }

    return conversation;
  }

  /**
   * Gets a conversation by ID without loading SDK messages.
   * Use this for UI code that only needs metadata (title, etc.).
   */
  getConversationSync(id: string): Conversation | null {
    return this.conversations.find(c => c.id === id) || null;
  }

  /** Finds an existing empty conversation (no messages). */
  findEmptyConversation(): Conversation | null {
    return this.conversations.find(c => c.messages.length === 0) || null;
  }

  /** Returns conversation metadata list for the history dropdown. */
  getConversationList(): ConversationMeta[] {
    return this.conversations.map(c => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      lastResponseAt: c.lastResponseAt,
      messageCount: c.messages.length,
      preview: this.getConversationPreview(c),
      titleGenerationStatus: c.titleGenerationStatus,
      isNative: c.isNative,
    }));
  }

  /** Returns the active Codian view from workspace, if open. */
  getView(): CodianView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    if (leaves.length > 0) {
      return leaves[0].view as CodianView;
    }
    return null;
  }

  /** Returns all open Codian views in the workspace. */
  getAllViews(): CodianView[] {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
    return leaves.map(leaf => leaf.view as CodianView);
  }

  /**
   * Checks if a conversation is open in any Codian view.
   * Returns the view and tab if found, null otherwise.
   */
  findConversationAcrossViews(conversationId: string): { view: CodianView; tabId: string } | null {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (!tabManager) continue;

      const tabs = tabManager.getAllTabs();
      for (const tab of tabs) {
        if (tab.conversationId === conversationId) {
          return { view, tabId: tab.id };
        }
      }
    }
    return null;
  }

  /**
   * Gets SDK supported commands from any ready service.
   * The command list is the same for all services, so we just need one ready.
   * Used by inline edit and other contexts that don't have direct TabManager access.
   */
  async getSdkCommands(): Promise<SlashCommand[]> {
    for (const view of this.getAllViews()) {
      const tabManager = view.getTabManager();
      if (tabManager) {
        const commands = await tabManager.getSdkCommands();
        if (commands.length > 0) {
          return commands;
        }
      }
    }
    return [];
  }
}
