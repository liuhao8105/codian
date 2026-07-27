import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { appendBoundedLog, appendBoundedLogSync } from '@/utils/boundedLog';

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
});
