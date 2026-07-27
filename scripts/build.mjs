#!/usr/bin/env node
/**
 * Combined build script - runs CSS build then esbuild
 * Avoids npm echoing commands
 */

import { execSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Run CSS build silently
execSync('node scripts/build-css.mjs', { cwd: ROOT, stdio: 'inherit' });

// Run esbuild with args passed through
const args = process.argv.slice(2).join(' ');
execSync(`node esbuild.config.mjs ${args}`, { cwd: ROOT, stdio: 'inherit' });

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const versions = JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8'));
if (
  packageJson.version !== manifest.version ||
  versions[packageJson.version] !== manifest.minAppVersion
) {
  throw new Error('Release version values disagree across package, manifest, or version map');
}

for (const releaseFile of ['main.js', 'manifest.json', 'styles.css']) {
  if (statSync(join(ROOT, releaseFile)).size === 0) {
    throw new Error(`Build produced an empty release file: ${releaseFile}`);
  }
}
