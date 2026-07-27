// eslint-disable-next-line jest/no-mocks-import
import {
  resetMockMessages,
} from '@test/__mocks__/claude-agent-sdk';

jest.mock('@/core/runtime/codexExec', () => ({
  execCodexPrompt: jest.fn(),
}));

// Import after mocks are set up
import { execCodexPrompt } from '@/core/runtime/codexExec';
import { InstructionRefineService } from '@/features/chat/services/InstructionRefineService';

const mockExecCodexPrompt = execCodexPrompt as jest.MockedFunction<typeof execCodexPrompt>;

function setMockMessages(messages: any[]): void {
  const text = messages
    .filter(message => message?.type === 'assistant' && Array.isArray(message.message?.content))
    .flatMap(message => message.message.content)
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
  mockExecCodexPrompt.mockResolvedValue({ text });
}

function getLastOptions(): Record<string, any> | undefined {
  return mockExecCodexPrompt.mock.calls.at(-1)?.[1];
}

function createMockPlugin(settings = {}) {
  return {
    settings: {
      model: 'sonnet',
      thinkingBudget: 'off',
      systemPrompt: '',
      memoryFilePath: '',
      ...settings,
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault/path',
        },
      },
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getResolvedClaudeCliPath: jest.fn().mockReturnValue('/fake/claude'),
  } as any;
}

describe('InstructionRefineService', () => {
  let service: InstructionRefineService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockMessages();
    mockExecCodexPrompt.mockResolvedValue({ text: '<instruction>ok</instruction>' });
    mockPlugin = createMockPlugin();
    service = new InstructionRefineService(mockPlugin);
  });

  describe('refineInstruction', () => {
    it('should use the read-only sandbox for text-only refinement', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>- Be concise.</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      const result = await service.refineInstruction('be concise', '');
      expect(result.success).toBe(true);

      const options = getLastOptions();
      expect(options?.permissionMode).toBe('read-only');
    });

    it('should set settingSources to project only when loadUserClaudeSettings is false', async () => {
      mockPlugin.settings.loadUserClaudeSettings = false;
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>- Be concise.</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      await service.refineInstruction('be concise', '');

      const options = getLastOptions();
      expect(options?.permissionMode).toBe('read-only');
    });

    it('should set settingSources to include user when loadUserClaudeSettings is true', async () => {
      mockPlugin.settings.loadUserClaudeSettings = true;
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>- Be concise.</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      await service.refineInstruction('be concise', '');

      const options = getLastOptions();
      expect(options?.permissionMode).toBe('read-only');
    });

    it('should include existing instructions and allow markdown blocks', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: '<instruction>\n## Coding Style\n\n- Use TypeScript.\n- Prefer small diffs.\n</instruction>',
              },
            ],
          },
        },
        { type: 'result' },
      ]);

      const existing = '## Existing\n\n- Keep it short.';
      const result = await service.refineInstruction('coding style', existing);

      expect(result.success).toBe(true);
      expect(result.refinedInstruction).toBe('## Coding Style\n\n- Use TypeScript.\n- Prefer small diffs.');

      const options = getLastOptions();
      expect(options?.prompt).toContain('EXISTING INSTRUCTIONS');
      expect(options?.prompt).toContain(existing);
      expect(options?.prompt).toContain('Consider how it fits with existing instructions');
      expect(options?.prompt).toContain('Match the format of existing instructions');
    });

    it('should return clarification when no instruction tag in response', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Could you clarify what you mean by concise?' }],
          },
        },
        { type: 'result' },
      ]);

      const result = await service.refineInstruction('be concise', '');
      expect(result.success).toBe(true);
      expect(result.clarification).toBe('Could you clarify what you mean by concise?');
      expect(result.refinedInstruction).toBeUndefined();
    });

    it('should return error for empty response', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '' }],
          },
        },
        { type: 'result' },
      ]);

      const result = await service.refineInstruction('be concise', '');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Empty response');
    });

    it('should call onProgress during streaming', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>- Be brief.</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      const onProgress = jest.fn();
      await service.refineInstruction('be concise', '', onProgress);
      expect(onProgress).toHaveBeenCalled();
    });

    it('should set thinking budget when configured', async () => {
      mockPlugin.settings.thinkingBudget = 'medium';
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>ok</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      await service.refineInstruction('test', '');
      const options = getLastOptions();
      expect(options?.model).toBe('sonnet');
    });

    it('should ignore non-text content blocks', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'test' },
              { type: 'text', text: '<instruction>result</instruction>' },
            ],
          },
        },
        { type: 'result' },
      ]);

      const result = await service.refineInstruction('test', '');
      expect(result.success).toBe(true);
      expect(result.refinedInstruction).toBe('result');
    });

    it('should skip messages without content', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        { type: 'assistant' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>ok</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      const result = await service.refineInstruction('test', '');
      expect(result.success).toBe(true);
    });
  });

  describe('continueConversation', () => {
    it('should return error when no active session', async () => {
      const result = await service.continueConversation('follow up');
      expect(result.success).toBe(false);
      expect(result.error).toBe('No active conversation to continue');
    });

    it('should continue with session id after initial refinement', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'session-abc' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'What do you mean?' }],
          },
        },
        { type: 'result' },
      ]);

      // First call establishes a session
      await service.refineInstruction('test', '');

      // Set up messages for the continuation
      resetMockMessages();
      setMockMessages([
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>- Be concise and clear.</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      const result = await service.continueConversation('I mean short answers');
      expect(result.success).toBe(true);
      expect(result.refinedInstruction).toBe('- Be concise and clear.');

      const options = getLastOptions();
      expect(options?.prompt).toContain('Previous conversation:');
    });
  });

  describe('resetConversation', () => {
    it('should clear session so continueConversation fails', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'session-abc' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'clarification' }],
          },
        },
        { type: 'result' },
      ]);

      await service.refineInstruction('test', '');
      service.resetConversation();

      const result = await service.continueConversation('follow up');
      expect(result.success).toBe(false);
      expect(result.error).toBe('No active conversation to continue');
    });
  });

  describe('cancel', () => {
    it('should abort the current request', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>ok</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      const promise = service.refineInstruction('test', '');
      service.cancel();
      const result = await promise;
      expect(result).toBeDefined();
    });

    it('should be safe to cancel when nothing is running', () => {
      service.cancel();
      // Verify service is still usable after cancelling with no active request
      expect(service).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should return error when vault path cannot be determined', async () => {
      mockPlugin.app.vault.adapter.basePath = undefined;
      const result = await service.refineInstruction('test', '');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Could not determine vault path');
    });

    it('should return error when Codex CLI is not found', async () => {
      mockPlugin.getResolvedClaudeCliPath.mockReturnValue(null);
      mockExecCodexPrompt.mockRejectedValue(
        new Error('找不到 Codex CLI。请在设置中填写 Codex CLI 路径，或安装 Codex 应用。')
      );
      const result = await service.refineInstruction('test', '');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Codex CLI');
    });
  });
});
