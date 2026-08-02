import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repositoryRoot = process.cwd();
const packageScript = path.join(repositoryRoot, 'scripts', 'package-release.mjs');
const verifyScript = path.join(repositoryRoot, 'scripts', 'verify-release.mjs');
const currentVersion = '1.3.84-test';

function writeJson(target: string, value: unknown): void {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-release-'));
  writeJson(path.join(root, 'package.json'), { name: 'codian', version: currentVersion });
  writeJson(path.join(root, 'manifest.json'), {
    id: 'codian',
    version: currentVersion,
    minAppVersion: '1.4.5',
  });
  writeJson(path.join(root, 'versions.json'), {
    [currentVersion]: '1.4.5',
  });
  fs.writeFileSync(path.join(root, 'main.js'), 'x'.repeat(2 * 1024 * 1024));
  fs.writeFileSync(path.join(root, 'styles.css'), 'current-css');
  return root;
}

function runPackage(root: string): void {
  execFileSync(process.execPath, [
    packageScript,
    '--root',
    root,
  ]);
}

function runVerify(root: string) {
  return spawnSync(process.execPath, [verifyScript, '--root', root], {
    encoding: 'utf8',
  });
}

describe('release packaging and verification', () => {
  const fixtures: string[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('creates an exact install archive and matching checksums', () => {
    const root = createFixture();
    fixtures.push(root);

    runPackage(root);
    const result = runVerify(root);

    expect(result.status).toBe(0);
    const installArchive = path.join(root, 'outputs', `codian-${currentVersion}.zip`);
    const entries = execFileSync('unzip', ['-Z1', installArchive], { encoding: 'utf8' })
      .trim()
      .split('\n');
    expect(entries).toEqual(['main.js', 'manifest.json', 'styles.css']);
    expect(fs.readFileSync(path.join(root, 'outputs', 'main.js'), 'utf8')).toHaveLength(
      2 * 1024 * 1024,
    );
    expect(fs.readdirSync(path.join(root, 'outputs')).sort()).toEqual([
      `codian-${currentVersion}-sha256.txt`,
      `codian-${currentVersion}.zip`,
      'main.js',
      'manifest.json',
      'styles.css',
    ]);
    expect(
      fs.readFileSync(
        path.join(root, 'outputs', `codian-${currentVersion}-sha256.txt`),
        'utf8',
      ),
    ).toContain(`codian-${currentVersion}.zip`);
  });

  it('fails closed when release versions disagree', () => {
    const root = createFixture();
    fixtures.push(root);
    runPackage(root);
    writeJson(path.join(root, 'manifest.json'), {
      id: 'codian',
      version: 'different-version',
      minAppVersion: '1.4.5',
    });

    const result = runVerify(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('version');
  });

  it('fails closed when an archive contains an extra file', () => {
    const root = createFixture();
    fixtures.push(root);
    runPackage(root);
    const output = path.join(root, 'outputs');
    fs.writeFileSync(path.join(root, 'extra.txt'), 'unexpected');
    execFileSync('zip', [
      '-q',
      path.join(output, `codian-${currentVersion}.zip`),
      'extra.txt',
    ], { cwd: root });

    const result = runVerify(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('archive entries');
  });

  it('fails closed when a published checksum does not match the bytes', () => {
    const root = createFixture();
    fixtures.push(root);
    runPackage(root);
    fs.appendFileSync(path.join(root, 'outputs', `codian-${currentVersion}.zip`), 'tamper');

    const result = runVerify(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SHA-256');
  });
});
