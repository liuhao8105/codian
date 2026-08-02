#!/usr/bin/env node

import { createHash } from 'crypto';
import { lstatSync, readFileSync, readdirSync } from 'fs';
import { basename, join, resolve } from 'path';

const RUNTIME_FILES = ['main.js', 'manifest.json', 'styles.css'];
const INSTALLED_FILES = [...RUNTIME_FILES, 'data.json'].sort();

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--plugin-dir', '--version', '--sha256-file'].includes(key) || !value) {
      throw new Error(`Unknown or incomplete argument: ${key ?? ''}`);
    }
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  for (const key of ['--plugin-dir', '--version', '--sha256-file']) {
    if (!values.has(key)) throw new Error(`Missing required argument: ${key}`);
  }
  return {
    pluginDir: resolve(values.get('--plugin-dir')),
    version: values.get('--version'),
    checksumFile: resolve(values.get('--sha256-file')),
  };
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function parseChecksums(filePath) {
  const checksums = new Map();
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  ([^/\\]+)$/);
    if (!match || checksums.has(match[2])) {
      throw new Error('SHA-256 file contains an invalid or duplicate entry.');
    }
    checksums.set(match[2], match[1]);
  }
  return checksums;
}

export function verifyInstalledPlugin({ pluginDir, version, checksumFile }) {
  const rootStat = lstatSync(pluginDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Plugin directory must be a real directory.');
  }

  const entries = readdirSync(pluginDir).sort();
  if (
    entries.length !== INSTALLED_FILES.length
    || entries.some((entry, index) => entry !== INSTALLED_FILES[index])
  ) {
    throw new Error(`Installed plugin entries must be exactly: ${INSTALLED_FILES.join(', ')}.`);
  }

  for (const file of INSTALLED_FILES) {
    const stat = lstatSync(join(pluginDir, file));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${file} must be a regular file.`);
    }
  }

  const manifest = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) {
    throw new Error('Installed manifest version does not match the expected version.');
  }
  JSON.parse(readFileSync(join(pluginDir, 'data.json'), 'utf8'));

  const checksums = parseChecksums(checksumFile);
  for (const file of RUNTIME_FILES) {
    if (!checksums.has(file) || checksums.get(file) !== sha256(join(pluginDir, file))) {
      throw new Error(`Installed SHA-256 mismatch for ${basename(file)}.`);
    }
  }

  return { version, runtimeFiles: RUNTIME_FILES.length };
}

try {
  const result = verifyInstalledPlugin(parseArgs(process.argv.slice(2)));
  process.stdout.write(`Verified installed Codian ${result.version}; ${result.runtimeFiles} runtime assets\n`);
} catch (error) {
  process.stderr.write(`Installed plugin verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
