import { createMockEl } from '@test/helpers/mockElement';

import type { SlashCommand } from '@/core/types';
import {
  SlashCommandDropdown,
  type SlashCommandDropdownCallbacks,
} from '@/shared/components/SlashCommandDropdown';

// Mock getBuiltInCommandsForDropdown
jest.mock('@/core/commands', () => ({
  getBuiltInCommandsForDropdown: jest.fn(() => [
    { id: 'builtin:clear', name: 'clear', description: '新建对话', content: '' },
    { id: 'builtin:add-dir', name: 'add-dir', description: '添加外部上下文目录', content: '', argumentHint: '[目录路径]' },
  ]),
}));

function createMockInput(): any {
  return {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    focus: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
}

function createMockCallbacks(overrides: Partial<SlashCommandDropdownCallbacks> = {}): SlashCommandDropdownCallbacks {
  return {
    onSelect: jest.fn(),
    onHide: jest.fn(),
    ...overrides,
  };
}

/**
 * Query the rendered dropdown DOM to extract displayed command items.
 * Each rendered item has a `.codian-slash-name` span (text: `/{name}`)
 * and an optional `.codian-slash-desc` div.
 */
function getRenderedItems(containerEl: any): { name: string; description: string }[] {
  const dropdownEl = containerEl.children.find(
    (c: any) => c.hasClass('codian-slash-dropdown')
  );
  if (!dropdownEl) return [];
  const items = dropdownEl.querySelectorAll('.codian-slash-item');
  return items.map((item: any) => {
    const nameSpan = item.children.find((c: any) => c.hasClass('codian-slash-name'));
    const descDiv = item.children.find((c: any) => c.hasClass('codian-slash-desc'));
    return {
      name: nameSpan?.textContent?.replace(/^\//, '') ?? '',
      description: descDiv?.textContent ?? '',
    };
  });
}

function getRenderedCommandNames(containerEl: any): string[] {
  return getRenderedItems(containerEl).map(i => i.name);
}

// Runtime commands for testing
const Runtime_COMMANDS: SlashCommand[] = [
  { id: 'runtime:commit', name: 'commit', description: 'Create a git commit', content: '', source: 'runtime' },
  { id: 'runtime:pr', name: 'pr', description: 'Create a pull request', content: '', source: 'runtime' },
  { id: 'runtime:review', name: 'review', description: 'Review code', content: '', source: 'runtime' },
  { id: 'runtime:my-custom', name: 'my-custom', description: 'Custom command', content: '', source: 'runtime' },
  { id: 'runtime:compact', name: 'compact', description: 'Compact context', content: '', source: 'runtime' },
];

// Commands that should be filtered out (not shown in Codian)
const FILTERED_Runtime_COMMANDS_LIST: SlashCommand[] = [
  { id: 'runtime:context', name: 'context', description: 'Show context', content: '', source: 'runtime' },
  { id: 'runtime:cost', name: 'cost', description: 'Show cost', content: '', source: 'runtime' },
  { id: 'runtime:init', name: 'init', description: 'Initialize project', content: '', source: 'runtime' },
  { id: 'runtime:release-notes', name: 'release-notes', description: 'Release notes', content: '', source: 'runtime' },
  { id: 'runtime:security-review', name: 'security-review', description: 'Security review', content: '', source: 'runtime' },
];

describe('SlashCommandDropdown', () => {
  let containerEl: any;
  let inputEl: any;
  let callbacks: SlashCommandDropdownCallbacks;
  let dropdown: SlashCommandDropdown;

  beforeEach(() => {
    containerEl = createMockEl();
    inputEl = createMockInput();
    callbacks = createMockCallbacks();
    dropdown = new SlashCommandDropdown(containerEl, inputEl, callbacks);
  });

  afterEach(() => {
    dropdown.destroy();
  });

  describe('constructor', () => {
    it('creates dropdown with container and input elements', () => {
      expect(dropdown).toBeInstanceOf(SlashCommandDropdown);
    });

    it('adds input event listener', () => {
      expect(inputEl.addEventListener).toHaveBeenCalledWith('input', expect.any(Function));
    });

    it('accepts optional hiddenCommands in options', () => {
      const hiddenCommands = new Set(['commit', 'pr']);
      const dropdownWithHidden = new SlashCommandDropdown(
        containerEl,
        inputEl,
        callbacks,
        { hiddenCommands }
      );
      expect(dropdownWithHidden).toBeInstanceOf(SlashCommandDropdown);
      dropdownWithHidden.destroy();
    });
  });

  describe('setEnabled', () => {
    it('should not show dropdown when disabled', async () => {
      dropdown.setEnabled(false);

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(dropdown.isVisible()).toBe(false);
      expect(getRenderedCommandNames(containerEl)).toEqual([]);
    });

    it('should hide dropdown when disabling while visible', async () => {
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(dropdown.isVisible()).toBe(true);

      dropdown.setEnabled(false);

      expect(dropdown.isVisible()).toBe(false);
    });
  });

  describe('FILTERED_Runtime_COMMANDS filtering', () => {
    it('should filter out context, cost, init, release-notes, security-review', async () => {
      const allSdkCommands = [...Runtime_COMMANDS, ...FILTERED_Runtime_COMMANDS_LIST];
      const getSdkCommands = jest.fn().mockResolvedValue(allSdkCommands);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // Trigger dropdown
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();

      // Wait for async Runtime fetch
      await new Promise(resolve => setTimeout(resolve, 10));

      const commandNames = getRenderedCommandNames(containerEl);

      // Should NOT include filtered commands
      expect(commandNames).not.toContain('context');
      expect(commandNames).not.toContain('cost');
      expect(commandNames).not.toContain('init');
      expect(commandNames).not.toContain('release-notes');
      expect(commandNames).not.toContain('security-review');

      // Should include other Runtime commands
      expect(commandNames).toContain('commit');
      expect(commandNames).toContain('compact');
      expect(commandNames).toContain('pr');
      expect(commandNames).toContain('review');
      expect(commandNames).toContain('my-custom');

      dropdownWithSdk.destroy();
    });
  });

  describe('hidden commands filtering', () => {
    it('should filter out user-hidden commands from Runtime commands', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(Runtime_COMMANDS);
      const hiddenCommands = new Set(['commit', 'pr']);

      const dropdownWithHidden = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands },
        { hiddenCommands }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithHidden.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const commandNames = getRenderedCommandNames(containerEl);

      // Hidden Runtime commands should not appear
      expect(commandNames).not.toContain('commit');
      expect(commandNames).not.toContain('pr');

      // Non-hidden Runtime commands should appear
      expect(commandNames).toContain('review');
      expect(commandNames).toContain('my-custom');

      dropdownWithHidden.destroy();
    });

    it('should NOT filter out built-in commands even if in hiddenCommands', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(Runtime_COMMANDS);
      // Try to hide built-in command 'clear'
      const hiddenCommands = new Set(['clear', 'add-dir']);

      const dropdownWithHidden = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands },
        { hiddenCommands }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithHidden.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const commandNames = getRenderedCommandNames(containerEl);

      // Built-in commands should STILL appear (not subject to hiding)
      expect(commandNames).toContain('clear');
      expect(commandNames).toContain('add-dir');

      dropdownWithHidden.destroy();
    });
  });

  describe('deduplication', () => {
    it('should deduplicate commands by name (built-in takes priority)', async () => {
      // Runtime has a command with same name as built-in
      const runtimeWithDuplicate: SlashCommand[] = [
        { id: 'runtime:clear', name: 'clear', description: 'Runtime clear command', content: '', source: 'runtime' },
        { id: 'runtime:commit', name: 'commit', description: 'Create commit', content: '', source: 'runtime' },
      ];
      const getSdkCommands = jest.fn().mockResolvedValue(runtimeWithDuplicate);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      inputEl.value = '/cle';
      inputEl.selectionStart = 4;
      dropdownWithSdk.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const items = getRenderedItems(containerEl);
      const clearItems = items.filter(i => i.name === 'clear');

      // Should only have one 'clear' command
      expect(clearItems).toHaveLength(1);
      // And it should be the built-in one (verified by its description)
      expect(clearItems[0].description).toBe('新建对话');

      dropdownWithSdk.destroy();
    });
  });

  describe('Runtime command caching', () => {
    it('should cache Runtime commands after first successful fetch', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(Runtime_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First trigger
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second trigger
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should only fetch once (cached)
      expect(getSdkCommands).toHaveBeenCalledTimes(1);

      dropdownWithSdk.destroy();
    });

    it('should retry fetch when previous result was empty', async () => {
      const getSdkCommands = jest.fn()
        .mockResolvedValueOnce([]) // First call returns empty
        .mockResolvedValueOnce(Runtime_COMMANDS); // Second call returns commands

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First trigger - gets empty result
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second trigger - should retry since previous was empty
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should fetch twice (retried because first was empty)
      expect(getSdkCommands).toHaveBeenCalledTimes(2);

      dropdownWithSdk.destroy();
    });

    it('should retry fetch when previous call threw error', async () => {
      const getSdkCommands = jest.fn()
        .mockRejectedValueOnce(new Error('Runtime not ready'))
        .mockResolvedValueOnce(Runtime_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First trigger - throws error
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second trigger - should retry since previous threw
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should fetch twice (retried because first failed)
      expect(getSdkCommands).toHaveBeenCalledTimes(2);

      dropdownWithSdk.destroy();
    });
  });

  describe('race condition handling', () => {
    it('should discard stale results when newer request is made', async () => {
      let resolveFirst: (value: SlashCommand[]) => void;
      const firstPromise = new Promise<SlashCommand[]>(resolve => { resolveFirst = resolve; });

      const getSdkCommands = jest.fn()
        .mockReturnValueOnce(firstPromise)
        .mockResolvedValueOnce([
          { id: 'runtime:new', name: 'new-command', description: 'New', content: '', source: 'runtime' },
        ]);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First trigger (will be slow)
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();

      // Second trigger (faster, should supersede first)
      inputEl.value = '/n';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Now resolve the first (stale) request
      resolveFirst!(Runtime_COMMANDS);
      await new Promise(resolve => setTimeout(resolve, 10));

      // Render dropdown with cached commands to verify stale results were discarded
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      // Should have the command from the second (newer) request
      expect(names).toContain('new-command');
      // Should NOT have commands from stale first request
      expect(names).not.toContain('commit');

      dropdownWithSdk.destroy();
    });
  });

  describe('setHiddenCommands', () => {
    it('should update hidden commands set', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(Runtime_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // Initial fetch with no hidden commands
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(getRenderedCommandNames(containerEl)).toContain('commit');

      // Now hide commit
      dropdownWithSdk.setHiddenCommands(new Set(['commit']));

      // Trigger again
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(getRenderedCommandNames(containerEl)).not.toContain('commit');

      dropdownWithSdk.destroy();
    });
  });

  describe('resetSdkSkillsCache', () => {
    it('should clear cached Runtime skills and allow refetch', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(Runtime_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      // First fetch
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(getSdkCommands).toHaveBeenCalledTimes(1);

      // Reset cache
      dropdownWithSdk.resetSdkSkillsCache();

      // Trigger again - should refetch
      inputEl.value = '/c';
      inputEl.selectionStart = 2;
      dropdownWithSdk.handleInputChange();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(getSdkCommands).toHaveBeenCalledTimes(2);

      dropdownWithSdk.destroy();
    });
  });

  describe('handleInputChange', () => {
    it('should hide dropdown when / is not at position 0', () => {
      inputEl.value = 'text /command';
      inputEl.selectionStart = 13;
      dropdown.handleInputChange();

      expect(callbacks.onHide).toHaveBeenCalled();
    });

    it('should hide dropdown when whitespace follows command', () => {
      inputEl.value = '/clear ';
      inputEl.selectionStart = 7;
      dropdown.handleInputChange();

      expect(callbacks.onHide).toHaveBeenCalled();
    });

    it('should show dropdown when / is at position 0', async () => {
      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdown.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have created dropdown element
      expect(containerEl.children.length).toBeGreaterThan(0);
    });
  });

  describe('handleKeydown', () => {
    it('should return false when dropdown is not visible', () => {
      const event = { key: 'ArrowDown', preventDefault: jest.fn() } as any;
      const handled = dropdown.handleKeydown(event);

      expect(handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('isVisible', () => {
    it('should return false initially', () => {
      expect(dropdown.isVisible()).toBe(false);
    });
  });

  describe('hide', () => {
    it('should call onHide callback', () => {
      dropdown.hide();
      expect(callbacks.onHide).toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('should remove input event listener', () => {
      dropdown.destroy();
      expect(inputEl.removeEventListener).toHaveBeenCalledWith('input', expect.any(Function));
    });
  });

  describe('search filtering', () => {
    it('should filter commands by name', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(Runtime_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      inputEl.value = '/com';
      inputEl.selectionStart = 4;
      dropdownWithSdk.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const commandNames = getRenderedCommandNames(containerEl);
      expect(commandNames).toContain('commit');
      expect(commandNames).not.toContain('pr');

      dropdownWithSdk.destroy();
    });

    it('should filter commands by description', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(Runtime_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      inputEl.value = '/pull';
      inputEl.selectionStart = 5;
      dropdownWithSdk.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      // 'pr' has description 'Create a pull request'
      expect(getRenderedCommandNames(containerEl)).toContain('pr');

      dropdownWithSdk.destroy();
    });

    it('should hide dropdown when search has no matches', async () => {
      inputEl.value = '/xyz123nonexistent';
      inputEl.selectionStart = 18;
      dropdown.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(callbacks.onHide).toHaveBeenCalled();
    });

    it('should sort results alphabetically', async () => {
      const getSdkCommands = jest.fn().mockResolvedValue(Runtime_COMMANDS);

      const dropdownWithSdk = new SlashCommandDropdown(
        containerEl,
        inputEl,
        { ...callbacks, getSdkCommands }
      );

      inputEl.value = '/';
      inputEl.selectionStart = 1;
      dropdownWithSdk.handleInputChange();

      await new Promise(resolve => setTimeout(resolve, 10));

      const names = getRenderedCommandNames(containerEl);
      const sortedNames = [...names].sort();
      expect(names).toEqual(sortedNames);

      dropdownWithSdk.destroy();
    });
  });
});
