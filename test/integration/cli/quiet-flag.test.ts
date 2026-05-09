import { resolve } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

describe('--quiet flag', () => {
  const cliPath = resolve(process.cwd(), 'dist/index.js');

  it('accepts --quiet without error', async () => {
    const result = await execa('node', [cliPath, '--quiet'], {
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('accepts -q short form without error', async () => {
    const result = await execa('node', [cliPath, '-q'], {
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('lists --quiet in --help output', async () => {
    const result = await execa('node', [cliPath, '--help'], {
      reject: false,
    });

    expect(result.stdout).toContain('--quiet');
  });

  // Errors thrown during config loading are rendered by the bootstrap printer
  // (quiet: false), not the request-scoped printer. The quiet flag is never
  // applied here because loadConfig throws before createContext() is reached.
  // The quiet-exemption behavior for printer.error() is unit-tested in
  // test/unit/output/printer-quiet.test.ts.
  it('does not suppress error output — errors still appear on stderr with --quiet', async () => {
    const result = await execa(
      'node',
      [cliPath, '--quiet', '--config', '/nonexistent-heimdall-config.json'],
      { reject: false }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });

  // Verify that error output produced WITHOUT --quiet is also present WITH
  // --quiet — quiet suppresses info/warn/verbose/debug but must never swallow
  // errors.  Both invocations use an invalid config path to produce a
  // predictable ERROR line.
  it('--quiet does not suppress error output and emits no non-error lines', async () => {
    const withoutQuiet = await execa(
      'node',
      [cliPath, '--config', '/nonexistent-heimdall-config.json'],
      { reject: false }
    );

    const withQuiet = await execa(
      'node',
      [cliPath, '--quiet', '--config', '/nonexistent-heimdall-config.json'],
      { reject: false }
    );

    // Both runs must fail with the same exit code.
    expect(withQuiet.exitCode).toBe(withoutQuiet.exitCode);
    // The error message must appear on stderr in both cases.
    expect(withoutQuiet.stderr).toContain('ERROR');
    expect(withQuiet.stderr).toContain('ERROR');
    // With --quiet, there must be no additional info/warn/verbose/debug lines
    // beyond the error line — quiet suppresses all non-error log output.
    const nonErrorLines = withQuiet.stderr
      .split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line) => !line.includes('ERROR'));
    expect(nonErrorLines).toHaveLength(0);
  });
});

describe('--quiet conflicting-flag validation', () => {
  const cliPath = resolve(process.cwd(), 'dist/index.js');

  it.each([
    { conflictingFlag: '--verbose', args: ['--quiet', '--verbose'] },
    { conflictingFlag: '--debug', args: ['--quiet', '--debug'] },
  ])(
    'exits with code 2 and prints a usage error naming --quiet and $conflictingFlag when combined',
    async ({ conflictingFlag, args }) => {
      const result = await execa('node', [cliPath, ...args], {
        reject: false,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(/--quiet/);
      expect(result.stderr).toContain(conflictingFlag);
    }
  );

  it('does NOT exit with code 2 when --verbose and --debug are combined without --quiet', async () => {
    const result = await execa('node', [cliPath, '--verbose', '--debug'], {
      reject: false,
    });

    expect(result.exitCode).toBe(0);
  });
});
