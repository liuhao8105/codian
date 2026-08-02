import type { App } from 'obsidian';

export interface VaultGrepOptions {
  maxFiles?: number;
  maxSourceBytes?: number;
  maxDurationMs?: number;
  maxMatches?: number;
}

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DURATION_MS = 10_000;
const DEFAULT_MAX_MATCHES = 200;

function normalizeVaultRelativePath(value?: string): string | null {
  if (!value?.trim()) return '';

  const candidate = value.trim().replace(/\\/g, '/');
  if (
    candidate.startsWith('/')
    || candidate.startsWith('//')
    || /^[A-Za-z]:\//.test(candidate)
  ) {
    return null;
  }

  const segments = candidate.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..')) return null;
  return segments.join('/');
}

function isWithinPrefix(filePath: string, prefix: string): boolean {
  return prefix === '' || filePath === prefix || filePath.startsWith(`${prefix}/`);
}

/** Search Markdown files exposed by the Obsidian Vault API without invoking a shell. */
export async function searchVaultMarkdown(
  app: App,
  pattern: string,
  relativePath?: string,
  options: VaultGrepOptions = {},
): Promise<string> {
  const prefix = normalizeVaultRelativePath(relativePath);
  if (prefix === null) return 'Error: Search path is outside the vault.';

  let expression: RegExp;
  try {
    expression = new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Invalid regular expression: ${message}`;
  }

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const startedAt = Date.now();
  const matches: string[] = [];
  let filesRead = 0;
  let sourceBytes = 0;
  let truncated = false;

  const files = app.vault.getMarkdownFiles()
    .filter((file) => isWithinPrefix(file.path.replace(/\\/g, '/'), prefix))
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const file of files) {
    if (filesRead >= maxFiles || Date.now() - startedAt >= maxDurationMs) {
      truncated = true;
      break;
    }

    const content = await app.vault.cachedRead(file);
    filesRead += 1;
    sourceBytes += Buffer.byteLength(content, 'utf8');
    if (sourceBytes > maxSourceBytes) {
      truncated = true;
      break;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (Date.now() - startedAt >= maxDurationMs) {
        truncated = true;
        break;
      }
      if (expression.test(lines[index])) {
        matches.push(`${file.path}:${index + 1}:${lines[index]}`);
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
    }

    if (truncated) break;
  }

  if (matches.length === 0 && !truncated) return 'No matches found.';
  if (truncated) matches.push('... (search truncated by safety limit)');
  return matches.join('\n');
}
