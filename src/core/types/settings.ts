/**
 * Settings type definitions.
 */

import type { Locale } from '../../i18n/types';
import type { AgentModel, ThinkingBudget } from './models';

const UNIX_BLOCKED_COMMANDS = [
  'rm -rf',
  'chmod 777',
  'chmod -R 777',
];

/** Platform-specific blocked commands (Windows - both CMD and PowerShell). */
const WINDOWS_BLOCKED_COMMANDS = [
  // CMD commands
  'del /s /q',
  'rd /s /q',
  'rmdir /s /q',
  'format',
  'diskpart',
  // PowerShell Remove-Item variants (full and abbreviated flags)
  'Remove-Item -Recurse -Force',
  'Remove-Item -Force -Recurse',
  'Remove-Item -r -fo',
  'Remove-Item -fo -r',
  'Remove-Item -Recurse',
  'Remove-Item -r',
  // PowerShell aliases for Remove-Item
  'ri -Recurse',
  'ri -r',
  'ri -Force',
  'ri -fo',
  'rm -r -fo',
  'rm -Recurse',
  'rm -Force',
  'del -Recurse',
  'del -Force',
  'erase -Recurse',
  'erase -Force',
  // PowerShell directory removal aliases
  'rd -Recurse',
  'rmdir -Recurse',
  // Dangerous disk/volume commands
  'Format-Volume',
  'Clear-Disk',
  'Initialize-Disk',
  'Remove-Partition',
];

export interface PlatformBlockedCommands {
  unix: string[];
  windows: string[];
}

export function getDefaultBlockedCommands(): PlatformBlockedCommands {
  return {
    unix: [...UNIX_BLOCKED_COMMANDS],
    windows: [...WINDOWS_BLOCKED_COMMANDS],
  };
}

export function getCurrentPlatformKey(): keyof PlatformBlockedCommands {
  return process.platform === 'win32' ? 'windows' : 'unix';
}

export function getCurrentPlatformBlockedCommands(commands: PlatformBlockedCommands): string[] {
  return commands[getCurrentPlatformKey()];
}

/**
 * Get blocked commands for the Bash tool.
 *
 * On Windows, the Bash tool runs in a Git Bash/MSYS2 environment but can still
 * invoke Windows commands (e.g., via `cmd /c` or `powershell`), so both Unix
 * and Windows blocklist patterns are merged.
 */
export function getBashToolBlockedCommands(commands: PlatformBlockedCommands): string[] {
  if (process.platform === 'win32') {
    return Array.from(new Set([...commands.unix, ...commands.windows]));
  }
  return getCurrentPlatformBlockedCommands(commands);
}

/**
 * Hostname-keyed CLI paths for per-device configuration.
 * Each device stores its path using its hostname as key.
 * This allows settings to sync across devices without conflicts.
 */
export type HostnameCliPaths = Record<string, string>;

export type ProviderId = 'codex' | 'deepseek';

export interface ProviderConfigBase {
  enabled: boolean;
}

export type CodexProviderConfig = ProviderConfigBase;

