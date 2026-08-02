import { type ChildProcess,spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import type CodianPlugin from '../../main';
import {
  appendBoundedLogSync,
  classifyDiagnosticError,
  sanitizeDiagnosticValue,
} from '../../utils/boundedLog';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import {
  buildCodexConfigOverrideArgs,
  buildCodexMcpDisableOverrideArgs,
  extractReadableCodexErrorMessage,
  normalizeCodexModelForRuntime,
  resolveCodexCliPath,
} from './codexExec';

type JsonRpcId = string | number;

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
  };
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export interface AppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerClientOptions {
  disabledMcpServers?: string[];
  requestHandler?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}

const CODIAN_DIAGNOSTIC_LOG = path.join(os.tmpdir(), 'codian-app-server.log');

function appendDiagnosticLog(message: string): void {
  try {
    appendBoundedLogSync(
      CODIAN_DIAGNOSTIC_LOG,
      `[${new Date().toISOString()}] ${message}\n`
    );
  } catch {
    // Ignore logging failures.
  }
}

function buildRuntimeEnv(plugin: CodianPlugin, codexPath: string): NodeJS.ProcessEnv {
  const customEnv = parseEnvironmentVariables(plugin.getActiveEnvironmentVariables());
  return {
    ...process.env,
    ...customEnv,
    PATH: getEnhancedPath(customEnv.PATH, codexPath),
  };
}

