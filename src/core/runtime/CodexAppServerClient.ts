import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

import type CodianPlugin from '../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { resolveCodexCliPath } from './codexExec';

type JsonRpcId = string;

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

export class CodexAppServerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly readlineInterface: readline.Interface;
  private readonly notificationHandler: (notification: AppServerNotification) => void;
  private closed = false;

  constructor(
    plugin: CodianPlugin,
    notificationHandler: (notification: AppServerNotification) => void,
    abortSignal?: AbortSignal
  ) {
    const codexPath = resolveCodexCliPath(plugin);
    if (!codexPath) {
      throw new Error('找不到 Codex CLI。请在设置中填写 Codex CLI 路径，或安装 Codex 应用。');
    }

    this.notificationHandler = notificationHandler;

    this.child = spawn(codexPath, ['app-server', '--listen', 'stdio://'], {
      env: buildRuntimeEnv(plugin, codexPath),
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
      this.rejectAll(new Error(`启动 Codex App Server 失败：${error.message}`));
    });

    this.child.on('close', (code, signal) => {
      if (this.closed) return;
      const reason = code === 0
        ? new Error('Codex App Server 已关闭。')
        : new Error(`Codex App Server 异常退出（code=${code ?? 'unknown'}${signal ? `, signal=${signal}` : ''}）。`);
      this.rejectAll(reason);
    });

    if (this.child.stderr) {
      this.child.stderr.on('data', () => {
        // Ignore stderr noise from helper processes.
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
    await this.request('initialize', {
      clientInfo: {
        name: 'codian',
        title: 'Codian',
        version: '0.1.0',
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

    const id = createJsonRpcId();
    const payload = JSON.stringify({ id, method, params });

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(`${payload}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
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

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || 'App Server 请求失败。'));
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

  private rejectAll(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
