import type { VaultFileAdapter } from './VaultFileAdapter';

export const LOCAL_MEMORY_PATH = '.codian/local-memory';
export const LOCAL_MEMORY_FILE = `${LOCAL_MEMORY_PATH}/memories.jsonl`;
export const LOCAL_MEMORY_PROFILE_FILE = `${LOCAL_MEMORY_PATH}/profile.md`;

export type LocalMemoryType = 'fact' | 'preference' | 'rule' | 'note';

export interface LocalMemoryEntry {
  id: string;
  type: LocalMemoryType;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  source: 'manual' | 'auto';
}

function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .trim();
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(/\s+/).filter(token => token.length > 1)));
}

function inferType(content: string): LocalMemoryType {
  if (/规则|必须|不要|禁止|以后/.test(content)) return 'rule';
  if (/喜欢|偏好|习惯|希望|倾向|默认/.test(content)) return 'preference';
  return 'fact';
}

function scoreMemory(entry: LocalMemoryEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;

  const haystack = `${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += token.length;
  }
  if (score === 0) return 0;

  const ageDays = Math.max(0, (Date.now() - entry.updatedAt) / 86400000);
  return score + Math.max(0, 3 - ageDays / 30);
}

export class LocalMemoryStorage {
  private basePath = LOCAL_MEMORY_PATH;

  constructor(private adapter: VaultFileAdapter) {}

  setBasePath(path: string): void {
    const trimmed = path.trim().replace(/^\/+|\/+$/g, '');
    this.basePath = trimmed || LOCAL_MEMORY_PATH;
  }

  getBasePath(): string {
    return this.basePath;
  }

  private getMemoryFile(): string {
    return `${this.basePath}/memories.jsonl`;
  }

  private getProfileFile(): string {
    return `${this.basePath}/profile.md`;
  }

  async ensureInitialized(): Promise<void> {
    await this.adapter.ensureFolder(this.basePath);
    const profileFile = this.getProfileFile();
    if (!(await this.adapter.exists(profileFile))) {
      await this.adapter.write(
        profileFile,
        '# Local Memory Profile\n\nThis file is reserved for stable local profile summaries.\n'
      );
    }
  }

  async add(content: string, options: {
    type?: LocalMemoryType;
    tags?: string[];
    source?: LocalMemoryEntry['source'];
  } = {}): Promise<LocalMemoryEntry> {
    const now = Date.now();
    const entry: LocalMemoryEntry = {
      id: `mem-${now}-${Math.random().toString(36).slice(2, 8)}`,
      type: options.type ?? inferType(content),
      content: content.trim(),
      tags: options.tags ?? [],
      createdAt: now,
      updatedAt: now,
      source: options.source ?? 'manual',
    };

    await this.ensureInitialized();
    await this.adapter.append(this.getMemoryFile(), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  async list(): Promise<LocalMemoryEntry[]> {
    const memoryFile = this.getMemoryFile();
    if (!(await this.adapter.exists(memoryFile))) return [];

    const content = await this.adapter.read(memoryFile);
    return content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line): LocalMemoryEntry | null => {
        try {
          const entry = JSON.parse(line) as LocalMemoryEntry;
          if (!entry.content?.trim()) return null;
          return entry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is LocalMemoryEntry => entry !== null);
  }

  async search(query: string, limit = 8): Promise<LocalMemoryEntry[]> {
    const queryTokens = tokenize(query);
    const entries = await this.list();
    if (queryTokens.length === 0) {
      return entries
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit);
    }

    return entries
      .map(entry => ({ entry, score: scoreMemory(entry, queryTokens) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
      .slice(0, limit)
      .map(item => item.entry);
  }

  async buildContext(query: string, limit = 6): Promise<string> {
    const memories = await this.search(query, limit);
    if (memories.length === 0) return '';

    const lines = memories.map(memory => {
      const tags = memory.tags.length > 0 ? ` tags=${memory.tags.join(',')}` : '';
      return `- [${memory.type}${tags}] ${memory.content}`;
    });

    return `<local_memory>
The following memories are stored locally in this Obsidian vault. Use them as background context.
Do not mention local memory files or internal retrieval unless the user asks.

${lines.join('\n')}
</local_memory>`;
  }
}
