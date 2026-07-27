import { execCodexPrompt } from '@/core/runtime/codexExec';
import { TitleGenerationService } from '@/features/chat/services/TitleGenerationService';

jest.mock('@/core/runtime/codexExec', () => ({
  execCodexPrompt: jest.fn().mockResolvedValue({ text: 'Synced title' }),
}));

describe('TitleGenerationService Codex model', () => {
  it('uses GPT-5.6-Sol when no title model override is configured', async () => {
    const plugin = {
      settings: { titleGenerationModel: '' },
      app: { vault: { adapter: { basePath: '/test/vault' } } },
      getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    } as any;
    const callback = jest.fn();

    await new TitleGenerationService(plugin).generateTitle('conversation-1', 'hello', callback);

    expect(execCodexPrompt).toHaveBeenCalledWith(plugin, expect.objectContaining({
      model: 'gpt-5.6-sol',
    }));
  });
});
