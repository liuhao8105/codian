import * as fs from 'fs';
import * as path from 'path';

import { AgentManager } from '@/core/agents/AgentManager';

jest.mock('fs');
jest.mock('os', () => ({ homedir: () => '/home/test' }));

const vaultPath = '/vault';
const vaultAgents = path.join(vaultPath, '.codian', 'agents');
const globalAgents = path.join('/home/test', '.codian', 'agents');

function entry(name: string): fs.Dirent {
  return { name, isFile: () => true } as fs.Dirent;
}

describe('AgentManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockImplementation((candidate: string) => (
      candidate === vaultAgents || candidate === globalAgents
    ));
    (fs.readdirSync as jest.Mock).mockImplementation((directory: string) => (
      directory === vaultAgents ? [entry('vault-agent.md')] : [entry('global-agent.md')]
    ));
    (fs.readFileSync as jest.Mock).mockImplementation((filePath: string) => {
      const name = filePath.includes('vault-agent') ? 'vault-agent' : 'global-agent';
      return `---\nname: ${name}\ndescription: ${name}\n---\nPrompt`;
    });
  });

  it('loads built-in, vault, and global agents without plugin discovery', async () => {
    const manager = new AgentManager(vaultPath);

    await manager.loadAgents();

    expect(manager.getAgentById('Explore')?.source).toBe('builtin');
    expect(manager.getAgentById('vault-agent')?.source).toBe('vault');
    expect(manager.getAgentById('global-agent')?.source).toBe('global');
  });

  it('lets vault agents take precedence over duplicate global IDs', async () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(
      '---\nname: shared\ndescription: Shared\n---\nPrompt',
    );
    const manager = new AgentManager(vaultPath);

    await manager.loadAgents();

    expect(manager.getAgentById('shared')?.source).toBe('vault');
    expect(manager.getAvailableAgents().filter(agent => agent.id === 'shared')).toHaveLength(1);
  });

  it('searches loaded agents by name and description', async () => {
    const manager = new AgentManager(vaultPath);
    await manager.loadAgents();

    expect(manager.searchAgents('vault').map(agent => agent.id)).toContain('vault-agent');
  });
});
