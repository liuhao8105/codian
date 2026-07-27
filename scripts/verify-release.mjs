#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { basename, join, resolve } from 'path';

const RELEASE_FILES = ['main.js', 'manifest.json', 'styles.css'];
const MAX_ARCHIVE_FILE_BYTES = 64 * 1024 * 1024;

function parseArgs(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--root' || !argv[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${argv[index] ?? ''}`);
    }
    root = argv[index + 1];
    index += 1;
  }
  return { root: resolve(root) };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function archiveEntries(archivePath) {
  const output = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter(Boolean);
}

function assertExactArchive(archivePath) {
  execFileSync('unzip', ['-tqq', archivePath], { stdio: 'pipe' });
  const entries = archiveEntries(archivePath);
  const unique = new Set(entries);
  if (
    entries.length !== RELEASE_FILES.length ||
    unique.size !== entries.length ||
    entries.some((entry, index) => entry !== RELEASE_FILES[index])
  ) {
    throw new Error(
      `${basename(archivePath)} archive entries must be exactly: ${RELEASE_FILES.join(', ')}`,
    );
  }
}

function readArchiveFile(archivePath, file) {
  return execFileSync('unzip', ['-p', archivePath, file], {
    maxBuffer: MAX_ARCHIVE_FILE_BYTES,
  });
}

function parseChecksums(raw, expectedNames) {
  const checksums = new Map();
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  ([^/]+)$/);
    if (!match || checksums.has(match[2])) {
      throw new Error('SHA-256 file contains an invalid or duplicate entry');
    }
    checksums.set(match[2], match[1]);
  }
  if (
    checksums.size !== expectedNames.length ||
    expectedNames.some(name => !checksums.has(name))
  ) {
    throw new Error('SHA-256 file does not list the exact release assets');
  }
  return checksums;
}

export function verifyRelease(root) {
  const packageJson = readJson(join(root, 'package.json'));
  const manifest = readJson(join(root, 'manifest.json'));
  const versions = readJson(join(root, 'versions.json'));
  if (
    typeof packageJson.version !== 'string' ||
    packageJson.version !== manifest.version ||
    versions[packageJson.version] !== manifest.minAppVersion
  ) {
    throw new Error('Release version values disagree across package, manifest, or version map');
  }

  const version = packageJson.version;
  const outputDirectory = join(root, 'outputs');
  const installArchive = join(outputDirectory, `codian-${version}.zip`);
  const rollbackArchive = join(outputDirectory, `codian-${version}-rollback.zip`);
  const checksumPath = join(outputDirectory, `codian-${version}-sha256.txt`);
  assertExactArchive(installArchive);
  assertExactArchive(rollbackArchive);

  for (const file of RELEASE_FILES) {
    const source = readFileSync(join(root, file));
    const published = readFileSync(join(outputDirectory, file));
    const archived = readArchiveFile(installArchive, file);
    if (!source.equals(published) || !source.equals(archived)) {
      throw new Error(`Published ${file} does not match the built release asset`);
    }
  }

  const rollbackManifest = JSON.parse(
    readArchiveFile(rollbackArchive, 'manifest.json').toString('utf8'),
  );
  if (
    typeof rollbackManifest.version !== 'string' ||
    rollbackManifest.version === version ||
    versions[rollbackManifest.version] !== rollbackManifest.minAppVersion
  ) {
    throw new Error('Rollback archive manifest version is invalid or absent from version map');
  }

  const expectedPaths = [
    ...RELEASE_FILES.map(file => join(outputDirectory, file)),
    installArchive,
    rollbackArchive,
  ];
  const expectedNames = expectedPaths.map(filePath => basename(filePath));
  const checksums = parseChecksums(readFileSync(checksumPath, 'utf8'), expectedNames);
  for (const filePath of expectedPaths) {
    if (checksums.get(basename(filePath)) !== sha256(filePath)) {
      throw new Error(`SHA-256 mismatch for ${basename(filePath)}`);
    }
  }

  return {
    version,
    rollbackVersion: rollbackManifest.version,
    assets: expectedNames,
  };
}

try {
  const { root } = parseArgs(process.argv.slice(2));
  const result = verifyRelease(root);
  process.stdout.write(
    `Verified Codian ${result.version}; rollback ${result.rollbackVersion}; ${result.assets.length} hashed assets\n`,
  );
} catch (error) {
  process.stderr.write(`Release verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