function createJsonRpcId(): JsonRpcId {
  return `codian-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function summarizeSpawnForLog(input: {
  provider: string;
  modelConfigured: boolean;
  baseUrlConfigured: boolean;
  cliResolved: boolean;
  disabledMcpCount: number;
}): string {
  return `spawn provider=${sanitizeDiagnosticValue(input.provider, 40)} modelConfigured=${input.modelConfigured} baseUrlConfigured=${input.baseUrlConfigured} cliResolved=${input.cliResolved} disabledMcpCount=${input.disabledMcpCount}`;
}

export function summarizeStderrForLog(line: string): string {
  return `stderr category=${classifyDiagnosticError(line)} message=${sanitizeDiagnosticValue(line)}`;
}

export class CodexAppServerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly readlineInterface: readline.Interface;
  private readonly notificationHandler: (notification: AppServerNotification) => void;
  private readonly requestHandler?: CodexAppServerClientOptions['requestHandler'];
  private readonly stderrLines: string[] = [];
  private readonly clientVersion: string;
  private closed = false;

  constructor(
    plugin: CodianPlugin,
    notificationHandler: (notification: AppServerNotification) => void,
    abortSignal?: AbortSignal,
    options: CodexAppServerClientOptions = {},
  ) {
    const codexPath = resolveCodexCliPath(plugin);
    if (!codexPath) {
      throw new Error('找不到 Codex CLI。请在设置中填写 Codex CLI 路径，或安装 Codex 应用。');
    }

    this.notificationHandler = notificationHandler;
    this.requestHandler = options.requestHandler;
    this.clientVersion = plugin.manifest.version;

    const startupModel = normalizeCodexModelForRuntime(plugin.settings.model);
    const startupArgs = plugin.settings.currentProvider === 'codex'
      ? [
          ...buildCodexConfigOverrideArgs(startupModel),
          ...buildCodexMcpDisableOverrideArgs(options.disabledMcpServers ?? [], []),
        ]
      : [];
    const runtimeEnv = buildRuntimeEnv(plugin, codexPath);
    appendDiagnosticLog(summarizeSpawnForLog({
      provider: plugin.settings.currentProvider,
      modelConfigured: Boolean(plugin.settings.model?.trim()),
      baseUrlConfigured: Boolean(runtimeEnv.OPENAI_BASE_URL?.trim()),
      cliResolved: Boolean(codexPath),
      disabledMcpCount: options.disabledMcpServers?.length ?? 0,
    }));

    this.child = spawn(codexPath, [...startupArgs, 'app-server', '--listen', 'stdio://'], {
      env: runtimeEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(codexPath),
    });

    this.readlineInterface = readline.createInterface({
      input: this.child.stdout!,
      crlfDelay: Infinity,
    });

    this.readlineInterface.on('line', (line) => {
      this.handleLine(line);
    });

    this.child.on('error', (error) => {
      appendDiagnosticLog(`child-error category=${classifyDiagnosticError(error.message)} message=${sanitizeDiagnosticValue(error.message)}`);
      this.rejectAll(this.withStderrContext(`启动 Codex App Server 失败：${error.message}`));
    });

    this.child.on('close', (code, signal) => {
      const lastStderr = this.stderrLines.at(-1);
      appendDiagnosticLog(`child-close code=${code ?? 'unknown'} signal=${signal ?? 'none'} stderrCount=${this.stderrLines.length} stderrCategory=${lastStderr ? classifyDiagnosticError(lastStderr) : 'none'}`);
      if (this.closed) return;
      const reason = code === 0
        ? new Error(this.withStderrContext('Codex App Server 已关闭。').message)
        : new Error(this.withStderrContext(
          `Codex App Server 异常退出（code=${code ?? 'unknown'}${signal ? `, signal=${signal}` : ''}）。`
        ).message);
      this.rejectAll(reason);
    });

    if (this.child.stderr) {
      this.child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          appendDiagnosticLog(summarizeStderrForLog(trimmed));
          this.stderrLines.push(trimmed);
          if (this.stderrLines.length > 20) {
            this.stderrLines.shift();
          }
        }
      });
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        this.kill();
      } else {
        abortSignal.addEventListener('abort', () => this.kill(), { once: true });
      }
    }
  }

  async initialize(): Promise<void> {
    appendDiagnosticLog('request initialize');
    await this.request('initialize', {
      clientInfo: {
        name: 'codian',
        title: 'Codian',
        version: this.clientVersion,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized');
  }

  async request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed || !this.child.stdin?.writable) {
      throw new Error('Codex App Server 不可用。');
    }
    appendDiagnosticLog(`request ${method}`);

    const id = createJsonRpcId();
    const payload = JSON.stringify({ id, method, params });

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(`${payload}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          appendDiagnosticLog(`request-write-error method=${sanitizeDiagnosticValue(method, 80)} category=${classifyDiagnosticError(error.message)} message=${sanitizeDiagnosticValue(error.message)}`);
          reject(new Error(`发送 App Server 请求失败：${error.message}`));
        }
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  kill(): void {
    if (this.closed) return;
    appendDiagnosticLog('client-kill');
    this.closed = true;
    this.rejectAll(new Error('Cancelled'));
    this.readlineInterface.close();
    try {
      this.child.kill();
    } catch {
      // Ignore kill errors.
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message.id, message.method, message.params || {});
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.error) {
        const responseError = message.error.message || 'App Server 请求失败。';
        appendDiagnosticLog(`response-error category=${classifyDiagnosticError(responseError)} message=${sanitizeDiagnosticValue(responseError)}`);
        pending.reject(new Error(extractReadableCodexErrorMessage(message.error.message || 'App Server 请求失败。')));
        return;
      }

      pending.resolve(message.result || {});
      return;
    }

    if (message.method) {
      this.notificationHandler({
        method: message.method,
        params: message.params || {},
      });
    }
  }

  private async handleServerRequest(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      const result = await this.requestHandler?.(method, params);
      if (!result) {
        this.writeResponse({
          id,
          error: {
            code: -32601,
            message: `Unsupported App Server request: ${method}`,
          },
        });
        return;
      }
      this.writeResponse({ id, result });
    } catch (error) {
      this.writeResponse({
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'App Server request failed.',
        },
      });
    }
  }

  private writeResponse(message: JsonRpcMessage): void {
    if (this.closed || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        appendDiagnosticLog(`response-write-error category=${classifyDiagnosticError(error.message)} message=${sanitizeDiagnosticValue(error.message)}`);
      }
    });
  }

  private rejectAll(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private withStderrContext(baseMessage: string): Error {
    const lastRelevantLine = [...this.stderrLines]
      .reverse()
      .find((line) => /error|failed|unsupported|invalid|unauthorized|forbidden|denied/i.test(line));
    if (!lastRelevantLine) {
      return new Error(baseMessage);
    }
    return new Error(`${baseMessage} ${lastRelevantLine}`);
  }
}
