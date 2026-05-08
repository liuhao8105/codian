import * as fs from 'fs';
import type { App } from 'obsidian';
import { Notice, PluginSettingTab, Setting } from 'obsidian';

import type { ProviderId } from '../../core/types';
import { getCurrentPlatformKey, getHostnameKey } from '../../core/types';
import { DEFAULT_CODEX_MODELS } from '../../core/types/models';
import { getAvailableLocales, getLocaleDisplayName, setLocale, t } from '../../i18n';
import type { Locale, TranslationKey } from '../../i18n/types';
import type CodianPlugin from '../../main';
import { findNodeExecutable, formatContextLimit, getCustomModelIds, getEnhancedPath, getModelsFromEnvironment, parseContextLimit, parseEnvironmentVariables } from '../../utils/env';
import { expandHomePath } from '../../utils/path';
import { CodianView } from '../chat/CodianView';
import { buildNavMappingText, parseNavMappings } from './keyboardNavigation';
import { AgentSettings } from './ui/AgentSettings';
import { EnvSnippetManager } from './ui/EnvSnippetManager';
import { McpSettingsManager } from './ui/McpSettingsManager';
import { PluginSettingsManager } from './ui/PluginSettingsManager';
import { SlashCommandSettings } from './ui/SlashCommandSettings';

