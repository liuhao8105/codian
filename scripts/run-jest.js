const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const jestPath = require.resolve('jest/bin/jest');
const localStorageFile = path.join(os.tmpdir(), 'claudian-localstorage');
const forwardedArgs = process.argv.slice(2);
const localStorageArgs = process.allowedNodeEnvironmentFlags?.has(
  '--localstorage-file'
)
  ? [`--localstorage-file=${localStorageFile}`]
  : [];

function runJest(args, stdio = 'inherit') {
  return spawnSync(
    process.execPath,
    [...localStorageArgs, jestPath, ...args],
    { stdio, encoding: stdio === 'pipe' ? 'utf8' : undefined }
  );
}

// ts-jest retains transformed modules for the life of a process. On this
// project the complete suite can exceed the desktop/CI memory limit even with
// --runInBand, so normal verification runs in bounded fresh-process batches.
// Watch and coverage modes remain single-process because they require shared
// state.
if (!forwardedArgs.includes('--watch') && !forwardedArgs.includes('--coverage')) {
  const listed = runJest([...forwardedArgs, '--listTests'], 'pipe');
  if (listed.error || listed.status !== 0) {
    if (listed.stdout) process.stdout.write(listed.stdout);
    if (listed.stderr) process.stderr.write(listed.stderr);
    process.exit(listed.status ?? 1);
  }

  const testFiles = listed.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /\.(test|spec)\.[cm]?[jt]sx?$/.test(line));
  const batchSize = 10;

  for (let index = 0; index < testFiles.length; index += batchSize) {
    const batch = testFiles.slice(index, index + batchSize);
    const result = runJest(['--runInBand', '--runTestsByPath', ...batch]);
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
  process.exit(0);
}

const result = runJest(forwardedArgs);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
