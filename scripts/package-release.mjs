#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';

const RELEASE_FILES = ['main.js', 'manifest.json', 'styles.css'];
const FIXED_ARCHIVE_TIME = new Date('1980-01-01T00:00:00.000Z');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      values[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return values;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function requireReleaseFiles(directory, label) {
  for (const file of RELEASE_FILES) {
    try {
      const content = readFileSync(join(directory, file));
      if (content.length === 0) throw new Error('is empty');
    } catch (error) {
      throw new Error(`${label} ${file} is missing or empty: ${error.message}`);
    }
  }
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function buildArchive(sourceDirectory, archivePath) {
  const staging = mkdtempSync(join(tmpdir(), 'codian-release-stage-'));
  try {
    for (const file of RELEASE_FILES) {
      const stagedPath = join(staging, file);
      copyFileSync(join(sourceDirectory, file), stagedPath);
      utimesSync(stagedPath, FIXED_ARCHIVE_TIME, FIXED_ARCHIVE_TIME);
    }
    rmSync(archivePath, { force: true });
    execFileSync('zip', ['-X', '-q', archivePath, ...RELEASE_FILES], {
      cwd: staging,
      stdio: 'inherit',
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function packageRelease({ root }) {
  const resolvedRoot = resolve(root);
  requireReleaseFiles(resolvedRoot, 'Release source');

  const packageVersion = readJson(join(resolvedRoot, 'package.json')).version;
  const manifestVersion = readJson(join(resolvedRoot, 'manifest.json')).version;
  if (typeof packageVersion !== 'string' || packageVersion !== manifestVersion) {
    throw new Error('package.json and manifest.json version values must match');
  }

  const outputDirectory = join(resolvedRoot, 'outputs');
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  for (const file of RELEASE_FILES) {
    copyFileSync(join(resolvedRoot, file), join(outputDirectory, file));
  }
  const installArchive = join(outputDirectory, `codian-${packageVersion}.zip`);
  buildArchive(resolvedRoot, installArchive);

  const checksumTargets = [
    ...RELEASE_FILES.map(file => join(outputDirectory, file)),
    installArchive,
  ];
  const checksumPath = join(
    outputDirectory,
    `codian-${packageVersion}-sha256.txt`,
  );
  const checksumText = checksumTargets
    .map(filePath => `${sha256(filePath)}  ${basename(filePath)}`)
    .join('\n');
  writeFileSync(checksumPath, `${checksumText}\n`);

  return { installArchive, checksumPath };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ?? process.cwd();
  const result = packageRelease({ root });
  process.stdout.write(
    `Packaged ${basename(result.installArchive)}\n`,
  );
} catch (error) {
  process.stderr.write(`Release packaging failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