function formatHotkey(hotkey: { modifiers: string[]; key: string }): string {
  const isMac = navigator.platform.includes('Mac');
  const modMap: Record<string, string> = isMac
    ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
    : { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

  const mods = hotkey.modifiers.map((m) => modMap[m] || m);
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;

  return isMac ? [...mods, key].join('') : [...mods, key].join('+');
}

export { CodianSettingTab as ClaudianSettingTab };

function openHotkeySettings(app: App): void {
  const setting = (app as any).setting;
  setting.open();
  setting.openTabById('hotkeys');
  setTimeout(() => {
    const tab = setting.activeTab;
    if (tab) {
      // Handle both old and new Obsidian versions
      const searchEl = tab.searchInputEl ?? tab.searchComponent?.inputEl;
      if (searchEl) {
        searchEl.value = 'Codian';
        tab.updateHotkeyVisibility?.();
      }
    }
  }, 100);
}

function getHotkeyForCommand(app: App, commandId: string): string | null {
  const hotkeyManager = (app as any).hotkeyManager;
  if (!hotkeyManager) return null;

  const customHotkeys = hotkeyManager.customKeys?.[commandId];
  const defaultHotkeys = hotkeyManager.defaultKeys?.[commandId];
  const hotkeys = customHotkeys?.length > 0 ? customHotkeys : defaultHotkeys;

  if (!hotkeys || hotkeys.length === 0) return null;

  return hotkeys.map(formatHotkey).join(', ');
}

function addHotkeySettingRow(
  containerEl: HTMLElement,
  app: App,
  commandId: string,
  translationPrefix: string
): void {
  const hotkey = getHotkeyForCommand(app, commandId);
  const item = containerEl.createDiv({ cls: 'codian-hotkey-item' });
  item.createSpan({ cls: 'codian-hotkey-name', text: t(`${translationPrefix}.name` as TranslationKey) });
  if (hotkey) {
    item.createSpan({ cls: 'codian-hotkey-badge', text: hotkey });
  }
  item.addEventListener('click', () => openHotkeySettings(app));
}

export class CodianSettingTab extends PluginSettingTab {
  plugin: CodianPlugin;
  private contextLimitsContainer: HTMLElement | null = null;

  constructor(app: App, plugin: CodianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('codian-settings');

    setLocale(this.plugin.settings.locale);

    new Setting(containerEl)
      .setName(t('settings.language.name'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((dropdown) => {
        const locales = getAvailableLocales();
        for (const locale of locales) {
          dropdown.addOption(locale, getLocaleDisplayName(locale));
        }
        dropdown
          .setValue(this.plugin.settings.locale)
          .onChange(async (value: Locale) => {
            if (!setLocale(value)) {
              // Invalid locale - reset dropdown to current value
              dropdown.setValue(this.plugin.settings.locale);
              return;
            }
            this.plugin.settings.locale = value;
            await this.plugin.saveSettings();
            // Re-render the entire settings page with new language
            this.display();
          });
      });

    new Setting(containerEl).setName(t('settings.customization')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.userName.name'))
      .setDesc(t('settings.userName.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.userName.name'))
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.excludedTags.name'))
      .setDesc(t('settings.excludedTags.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder('system\nprivate\ndraft')
          .setValue(this.plugin.settings.excludedTags.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.excludedTags = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^#/, ''))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    new Setting(containerEl)
      .setName(t('settings.mediaFolder.name'))
      .setDesc(t('settings.mediaFolder.desc'))
      .addText((text) => {
        text
          .setPlaceholder('attachments')
          .setValue(this.plugin.settings.mediaFolder)
          .onChange(async (value) => {
            this.plugin.settings.mediaFolder = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass('codian-settings-media-input');
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.systemPrompt.name'))
      .setDesc(t('settings.systemPrompt.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.systemPrompt.name'))
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.strongRulesFilePath.name'))
      .setDesc(t('settings.strongRulesFilePath.desc'))
      .addText((text) => {
        text
          .setPlaceholder('profiles/user-memory.md')
          .setValue(this.plugin.settings.strongRulesFilePath ?? '')
          .onChange(async (value) => {
            this.plugin.settings.strongRulesFilePath = value.trim();
            if (!this.plugin.settings.strongRulesFilePath) {
              this.plugin.settings.strongRulesPrompt = '';
            }
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass('codian-settings-media-input');
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName(t('settings.memoryFilePath.name'))
      .setDesc(t('settings.memoryFilePath.desc'))
      .addText((text) => {
        text
          .setPlaceholder('profiles/user-memory.md')
          .setValue(this.plugin.settings.memoryFilePath ?? '')
          .onChange(async (value) => {
            this.plugin.settings.memoryFilePath = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addClass('codian-settings-media-input');
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    new Setting(containerEl)
      .setName('本地记忆')
      .setDesc('在当前 Obsidian 仓库内保存和召回记忆，不上传云端。可用 /remember 保存，/recall 搜索。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableLocalMemory !== false)
          .onChange(async (value) => {
            this.plugin.settings.enableLocalMemory = value;
            this.plugin.storage.localMemory.setBasePath(this.plugin.settings.localMemoryPath || '.claude/local-memory');
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('本地记忆目录')
      .setDesc('保存本地记忆的仓库内目录。默认 .claude/local-memory。')
      .addText((text) => {
        text
          .setPlaceholder('.claude/local-memory')
          .setValue(this.plugin.settings.localMemoryPath || '.claude/local-memory')
          .onChange(async (value) => {
            this.plugin.settings.localMemoryPath = value.trim() || '.claude/local-memory';
            this.plugin.storage.localMemory.setBasePath(this.plugin.settings.localMemoryPath);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t('settings.enableAutoScroll.name'))
      .setDesc(t('settings.enableAutoScroll.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoScroll ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoScroll = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t('settings.autoTitle.name'))
      .setDesc(t('settings.autoTitle.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoTitleGeneration)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoTitleGeneration = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.enableAutoTitleGeneration) {
      new Setting(containerEl)
        .setName(t('settings.titleModel.name'))
        .setDesc(t('settings.titleModel.desc'))
        .addDropdown((dropdown) => {
          // Add "Auto" option (empty string = use default logic)
          dropdown.addOption('', t('settings.titleModel.auto'));

          // Get available models from environment or defaults
          const envVars = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
          const customModels = getModelsFromEnvironment(envVars);
          const models = customModels.length > 0 ? customModels : DEFAULT_CODEX_MODELS;

          for (const model of models) {
            dropdown.addOption(model.value, model.label);
          }

          dropdown
            .setValue(this.plugin.settings.titleGenerationModel || '')
            .onChange(async (value) => {
              this.plugin.settings.titleGenerationModel = value;
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName(t('settings.navMappings.name'))
      .setDesc(t('settings.navMappings.desc'))
      .addTextArea((text) => {
        let pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
        let saveTimeout: number | null = null;

        const commitValue = async (showError: boolean): Promise<void> => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
            saveTimeout = null;
          }

          const result = parseNavMappings(pendingValue);
          if (!result.settings) {
            if (showError) {
              new Notice(`${t('common.error')}: ${result.error}`);
              pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
              text.setValue(pendingValue);
            }
            return;
          }

          this.plugin.settings.keyboardNavigation.scrollUpKey = result.settings.scrollUp;
          this.plugin.settings.keyboardNavigation.scrollDownKey = result.settings.scrollDown;
          this.plugin.settings.keyboardNavigation.focusInputKey = result.settings.focusInput;
          await this.plugin.saveSettings();
          pendingValue = buildNavMappingText(this.plugin.settings.keyboardNavigation);
          text.setValue(pendingValue);
        };

        const scheduleSave = (): void => {
          if (saveTimeout !== null) {
            window.clearTimeout(saveTimeout);
          }
          saveTimeout = window.setTimeout(() => {
            void commitValue(false);
          }, 500);
        };

        text
          .setPlaceholder('map w scrollUp\nmap s scrollDown\nmap i focusInput')
          .setValue(pendingValue)
          .onChange((value) => {
            pendingValue = value;
            scheduleSave();
          });

        text.inputEl.rows = 3;
        text.inputEl.addEventListener('blur', async () => {
          await commitValue(true);
        });
      });

    // Tab bar position setting
    new Setting(containerEl)
      .setName(t('settings.tabBarPosition.name'))
      .setDesc(t('settings.tabBarPosition.desc'))
      .addDropdown((dropdown) => {
        dropdown
          .addOption('input', t('settings.tabBarPosition.input'))
          .addOption('header', t('settings.tabBarPosition.header'))
          .setValue(this.plugin.settings.tabBarPosition ?? 'input')
          .onChange(async (value: 'input' | 'header') => {
            this.plugin.settings.tabBarPosition = value;
            await this.plugin.saveSettings();

            // Update all views' layouts immediately
            for (const leaf of this.plugin.app.workspace.getLeavesOfType('codian-view')) {
              if (leaf.view instanceof CodianView) {
                leaf.view.updateLayoutForPosition();
              }
            }
          });
      });
 
    // Open in main tab setting
    new Setting(containerEl)
      .setName(t('settings.openInMainTab.name'))
      .setDesc(t('settings.openInMainTab.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.openInMainTab)
          .onChange(async (value) => {
            this.plugin.settings.openInMainTab = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName(t('settings.hotkeys')).setHeading();

    const hotkeyGrid = containerEl.createDiv({ cls: 'codian-hotkey-grid' });
    addHotkeySettingRow(hotkeyGrid, this.app, 'codian:inline-edit', 'settings.inlineEditHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'codian:open-view', 'settings.openChatHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'codian:new-session', 'settings.newSessionHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'codian:new-tab', 'settings.newTabHotkey');
    addHotkeySettingRow(hotkeyGrid, this.app, 'codian:close-current-tab', 'settings.closeTabHotkey');

    new Setting(containerEl).setName(t('settings.slashCommands.name')).setHeading();

    const slashCommandsDesc = containerEl.createDiv({ cls: 'codian-sp-settings-desc' });
    const descP = slashCommandsDesc.createEl('p', { cls: 'setting-item-description' });
    descP.appendText(t('settings.slashCommands.desc') + ' ');
    descP.createEl('a', {
      text: 'Learn more',
      href: 'https://help.openai.com/en/articles/11096431-openai-codex-ci-getting-started',
    });

    const slashCommandsContainer = containerEl.createDiv({ cls: 'codian-slash-commands-container' });
    new SlashCommandSettings(slashCommandsContainer, this.plugin);

    new Setting(containerEl)
      .setName(t('settings.hiddenSlashCommands.name'))
      .setDesc(t('settings.hiddenSlashCommands.desc'))
      .addTextArea((text) => {
        text
          .setPlaceholder(t('settings.hiddenSlashCommands.placeholder'))
          .setValue((this.plugin.settings.hiddenSlashCommands || []).join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.hiddenSlashCommands = value
              .split(/\r?\n/)
              .map((s) => s.trim().replace(/^\//, ''))
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
            this.plugin.getView()?.updateHiddenSlashCommands();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 30;
      });

    this.renderSubagentsSection(containerEl);
    this.renderMcpSection(containerEl);

    new Setting(containerEl).setName(t('settings.safety')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.enableBlocklist.name'))
      .setDesc(t('settings.enableBlocklist.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBlocklist)
          .onChange(async (value) => {
            this.plugin.settings.enableBlocklist = value;
            await this.plugin.saveSettings();
          })
      );

    const platformKey = getCurrentPlatformKey();
    const isWindows = platformKey === 'windows';
    const platformLabel = isWindows ? 'Windows' : 'Unix';

    new Setting(containerEl)
      .setName(t('settings.blockedCommands.name', { platform: platformLabel }))
      .setDesc(t('settings.blockedCommands.desc', { platform: platformLabel }))
      .addTextArea((text) => {
        const placeholder = isWindows
          ? 'del /s /q\nrd /s /q\nRemove-Item -Recurse -Force'
          : 'rm -rf\nchmod 777\nmkfs';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.blockedCommands[platformKey].join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.blockedCommands[platformKey] = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
      });

    // On Windows, show Unix blocklist too since Git Bash can run Unix commands
    if (isWindows) {
      new Setting(containerEl)
        .setName(t('settings.blockedCommands.unixName'))
        .setDesc(t('settings.blockedCommands.unixDesc'))
        .addTextArea((text) => {
          text
            .setPlaceholder('rm -rf\nchmod 777\nmkfs')
            .setValue(this.plugin.settings.blockedCommands.unix.join('\n'))
            .onChange(async (value) => {
              this.plugin.settings.blockedCommands.unix = value
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              await this.plugin.saveSettings();
            });
          text.inputEl.rows = 4;
          text.inputEl.cols = 40;
        });
    }

    new Setting(containerEl)
      .setName(t('settings.exportPaths.name'))
      .setDesc(t('settings.exportPaths.desc'))
      .addTextArea((text) => {
        const placeholder = process.platform === 'win32'
          ? '~/Desktop\n~/Downloads\n%TEMP%'
          : '~/Desktop\n~/Downloads\n/tmp';
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings.allowedExportPaths.join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.allowedExportPaths = value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.cols = 40;
        text.inputEl.addEventListener('blur', () => this.restartServiceForPromptChange());
      });

    const saveDeepSeekConfig = async (): Promise<void> => {
      await this.plugin.saveSettings();
      if (this.plugin.settings.currentProvider === 'deepseek') {
        await this.plugin.refreshRuntimeEnvironmentFromSettings();
        this.renderContextLimitsSection();
      }
    };

    new Setting(containerEl).setName('Provider 与模型').setHeading();

    let rebuildProviderDropdown: (() => void) | null = null;

    new Setting(containerEl)
      .setName('当前 Provider')
      .setDesc('选择当前聊天默认使用的模型服务。第一版支持 Codex 和 DeepSeek。')
      .addDropdown((dropdown) => {
        rebuildProviderDropdown = () => {
          while (dropdown.selectEl.options.length > 0) {
            dropdown.selectEl.remove(0);
          }
          dropdown.addOption('codex', 'Codex');
          if (this.plugin.settings.providerConfigs.deepseek.enabled) {
            dropdown.addOption('deepseek', 'DeepSeek');
          }
          dropdown.setValue(this.plugin.settings.currentProvider);
        };
        rebuildProviderDropdown();

        dropdown.onChange(async (value: ProviderId) => {
          try {
            await this.plugin.setCurrentProvider(value);
            dropdown.setValue(this.plugin.settings.currentProvider);
            this.renderContextLimitsSection();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : 'Provider 切换失败。');
            dropdown.setValue(this.plugin.settings.currentProvider);
          }
        });
      });

    new Setting(containerEl)
      .setName('启用 DeepSeek')
      .setDesc('启用后，聊天工具栏里可以切换到 DeepSeek。启用是使用 DeepSeek 的前提条件。')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.providerConfigs.deepseek.enabled)
          .onChange(async (value) => {
            this.plugin.settings.providerConfigs.deepseek.enabled = value;
            if (!value && this.plugin.settings.currentProvider === 'deepseek') {
              await this.plugin.setCurrentProvider('codex');
            }
            await this.plugin.saveSettings();
            this.plugin.getView()?.refreshToolbarState();
            rebuildProviderDropdown?.();
          })
      );

    new Setting(containerEl)
      .setName('DeepSeek API Key')
      .setDesc('用于访问 DeepSeek 的密钥。仅保存在当前仓库设置中。')
      .addText((text) => {
        text
          .setPlaceholder('sk-...')
          .setValue(this.plugin.settings.providerConfigs.deepseek.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.providerConfigs.deepseek.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
        text.inputEl.addEventListener('blur', () => {
          void saveDeepSeekConfig();
        });
      });

    new Setting(containerEl)
      .setName('DeepSeek Base URL')
      .setDesc('不要直接填 `https://api.deepseek.com/v1`。当前 Codex App Server 需要支持 `/v1/responses` 的 OpenAI 兼容网关。')
      .addText((text) => {
        text
          .setPlaceholder('https://your-gateway.example.com/v1')
          .setValue(this.plugin.settings.providerConfigs.deepseek.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.providerConfigs.deepseek.baseUrl = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener('blur', () => {
          void saveDeepSeekConfig();
        });
      });

    new Setting(containerEl)
      .setName('DeepSeek 默认模型')
      .setDesc('填写你的兼容网关实际支持的模型名，例如 `deepseek-v4-flash`。')
      .addText((text) => {
        text
          .setPlaceholder('deepseek-v4-flash')
          .setValue(this.plugin.settings.providerConfigs.deepseek.model)
          .onChange(async (value) => {
            this.plugin.settings.providerConfigs.deepseek.model = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.addEventListener('blur', () => {
          void saveDeepSeekConfig();
        });
      });

    new Setting(containerEl).setName(t('settings.environment')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.customVariables.name'))
      .setDesc('高级覆盖区：用于兼容特殊场景或手动覆盖 Provider 生成的环境变量。')
      .addTextArea((text) => {
        text
          .setPlaceholder('OPENAI_API_KEY=your-key\nOPENAI_BASE_URL=https://api.example.com/v1\nCODEX_MODEL=gpt-5')
          .setValue(this.plugin.settings.environmentVariables);
        text.inputEl.rows = 6;
        text.inputEl.cols = 50;
        text.inputEl.addClass('codian-settings-env-textarea');
        text.inputEl.addEventListener('blur', async () => {
          await this.plugin.applyEnvironmentVariables(text.inputEl.value);
          this.renderContextLimitsSection();
        });
      });

    this.contextLimitsContainer = containerEl.createDiv({ cls: 'codian-context-limits-container' });
    this.renderContextLimitsSection();

    const envSnippetsContainer = containerEl.createDiv({ cls: 'codian-env-snippets-container' });
    new EnvSnippetManager(envSnippetsContainer, this.plugin, () => {
      this.renderContextLimitsSection();
    });

    new Setting(containerEl).setName(t('settings.advanced')).setHeading();

    new Setting(containerEl)
      .setName(t('settings.enableBangBash.name'))
      .setDesc(t('settings.enableBangBash.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableBangBash ?? false)
          .onChange(async (value) => {
            bangBashValidationEl.style.display = 'none';
            if (value) {
              const enhancedPath = getEnhancedPath();
              const nodePath = findNodeExecutable(enhancedPath);
              if (!nodePath) {
                bangBashValidationEl.setText(t('settings.enableBangBash.validation.noNode'));
                bangBashValidationEl.style.display = 'block';
                toggle.setValue(false);
                return;
              }
            }
            this.plugin.settings.enableBangBash = value;
            await this.plugin.saveSettings();
          })
      );

    const bangBashValidationEl = containerEl.createDiv({ cls: 'codian-bang-bash-validation' });
    bangBashValidationEl.style.color = 'var(--text-error)';
    bangBashValidationEl.style.fontSize = '0.85em';
    bangBashValidationEl.style.marginTop = '-0.5em';
    bangBashValidationEl.style.marginBottom = '0.5em';
    bangBashValidationEl.style.display = 'none';

    const maxTabsSetting = new Setting(containerEl)
      .setName(t('settings.maxTabs.name'))
      .setDesc(t('settings.maxTabs.desc'));

    const maxTabsWarningEl = containerEl.createDiv({ cls: 'codian-max-tabs-warning' });
    maxTabsWarningEl.style.color = 'var(--text-warning)';
    maxTabsWarningEl.style.fontSize = '0.85em';
    maxTabsWarningEl.style.marginTop = '-0.5em';
    maxTabsWarningEl.style.marginBottom = '0.5em';
    maxTabsWarningEl.style.display = 'none';
    maxTabsWarningEl.setText(t('settings.maxTabs.warning'));

    const updateMaxTabsWarning = (value: number): void => {
      maxTabsWarningEl.style.display = value > 5 ? 'block' : 'none';
    };

    maxTabsSetting.addSlider((slider) => {
      slider
        .setLimits(3, 10, 1)
        .setValue(this.plugin.settings.maxTabs ?? 3)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxTabs = value;
          await this.plugin.saveSettings();
          updateMaxTabsWarning(value);
        });
      updateMaxTabsWarning(this.plugin.settings.maxTabs ?? 3);
    });

    const hostnameKey = getHostnameKey();

    const platformDesc = process.platform === 'win32'
      ? t('settings.cliPath.descWindows')
      : t('settings.cliPath.descUnix');
    const cliPathDescription = `${t('settings.cliPath.desc')} ${platformDesc}`;

    const cliPathSetting = new Setting(containerEl)
      .setName(`${t('settings.cliPath.name')} (${hostnameKey})`)
      .setDesc(cliPathDescription);

    const validationEl = containerEl.createDiv({ cls: 'codian-cli-path-validation' });
    validationEl.style.color = 'var(--text-error)';
    validationEl.style.fontSize = '0.85em';
    validationEl.style.marginTop = '-0.5em';
    validationEl.style.marginBottom = '0.5em';
    validationEl.style.display = 'none';

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null; // Empty is valid (auto-detect)

      const expandedPath = expandHomePath(trimmed);

      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist');
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
      return null;
    };

    cliPathSetting.addText((text) => {
      const placeholder = process.platform === 'win32'
        ? 'C:\\path\\to\\codex.exe'
        : '/usr/local/bin/codex';

      const currentValue = this.plugin.settings.claudeCliPathsByHost?.[hostnameKey] || '';

      text
        .setPlaceholder(placeholder)
        .setValue(currentValue)
        .onChange(async (value) => {
          const error = validatePath(value);
          if (error) {
            validationEl.setText(error);
            validationEl.style.display = 'block';
            text.inputEl.style.borderColor = 'var(--text-error)';
          } else {
            validationEl.style.display = 'none';
            text.inputEl.style.borderColor = '';
          }

          const trimmed = value.trim();
          if (!this.plugin.settings.claudeCliPathsByHost) {
            this.plugin.settings.claudeCliPathsByHost = {};
          }
          this.plugin.settings.claudeCliPathsByHost[hostnameKey] = trimmed;
          await this.plugin.saveSettings();
          this.plugin.cliResolver?.reset();
          const view = this.plugin.getView();
          await view?.getTabManager()?.broadcastToAllTabs(
            (service) => Promise.resolve(service.cleanup())
          );
        });
      text.inputEl.addClass('codian-settings-cli-path-input');
      text.inputEl.style.width = '100%';

      const initialError = validatePath(currentValue);
      if (initialError) {
        validationEl.setText(initialError);
        validationEl.style.display = 'block';
        text.inputEl.style.borderColor = 'var(--text-error)';
      }
    });

    this.renderCompatibilitySection(containerEl);
  }

  private renderCompatibilitySection(containerEl: HTMLElement): void {
    const details = containerEl.createEl('details', {
      cls: 'codian-settings-compatibility',
    });

    if (this.plugin.settings.loadUserClaudeSettings || this.plugin.settings.enableChrome) {
      details.open = true;
    }

    const summary = details.createEl('summary', {
      text: t('settings.plugins.name'),
      cls: 'codian-settings-compatibility-summary',
    });
    summary.setAttr('aria-label', t('settings.plugins.name'));

    const desc = details.createDiv({ cls: 'codian-sp-settings-desc' });
    desc.createEl('p', {
      text: t('settings.plugins.desc'),
      cls: 'setting-item-description',
    });

    const legacySettingsContainer = details.createDiv();
    new Setting(legacySettingsContainer)
      .setName(t('settings.loadUserSettings.name'))
      .setDesc(t('settings.loadUserSettings.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.loadUserClaudeSettings)
          .onChange(async (value) => {
            this.plugin.settings.loadUserClaudeSettings = value;
            await this.plugin.saveSettings();
          })
      );

    const pluginsHeading = details.createDiv({ cls: 'codian-plugin-settings-desc' });
    pluginsHeading.createEl('p', {
      text: t('settings.plugins.desc'),
      cls: 'setting-item-description',
    });

    const pluginsContainer = details.createDiv({ cls: 'codian-plugins-container' });
    new PluginSettingsManager(pluginsContainer, this.plugin);

    const chromeSettingsContainer = details.createDiv();
    new Setting(chromeSettingsContainer)
      .setName(t('settings.enableChrome.name'))
      .setDesc(t('settings.enableChrome.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableChrome ?? false)
          .onChange(async (value) => {
            this.plugin.settings.enableChrome = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderSubagentsSection(containerEl: HTMLElement): void {
    const details = containerEl.createEl('details', {
      cls: 'codian-settings-subagents',
    });

    const summary = details.createEl('summary', {
      text: t('settings.subagents.name'),
      cls: 'codian-settings-compatibility-summary',
    });
    summary.setAttr('aria-label', t('settings.subagents.name'));

    const agentsDesc = details.createDiv({ cls: 'codian-sp-settings-desc' });
    agentsDesc.createEl('p', {
      text: t('settings.subagents.desc'),
      cls: 'setting-item-description',
    });

    const agentsContainer = details.createDiv({ cls: 'codian-agents-container' });
    new AgentSettings(agentsContainer, this.plugin);
  }

  private renderMcpSection(containerEl: HTMLElement): void {
    const details = containerEl.createEl('details', {
      cls: 'codian-settings-mcp',
    });

    const summary = details.createEl('summary', {
      text: t('settings.mcpServers.name'),
      cls: 'codian-settings-compatibility-summary',
    });
    summary.setAttr('aria-label', t('settings.mcpServers.name'));

    const mcpDesc = details.createDiv({ cls: 'codian-mcp-settings-desc' });
    mcpDesc.createEl('p', {
      text: t('settings.mcpServers.desc'),
      cls: 'setting-item-description',
    });

    const mcpContainer = details.createDiv({ cls: 'codian-mcp-container' });
    new McpSettingsManager(mcpContainer, this.plugin);
  }

  private renderContextLimitsSection(): void {
    const container = this.contextLimitsContainer;
    if (!container) return;

    container.empty();

    const envVars = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const uniqueModelIds = getCustomModelIds(envVars);

    if (uniqueModelIds.size === 0) {
      return;
    }

    const headerEl = container.createDiv({ cls: 'codian-context-limits-header' });
    headerEl.createSpan({ text: t('settings.customContextLimits.name'), cls: 'codian-context-limits-label' });

    const descEl = container.createDiv({ cls: 'codian-context-limits-desc' });
    descEl.setText(t('settings.customContextLimits.desc'));

    const listEl = container.createDiv({ cls: 'codian-context-limits-list' });

    for (const modelId of uniqueModelIds) {
      const currentValue = this.plugin.settings.customContextLimits?.[modelId];

      const itemEl = listEl.createDiv({ cls: 'codian-context-limits-item' });

      const nameEl = itemEl.createDiv({ cls: 'codian-context-limits-model' });
      nameEl.setText(modelId);

      const inputWrapper = itemEl.createDiv({ cls: 'codian-context-limits-input-wrapper' });

      const inputEl = inputWrapper.createEl('input', {
        type: 'text',
        placeholder: '200k',
        cls: 'codian-context-limits-input',
        value: currentValue ? formatContextLimit(currentValue) : '',
      });

      // Validation element
      const validationEl = inputWrapper.createDiv({ cls: 'codian-context-limit-validation' });

      inputEl.addEventListener('input', async () => {
        const trimmed = inputEl.value.trim();

        if (!this.plugin.settings.customContextLimits) {
          this.plugin.settings.customContextLimits = {};
        }

        if (!trimmed) {
          // Empty = use default (remove from custom limits)
          delete this.plugin.settings.customContextLimits[modelId];
          validationEl.style.display = 'none';
          inputEl.classList.remove('codian-input-error');
        } else {
          const parsed = parseContextLimit(trimmed);
          if (parsed === null) {
            validationEl.setText(t('settings.customContextLimits.invalid'));
            validationEl.style.display = 'block';
            inputEl.classList.add('codian-input-error');
            return; // Don't save invalid value
          }

          this.plugin.settings.customContextLimits[modelId] = parsed;
          validationEl.style.display = 'none';
          inputEl.classList.remove('codian-input-error');
        }

        await this.plugin.saveSettings();
      });
    }
  }

  private async restartServiceForPromptChange(): Promise<void> {
    const view = this.plugin.getView();
    const tabManager = view?.getTabManager();
    if (!tabManager) return;

    try {
      await tabManager.broadcastToAllTabs(
        async (service) => { await service.ensureReady({ force: true }); }
      );
    } catch {
      // Silently ignore restart failures - changes will apply on next conversation
    }
  }

}
