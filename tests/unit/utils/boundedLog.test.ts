import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  appendBoundedLog,
  appendBoundedLogSync,
  redactDiagnosticText,
} from '@/utils/boundedLog';

describe('bounded diagnostic logs', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codian-bounded-log-test-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('rotates an async log before it grows beyond the configured bound', async () => {
    const file = path.join(directory, 'runtime.log');
    await fs.writeFile(file, 'old-data'.repeat(20), 'utf8');

    await appendBoundedLog(file, 'new-entry\n', 64);

    expect(await fs.readFile(`${file}.1`, 'utf8')).toContain('old-data');
    expect(await fs.readFile(file, 'utf8')).toBe('new-entry\n');
  });

  it('rotates a synchronous log and keeps only one backup', async () => {
    const file = path.join(directory, 'app-server.log');
    await fs.writeFile(file, 'old-data'.repeat(20), 'utf8');
    await fs.writeFile(`${file}.1`, 'older-data', 'utf8');

    appendBoundedLogSync(file, 'new-entry\n', 64);

    expect(await fs.readFile(`${file}.1`, 'utf8')).toContain('old-data');
    expect(await fs.readFile(file, 'utf8')).toBe('new-entry\n');
  });

  it('redacts credentials, environment values, URLs, and home paths', () => {
    const message = [
      'Runtime failed while opening /Users/liuhao/Private Vault/note.md',
      'Authorization: Bearer ghp_super-secret',
      'OPENAI_API_KEY=sk-live-secret',
      'api_key=deepseek-secret',
      'https://user:pass@example.com/api?token=query-secret&safe=visible',
    ].join('\n');

    const redacted = redactDiagnosticText(message);

    expect(redacted).toContain('Runtime failed while opening [HOME]/Private Vault/note.md');
    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
    expect(redacted).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(redacted).toContain('api_key=[REDACTED]');
    expect(redacted).toContain('https://example.com/api?token=[REDACTED]&safe=visible');
    expect(redacted).not.toContain('liuhao');
    expect(redacted).not.toContain('ghp_super-secret');
    expect(redacted).not.toContain('sk-live-secret');
    expect(redacted).not.toContain('deepseek-secret');
    expect(redacted).not.toContain('query-secret');
    expect(redacted).not.toContain('user:pass');
  });

  it('keeps a fixed three-generation rotation chain', async () => {
    const file = path.join(directory, 'runtime.log');
    await fs.writeFile(file, 'base'.repeat(20), 'utf8');
    await fs.writeFile(`${file}.1`, 'generation-one', 'utf8');
    await fs.writeFile(`${file}.2`, 'generation-two', 'utf8');
    await fs.writeFile(`${file}.3`, 'generation-three', 'utf8');

    await appendBoundedLog(file, 'new-entry\n', 64, 3);

    expect(await fs.readFile(file, 'utf8')).toBe('new-entry\n');
    expect(await fs.readFile(`${file}.1`, 'utf8')).toContain('base');
    expect(await fs.readFile(`${file}.2`, 'utf8')).toBe('generation-one');
    expect(await fs.readFile(`${file}.3`, 'utf8')).toBe('generation-two');
    await expect(fs.access(`${file}.4`)).rejects.toThrow();
  });

  it('redacts synchronous log messages before writing', async () => {
    const file = path.join(directory, 'app-server.log');

    appendBoundedLogSync(file, 'token=plaintext-secret\n', 1024, 3);

    expect(await fs.readFile(file, 'utf8')).toBe('token=[REDACTED]\n');
  });

  it('never writes a single diagnostic entry beyond the configured bound', async () => {
    const file = path.join(directory, 'runtime.log');

    await appendBoundedLog(file, 'x'.repeat(200), 64, 3);

    expect((await fs.stat(file)).size).toBeLessThanOrEqual(64);
    expect(await fs.readFile(file, 'utf8')).toContain('[TRUNCATED]');
  });
});
