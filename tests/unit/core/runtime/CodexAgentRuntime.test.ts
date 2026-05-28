import { CodexAgentRuntime } from '@/core/runtime/CodexAgentRuntime';
import type { AppServerNotification } from '@/core/runtime/CodexAppServerClient';
import type { StreamChunk } from '@/core/types';

let latestNotificationHandler: ((notification: AppServerNotification) => void) | null = null;
const requestMock = jest.fn();
const killMock = jest.fn();

jest.mock('@/core/runtime/codexExec', () => ({
  normalizeCodexModelForRuntime: (model?: string | null) => model ?? null,
  resolveCodexCliPath: jest.fn(() => '/mock/codex'),
}));

jest.mock('@/core/runtime/CodexAppServerClient', () => ({
  CodexAppServerClient: jest.fn().mockImplementation((_plugin, notificationHandler) => {
    latestNotificationHandler = notificationHandler;
    return {
      initialize: jest.fn().mockResolvedValue(undefined),
      request: requestMock,
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
  } as any;
}

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
});
