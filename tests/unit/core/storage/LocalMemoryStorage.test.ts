import { LocalMemoryStorage } from '@/core/storage/LocalMemoryStorage';

function createMockAdapter() {
  const files = new Map<string, string>();
  const folders = new Set<string>();

  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path) || folders.has(path)),
    read: jest.fn(async (path: string) => files.get(path) ?? ''),
    write: jest.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    append: jest.fn(async (path: string, content: string) => {
      files.set(path, (files.get(path) ?? '') + content);
    }),
    delete: jest.fn(async (path: string) => {
      files.delete(path);
    }),
    ensureFolder: jest.fn(async (path: string) => {
      folders.add(path);
    }),
  };

  return { adapter: adapter as any, files, folders };
}

describe('LocalMemoryStorage', () => {
  it('stores memories locally as jsonl', async () => {
    const { adapter, files } = createMockAdapter();
    const storage = new LocalMemoryStorage(adapter);

    await storage.add('用户喜欢简洁回答', { tags: ['preference'] });

    const content = files.get('.claude/local-memory/memories.jsonl') ?? '';
    expect(content).toContain('用户喜欢简洁回答');
    expect(content).toContain('preference');
  });

  it('searches memories by query text', async () => {
    const { adapter } = createMockAdapter();
    const storage = new LocalMemoryStorage(adapter);

    await storage.add('用户喜欢简洁回答');
    await storage.add('项目使用 TypeScript');

    const results = await storage.search('简洁');

    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('用户喜欢简洁回答');
  });

  it('supports a custom vault-relative base path', async () => {
    const { adapter, files } = createMockAdapter();
    const storage = new LocalMemoryStorage(adapter);
    storage.setBasePath('custom-memory');

    await storage.add('自定义目录记忆');

    expect(files.has('custom-memory/memories.jsonl')).toBe(true);
  });
});
