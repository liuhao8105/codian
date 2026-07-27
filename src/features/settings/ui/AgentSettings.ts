import type { App } from 'obsidian';
import { Modal, Notice, setIcon, Setting } from 'obsidian';

import {
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LIST_MCP_RESOURCES,
  TOOL_LS,
  TOOL_MCP,
  TOOL_NOTEBOOK_EDIT,
  TOOL_READ,
  TOOL_READ_MCP_RESOURCE,
  TOOL_SKILL,
  TOOL_TASK,
  TOOL_TODO_WRITE,
  TOOL_WEB_FETCH,
  TOOL_WEB_SEARCH,
  TOOL_WRITE,
} from '../../../core/tools/toolNames';
import type { AgentDefinition } from '../../../core/types';
import { DEFAULT_CODEX_MODELS } from '../../../core/types';
import { t } from '../../../i18n';
import type CodianPlugin from '../../../main';
import { confirmDelete } from '../../../shared/modals/ConfirmModal';
import { validateAgentName } from '../../../utils/agent';
import { getModelsFromEnvironment, parseEnvironmentVariables } from '../../../utils/env';

const BUILTIN_SUBAGENT_TOOLS = [
  TOOL_READ,
  TOOL_WRITE,
  TOOL_EDIT,
  TOOL_NOTEBOOK_EDIT,
  TOOL_BASH,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_LS,
  TOOL_WEB_SEARCH,
  TOOL_WEB_FETCH,
  TOOL_TODO_WRITE,
  TOOL_TASK,
  TOOL_SKILL,
  TOOL_LIST_MCP_RESOURCES,
  TOOL_READ_MCP_RESOURCE,
  TOOL_MCP,
] as const;

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values))
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export function mergeSelectedOptions(selected: Iterable<string>): string[] | undefined {
  const merged = uniqueSorted(selected);
  return merged.length > 0 ? merged : undefined;
}

