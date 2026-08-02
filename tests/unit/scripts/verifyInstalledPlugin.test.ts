import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repositoryRoot = path.resolve(__dirname, '../../..');
const verifier = path.join(repositoryRoot, 'scripts', 'verify-installed-plugin.mjs');
const version = '1.3.88-long-run-safety';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createFixture(): { root: string; pluginDir: string; checksumFile: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-installed-verifier-'));
  const pluginDir = path.join(root, 'codian');
  fs.mkdirSync(pluginDir);
  const assets: Record<string, string> = {
    'main.js': 'main-content',
    'manifest.json': JSON.stringify({ id: 'codian', version }),
    'styles.css': 'styles-content',
  };
  for (const [name, content] of Object.entries(assets)) {
    fs.writeFileSync(path.join(pluginDir, name), content);
  }
  fs.writeFileSync(path.join(pluginDir, 'data.json'), JSON.stringify({ preserved: true }));
  const checksumFile = path.join(root, 'sha256.txt');
  fs.writeFileSync(
    checksumFile,
    Object.entries(assets).map(([name, content]) => `${sha256(content)}  ${name}`).join('\n') + '\n',
  );
  return { root, pluginDir, checksumFile };
}

function verify(pluginDir: string, checksumFile: string) {
  return spawnSync(process.execPath, [
    verifier,
    '--plugin-dir', pluginDir,
    '--version', version,
    '--sha256-file', checksumFile,
  ], { encoding: 'utf8' });
}

describe('installed plugin verifier', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const value = createFixture();
    roots.push(value.root);
    return value;
  }

  it('accepts exactly three verified runtime files plus preserved data.json', () => {
    const value = fixture();
    const result = verify(value.pluginDir, value.checksumFile);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Verified installed Codian ${version}`);
  });

  it('rejects a wrong installed version', () => {
    const value = fixture();
    fs.writeFileSync(path.join(value.pluginDir, 'manifest.json'), JSON.stringify({ id: 'codian', version: 'wrong' }));
    expect(verify(value.pluginDir, value.checksumFile).status).not.toBe(0);
  });

  it('rejects a wrong runtime hash', () => {
    const value = fixture();
    fs.writeFileSync(path.join(value.pluginDir, 'main.js'), 'tampered');
    expect(verify(value.pluginDir, value.checksumFile).status).not.toBe(0);
  });

  it('rejects a missing required file', () => {
    const value = fixture();
    fs.rmSync(path.join(value.pluginDir, 'styles.css'));
    expect(verify(value.pluginDir, value.checksumFile).status).not.toBe(0);
  });

  it('rejects every unexpected top-level file', () => {
    const value = fixture();
    fs.writeFileSync(path.join(value.pluginDir, 'unexpected.txt'), 'unexpected');
    expect(verify(value.pluginDir, value.checksumFile).status).not.toBe(0);
  });

  it('rejects historical backup directories in the active plugin folder', () => {
    const value = fixture();
    fs.mkdirSync(path.join(value.pluginDir, '.backup-20260802'));
    expect(verify(value.pluginDir, value.checksumFile).status).not.toBe(0);
  });
});
