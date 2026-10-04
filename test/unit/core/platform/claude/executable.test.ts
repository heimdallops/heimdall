import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveClaudeCodeExecutable } from '../../../../../src/core/platform/claude/executable.ts';
import { PlatformError } from '../../../../../src/core/platform/errors.ts';

let runningAsSea = false;

vi.mock('node:sea', () => ({
  isSea: (): boolean => runningAsSea,
}));

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'heimdall-claude-exe-'));
  tempDirs.push(dir);

  return dir;
};

const writeExecutable = async (dir: string, name = 'claude'): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, '#!/bin/sh\n', 'utf8');
  await chmod(path, 0o755);

  return path;
};

beforeEach(() => {
  runningAsSea = false;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveClaudeCodeExecutable', () => {
  describe('configured path', () => {
    it('returns a configured executable', async () => {
      const executable = await writeExecutable(await makeTempDir());

      await expect(resolveClaudeCodeExecutable(executable, { PATH: '' })).resolves.toBe(executable);
    });

    it('throws CLAUDE_CODE_NOT_FOUND when the configured path does not exist', async () => {
      const missing = join(await makeTempDir(), 'claude');

      const error = await resolveClaudeCodeExecutable(missing, { PATH: '' }).catch(
        (err: unknown) => err
      );

      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe('CLAUDE_CODE_NOT_FOUND');
    });

    it('throws CLAUDE_CODE_NOT_FOUND when the configured path is a directory', async () => {
      const dir = await makeTempDir();

      await expect(resolveClaudeCodeExecutable(dir, { PATH: '' })).rejects.toMatchObject({
        code: 'CLAUDE_CODE_NOT_FOUND',
      });
    });
  });

  describe('npm install (not a SEA)', () => {
    it('returns undefined so the SDK uses its bundled binary, even with claude on PATH', async () => {
      const dir = await makeTempDir();
      await writeExecutable(dir);

      await expect(resolveClaudeCodeExecutable(undefined, { PATH: dir })).resolves.toBeUndefined();
    });
  });

  describe('standalone binary (SEA)', () => {
    beforeEach(() => {
      runningAsSea = true;
    });

    it('returns the first claude found on PATH', async () => {
      const emptyDir = await makeTempDir();
      const firstDir = await makeTempDir();
      const secondDir = await makeTempDir();
      const expected = await writeExecutable(firstDir);
      await writeExecutable(secondDir);

      await expect(
        resolveClaudeCodeExecutable(undefined, {
          PATH: [emptyDir, firstDir, secondDir].join(delimiter),
        })
      ).resolves.toBe(expected);
    });

    it('skips a non-executable claude and directories named claude', async () => {
      const nonExecutableDir = await makeTempDir();
      await writeFile(join(nonExecutableDir, 'claude'), '', 'utf8');
      const directoryDir = await makeTempDir();
      await mkdir(join(directoryDir, 'claude'));
      const goodDir = await makeTempDir();
      const expected = await writeExecutable(goodDir);

      await expect(
        resolveClaudeCodeExecutable(undefined, {
          PATH: [nonExecutableDir, directoryDir, goodDir].join(delimiter),
        })
      ).resolves.toBe(expected);
    });

    it('throws CLAUDE_CODE_NOT_FOUND with install guidance when claude is not on PATH', async () => {
      const dir = await makeTempDir();

      const error = await resolveClaudeCodeExecutable(undefined, { PATH: dir }).catch(
        (err: unknown) => err
      );

      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe('CLAUDE_CODE_NOT_FOUND');
      expect((error as PlatformError).message).toContain('HEIMDALL_CLAUDE_CODE_EXECUTABLE');
    });

    it('prefers a configured path over PATH', async () => {
      const pathDir = await makeTempDir();
      await writeExecutable(pathDir);
      const configured = await writeExecutable(await makeTempDir(), 'my-claude');

      await expect(resolveClaudeCodeExecutable(configured, { PATH: pathDir })).resolves.toBe(
        configured
      );
    });
  });
});
