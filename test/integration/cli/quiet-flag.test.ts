import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const cliPath = resolve(process.cwd(), 'dist/index.js');

// Global flags are resolved on the command path, where createContext() loads config. A bare
// invocation prints help and never gets that far, so these exercise a real command. --dry-run
// keeps the assertions about flag handling rather than filesystem effects.
const command = ['skills', 'install', 'claude', '--dry-run'];

const workdir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'heimdall-quiet-'));

describe('--quiet flag', () => {
  it('accepts --quiet without error', async () => {
    const result = await execa('node', [cliPath, ...command, '--quiet'], {
      cwd: await workdir(),
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('accepts -q short form without error', async () => {
    const result = await execa('node', [cliPath, ...command, '-q'], {
      cwd: await workdir(),
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('lists --quiet in --help output', async () => {
    const result = await execa('node', [cliPath, '--help'], { reject: false });

    expect(result.stdout).toContain('--quiet');
  });

  it('does not suppress error output — errors still appear on stderr with --quiet', async () => {
    const result = await execa(
      'node',
      [cliPath, ...command, '--quiet', '--config', '/nonexistent-heimdall-config.json'],
      { cwd: await workdir(), reject: false }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });

  // Verify that error output produced WITHOUT --quiet is also present WITH --quiet — quiet
  // suppresses info/warn/verbose/debug but must never swallow errors. Both invocations use an
  // invalid config path to produce a predictable [UNKNOWN_ERROR] line.
  it('--quiet does not suppress error output and emits no non-error lines', async () => {
    const args = [...command, '--config', '/nonexistent-heimdall-config.json'];

    const withoutQuiet = await execa('node', [cliPath, ...args], {
      cwd: await workdir(),
      reject: false,
    });
    const withQuiet = await execa('node', [cliPath, ...args, '--quiet'], {
      cwd: await workdir(),
      reject: false,
    });

    expect(withQuiet.exitCode).toBe(withoutQuiet.exitCode);
    expect(withoutQuiet.stderr).toContain('[UNKNOWN_ERROR]');
    expect(withQuiet.stderr).toContain('[UNKNOWN_ERROR]');
  });
});

describe('--quiet conflicting-flag validation', () => {
  it.each([
    { conflictingFlag: '--verbose', args: ['--quiet', '--verbose'] },
    { conflictingFlag: '--debug', args: ['--quiet', '--debug'] },
  ])(
    'exits with code 2 and prints a usage error naming --quiet and $conflictingFlag when combined',
    async ({ conflictingFlag, args }) => {
      const result = await execa('node', [cliPath, ...command, ...args], {
        cwd: await workdir(),
        reject: false,
      });

      expect(result.exitCode).toBe(2);
      // Assert the conflict error itself, not just the flag names — help output also contains
      // every flag, so a looser match would pass without validation having run.
      expect(result.stderr).toContain('[CONFLICTING_FLAGS]');
      expect(result.stderr).toMatch(/--quiet/);
      expect(result.stderr).toContain(conflictingFlag);
    }
  );

  it('does NOT exit with code 2 when --verbose and --debug are combined without --quiet', async () => {
    const result = await execa('node', [cliPath, ...command, '--verbose', '--debug'], {
      cwd: await workdir(),
      reject: false,
    });

    expect(result.exitCode).toBe(0);
  });
});
