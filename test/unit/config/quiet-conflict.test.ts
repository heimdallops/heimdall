import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/load-config.ts';
import { CliError, EXIT_CODE } from '../../../src/errors/cli-error.ts';

const tempDirs: string[] = [];

const makeTempCwd = async (): Promise<string> => {
  const cwd = await mkdtemp(join(tmpdir(), 'heimdall-conflict-'));
  tempDirs.push(cwd);

  return cwd;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadConfig — conflicting-flag validation', () => {
  it('throws a CliError with exitCode USAGE, code CONFLICTING_FLAGS, and a message naming --quiet and --verbose when quiet and verbose conflict', async () => {
    const cwd = await makeTempCwd();

    const error = await loadConfig({ quiet: true, verbose: true }, cwd).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
    expect((error as CliError).code).toBe('CONFLICTING_FLAGS');
    expect((error as CliError).message).toContain('--quiet');
    expect((error as CliError).message).toContain('--verbose');
  });

  it('throws a CliError with exitCode USAGE, code CONFLICTING_FLAGS, and a message naming --quiet and --debug when quiet and debug conflict', async () => {
    const cwd = await makeTempCwd();

    const error = await loadConfig({ quiet: true, debug: true }, cwd).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
    expect((error as CliError).code).toBe('CONFLICTING_FLAGS');
    expect((error as CliError).message).toContain('--quiet');
    expect((error as CliError).message).toContain('--debug');
  });

  it('throws a CliError with exitCode USAGE, code CONFLICTING_FLAGS, and a message naming both --verbose and --debug when all three flags conflict', async () => {
    const cwd = await makeTempCwd();

    const error = await loadConfig({ quiet: true, verbose: true, debug: true }, cwd).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
    expect((error as CliError).code).toBe('CONFLICTING_FLAGS');
    expect((error as CliError).message).toContain('--quiet');
    expect((error as CliError).message).toContain('--verbose');
    expect((error as CliError).message).toContain('--debug');
  });

  it('does NOT throw when verbose and debug are both true without quiet', async () => {
    const cwd = await makeTempCwd();

    await expect(loadConfig({ verbose: true, debug: true }, cwd)).resolves.toMatchObject({
      verbose: true,
      debug: true,
      quiet: false,
    });
  });
});
