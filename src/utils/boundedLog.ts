import * as fsSync from 'fs';
import { promises as fs } from 'fs';

export const DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_DIAGNOSTIC_LOG_ROTATIONS = 3;

const logQueues = new Map<string, Promise<void>>();

function isMissingFileError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && String((error as { code: unknown }).code) === 'ENOENT';
}

function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(?:api[_-]?key|token|secret|password|signature|credential)/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function redactDiagnosticText(message: string): string {
  return message
    .replace(/https?:\/\/[^\s<>"']+/gi, redactUrl)
    .replace(
      /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/g,
      '[HOME]',
    )
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /(\b(?:[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)|api[_-]?key)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s&]+)/gi,
      '$1[REDACTED]',
    );
}

function boundMessage(message: string, maxBytes: number): string {
  const redacted = redactDiagnosticText(message);
  if (Buffer.byteLength(redacted) <= maxBytes) return redacted;

  const suffix = '\n[TRUNCATED]\n';
  const suffixBytes = Buffer.byteLength(suffix);
  if (maxBytes <= suffixBytes) {
    return Buffer.from(suffix).subarray(0, maxBytes).toString('utf8');
  }

  const source = Buffer.from(redacted);
  let end = Math.min(source.length, maxBytes - suffixBytes);
  while (end > 0 && (source[end] & 0xc0) === 0x80) {
    end--;
  }

  let prefix = source.subarray(0, end).toString('utf8');
  while (prefix && Buffer.byteLength(prefix) + suffixBytes > maxBytes) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${suffix}`;
}

async function rotateAsync(filePath: string, rotations: number): Promise<void> {
  if (rotations <= 0) {
    await fs.rm(filePath, { force: true });
    return;
  }

  await fs.rm(`${filePath}.${rotations}`, { force: true });
  for (let generation = rotations - 1; generation >= 1; generation--) {
    try {
      await fs.rename(`${filePath}.${generation}`, `${filePath}.${generation + 1}`);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  await fs.rename(filePath, `${filePath}.1`);
}

function rotateSync(filePath: string, rotations: number): void {
  if (rotations <= 0) {
    fsSync.rmSync(filePath, { force: true });
    return;
  }

  fsSync.rmSync(`${filePath}.${rotations}`, { force: true });
  for (let generation = rotations - 1; generation >= 1; generation--) {
    try {
      fsSync.renameSync(`${filePath}.${generation}`, `${filePath}.${generation + 1}`);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  fsSync.renameSync(filePath, `${filePath}.1`);
}

async function rotateIfNeeded(
  filePath: string,
  incomingBytes: number,
  maxBytes: number,
  rotations: number,
) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size + incomingBytes <= maxBytes) return;
    await rotateAsync(filePath, rotations);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export function appendBoundedLog(
  filePath: string,
  message: string,
  maxBytes = DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES,
  rotations = DEFAULT_DIAGNOSTIC_LOG_ROTATIONS,
): Promise<void> {
  const boundedMessage = boundMessage(message, maxBytes);
  const previous = logQueues.get(filePath) ?? Promise.resolve();
  const current = previous.then(async () => {
    await rotateIfNeeded(
      filePath,
      Buffer.byteLength(boundedMessage),
      maxBytes,
      rotations,
    );
    await fs.appendFile(filePath, boundedMessage, 'utf8');
  });
  logQueues.set(filePath, current.catch(() => undefined));
  return current;
}

export function appendBoundedLogSync(
  filePath: string,
  message: string,
  maxBytes = DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES,
  rotations = DEFAULT_DIAGNOSTIC_LOG_ROTATIONS,
): void {
  const boundedMessage = boundMessage(message, maxBytes);
  try {
    const currentSize = fsSync.statSync(filePath).size;
    if (currentSize + Buffer.byteLength(boundedMessage) > maxBytes) {
      rotateSync(filePath, rotations);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  fsSync.appendFileSync(filePath, boundedMessage, 'utf8');
}
