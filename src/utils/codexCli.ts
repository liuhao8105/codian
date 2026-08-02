import * as fs from 'fs';
import * as path from 'path';

import type { HostnameCliPaths } from '../core/types/settings';
import { getHostnameKey, parseEnvironmentVariables } from './env';
import { expandHomePath, findCodexCliPath } from './path';

function existingFile(candidate: string | undefined): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;

  try {
    const expanded = expandHomePath(trimmed);
    const basename = path.basename(expanded).toLowerCase();
    if (basename !== 'codex' && basename !== 'codex.exe') return null;
    return fs.existsSync(expanded) && fs.statSync(expanded).isFile()
      ? expanded
      : null;
  } catch {
    return null;
  }
}

export function resolveCodexCliPath(
  hostnamePath: string | undefined,
  envText: string,
): string | null {
  return existingFile(hostnamePath)
    ?? findCodexCliPath(parseEnvironmentVariables(envText || '').PATH);
}

export class CodexCliResolver {
  private resolvedPath: string | null = null;
  private lastHostnamePath = '';
  private lastEnvText = '';

  resolve(
    hostnamePaths: HostnameCliPaths | undefined,
    envText: string,
    hostnameKey = getHostnameKey(),
  ): string | null {
    const hostnamePath = (hostnamePaths?.[hostnameKey] ?? '').trim();
    const normalizedEnv = envText ?? '';

    if (
      this.resolvedPath &&
      hostnamePath === this.lastHostnamePath &&
      normalizedEnv === this.lastEnvText
    ) {
      return this.resolvedPath;
    }

    this.lastHostnamePath = hostnamePath;
    this.lastEnvText = normalizedEnv;
    this.resolvedPath = resolveCodexCliPath(
      hostnamePath,
      normalizedEnv,
    );
    return this.resolvedPath;
  }

  reset(): void {
    this.resolvedPath = null;
    this.lastHostnamePath = '';
    this.lastEnvText = '';
  }
}
