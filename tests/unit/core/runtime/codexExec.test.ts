import * as fs from 'fs';

import {
  buildCodexExecArgs,
  buildCodexMcpDisableOverrideArgs,
  discoverConfiguredCodexMcpServerNames,
  extractExplicitCodexMcpNames,
  normalizeCodexModelForRuntime,
  parseConfiguredCodexMcpServerNames,
  parseEnabledCodexMcpServerNames,
} from '@/core/runtime/codexExec';

describe('Codex exec sandbox policy', () => {
  it('uses the read-only sandbox for inline transformations', () => {
    expect(buildCodexExecArgs({
      prompt: 'rewrite',
      cwd: '/vault',
      permissionMode: 'read-only',
    }, 'gpt-5.6-sol')).toEqual(expect.arrayContaining([
      '--sandbox',
      'read-only',
    ]));
  });
});

describe('Codex runtime model fallback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses GPT-5.6-Sol for legacy defaults with ChatGPT authentication', () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ auth_mode: 'chatgpt' }));

    expect(normalizeCodexModelForRuntime('gpt-5')).toBe('gpt-5.6-sol');
    expect(normalizeCodexModelForRuntime('')).toBe('gpt-5.6-sol');
  });
});

describe('Codex MCP on-demand selection', () => {
  it('extracts only enabled MCP names without retaining transport configuration', () => {
    const raw = JSON.stringify([
      { name: 'blender', enabled: true, transport: { env: { SECRET: 'do-not-retain' } } },
      { name: 'github', enabled: true, transport: { url: 'https://example.invalid' } },
      { name: 'computer-use', enabled: false },
      { name: 'unsafe.name', enabled: true },
    ]);

    expect(parseEnabledCodexMcpServerNames(raw)).toEqual(['blender', 'github']);
  });

  it('recognizes explicit @MCP requests case-insensitively', () => {
    expect(extractExplicitCodexMcpNames('请用 @Blender 处理这个模型，并参考 @github。', ['blender', 'github', 'stitch']))
      .toEqual(['blender', 'github']);
  });

  it('disables every unrequested global MCP and leaves explicitly requested MCP enabled', () => {
    expect(buildCodexMcpDisableOverrideArgs(
      ['blender', 'github', 'sites-design-picker'],
      ['github'],
    )).toEqual([
      '-c', 'mcp_servers.blender.enabled=false',
      '-c', 'mcp_servers.sites-design-picker.enabled=false',
    ]);
  });

  it('does not disable anything when MCP discovery fails safely', () => {
    expect(buildCodexMcpDisableOverrideArgs([], [])).toEqual([]);
    expect(parseEnabledCodexMcpServerNames('not json')).toEqual([]);
  });

  it('discovers only directly configured MCP sections and ignores disabled or plugin-injected servers', async () => {
    const config = `
[mcp_servers.blender]
command = "uvx"
args = ["blender-mcp"]

[mcp_servers.github]
command = "github-mcp"
enabled = false

[plugins.figma]
enabled = true
`;
    const readSuccessfully = jest.fn().mockResolvedValue(config);
    const readWithFailure = jest.fn().mockRejectedValue(new Error('missing'));

    expect(parseConfiguredCodexMcpServerNames(config)).toEqual(['blender']);
    await expect(discoverConfiguredCodexMcpServerNames({ CODEX_HOME: '/mock/.codex' }, readSuccessfully))
      .resolves.toEqual(['blender']);
    expect(readSuccessfully).toHaveBeenCalledWith('/mock/.codex/config.toml', 'utf8');
    await expect(discoverConfiguredCodexMcpServerNames({ CODEX_HOME: '/mock/.codex' }, readWithFailure))
      .resolves.toEqual([]);
  });
});