export interface DeepSeekProviderConfig extends ProviderConfigBase {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ProviderConfigs {
  codex: CodexProviderConfig;
  deepseek: DeepSeekProviderConfig;
}

/** Permission mode for tool execution. */
export type PermissionMode = 'yolo' | 'plan' | 'normal';

/** User decision from the approval modal. */
export type ApprovalDecision = 'allow' | 'allow-always' | 'deny' | 'cancel';

/**
 * Runtime permission rule string.
 * Format: "Tool(pattern)" or "Tool" for all
 * Examples: "Bash(git *)", "Read(*.md)", "WebFetch(domain:github.com)"
 */
export type PermissionRule = string & { readonly __brand: 'PermissionRule' };

/**
 * Create a PermissionRule from a string.
 * @internal Prefer this helper over direct casts.
 */
export function createPermissionRule(rule: string): PermissionRule {
  return rule as PermissionRule;
}

/**
 * Tool permission rules stored by Codian.
 */
export interface RuntimePermissions {
  /** Rules that auto-approve tool actions */
  allow?: PermissionRule[];
  /** Rules that auto-deny tool actions (highest persistent priority) */
  deny?: PermissionRule[];
  /** Rules that always prompt for confirmation */
  ask?: PermissionRule[];
  /** Default permission mode */
  defaultMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
  /** Additional directories to include in permission scope */
  additionalDirectories?: string[];
}

/**
 * Runtime settings stored in .codian/settings.json.
 */
export interface RuntimeSettings {
  /** Tool permissions */
  permissions?: RuntimePermissions;
}

/** Saved environment variable configuration. */
export interface EnvSnippet {
  id: string;
  name: string;
  description: string;
  envVars: string;
  contextLimits?: Record<string, number>;  // Optional: context limits for custom models
}

/** Source of a slash command. */
export type SlashCommandSource = 'builtin' | 'user' | 'plugin' | 'runtime';

/** Slash command configuration with Codex compatibility. */
export interface SlashCommand {
  id: string;
  name: string;                // Command name used after / (e.g., "review-code")
  description?: string;        // Optional description shown in dropdown
  argumentHint?: string;       // Placeholder text for arguments (e.g., "[file] [focus]")
  allowedTools?: string[];     // Restrict tools when command is used
  model?: AgentModel;          // Override model for this command
  content: string;             // Prompt template with placeholders
  source?: SlashCommandSource; // Origin of the command (builtin, user, plugin, runtime)
  // Skill fields (from .codian/skills/ definitions)
  disableModelInvocation?: boolean;  // Disable model invocation for this skill
  userInvocable?: boolean;           // Whether user can invoke this skill directly
  context?: 'fork';                  // Subagent execution mode
  agent?: string;                    // Subagent type when context='fork'
  hooks?: Record<string, unknown>;   // Pass-through to Runtime
}

/** Keyboard navigation settings for vim-style scrolling. */
export interface KeyboardNavigationSettings {
  scrollUpKey: string;         // Key to scroll up when focused on messages (default: 'w')
  scrollDownKey: string;       // Key to scroll down when focused on messages (default: 's')
  focusInputKey: string;       // Key to focus input (default: 'i', like vim insert mode)
}

/** Tab bar position setting. */
export type TabBarPosition = 'input' | 'header';

/**
 * Codian-specific settings stored in .codian/codian-settings.json.
 * These settings are NOT shared with Codian runtime.
 */
export interface CodianSettings {
  // User preferences
  userName: string;

  // Security (Codian-specific, runtime uses permissions.deny instead)
  enableBlocklist: boolean;
  blockedCommands: PlatformBlockedCommands;
  permissionMode: PermissionMode;

  // Model & thinking (Codian uses enum, runtime uses full model ID string)
  currentProvider: ProviderId;
  providerConfigs: ProviderConfigs;
  model: AgentModel;
  thinkingBudget: ThinkingBudget;
  enableAutoTitleGeneration: boolean;
  titleGenerationModel: string;  // Model for auto title generation (empty = auto)
  allowExternalAccess: boolean;  // Allow tools to access files outside the vault
  temporaryExternalAccess?: boolean;  // Transient per-turn external access; never a persisted user setting
  enableBangBash: boolean;  // Enable ! bash mode for direct command execution
  enableDeepSeekBash: boolean;  // Allow DeepSeek tool loop to execute local Bash commands

  // Content settings
  excludedTags: string[];
  mediaFolder: string;
  systemPrompt: string;
  strongRulesFilePath: string;
  strongRulesPrompt: string;
  memoryFilePath: string;
  enableLocalMemory: boolean;
  localMemoryPath: string;
  allowedExportPaths: string[];
  persistentExternalContextPaths: string[];  // Paths that persist across all sessions

