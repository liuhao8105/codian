import * as fs from 'fs';
import * as path from 'path';

const repositoryRoot = path.resolve(__dirname, '../../..');

describe('long-run dependency policy', () => {
  it('pins both vulnerable brace-expansion major lines to patched releases', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));

    expect(packageJson.overrides).toMatchObject({
      'brace-expansion@<1.1.17': '1.1.17',
      'brace-expansion@>=2.0.0 <2.1.3': '2.1.3',
    });
  });

  it('runs CI on code changes, manual requests, and a weekly schedule with separate audits', () => {
    const workflow = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/push:/);
    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/schedule:[\s\S]*cron:/);
    expect(workflow).toContain('npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org');
    expect(workflow).toContain('npm audit --audit-level=high --registry=https://registry.npmjs.org');
    expect(workflow.indexOf('npm audit --omit=dev')).toBeLessThan(workflow.indexOf('npm ci'));
  });

  it('configures weekly npm and GitHub Actions Dependabot updates without auto-merge', () => {
    const dependabot = fs.readFileSync(path.join(repositoryRoot, '.github/dependabot.yml'), 'utf8');

    expect(dependabot).toMatch(/package-ecosystem:\s*["']?npm["']?/);
    expect(dependabot).toMatch(/package-ecosystem:\s*["']?github-actions["']?/);
    expect(dependabot.match(/interval:\s*["']?weekly["']?/g)).toHaveLength(2);
    expect(dependabot).toContain('open-pull-requests-limit: 5');
    expect(dependabot).not.toMatch(/auto-merge|automerge/i);
  });
});
