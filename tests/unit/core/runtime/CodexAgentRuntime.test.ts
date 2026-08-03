import {
  CodexAgentRuntime,
  summarizeNotificationForLog,
} from '@/core/runtime/CodexAgentRuntime';

describe('CodexAgentRuntime diagnostic summaries', () => {
  it('keeps notification structure without persisting content, arguments, paths, URLs, or stacks', () => {
    const summary = summarizeNotificationForLog({
      method: 'error',
      params: {
        willRetry: true,
        content: 'private note body',
        arguments: { token: 'secret-token' },
        message: 'failed at /Users/example/private.md https://api.example.test?token=secret\n    at private stack',
      },
    });

    expect(summary).toContain('method=error');
    expect(summary).toContain('retry=true');
    expect(summary).toContain('category=');
    expect(summary).not.toContain('private note body');
    expect(summary).not.toContain('secret-token');
    expect(summary).not.toContain('/Users/example');
    expect(summary).not.toContain('api.example.test');
    expect(summary).not.toContain('private stack');
  });
});
import type { AppServerNotification } from '@/core/runtime/CodexAppServerClient';
import type { StreamChunk } from '@/core/types';

let latestNotificationHandler: ((notification: AppServerNotification) => void) | null = null;
let latestRequestHandler: ((
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>) | null = null;
const notificationHandlers: Array<(notification: AppServerNotification) => void> = [];
const initializeMock = jest.fn();
const requestMock = jest.fn();
const killMock = jest.fn();

jest.mock('@/core/runtime/codexExec', () => ({
  buildCodexMcpDisableOverrideArgs: (available: string[], requested: string[]) => available
    .filter((name) => !requested.includes(name))
    .flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
  discoverConfiguredCodexMcpServerNames: jest.fn().mockResolvedValue(['blender', 'github']),
  extractExplicitCodexMcpNames: (prompt: string, available: string[]) => available
    .filter((name) => prompt.toLocaleLowerCase().includes(`@${name.toLocaleLowerCase()}`)),
  normalizeCodexModelForRuntime: (model?: string | null) => model ?? null,
  resolveCodexCliPath: jest.fn(() => '/mock/codex'),
}));

import { discoverConfiguredCodexMcpServerNames } from '@/core/runtime/codexExec';

const discoverConfiguredCodexMcpServerNamesMock = discoverConfiguredCodexMcpServerNames as jest.MockedFunction<typeof discoverConfiguredCodexMcpServerNames>;

jest.mock('@/core/runtime/CodexAppServerClient', () => ({
  CodexAppServerClient: jest.fn().mockImplementation((_plugin, notificationHandler, _signal, options) => {
    latestNotificationHandler = notificationHandler;
    latestRequestHandler = options?.requestHandler ?? null;
    const clientIndex = notificationHandlers.push(notificationHandler) - 1;
    return {
      initialize: () => initializeMock(clientIndex),
      request: (method: string, params?: Record<string, unknown>) => requestMock(method, params, clientIndex),
      kill: killMock,
    };
  }),
}));

function createPlugin() {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/mock/vault',
        },
      },
    },
    settings: {
      currentProvider: 'codex',
      model: 'gpt-5.5',
      thinkingBudget: 'low',
      mediaFolder: '',
      strongRulesPrompt: '',
      systemPrompt: '',
      allowedExportPaths: [],
      userName: '',
      providerConfigs: {
        deepseek: {
          apiKey: '',
          baseUrl: '',
          model: '',
        },
      },
    },
    getActiveEnvironmentVariables: jest.fn(() => ''),
  } as any;
}