  // Environment (string format, runtime uses object format in settings.json)
  environmentVariables: string;
  envSnippets: EnvSnippet[];
  /**
   * Custom context window limits for models configured via environment variables.
   * Keys are model IDs from the active model catalog or model override variables.
   * Values are token counts in range [1000, 10000000].
   * Empty object means all models use the standard context limit.
   */
  customContextLimits: Record<string, number>;

  // UI settings
  keyboardNavigation: KeyboardNavigationSettings;

  // Internationalization
  locale: Locale;  // UI language setting

  // CLI paths
  codexCliPathsByHost: HostnameCliPaths;

  // State (merged from data.json)
  lastCodexModel?: AgentModel;
  lastCustomModel?: AgentModel;
  lastEnvHash?: string;

  // Slash commands (loaded separately from .codian/commands/)
  slashCommands: SlashCommand[];

  // UI preferences
  maxTabs: number;  // Maximum number of chat tabs (3-10, default 3)
  tabBarPosition: TabBarPosition;  // Where to show tab bar ('input' or 'header')
  enableAutoScroll: boolean;  // Enable auto-scroll during streaming (default: true)
  openInMainTab: boolean;  // Open chat panel in main editor area instead of sidebar

  // Slash commands
  hiddenSlashCommands: string[];  // Command names to hide from dropdown (user preference)
}

/** Default Codian-specific settings. */
export const DEFAULT_SETTINGS: CodianSettings = {
  // User preferences
  userName: '',

  // Security
  enableBlocklist: true,
  blockedCommands: getDefaultBlockedCommands(),
  permissionMode: 'normal',

  // Model & thinking
  currentProvider: 'codex',
  providerConfigs: {
    codex: {
      enabled: true,
    },
    deepseek: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    },
  },
  model: 'gpt-5.6-sol',
  thinkingBudget: 'low',
  enableAutoTitleGeneration: true,
  titleGenerationModel: '',  // Empty = auto (OPENAI_MODEL / CODEX_MODEL / gpt-5.6-sol)
  allowExternalAccess: false,  // Keep vault restriction enabled by default
  enableBangBash: false,  // Disabled by default
  enableDeepSeekBash: false,  // Disabled by default

  // Content settings
  excludedTags: [],
  mediaFolder: '',
  systemPrompt: '',
  strongRulesFilePath: '',
  strongRulesPrompt: '',
  memoryFilePath: '',
  enableLocalMemory: true,
  localMemoryPath: '.codian/local-memory',
  allowedExportPaths: ['~/Desktop', '~/Downloads'],
  persistentExternalContextPaths: [],

  // Environment
  environmentVariables: '',
  envSnippets: [],
  customContextLimits: {},

  // UI settings
  keyboardNavigation: {
    scrollUpKey: 'w',
    scrollDownKey: 's',
    focusInputKey: 'i',
  },

  // Internationalization
  locale: 'en',  // Default to English

  // CLI paths
  codexCliPathsByHost: {},

  lastCodexModel: 'gpt-5.6-sol',
  lastCustomModel: '',
  lastEnvHash: '',

  // Slash commands (loaded separately)
  slashCommands: [],

  // UI preferences
  maxTabs: 3,  // Default to 3 tabs (safe resource usage)
  tabBarPosition: 'input',  // Default to input mode (current behavior)
  enableAutoScroll: true,  // Default to auto-scroll enabled
  openInMainTab: false,  // Default to sidebar (current behavior)

  // Slash commands
  hiddenSlashCommands: [],  // No commands hidden by default
};

/** Default runtime permission settings. */
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  permissions: {
    allow: [],
    deny: [],
    ask: [],
  },
};

/** Default runtime permissions. */
export const DEFAULT_RUNTIME_PERMISSIONS: RuntimePermissions = {
  allow: [],
  deny: [],
  ask: [],
};

/** Result from instruction refinement agent query. */
export interface InstructionRefineResult {
  success: boolean;
  refinedInstruction?: string;  // The refined instruction text
  clarification?: string;       // Agent's clarifying question (if any)
  error?: string;               // Error message (if failed)
}
