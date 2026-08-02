import type { App } from 'obsidian';

import { searchVaultMarkdown } from '@/core/tools/vaultGrep';

function createApp(files: Record<string, string>): App {
  const markdownFiles = Object.keys(files).map((path) => ({ path }));
  return {
    vault: {
      getMarkdownFiles: jest.fn(() => markdownFiles),
      cachedRead: jest.fn(async (file: { path: string }) => files[file.path]),
    },
  } as unknown as App;
}

describe('searchVaultMarkdown', () => {
  it.each(['../outside', '/absolute', 'C:\\outside', '\\\\server\\share']) (
    'rejects paths outside the vault: %s',
    async (relativePath) => {
      const app = createApp({ 'inside.md': 'token' });

      await expect(searchVaultMarkdown(app, 'token', relativePath)).resolves.toContain(
        'outside the vault',
      );
      expect(app.vault.cachedRead).not.toHaveBeenCalled();
    },
  );

  it('treats injection-shaped patterns as regular expressions without executing a shell', async () => {
    const pattern = "x'; touch /tmp/pwned; echo '";
    const app = createApp({ 'notes/safe.md': pattern });

    await expect(searchVaultMarkdown(app, pattern)).resolves.toContain('notes/safe.md:1');
  });

  it('reports invalid regular expressions', async () => {
    await expect(searchVaultMarkdown(createApp({ 'note.md': 'text' }), '[')).resolves.toContain(
      'Invalid regular expression',
    );
  });

  it('searches only the requested vault-relative folder', async () => {
    const app = createApp({
      'chosen/one.md': 'needle',
      'chosen/nested/two.md': 'needle',
      'other/three.md': 'needle',
    });

    const result = await searchVaultMarkdown(app, 'needle', './chosen/');

    expect(result).toContain('chosen/one.md:1');
    expect(result).toContain('chosen/nested/two.md:1');
    expect(result).not.toContain('other/three.md');
  });

  it('stops deterministically at the match cap', async () => {
    const app = createApp({
      'many.md': Array.from({ length: 250 }, (_, index) => `hit ${index}`).join('\n'),
    });

    const result = await searchVaultMarkdown(app, 'hit');

    expect(result.split('\n').filter((line) => line.startsWith('many.md:'))).toHaveLength(200);
    expect(result).toContain('search truncated');
  });

  it('stops before reading beyond the source-byte cap', async () => {
    const app = createApp({ 'one.md': 'hit', 'two.md': 'hit' });

    const result = await searchVaultMarkdown(app, 'hit', undefined, { maxSourceBytes: 2 });

    expect(app.vault.cachedRead).toHaveBeenCalledTimes(1);
    expect(result).toContain('search truncated');
  });
});
