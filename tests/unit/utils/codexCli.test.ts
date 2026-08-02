import * as fs from 'fs';

import { CodexCliResolver, resolveCodexCliPath } from '@/utils/codexCli';
import { findCodexCliPath } from '@/utils/path';

jest.mock('fs');

const mockedExists = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockedStat = fs.statSync as jest.MockedFunction<typeof fs.statSync>;

describe('Codex CLI discovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedExists.mockReturnValue(false);
    mockedStat.mockReturnValue({ isFile: () => false } as fs.Stats);
  });

  it('finds codex and ignores unrelated executables', () => {
    mockedExists.mockImplementation(candidate => String(candidate) === '/custom/bin/codex');
    mockedStat.mockImplementation(candidate => ({
      isFile: () => String(candidate) === '/custom/bin/codex',
    }) as fs.Stats);

    expect(findCodexCliPath('/custom/bin')).toBe('/custom/bin/codex');
  });

  it('prefers a valid host-specific path', () => {
    mockedExists.mockImplementation(candidate => String(candidate) === '/host/codex');
    mockedStat.mockReturnValue({ isFile: () => true } as fs.Stats);

    expect(resolveCodexCliPath('/host/codex', '')).toBe('/host/codex');
  });

  it('caches unchanged resolution inputs', () => {
    mockedExists.mockImplementation(candidate => String(candidate) === '/host/codex');
    mockedStat.mockReturnValue({ isFile: () => true } as fs.Stats);
    const resolver = new CodexCliResolver();

    expect(resolver.resolve({ test: '/host/codex' }, '', 'test')).toBe('/host/codex');
    expect(resolver.resolve({ test: '/host/codex' }, '', 'test')).toBe('/host/codex');
    expect(mockedStat).toHaveBeenCalledTimes(1);
  });
});
