import { type ChildProcess,spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type CodianPlugin from '../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../utils/env';
import { expandHomePath, parsePathEntries } from '../../utils/path';

export interface CodexExecParams {
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode?: 'yolo' | 'plan' | 'normal' | 'read-only';
  abortController?: AbortController | null;
}

export interface CodexExecResult {
  text: string;
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
}

const CHATGPT_SAFE_CODEX_MODEL = 'gpt-5.6-sol';

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isLikelyCodexExecutable(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  const baseName = path.basename(normalizedPath);

  return (
    baseName === 'codex' ||
    baseName === 'codex.exe' ||
    normalizedPath.includes('/codex.app/contents/resources/codex') ||
    normalizedPath.includes('\\codex.app\\contents\\resources\\codex')
  );
}

function isLikelyCodexModel(model: string | undefined): boolean {
  if (!model) return false;
  return /^(gpt-|o[1-9]|o[1-9]-|codex)/i.test(model.trim());
}

function readCodexAuthMode(): string | null {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const raw = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(raw) as { auth_mode?: unknown };
    return typeof parsed.auth_mode === 'string' ? parsed.auth_mode : null;
  } catch {
    return null;
  }
}

export function extractReadableCodexErrorMessage(rawMessage: string): string {
  const trimmed = rawMessage.trim();
  if (!trimmed) return rawMessage;

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const nested = typeof parsed.error?.message === 'string'
      ? parsed.error.message
      : (typeof parsed.message === 'string' ? parsed.message : null);
    return nested || rawMessage;
  } catch {
    return rawMessage;
  }
}

export function normalizeCodexModelForRuntime(model: string | undefined): string | null {
  const trimmed = model?.trim();
  const authMode = readCodexAuthMode();

  if (authMode === 'chatgpt') {
    if (!trimmed || trimmed === 'gpt-5' || /^deepseek-/i.test(trimmed)) {
      return CHATGPT_SAFE_CODEX_MODEL;
    }
  }

  return trimmed || null;
}

export function buildCodexConfigOverrideArgs(model: string | null): string[] {
  if (!model) return [];
  return ['-c', `model="${model}"`];
}

const SAFE_CODEX_MCP_NAME = /^[A-Za-z0-9_-]+$/;

