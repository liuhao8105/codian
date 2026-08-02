import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

describe('release dependency policy', () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../../../package.json'), 'utf8')
  ) as PackageManifest;

  it('uses the security-fixed MCP SDK release line', () => {
    expect(manifest.dependencies?.['@modelcontextprotocol/sdk']).toBe('^1.29.0');
  });

  it('does not ship the unused Codex SDK', () => {
    expect(manifest.dependencies).not.toHaveProperty('@openai/codex-sdk');
  });

  it('has no dormant provider runtime entry point', () => {
    expect(existsSync(join(
      __dirname,
      '../../../src/core/agent/ClaudianService.ts',
    ))).toBe(false);
  });

  it('pins the Obsidian development API for reproducible installs', () => {
    expect(manifest.devDependencies?.obsidian).toBe('1.13.1');
  });

  it('overrides the vulnerable Hono Node adapter pulled by the MCP SDK', () => {
    expect(manifest.overrides?.['@hono/node-server']).toBe('^2.0.12');
  });
});
