import { DEFAULT_SETTINGS } from '@/core/types';

const requestMock = jest.fn();
const killMock = jest.fn();

jest.mock('@/core/runtime/CodexAppServerClient', () => ({
  CodexAppServerClient: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    request: requestMock,
    kill: killMock,
  })),
}));

import CodianPlugin from '@/main';

describe('CodianPlugin dynamic Codex model catalog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestMock.mockResolvedValue({
      data: [
        {
          id: 'gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          description: 'Latest frontier agentic coding model.',
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: 'low',
        },
        {
          id: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: 'Previous generation.',
          hidden: false,
          defaultReasoningEffort: 'medium',
        },
      ],
    });
  });

  it('refreshes selectors and migrates a retired model to the CLI default', async () => {
    const app = {
      vault: { adapter: { basePath: '/test/vault' } },
      workspace: { getLeavesOfType: jest.fn().mockReturnValue([]) },
    };
    const plugin = new CodianPlugin(app as any, { id: 'codian', version: 'test' } as any);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      model: 'gpt-5.2',
      thinkingBudget: 'off',
      lastClaudeModel: 'gpt-5.2',
    };
    const saveSettings = jest.spyOn(plugin, 'saveSettings').mockResolvedValue(undefined);
    const refreshCodexModelCatalog = (plugin as any).refreshCodexModelCatalog;
    expect(refreshCodexModelCatalog).toBeInstanceOf(Function);

    await refreshCodexModelCatalog.call(plugin);

    expect(requestMock).toHaveBeenCalledWith('model/list', {});
    expect(plugin.getAvailableModelsForCurrentProvider().map((model) => model.value)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.5',
    ]);
    expect(plugin.settings.model).toBe('gpt-5.6-sol');
    expect(plugin.settings.thinkingBudget).toBe('low');
    expect(plugin.settings.lastClaudeModel).toBe('gpt-5.6-sol');
    expect(plugin.getDefaultThinkingBudgetForModel('gpt-5.5')).toBe('medium');
    expect(saveSettings).toHaveBeenCalledTimes(1);
    expect(killMock).toHaveBeenCalledTimes(1);
  });

  it('quietly keeps the fallback catalog when discovery is unavailable', async () => {
    requestMock.mockRejectedValueOnce(new Error('Codex CLI unavailable'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = {
      vault: { adapter: { basePath: '/test/vault' } },
      workspace: { getLeavesOfType: jest.fn().mockReturnValue([]) },
    };
    const plugin = new CodianPlugin(app as any, { id: 'codian', version: 'test' } as any);
    plugin.settings = { ...DEFAULT_SETTINGS };

    await expect(plugin.refreshCodexModelCatalog()).resolves.toBe(false);

    expect(plugin.getAvailableModelsForCurrentProvider().map((model) => model.value)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});
