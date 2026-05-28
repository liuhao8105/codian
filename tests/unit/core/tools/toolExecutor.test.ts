import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { executeDeepSeekToolCall, type ToolExecutionContext } from '@/core/tools/toolExecutor';
import { TransactionLog } from '@/core/tools/transactionLog';
import type CodianPlugin from '@/main';

function createContext(vaultPath: string, settings: Record<string, unknown>): ToolExecutionContext {
  const plugin = {
    settings: {
      enableBlocklist: true,
      blockedCommands: {
        unix: ['rm -rf'],
        windows: [],
      },
      ...settings,
    },
    app: {
      vault: {
        adapter: { basePath: vaultPath },
      },
    },
  } as unknown as CodianPlugin;

  return {
    plugin,
    requestApproval: jest.fn(async () => false),
    transactionLog: new TransactionLog(),
  };
}

function createContextWithApproval(
  vaultPath: string,
  settings: Record<string, unknown>,
  approved: boolean,
): ToolExecutionContext {
  const context = createContext(vaultPath, settings);
  context.requestApproval = jest.fn(async () => approved);
  return context;
}

describe('executeDeepSeekToolCall Bash', () => {
  let vaultPath: string;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-deepseek-bash-'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  it('rejects Bash when DeepSeek bash execution is disabled', async () => {
    const result = await executeDeepSeekToolCall(
      { id: 'tool-1', name: 'Bash', arguments: { command: 'echo disabled' } },
      createContext(vaultPath, { enableDeepSeekBash: false }),
    );

    expect(result).toContain('DeepSeek Bash execution is disabled');
  });

  it('executes Bash inside the vault when DeepSeek bash execution is enabled', async () => {
    const result = await executeDeepSeekToolCall(
      { id: 'tool-1', name: 'Bash', arguments: { command: 'pwd && echo deepseek-ok' } },
      createContext(vaultPath, { enableDeepSeekBash: true }),
    );

    expect(result).toContain(vaultPath);
    expect(result).toContain('deepseek-ok');
    expect(result).toContain('Exit code: 0');
  });

  it('blocks Bash commands that match the command blocklist', async () => {
    const result = await executeDeepSeekToolCall(
      { id: 'tool-1', name: 'Bash', arguments: { command: 'rm -rf ./tmp' } },
      createContext(vaultPath, { enableDeepSeekBash: true }),
    );

    expect(result).toContain('Command blocked by blocklist');
  });

  it('allows Bash commands to reference global Codex skill scripts', async () => {
    const result = await executeDeepSeekToolCall(
      {
        id: 'tool-1',
        name: 'Bash',
        arguments: { command: 'echo ok ~/.codex/skills/example/scripts/run.py' },
      },
      createContext(vaultPath, { enableDeepSeekBash: true }),
    );

    expect(result).toContain('ok');
    expect(result).toContain('.codex/skills/example/scripts/run.py');
    expect(result).not.toContain('Access denied');
  });

  it('blocks Bash commands that reference ordinary paths outside the vault when approval is denied', async () => {
    const result = await executeDeepSeekToolCall(
      { id: 'tool-1', name: 'Bash', arguments: { command: 'cat /etc/passwd' } },
      createContext(vaultPath, { enableDeepSeekBash: true }),
    );

    expect(result).toContain('User denied external path access');
    expect(result).toContain('outside the vault');
  });

  it('allows Bash commands to reference ordinary outside paths during temporary external access', async () => {
    const result = await executeDeepSeekToolCall(
      { id: 'tool-1', name: 'Bash', arguments: { command: 'echo ok /etc/passwd' } },
      createContext(vaultPath, {
        enableDeepSeekBash: true,
        temporaryExternalAccess: true,
      }),
    );

    expect(result).toContain('ok /etc/passwd');
    expect(result).not.toContain('Access denied');
  });

  it('asks for approval before Bash uses an outside path', async () => {
    const context = createContextWithApproval(
      vaultPath,
      { enableDeepSeekBash: true },
      false,
    );

    const result = await executeDeepSeekToolCall(
      { id: 'tool-1', name: 'Bash', arguments: { command: 'echo ok /etc/passwd' } },
      context,
    );

    expect(context.requestApproval).toHaveBeenCalledWith(
      'Bash',
      expect.stringContaining('external path'),
      expect.objectContaining({
        command: 'echo ok /etc/passwd',
        temporaryExternalAccess: true,
      }),
      expect.objectContaining({
        decisionReason: expect.stringContaining('outside the vault'),
        blockedPath: '/etc/passwd',
        approvalKind: 'temporaryExternalAccess',
      }),
    );
    expect(result).toContain('User denied external path access');
    expect(result).not.toContain('ok /etc/passwd');
  });

  it('continues Bash and enables turn-scoped external access after approval', async () => {
    const context = createContextWithApproval(
      vaultPath,
      { enableDeepSeekBash: true },
      true,
    );

    const result = await executeDeepSeekToolCall(
      { id: 'tool-1', name: 'Bash', arguments: { command: 'echo ok /etc/passwd' } },
      context,
    );

    expect(context.requestApproval).toHaveBeenCalledTimes(1);
    expect((context.plugin.settings as any).temporaryExternalAccess).toBe(true);
    expect(result).toContain('ok /etc/passwd');
    expect(result).not.toContain('Access denied');
  });

  it('keeps the command blocklist enabled during temporary external access', async () => {
    const result = await executeDeepSeekToolCall(
      { id: 'tool-1', name: 'Bash', arguments: { command: 'rm -rf ./tmp' } },
      createContext(vaultPath, {
        enableDeepSeekBash: true,
        temporaryExternalAccess: true,
      }),
    );

    expect(result).toContain('Command blocked by blocklist');
  });

  it('allows Bash commands to discard stderr with /dev/null redirection', async () => {
    const result = await executeDeepSeekToolCall(
      { id: 'tool-1', name: 'Bash', arguments: { command: 'ls missing-file 2>/dev/null; echo after-null' } },
      createContext(vaultPath, { enableDeepSeekBash: true }),
    );

    expect(result).not.toContain('Access denied');
    expect(result).toContain('after-null');
  });
});
