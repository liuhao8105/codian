import {
  DEFAULT_CODEX_MODELS,
  DEFAULT_THINKING_BUDGET,
} from '@/core/types/models';
import * as modelTypes from '@/core/types/models';
import { DEFAULT_SETTINGS } from '@/core/types/settings';

describe('Codex model catalog', () => {
  it('uses the current Codex CLI model catalog as the fallback', () => {
    expect(DEFAULT_CODEX_MODELS.map((model) => model.value)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
  });

  it('matches the default reasoning effort reported by the current CLI', () => {
    expect(DEFAULT_THINKING_BUDGET).toEqual({
      'gpt-5.6-sol': 'low',
      'gpt-5.6-terra': 'medium',
      'gpt-5.6-luna': 'medium',
      'gpt-5.5': 'medium',
      'gpt-5.4': 'medium',
      'gpt-5.4-mini': 'medium',
    });
  });

  it('uses GPT-5.6-Sol for new Codian settings', () => {
    expect(DEFAULT_SETTINGS.model).toBe('gpt-5.6-sol');
    expect(DEFAULT_SETTINGS.lastClaudeModel).toBe('gpt-5.6-sol');
    expect(DEFAULT_SETTINGS.thinkingBudget).toBe('low');
  });

  it('parses visible models and their defaults from model/list', () => {
    const parseCodexModelCatalog = (modelTypes as Record<string, unknown>).parseCodexModelCatalog;
    expect(parseCodexModelCatalog).toBeInstanceOf(Function);

    const catalog = (parseCodexModelCatalog as (value: unknown) => {
      models: Array<{ value: string; label: string; description: string }>;
      defaultModel: string;
      thinkingBudgets: Record<string, string>;
    })({
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
          model: 'gpt-5.6-terra',
          displayName: 'GPT-5.6-Terra',
          description: 'Balanced agentic coding model for everyday work.',
          hidden: false,
          defaultReasoningEffort: 'medium',
        },
        {
          id: 'hidden-preview',
          displayName: 'Hidden preview',
          hidden: true,
        },
        { displayName: 'Missing identifier', hidden: false },
      ],
    });

    expect(catalog).toEqual({
      models: [
        {
          value: 'gpt-5.6-sol',
          label: 'GPT-5.6-Sol',
          description: 'Latest frontier agentic coding model.',
        },
        {
          value: 'gpt-5.6-terra',
          label: 'GPT-5.6-Terra',
          description: 'Balanced agentic coding model for everyday work.',
        },
      ],
      defaultModel: 'gpt-5.6-sol',
      thinkingBudgets: {
        'gpt-5.6-sol': 'low',
        'gpt-5.6-terra': 'medium',
      },
    });
  });

  it('loads the model catalog through an initialized App Server client', async () => {
    const fetchCodexModelCatalog = (modelTypes as Record<string, unknown>).fetchCodexModelCatalog;
    expect(fetchCodexModelCatalog).toBeInstanceOf(Function);

    const client = {
      initialize: jest.fn().mockResolvedValue(undefined),
      request: jest.fn().mockResolvedValue({
        data: [{
          id: 'gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: 'low',
        }],
      }),
      kill: jest.fn(),
    };

    const catalog = await (fetchCodexModelCatalog as (
      createClient: (signal: AbortSignal) => typeof client,
      timeoutMs?: number,
    ) => Promise<{ defaultModel: string }>)(() => client, 100);

    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith('model/list', {});
    expect(client.kill).toHaveBeenCalledTimes(1);
    expect(catalog.defaultModel).toBe('gpt-5.6-sol');
  });

  it('aborts and closes model discovery when the CLI does not respond in time', async () => {
    jest.useFakeTimers();
    try {
      const fetchCodexModelCatalog = modelTypes.fetchCodexModelCatalog;
      let receivedSignal: AbortSignal | undefined;
      const client = {
        initialize: jest.fn().mockResolvedValue(undefined),
        request: jest.fn().mockImplementation(() => new Promise<Record<string, unknown>>((resolve) => {
          setTimeout(() => resolve({ data: [] }), 50);
        })),
        kill: jest.fn(),
      };

      const result = fetchCodexModelCatalog((signal) => {
        receivedSignal = signal;
        return client;
      }, 10);
      const rejection = result.then(
        () => null,
        (error: unknown) => error,
      );

      await jest.advanceTimersByTimeAsync(50);

      await expect(rejection).resolves.toThrow('读取 Codex 模型清单超时');
      expect(receivedSignal?.aborted).toBe(true);
      expect(client.kill).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('migrates only retired built-in models to the CLI default', () => {
    const reconcileCodexModelSelection = (modelTypes as Record<string, unknown>).reconcileCodexModelSelection;
    expect(reconcileCodexModelSelection).toBeInstanceOf(Function);

    const reconcile = reconcileCodexModelSelection as (
      currentModel: string,
      availableModels: string[],
      defaultModel: string,
    ) => { model: string; migrated: boolean };
    const availableModels = ['gpt-5.6-sol', 'gpt-5.5'];

    expect(reconcile('gpt-5.2', availableModels, 'gpt-5.6-sol')).toEqual({
      model: 'gpt-5.6-sol',
      migrated: true,
    });
    expect(reconcile('gpt-5.3-codex', availableModels, 'gpt-5.6-sol')).toEqual({
      model: 'gpt-5.6-sol',
      migrated: true,
    });
    expect(reconcile('gpt-5.5', availableModels, 'gpt-5.6-sol')).toEqual({
      model: 'gpt-5.5',
      migrated: false,
    });
    expect(reconcile('custom/private-model', availableModels, 'gpt-5.6-sol')).toEqual({
      model: 'custom/private-model',
      migrated: false,
    });
  });
});
