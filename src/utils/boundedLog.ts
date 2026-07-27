import * as fsSync from 'fs';
import { promises as fs } from 'fs';

export const DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES = 2 * 1024 * 1024;

const logQueues = new Map<string, Promise<void>>();

async function rotateIfNeeded(filePath: string, incomingBytes: number, maxBytes: number) {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size + incomingBytes <= maxBytes) return;
    const backupPath = `${filePath}.1`;
    await fs.rm(backupPath, { force: true });
    await fs.rename(filePath, backupPath);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
    if (code !== 'ENOENT') throw error;
  }
}

export function appendBoundedLog(
  filePath: string,
  message: string,
  maxBytes = DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES,
): Promise<void> {
  const previous = logQueues.get(filePath) ?? Promise.resolve();
  const current = previous.then(async () => {
    await rotateIfNeeded(filePath, Buffer.byteLength(message), maxBytes);
    await fs.appendFile(filePath, message, 'utf8');
  });
  logQueues.set(filePath, current.catch(() => undefined));
  return current;
}

export function appendBoundedLogSync(
  filePath: string,
  message: string,
  maxBytes = DEFAULT_DIAGNOSTIC_LOG_MAX_BYTES,
): void {
  try {
    const currentSize = fsSync.statSync(filePath).size;
    if (currentSize + Buffer.byteLength(message) > maxBytes) {
      const backupPath = `${filePath}.1`;
      fsSync.rmSync(backupPath, { force: true });
      fsSync.renameSync(filePath, backupPath);
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
    if (code !== 'ENOENT') throw error;
  }
  fsSync.appendFileSync(filePath, message, 'utf8');
}
