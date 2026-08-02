import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { extname, join, relative } from 'path';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

describe('release dependency policy', () => {
  const projectRoot = join(__dirname, '../../..');
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, 'package.json'), 'utf8')
  ) as PackageManifest;

  const retiredMarkers = [
    [99, 108, 97, 117, 100, 101],
    [99, 108, 97, 117, 100, 105, 97, 110],
    [97, 110, 116, 104, 114, 111, 112, 105, 99],
  ].map(bytes => String.fromCharCode(...bytes));

  function collectReleaseTextFiles(root: string): string[] {
    const excludedDirectories = new Set(['.git', 'node_modules', 'coverage', 'release']);
    const textExtensions = new Set([
      '.cjs', '.css', '.js', '.json', '.md', '.mjs', '.ts', '.tsx', '.yaml', '.yml',
    ]);
    const files: string[] = [];

    for (const entry of readdirSync(root)) {
      if (excludedDirectories.has(entry) || entry.startsWith('.env')) continue;
      const absolutePath = join(root, entry);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        files.push(...collectReleaseTextFiles(absolutePath));
      } else if (textExtensions.has(extname(entry)) || entry === '.gitignore') {
        files.push(absolutePath);
      }
    }
    return files;
  }

  it('uses the security-fixed MCP SDK release line', () => {
    expect(manifest.dependencies?.['@modelcontextprotocol/sdk']).toBe('^1.29.0');
  });

  it('does not ship the unused Codex SDK', () => {
    expect(manifest.dependencies).not.toHaveProperty('@openai/codex-sdk');
  });

  it('rejects retired provider markers from release inputs and bundle', () => {
    const violations: string[] = [];
    for (const filePath of collectReleaseTextFiles(projectRoot)) {
      const relativePath = relative(projectRoot, filePath);
      const normalizedPath = relativePath.toLowerCase();
      const content = readFileSync(filePath, 'utf8').toLowerCase();
      for (const marker of retiredMarkers) {
        if (normalizedPath.includes(marker) || content.includes(marker)) {
          violations.push(`${relativePath}:${marker.length}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('has no dormant provider runtime entry point', () => {
    const retiredServiceName = `${retiredMarkers[1]}Service.ts`;
    expect(existsSync(join(
      __dirname,
      '../../../src/core/agent',
      retiredServiceName,
    ))).toBe(false);
  });

  it('pins the Obsidian development API for reproducible installs', () => {
    expect(manifest.devDependencies?.obsidian).toBe('1.13.1');
  });

  it('overrides the vulnerable Hono Node adapter pulled by the MCP SDK', () => {
    expect(manifest.overrides?.['@hono/node-server']).toBe('^2.0.12');
  });
});
