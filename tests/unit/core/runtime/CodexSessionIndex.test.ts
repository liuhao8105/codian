import * as path from 'path';

import {
  CodexSessionIndex,
  type CodexSessionIndexEntry,
  type CodexSessionIndexFileSystem,
} from '@/core/runtime/CodexSessionIndex';

function directory(name: string): CodexSessionIndexEntry {
  return { name, isDirectory: () => true, isFile: () => false };
}

function file(name: string): CodexSessionIndexEntry {
  return { name, isDirectory: () => false, isFile: () => true };
}

function createFileSystem(
  tree: Record<string, CodexSessionIndexEntry[]>,
): CodexSessionIndexFileSystem & { reads: number; existing: Set<string> } {
  const existing = new Set<string>(Object.keys(tree));
  for (const [directoryPath, entries] of Object.entries(tree)) {
    for (const entry of entries) {
      existing.add(path.join(directoryPath, entry.name));
    }
  }

  return {
    reads: 0,
    existing,
    existsSync(candidate: string) {
      return this.existing.has(candidate);
    },
    readDirSync(directoryPath: string) {
      this.reads += 1;
      return tree[directoryPath] ?? [];
    },
    async readDir(directoryPath: string) {
      this.reads += 1;
      return tree[directoryPath] ?? [];
    },
  };
}

describe('CodexSessionIndex', () => {
  const root = '/sessions';

  it('scans once and caches both hits and misses', () => {
    const fileSystem = createFileSystem({
      [root]: [directory('2026')],
      [path.join(root, '2026')]: [file('rollout-session-a.jsonl')],
    });
    const index = new CodexSessionIndex(root, { fileSystem });

    expect(index.findSync('session-a')).toBe('/sessions/2026/rollout-session-a.jsonl');
    const readsAfterFirstScan = fileSystem.reads;
    expect(index.findSync('missing')).toBeNull();
    expect(index.findSync('missing')).toBeNull();
    expect(fileSystem.reads).toBe(readsAfterFirstScan);
  });

  it('uses deterministic lexical ordering when duplicate matches exist', () => {
    const fileSystem = createFileSystem({
      [root]: [directory('z'), directory('a')],
      [path.join(root, 'a')]: [file('rollout-shared.jsonl')],
      [path.join(root, 'z')]: [file('rollout-shared.jsonl')],
    });
    const index = new CodexSessionIndex(root, { fileSystem });

    expect(index.findSync('shared')).toBe('/sessions/a/rollout-shared.jsonl');
  });

  it('stops at the configured visit limit', () => {
    const fileSystem = createFileSystem({
      [root]: [directory('a'), directory('b'), directory('c')],
      [path.join(root, 'a')]: [file('rollout-first.jsonl')],
      [path.join(root, 'b')]: [file('rollout-second.jsonl')],
      [path.join(root, 'c')]: [file('rollout-third.jsonl')],
    });
    const index = new CodexSessionIndex(root, { fileSystem, maxVisitedEntries: 2 });

    expect(index.findSync('third')).toBeNull();
    expect(index.getStats()).toMatchObject({ visitedEntries: 2, truncated: true });
  });

  it('rebuilds once when a cached file disappears', async () => {
    const oldPath = '/sessions/rollout-replaced.jsonl';
    const newPath = '/sessions/new/rollout-replaced.jsonl';
    const tree: Record<string, CodexSessionIndexEntry[]> = {
      [root]: [file('rollout-replaced.jsonl')],
    };
    const fileSystem = createFileSystem(tree);
    const index = new CodexSessionIndex(root, { fileSystem });

    expect(await index.find('replaced')).toBe(oldPath);

    fileSystem.existing.delete(oldPath);
    tree[root] = [directory('new')];
    tree['/sessions/new'] = [file('rollout-replaced.jsonl')];
    fileSystem.existing.add('/sessions/new');
    fileSystem.existing.add(newPath);

    expect(await index.find('replaced')).toBe(newPath);
    expect(index.getStats().scanCount).toBe(2);
  });

  it('can be explicitly invalidated when external session state changes', () => {
    const tree: Record<string, CodexSessionIndexEntry[]> = { [root]: [] };
    const fileSystem = createFileSystem(tree);
    const index = new CodexSessionIndex(root, { fileSystem });

    expect(index.findSync('later')).toBeNull();
    tree[root] = [file('rollout-later.jsonl')];
    fileSystem.existing.add('/sessions/rollout-later.jsonl');
    expect(index.findSync('later')).toBeNull();

    index.invalidate();
    expect(index.findSync('later')).toBe('/sessions/rollout-later.jsonl');
  });
});