export function parseEnabledCodexMcpServerNames(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((entry): entry is { name: string; enabled: boolean } => (
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as { name?: unknown }).name === 'string' &&
        (entry as { enabled?: unknown }).enabled === true &&
        SAFE_CODEX_MCP_NAME.test((entry as { name: string }).name)
      ))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function extractExplicitCodexMcpNames(prompt: string, availableNames: string[]): string[] {
  const normalizedPrompt = prompt.toLocaleLowerCase();
  return availableNames.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s|[，。！？、；：,(（])@${escaped}(?=$|\\s|[，。！？、；：,.!?)）])`, 'i')
      .test(normalizedPrompt);
  });
}

export function buildCodexMcpDisableOverrideArgs(
  availableNames: string[],
  requestedNames: string[],
): string[] {
  const requested = new Set(requestedNames.map((name) => name.toLocaleLowerCase()));
  return availableNames
    .filter((name) => SAFE_CODEX_MCP_NAME.test(name) && !requested.has(name.toLocaleLowerCase()))
    .flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]);
}

export function parseConfiguredCodexMcpServerNames(rawToml: string): string[] {
  const names: string[] = [];
  let currentName: string | null = null;
  let currentEnabled = true;

  const flushCurrent = () => {
    if (currentName && currentEnabled && !names.includes(currentName)) {
      names.push(currentName);
    }
  };

  for (const line of rawToml.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (section) {
      flushCurrent();
      const mcpSection = section[1].match(/^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/);
      const name = mcpSection?.[1] ?? mcpSection?.[2] ?? null;
      currentName = name && SAFE_CODEX_MCP_NAME.test(name) ? name : null;
      currentEnabled = true;
      continue;
    }

    if (currentName && /^\s*enabled\s*=\s*false\s*(?:#.*)?$/i.test(line)) {
      currentEnabled = false;
    }
  }
  flushCurrent();
  return names;
}

export type CodexConfigReader = (filePath: string, encoding: 'utf8') => Promise<string>;

const readCodexConfig: CodexConfigReader = async (filePath, encoding) => {
  return await fs.promises.readFile(filePath, encoding);
};

export async function discoverConfiguredCodexMcpServerNames(
  env: NodeJS.ProcessEnv,
  reader: CodexConfigReader = readCodexConfig,
): Promise<string[]> {
  try {
    const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
    const raw = await reader(path.join(codexHome, 'config.toml'), 'utf8');
    return parseConfiguredCodexMcpServerNames(raw);
  } catch {
    return [];
  }
}

export function resolveCodexCliPath(plugin: CodianPlugin): string | null {
  const configuredPath = plugin.getResolvedClaudeCliPath();
  if (configuredPath && isExistingFile(configuredPath) && isLikelyCodexExecutable(configuredPath)) {
    return configuredPath;
  }

  const home = os.homedir();
  const preferredCandidates = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Local', 'Programs', 'Codex', 'codex.exe'),
      ]
    : [
        '/Applications/Codex.app/Contents/Resources/codex',
      ];

  for (const candidate of preferredCandidates) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  const envVars = parseEnvironmentVariables(plugin.getActiveEnvironmentVariables());
  const searchEntries = [
    ...parsePathEntries(envVars.PATH),
    ...parsePathEntries(process.env.PATH),
  ];

  for (const entry of searchEntries) {
    const candidate = path.join(expandHomePath(entry), process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }
  const fallbackCandidates = process.platform === 'win32'
    ? [
        path.join(home, '.local', 'bin', 'codex.exe'),
      ]
    : [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        path.join(home, '.local', 'bin', 'codex'),
        path.join(home, 'bin', 'codex'),
      ];

  for (const candidate of fallbackCandidates) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildRuntimeEnv(plugin: CodianPlugin, codexPath: string): NodeJS.ProcessEnv {
  const customEnv = parseEnvironmentVariables(plugin.getActiveEnvironmentVariables());
  return {
    ...process.env,
    ...customEnv,
    PATH: getEnhancedPath(customEnv.PATH, codexPath),
  };
}

export function buildCodexExecArgs(
  params: CodexExecParams,
  startupModel: string | null,
): string[] {
  const args = [...buildCodexConfigOverrideArgs(startupModel), 'exec', '--json', '--skip-git-repo-check', '-C', params.cwd];

  if (params.permissionMode === 'yolo') {
    args.push('--full-auto');
  } else {
    args.push('--sandbox', params.permissionMode === 'read-only' ? 'read-only' : 'workspace-write');
  }

  if (isLikelyCodexModel(params.model)) {
    args.push('-m', params.model!.trim());
  }

  args.push(params.prompt);
  return args;
}

export async function execCodexPrompt(
  plugin: CodianPlugin,
  params: CodexExecParams
): Promise<CodexExecResult> {
  const codexPath = resolveCodexCliPath(plugin);
  if (!codexPath) {
    throw new Error('找不到 Codex CLI。请在设置中填写 Codex CLI 路径，或安装 Codex 应用。');
  }

  const env = buildRuntimeEnv(plugin, codexPath);
  const startupModel = normalizeCodexModelForRuntime(params.model ?? plugin.settings.model);
  const args = buildCodexExecArgs(params, startupModel);

  return await new Promise<CodexExecResult>((resolve, reject) => {
    let child: ChildProcess | null = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let text = '';
    let settled = false;
    let usage: CodexExecResult['usage'];

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      resolve({ text, usage });
    };

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      child = spawn(codexPath, args, {
        cwd: params.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdin?.end();
    } catch (error) {
      finishReject(error instanceof Error ? error : new Error('启动 Codex 失败'));
      return;
    }

    const abortHandler = () => {
      try {
        child?.kill();
      } catch {
        // Ignore kill errors
      }
      finishReject(new Error('Cancelled'));
    };

    if (params.abortController) {
      if (params.abortController.signal.aborted) {
        abortHandler();
        return;
      }
      params.abortController.signal.addEventListener('abort', abortHandler, { once: true });
    }

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return;

      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        const type = typeof event.type === 'string' ? event.type : '';

        if (type === 'item.completed') {
          const item = event.item;
          if (item && typeof item === 'object') {
            const typedItem = item as Record<string, unknown>;
            if (typedItem.type === 'agent_message' && typeof typedItem.text === 'string') {
              text += typedItem.text;
            }
          }
        }

        if (type === 'turn.completed') {
          const rawUsage = event.usage as Record<string, unknown> | undefined;
          usage = {
            inputTokens: typeof rawUsage?.input_tokens === 'number' ? rawUsage.input_tokens : 0,
            cachedInputTokens: typeof rawUsage?.cached_input_tokens === 'number' ? rawUsage.cached_input_tokens : 0,
            outputTokens: typeof rawUsage?.output_tokens === 'number' ? rawUsage.output_tokens : 0,
          };
        }

        if (type === 'turn.failed' || type === 'error') {
          const message = typeof event.message === 'string'
            ? extractReadableCodexErrorMessage(event.message)
            : (typeof (event.item as Record<string, unknown> | undefined)?.message === 'string'
                ? extractReadableCodexErrorMessage((event.item as Record<string, unknown>).message as string)
                : 'Codex 执行失败。');
          stderrBuffer = stderrBuffer ? `${stderrBuffer}\n${message}` : message;
        }
      } catch {
        // Ignore non-JSON lines
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        consumeLine(line);
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });

    child.on('error', (error) => {
      finishReject(new Error(`启动 Codex 失败：${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (params.abortController) {
        params.abortController.signal.removeEventListener('abort', abortHandler);
      }

      if (stdoutBuffer.trim()) {
        consumeLine(stdoutBuffer.trim());
      }

      if (code !== 0) {
        const message = stderrBuffer.trim() || `Codex 进程异常退出（code=${code ?? 'unknown'}${signal ? `, signal=${signal}` : ''}）。`;
        finishReject(new Error(message));
        return;
      }

      finishResolve();
    });
  });
}