describe('CodexAgentRuntime MCP discovery freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    discoverConfiguredCodexMcpServerNamesMock.mockResolvedValue(['blender', 'github']);
  });

  it('shares discovery inside 60 seconds and refreshes after the TTL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const runtime = new CodexAgentRuntime(createPlugin(), { loadServers: jest.fn() } as any);

    await (runtime as any).getGlobalMcpNames();
    await (runtime as any).getGlobalMcpNames();
    expect(discoverConfiguredCodexMcpServerNamesMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(61_001);
    await (runtime as any).getGlobalMcpNames();
    expect(discoverConfiguredCodexMcpServerNamesMock).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it('clears discovery immediately when MCP servers are explicitly reloaded', async () => {
    const mcpManager = { loadServers: jest.fn().mockResolvedValue(undefined) };
    const runtime = new CodexAgentRuntime(createPlugin(), mcpManager as any);

    await (runtime as any).getGlobalMcpNames();
    await runtime.reloadMcpServers();
    await (runtime as any).getGlobalMcpNames();

    expect(mcpManager.loadServers).toHaveBeenCalledTimes(1);
    expect(discoverConfiguredCodexMcpServerNamesMock).toHaveBeenCalledTimes(2);
  });
});

async function collectChunks(generator: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of generator) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('CodexAgentRuntime retryable App Server errors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    latestNotificationHandler = null;
    latestRequestHandler = null;
    notificationHandlers.length = 0;
    initializeMock.mockReset().mockResolvedValue(undefined);
    requestMock.mockImplementation(async (method: string) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        setTimeout(() => {
          latestNotificationHandler?.({
            method: 'error',
            params: {
              error: {
                message: 'Reconnecting... 2/5',
                codexErrorInfo: {
                  responseStreamDisconnected: {
                    httpStatusCode: null,
                  },
                },
              },
              willRetry: true,
              threadId: 'thread-1',
              turnId: 'turn-1',
            },
          });
        }, 0);
        setTimeout(() => {
          latestNotificationHandler?.({
            method: 'item/started',
            params: {
              item: {
                id: 'msg-1',
                type: 'agentMessage',
              },
            },
          });
          latestNotificationHandler?.({
            method: 'item/agentMessage/delta',
            params: {
              itemId: 'msg-1',
              delta: 'Recovered after retry.',
            },
          });
          latestNotificationHandler?.({
            method: 'turn/completed',
            params: {
              turnId: 'turn-1',
            },
          });
        }, 10);
        return { turn: { id: 'turn-1' } };
      }
      return {};
    });
  });

  it('keeps the stream open when App Server reports a retryable disconnect', async () => {
    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);

    const chunks = await collectChunks(runtime.query('hello'));

    expect(chunks).not.toContainEqual({ type: 'error', content: 'Reconnecting... 2/5' });
    expect(chunks).toContainEqual({ type: 'text', content: 'Recovered after retry.' });
    expect(chunks).toContainEqual({ type: 'done' });
  });

  it('keeps the no-activity watchdog active when a retryable disconnect never recovers', async () => {
    jest.useFakeTimers();
    const clientConstructor = jest.requireMock('@/core/runtime/CodexAppServerClient').CodexAppServerClient as jest.Mock;
    requestMock.mockImplementation(async (method: string, _params: unknown, clientIndex: number) => {
      if (method === 'thread/start') return { thread: { id: `thread-${clientIndex + 1}` } };
      if (method === 'turn/start') {
        setTimeout(() => {
          if (clientIndex === 0) {
            notificationHandlers[0]?.({
              method: 'error',
              params: { error: { message: 'Reconnecting... 1/5' }, willRetry: true },
            });
          } else {
            notificationHandlers[1]?.({
              method: 'item/agentMessage/delta',
              params: { itemId: 'msg-recovered', delta: 'Recovered after reconnect stall.' },
            });
            notificationHandlers[1]?.({ method: 'turn/completed', params: { turnId: 'turn-2' } });
          }
        }, 0);
        return { turn: { id: `turn-${clientIndex + 1}` } };
      }
      return {};
    });

    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);
    const chunksPromise = collectChunks(runtime.query('hello'));

    await jest.advanceTimersByTimeAsync(91_000);
    notificationHandlers[0]?.({
      method: 'error',
      params: { error: { message: 'Old reconnect attempt closed.' }, willRetry: false },
    });
    await jest.runOnlyPendingTimersAsync();
    const chunks = await chunksPromise;

    expect(clientConstructor).toHaveBeenCalledTimes(2);
    expect(chunks).toContainEqual({ type: 'text', content: 'Recovered after reconnect stall.' });
    expect(chunks).not.toContainEqual({ type: 'error', content: 'Reconnecting... 1/5' });
    jest.useRealTimers();
  });

  it('starts ordinary chat with every discovered global MCP disabled', async () => {
    const clientConstructor = jest.requireMock('@/core/runtime/CodexAppServerClient').CodexAppServerClient as jest.Mock;
    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);

    await collectChunks(runtime.query('hello'));

    expect(clientConstructor.mock.calls[0][3]).toEqual(expect.objectContaining({
      disabledMcpServers: ['blender', 'github'],
    }));
  });

  it('uses native developer instructions and the selected reasoning effort', async () => {
    const plugin = createPlugin();
    plugin.settings.strongRulesPrompt = 'Always use Chinese.';
    plugin.settings.thinkingBudget = 'low';
    const runtime = new CodexAgentRuntime(plugin, { getActiveServers: jest.fn(() => ({})) } as any);

    await collectChunks(runtime.query('hello'));

    const threadStart = requestMock.mock.calls.find(([method]) => method === 'thread/start');
    const turnStart = requestMock.mock.calls.find(([method]) => method === 'turn/start');
    const input = turnStart?.[1]?.input as Array<Record<string, unknown>>;

    expect(turnStart?.[1]?.effort).toBe('low');
    expect(threadStart?.[1]?.developerInstructions).toEqual(expect.stringContaining('Codian'));
    expect(threadStart?.[1]?.developerInstructions).toEqual(expect.stringContaining('Always use Chinese.'));
    expect(input[0]).toEqual(expect.objectContaining({ type: 'text', text: 'hello' }));
  });

  it('refreshes native developer instructions when resuming a thread', async () => {
    const plugin = createPlugin();
    plugin.settings.systemPrompt = 'Keep answers concise.';
    const runtime = new CodexAgentRuntime(plugin, { getActiveServers: jest.fn(() => ({})) } as any);
    runtime.setSessionId('thread-existing');

    await collectChunks(runtime.query('hello'));

    const threadResume = requestMock.mock.calls.find(([method]) => method === 'thread/resume');
    expect(threadResume?.[1]?.developerInstructions).toEqual(expect.stringContaining('Keep answers concise.'));
  });

  it('does not override App Server reasoning effort when thinking is off', async () => {
    const plugin = createPlugin();
    plugin.settings.thinkingBudget = 'off';
    const runtime = new CodexAgentRuntime(plugin, { getActiveServers: jest.fn(() => ({})) } as any);

    await collectChunks(runtime.query('hello'));

    const turnStart = requestMock.mock.calls.find(([method]) => method === 'turn/start');
    expect(turnStart?.[1]).not.toHaveProperty('effort');
  });

  it.each([
    ['normal', 'on-request'],
    ['plan', 'on-request'],
    ['yolo', 'never'],
  ] as const)('maps %s mode to the App Server %s approval policy', async (permissionMode, approvalPolicy) => {
    const plugin = createPlugin();
    plugin.settings.permissionMode = permissionMode;
    const runtime = new CodexAgentRuntime(plugin, { getActiveServers: jest.fn(() => ({})) } as any);

    await collectChunks(runtime.query('hello'));

    const turnStart = requestMock.mock.calls.find(([method]) => method === 'turn/start');
    expect(turnStart?.[1]).toEqual(expect.objectContaining({ approvalPolicy }));
  });

  it('routes App Server user-input requests through the existing inline callback', async () => {
    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);
    const ask = jest.fn().mockResolvedValue({ deploy: 'Production' });
    runtime.setAskUserQuestionCallback(ask);
    await collectChunks(runtime.query('hello'));

    const result = await latestRequestHandler?.('item/tool/requestUserInput', {
      questions: [{
        id: 'deploy',
        header: 'Target',
        question: 'Where should this run?',
        options: [{ label: 'Production', description: 'Live environment' }],
      }],
    });

    expect(ask).toHaveBeenCalled();
    expect(result).toEqual({
      answers: {
        deploy: { answers: ['Production'] },
      },
    });
  });

  it('routes dynamic permission grants through approval and declines MCP elicitation safely', async () => {
    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);
    const approve = jest.fn().mockResolvedValue('allow-always');
    runtime.setApprovalCallback(approve);
    await collectChunks(runtime.query('hello'));

    const permissions = { network: { enabled: true } };
    await expect(latestRequestHandler?.('item/permissions/requestApproval', {
      permissions,
      reason: 'Needs network access',
    })).resolves.toEqual({ permissions, scope: 'session' });
    await expect(latestRequestHandler?.('mcpServer/elicitation/request', {}))
      .resolves.toEqual({ action: 'decline' });
  });

  it('keeps an explicitly requested global MCP enabled for that turn only', async () => {
    const clientConstructor = jest.requireMock('@/core/runtime/CodexAppServerClient').CodexAppServerClient as jest.Mock;
    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);

    await collectChunks(runtime.query('请使用 @github 检查仓库'));

    expect(clientConstructor.mock.calls[0][3]).toEqual(expect.objectContaining({
      disabledMcpServers: ['blender'],
    }));
  });

  it('ends the stream when App Server reports a final error', async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        setTimeout(() => {
          latestNotificationHandler?.({
            method: 'error',
            params: {
              error: {
                message: 'Permanent failure',
              },
              threadId: 'thread-1',
              turnId: 'turn-1',
            },
          });
        }, 0);
        return { turn: { id: 'turn-1' } };
      }
      return {};
    });

    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);

    const chunks = await collectChunks(runtime.query('hello'));

    expect(chunks).toContainEqual({ type: 'error', content: 'Permanent failure' });
    expect(chunks).not.toContainEqual({ type: 'done' });
  });

  it('explains a final ChatGPT transport disconnect in actionable Chinese', async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        setTimeout(() => {
          latestNotificationHandler?.({
            method: 'error',
            params: {
              error: {
                message: 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
                codexErrorInfo: 'other',
                additionalDetails: null,
              },
              willRetry: false,
              threadId: 'thread-1',
              turnId: 'turn-1',
            },
          });
        }, 0);
        return { turn: { id: 'turn-1' } };
      }
      return {};
    });

    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);

    const chunks = await collectChunks(runtime.query('hello'));

    expect(chunks).toContainEqual({
      type: 'error',
      content: 'Codex 与 ChatGPT 的连接已中断，自动重试后仍未恢复。请检查网络或代理设置，然后重新发送消息。',
    });
    expect(chunks).not.toContainEqual({
      type: 'error',
      content: expect.stringContaining('backend-api/codex/responses'),
    });
  });

  it('rebuilds once with a stalled MCP server disabled before any turn output', async () => {
    jest.useFakeTimers();
    const clientConstructor = jest.requireMock('@/core/runtime/CodexAppServerClient').CodexAppServerClient as jest.Mock;

    requestMock.mockImplementation(async (method: string, _params: unknown, clientIndex: number) => {
      if (method === 'thread/start') {
        return { thread: { id: `thread-${clientIndex + 1}` } };
      }
      if (method === 'turn/start') {
        if (clientIndex === 0) {
          setTimeout(() => {
            notificationHandlers[0]?.({
              method: 'mcpServer/startupStatus/updated',
              params: { name: 'blender', status: 'starting' },
            });
          }, 0);
        } else {
          setTimeout(() => {
            notificationHandlers[1]?.({
              method: 'item/agentMessage/delta',
              params: { itemId: 'msg-recovered', delta: 'Recovered without Blender.' },
            });
            notificationHandlers[1]?.({ method: 'turn/completed', params: { turnId: 'turn-2' } });
          }, 0);
        }
        return { turn: { id: `turn-${clientIndex + 1}` } };
      }
      return {};
    });

    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);
    const chunksPromise = collectChunks(runtime.query('请使用 @blender 回答'));

    await jest.advanceTimersByTimeAsync(21_000);
    notificationHandlers[0]?.({
      method: 'error',
      params: { error: { message: 'Old stalled attempt closed.' }, willRetry: false },
    });
    await jest.runOnlyPendingTimersAsync();
    const chunks = await chunksPromise;

    expect(clientConstructor).toHaveBeenCalledTimes(2);
    expect(clientConstructor.mock.calls[1][3]).toEqual(expect.objectContaining({
      disabledMcpServers: ['blender', 'github'],
    }));
    expect(chunks).toContainEqual({ type: 'text', content: 'Recovered without Blender.' });
    expect(chunks).not.toContainEqual({ type: 'error', content: 'Old stalled attempt closed.' });
    jest.useRealTimers();
  });

  it('rebuilds when App Server initialization itself never returns', async () => {
    jest.useFakeTimers();
    const clientConstructor = jest.requireMock('@/core/runtime/CodexAppServerClient').CodexAppServerClient as jest.Mock;
    initializeMock.mockImplementation((clientIndex: number) => (
      clientIndex === 0 ? new Promise<void>(() => {}) : Promise.resolve()
    ));
    requestMock.mockImplementation(async (method: string, _params: unknown, clientIndex: number) => {
      if (method === 'thread/start') return { thread: { id: `thread-${clientIndex + 1}` } };
      if (method === 'turn/start') {
        setTimeout(() => {
          notificationHandlers[1]?.({
            method: 'item/agentMessage/delta',
            params: { itemId: 'msg-recovered', delta: 'Recovered after startup stall.' },
          });
          notificationHandlers[1]?.({ method: 'turn/completed', params: { turnId: 'turn-2' } });
        }, 0);
        return { turn: { id: `turn-${clientIndex + 1}` } };
      }
      return {};
    });

    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);
    const chunksPromise = collectChunks(runtime.query('hello'));

    await jest.advanceTimersByTimeAsync(31_000);
    notificationHandlers[0]?.({
      method: 'error',
      params: { error: { message: 'Old startup attempt closed.' }, willRetry: false },
    });
    await jest.runOnlyPendingTimersAsync();
    const chunks = await chunksPromise;

    expect(clientConstructor).toHaveBeenCalledTimes(2);
    expect(chunks).toContainEqual({ type: 'text', content: 'Recovered after startup stall.' });
    expect(chunks).not.toContainEqual({ type: 'error', content: 'Old startup attempt closed.' });
    jest.useRealTimers();
  });

  it('ends with an actionable error when the rebuilt attempt also has no turn activity', async () => {
    jest.useFakeTimers();
    requestMock.mockImplementation(async (method: string, _params: unknown, clientIndex: number) => {
      if (method === 'thread/start') {
        return { thread: { id: `thread-${clientIndex + 1}` } };
      }
      if (method === 'turn/start') {
        return { turn: { id: `turn-${clientIndex + 1}` } };
      }
      return {};
    });

    const runtime = new CodexAgentRuntime(createPlugin(), { getActiveServers: jest.fn(() => ({})) } as any);
    const chunksPromise = collectChunks(runtime.query('hello'));

    await jest.advanceTimersByTimeAsync(91_000);
    await jest.advanceTimersByTimeAsync(91_000);
    notificationHandlers[0]?.({
      method: 'error',
      params: { error: { message: 'Old stalled attempt closed.' }, willRetry: false },
    });
    await jest.runOnlyPendingTimersAsync();
    const chunks = await chunksPromise;

    expect(chunks).toContainEqual({
      type: 'error',
      content: 'Codex 长时间没有返回任何结果，自动重建后仍未恢复。请检查 MCP、网络或代理设置，然后重新发送消息。',
    });
    jest.useRealTimers();
  });
});
