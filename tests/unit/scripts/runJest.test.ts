import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

describe('run-jest Node compatibility', () => {
  it('does not pass --localstorage-file to Node 20', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/run-jest.js'),
      'utf8'
    );
    const spawnedArgs: string[][] = [];
    const exit = jest.fn((code: number) => {
      throw new Error(`exit:${code}`);
    });
    const fakeRequire = (id: string) => {
      if (id === 'child_process') {
        return {
          spawnSync: (_executable: string, args: string[]) => {
            spawnedArgs.push(args);
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      }
      if (id === 'os') {
        return { tmpdir: () => '/tmp' };
      }
      if (id === 'path') {
        return path;
      }
      throw new Error(`Unexpected require: ${id}`);
    };
    fakeRequire.resolve = (id: string) => {
      if (id === 'jest/bin/jest') return '/fake/jest.js';
      throw new Error(`Unexpected resolve: ${id}`);
    };

    expect(() =>
      vm.runInNewContext(source, {
        require: fakeRequire,
        process: {
          argv: ['node', 'scripts/run-jest.js'],
          execPath: '/fake/node',
          exit,
          versions: { node: '20.20.2' },
          stdout: { write: jest.fn() },
          stderr: { write: jest.fn() },
        },
        console,
      })
    ).toThrow('exit:0');

    expect(spawnedArgs).not.toHaveLength(0);
    expect(spawnedArgs[0]).not.toContain(
      '--localstorage-file=/tmp/codian-localstorage'
    );
  });
});