export function normalizeAgentNameCandidate(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function renderOptionPicker(
  setting: Setting,
  options: string[],
  selected: Set<string>
): void {
  setting.settingEl.addClass('codian-sp-multiselect-setting');
  const optionsEl = setting.settingEl.createDiv({ cls: 'codian-sp-option-list' });

  for (const option of uniqueSorted(options)) {
    const itemEl = optionsEl.createEl('label', { cls: 'codian-sp-option-item' });
    const checkboxEl = itemEl.createEl('input', {
      type: 'checkbox',
      cls: 'codian-sp-option-checkbox',
    });
    checkboxEl.checked = selected.has(option);
    checkboxEl.addEventListener('change', () => {
      if (checkboxEl.checked) {
        selected.add(option);
      } else {
        selected.delete(option);
      }
    });
    itemEl.createSpan({ text: option, cls: 'codian-sp-option-label' });
  }
}

class AgentModal extends Modal {
  private plugin: CodianPlugin;
  private existingAgent: AgentDefinition | null;
  private onSave: (agent: AgentDefinition) => Promise<void>;

  constructor(
    app: App,
    plugin: CodianPlugin,
    existingAgent: AgentDefinition | null,
    onSave: (agent: AgentDefinition) => Promise<void>
  ) {
    super(app);
    this.plugin = plugin;
    this.existingAgent = existingAgent;
    this.onSave = onSave;
  }

  onOpen() {
    this.setTitle(
      this.existingAgent
        ? t('settings.subagents.modal.titleEdit')
        : t('settings.subagents.modal.titleAdd')
    );
    this.modalEl.addClass('codian-sp-modal');

    const { contentEl } = this;
    const envVars = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const availableModels = getModelsFromEnvironment(envVars);
    const modelOptions = [
      { value: 'inherit', label: 'Inherit' },
      ...(availableModels.length > 0 ? availableModels : DEFAULT_CODEX_MODELS).map((model) => ({
        value: model.value,
        label: model.label,
      })),
    ];

    let nameInput: HTMLInputElement;
    let descInput: HTMLInputElement;
    let modelValue: string = this.existingAgent?.model ?? 'inherit';
    const selectedTools = new Set(this.existingAgent?.tools ?? []);
    const selectedDisallowedTools = new Set(this.existingAgent?.disallowedTools ?? []);
    const selectedSkills = new Set(this.existingAgent?.skills ?? []);

    new Setting(contentEl)
      .setName(t('settings.subagents.modal.name'))
      .setDesc(t('settings.subagents.modal.nameDesc'))
      .addText(text => {
        nameInput = text.inputEl;
        text.setValue(this.existingAgent?.name || '')
          .setPlaceholder(t('settings.subagents.modal.namePlaceholder'));
      });

    new Setting(contentEl)
      .setName(t('settings.subagents.modal.description'))
      .setDesc(t('settings.subagents.modal.descriptionDesc'))
      .addText(text => {
        descInput = text.inputEl;
        text.setValue(this.existingAgent?.description || '')
          .setPlaceholder(t('settings.subagents.modal.descriptionPlaceholder'));
      });

    const details = contentEl.createEl('details', { cls: 'codian-sp-advanced-section' });
    details.createEl('summary', {
      text: t('settings.subagents.modal.advancedOptions'),
      cls: 'codian-sp-advanced-summary',
    });
    if ((this.existingAgent?.model && this.existingAgent.model !== 'inherit') ||
        this.existingAgent?.tools?.length ||
        this.existingAgent?.disallowedTools?.length ||
        this.existingAgent?.skills?.length) {
      details.open = true;
    }

    new Setting(details)
      .setName(t('settings.subagents.modal.model'))
      .setDesc(t('settings.subagents.modal.modelDesc'))
      .addDropdown(dropdown => {
        for (const opt of modelOptions) {
          dropdown.addOption(opt.value, opt.label);
        }
        dropdown
          .setValue(modelValue)
          .onChange(value => { modelValue = value; });
      });

    const toolsSetting = new Setting(details)
      .setName(t('settings.subagents.modal.tools'))
      .setDesc(t('settings.subagents.modal.toolsDesc'));

    const disallowedToolsSetting = new Setting(details)
      .setName(t('settings.subagents.modal.disallowedTools'))
      .setDesc(t('settings.subagents.modal.disallowedToolsDesc'));

    const skillsSetting = new Setting(details)
      .setName(t('settings.subagents.modal.skills'))
      .setDesc(t('settings.subagents.modal.skillsDesc'));

    renderOptionPicker(
      toolsSetting,
      uniqueSorted([
        ...BUILTIN_SUBAGENT_TOOLS,
        ...selectedTools,
        ...selectedDisallowedTools,
      ]),
      selectedTools
    );
    renderOptionPicker(
      disallowedToolsSetting,
      uniqueSorted([
        ...BUILTIN_SUBAGENT_TOOLS,
        ...selectedTools,
        ...selectedDisallowedTools,
      ]),
      selectedDisallowedTools
    );
    renderOptionPicker(skillsSetting, uniqueSorted(selectedSkills), selectedSkills);

    void this.plugin.storage.skills.loadAll().then((skills) => {
      if (!skillsSetting.settingEl.isConnected) return;
      const latestSelectedSkills = new Set(selectedSkills);
      skillsSetting.settingEl.querySelector('.codian-sp-option-list')?.remove();
      renderOptionPicker(
        skillsSetting,
        uniqueSorted([
          ...skills.map((skill) => skill.name),
          ...latestSelectedSkills,
        ]),
        latestSelectedSkills
      );
      selectedSkills.clear();
      for (const skill of latestSelectedSkills) {
        selectedSkills.add(skill);
      }
    }).catch(() => {
      // Non-critical: keep existing selections if installed skills cannot be loaded.
    });

    new Setting(contentEl)
      .setName(t('settings.subagents.modal.prompt'))
      .setDesc(t('settings.subagents.modal.promptDesc'));

    const contentArea = contentEl.createEl('textarea', {
      cls: 'codian-sp-content-area',
      attr: {
        rows: '10',
        placeholder: t('settings.subagents.modal.promptPlaceholder'),
      },
    });
    contentArea.value = this.existingAgent?.prompt || '';

    const buttonContainer = contentEl.createDiv({ cls: 'codian-sp-modal-buttons' });

    const cancelBtn = buttonContainer.createEl('button', {
      text: t('common.cancel'),
      cls: 'codian-cancel-btn',
    });
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = buttonContainer.createEl('button', {
      text: t('common.save'),
      cls: 'codian-save-btn',
    });
    saveBtn.addEventListener('click', async () => {
      const focusNameInput = (): void => {
        nameInput.focus();
        nameInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
        nameInput.select();
      };

      const rawName = nameInput.value.trim();
      const name = normalizeAgentNameCandidate(rawName);
      if (name !== rawName) {
        nameInput.value = name;
      }
      const nameError = validateAgentName(name);
      if (nameError) {
        const message = nameError.includes('lowercase letters, numbers, and hyphens')
          ? `${t('settings.subagents.modal.name')}格式不正确：${t('settings.subagents.modal.nameDesc')}，例如 ${t('settings.subagents.modal.namePlaceholder')}`
          : nameError;
        new Notice(message);
        focusNameInput();
        return;
      }

      const description = descInput.value.trim();
      if (!description) {
        new Notice(t('settings.subagents.descriptionRequired'));
        return;
      }

      const prompt = contentArea.value;
      if (!prompt.trim()) {
        new Notice(t('settings.subagents.promptRequired'));
        return;
      }

      const allAgents = this.plugin.agentManager.getAvailableAgents();
      const duplicate = allAgents.find(
        a => a.id.toLowerCase() === name.toLowerCase() &&
             a.id !== this.existingAgent?.id
      );
      if (duplicate) {
        new Notice(t('settings.subagents.duplicateName', { name }));
        return;
      }

      const agent: AgentDefinition = {
        id: name,
        name,
        description,
        prompt,
        tools: mergeSelectedOptions(selectedTools),
        disallowedTools: mergeSelectedOptions(selectedDisallowedTools),
        model: (modelValue as AgentDefinition['model']) || 'inherit',
        source: 'vault',
        filePath: this.existingAgent?.filePath,
        skills: mergeSelectedOptions(selectedSkills),
        permissionMode: this.existingAgent?.permissionMode,
        hooks: this.existingAgent?.hooks,
        extraFrontmatter: this.existingAgent?.extraFrontmatter,
      };

      try {
        await this.onSave(agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        new Notice(t('settings.subagents.saveFailed', { message }));
        return;
      }
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class AgentSettings {
  private containerEl: HTMLElement;
  private plugin: CodianPlugin;

  constructor(containerEl: HTMLElement, plugin: CodianPlugin) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.render();
  }

  private render(): void {
    this.containerEl.empty();

    const headerEl = this.containerEl.createDiv({ cls: 'codian-sp-header' });
    headerEl.createSpan({ text: t('settings.subagents.name'), cls: 'codian-sp-label' });

    const actionsEl = headerEl.createDiv({ cls: 'codian-sp-header-actions' });

    const refreshBtn = actionsEl.createEl('button', {
      cls: 'codian-settings-action-btn',
      attr: { 'aria-label': t('common.refresh') },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => { void this.refreshAgents(); });

    const addBtn = actionsEl.createEl('button', {
      cls: 'codian-settings-action-btn',
      attr: { 'aria-label': t('common.add') },
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => { void this.openAgentModal(null); });

    const allAgents = this.plugin.agentManager.getAvailableAgents();
    const vaultAgents = allAgents.filter(a => a.source === 'vault');

    if (vaultAgents.length === 0) {
      const emptyEl = this.containerEl.createDiv({ cls: 'codian-sp-empty-state' });
      emptyEl.setText(t('settings.subagents.noAgents'));
      return;
    }

    const listEl = this.containerEl.createDiv({ cls: 'codian-sp-list' });

    for (const agent of vaultAgents) {
      this.renderAgentItem(listEl, agent);
    }
  }

  private renderAgentItem(listEl: HTMLElement, agent: AgentDefinition): void {
    const itemEl = listEl.createDiv({ cls: 'codian-sp-item' });

    const infoEl = itemEl.createDiv({ cls: 'codian-sp-info' });

    const headerRow = infoEl.createDiv({ cls: 'codian-sp-item-header' });

    const nameEl = headerRow.createSpan({ cls: 'codian-sp-item-name' });
    nameEl.setText(agent.name);

    if (agent.description) {
      const descEl = infoEl.createDiv({ cls: 'codian-sp-item-desc' });
      descEl.setText(agent.description);
    }

    const actionsEl = itemEl.createDiv({ cls: 'codian-sp-item-actions' });

    const editBtn = actionsEl.createEl('button', {
      cls: 'codian-settings-action-btn',
      attr: { 'aria-label': t('common.edit') },
    });
    setIcon(editBtn, 'pencil');
    editBtn.addEventListener('click', () => { void this.openAgentModal(agent); });

    const deleteBtn = actionsEl.createEl('button', {
      cls: 'codian-settings-action-btn codian-settings-delete-btn',
      attr: { 'aria-label': t('common.delete') },
    });
    setIcon(deleteBtn, 'trash-2');
    deleteBtn.addEventListener('click', async () => {
      const confirmed = await confirmDelete(
        this.plugin.app,
        t('settings.subagents.deleteConfirm', { name: agent.name })
      );
      if (!confirmed) return;
      try {
        await this.deleteAgent(agent);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        new Notice(t('settings.subagents.deleteFailed', { message }));
      }
    });
  }

  private async refreshAgents(): Promise<void> {
    try {
      await this.plugin.agentManager.loadAgents();
      this.render();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      new Notice(t('settings.subagents.refreshFailed', { message }));
    }
  }

  private async openAgentModal(existingAgent: AgentDefinition | null): Promise<void> {
    let fresh: AgentDefinition | null;
    if (existingAgent) {
      try {
        fresh = await this.plugin.storage.agents.load(existingAgent) ?? existingAgent;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        new Notice(`Failed to load subagent "${existingAgent.name}": ${message}`);
        return;
      }
    } else {
      fresh = null;
    }

    new AgentModal(
      this.plugin.app,
      this.plugin,
      fresh,
      (agent) => this.saveAgent(agent, fresh)
    ).open();
  }

  private async saveAgent(agent: AgentDefinition, existing: AgentDefinition | null): Promise<void> {
    if (existing && existing.name !== agent.name) {
      // Rename: save to new name-based path, then delete old file
      await this.plugin.storage.agents.save({ ...agent, filePath: undefined });
      try {
        await this.plugin.storage.agents.delete(existing);
      } catch {
        new Notice(t('settings.subagents.renameCleanupFailed', { name: existing.name }));
      }
    } else {
      await this.plugin.storage.agents.save(agent);
    }

    try {
      await this.plugin.agentManager.loadAgents();
    } catch {
      // Non-critical: agent list will refresh on next settings open
    }
    this.render();
    new Notice(
      existing
        ? t('settings.subagents.updated', { name: agent.name })
        : t('settings.subagents.created', { name: agent.name })
    );
  }

  private async deleteAgent(agent: AgentDefinition): Promise<void> {
    await this.plugin.storage.agents.delete(agent);

    try {
      await this.plugin.agentManager.loadAgents();
    } catch {
      // Non-critical: agent list will refresh on next settings open
    }
    this.render();
    new Notice(t('settings.subagents.deleted', { name: agent.name }));
  }

}
