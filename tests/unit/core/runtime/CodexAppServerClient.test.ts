import { EventEmitter } from 'events';

const stdinWrite = jest.fn((_payload: string, callback?: (error?: Error | null) => void) => {
  callback?.(null);
  return true;
});
const child = new EventEmitter() as EventEmitter & {
  stdin: { writable: boolean; write: typeof stdinWrite };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
};
child.stdin = { writable: true, write: stdinWrite };
child.stdout = new EventEmitter();
child.stderr = new EventEmitter();
child.kill = jest.fn();

jest.mock('child_process', () => ({
  spawn: jest.fn(() => child),
}));

import { spawn } from 'child_process';

const readlineOn = jest.fn();
jest.mock('readline', () => ({
  createInterface: jest.fn(() => ({
    on: readlineOn,
    close: jest.fn(),
  })),
}));

jest.mock('@/core/runtime/codexExec', () => ({
  buildCodexConfigOverrideArgs: jest.fn(() => []),
  buildCodexMcpDisableOverrideArgs: jest.fn(() => []),
  extractReadableCodexErrorMessage: (message: string) => message,
  normalizeCodexModelForRuntime: (model: string) => model,
  resolveCodexCliPath: jest.fn(() => '/mock/codex'),
}));

import {
  CodexAppServerClient,
  summarizeSpawnForLog,
  summarizeStderrForLog,
} from '@/core/runtime/CodexAppServerClient';

describe('CodexAppServerClient diagnostic summaries', () => {
  it('records only configured booleans and counts for process startup', () => {
    const summary = summarizeSpawnForLog({
      provider: 'codex',
      modelConfigured: true,
      baseUrlConfigured: true,
      cliResolved: true,
      disabledMcpCount: 2,
    });

    expect(summary).toBe('spawn provider=codex modelConfigured=true baseUrlConfigured=true cliResolved=true disabledMcpCount=2');
  });

  it('classifies stderr without persisting secrets, URLs, paths, environment values, or stacks', () => {
    const summary = summarizeStderrForLog(
      'unauthorized token=secret at /Users/example/private.md https://api.example.test\nstack-private',
    );

    expect(summary).toContain('stderr category=auth');
    expect(summary).not.toContain('secret');
    expect(summary).not.toContain('/Users/example');
    expect(summary).not.toContain('api.example.test');
    expect(summary).not.toContain('stack-private');
  });
});

function createPlugin() {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/mock/vault',
        },
      },
    },
    manifest: {
      version: '1.3.83-stability-hardening',
    },
    settings: {
      currentProvider: 'codex',
      model: 'gpt-5.6-sol',
    },
    getActiveEnvironmentVariables: jest.fn(() => ''),
  } as any;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CodexAppServerClient server requests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    child.stdin.writable = true;
  });

  it('starts App Server from the vault instead of the CLI installation directory', () => {
    new CodexAppServerClient(createPlugin(), jest.fn());

    expect(spawn).toHaveBeenCalledWith(
      '/mock/codex',
      expect.any(Array),
      expect.objectContaining({ cwd: '/mock/vault' }),
    );
  });

  it('routes server-initiated approval requests and writes the result response', async () => {
    const requestHandler = jest.fn().mockResolvedValue({ decision: 'accept' });
    const client = new CodexAppServerClient(
      createPlugin(),
      jest.fn(),
      undefined,
      { requestHandler } as any,
    );

    (client as any).handleLine(JSON.stringify({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'git status', itemId: 'item-1' },
    }));
    await flushPromises();

    expect(requestHandler).toHaveBeenCalledWith(
      'item/commandExecution/requestApproval',
      { command: 'git status', itemId: 'item-1' },
    );
    expect(stdinWrite).toHaveBeenCalledWith(
      `${JSON.stringify({ id: 'approval-1', result: { decision: 'accept' } })}\n`,
      expect.any(Function),
    );
  });

  it('reports the installed plugin version during initialization', async () => {
    const client = new CodexAppServerClient(createPlugin(), jest.fn());
    const initializing = client.initialize();
    await flushPromises();

    const payload = JSON.parse(stdinWrite.mock.calls[0][0].trim());
    expect(payload.method).toBe('initialize');
    expect(payload.params.clientInfo.version).toBe('1.3.83-stability-hardening');

    (client as any).handleLine(JSON.stringify({ id: payload.id, result: {} }));
    await expect(initializing).resolves.toBeUndefined();
  });

  it('returns method-not-found when no request handler accepts the method', async () => {
    const client = new CodexAppServerClient(createPlugin(), jest.fn());

    (client as any).handleLine(JSON.stringify({
      id: 'unknown-1',
      method: 'unknown/request',
      params: {},
    }));
    await flushPromises();

    expect(stdinWrite).toHaveBeenCalledWith(
      `${JSON.stringify({
        id: 'unknown-1',
        error: { code: -32601, message: 'Unsupported App Server request: unknown/request' },
      })}\n`,
      expect.any(Function),
    );
  });
});
