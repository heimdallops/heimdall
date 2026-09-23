import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { hasGeneratedMarker, type SkillFile } from '../core/skills/index.ts';
import { CliError, EXIT_CODE } from '../errors/cli-error.ts';

const readIfPresent = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
};

/**
 * Writes rendered skill files under `root`, returning the absolute paths written.
 *
 * A file that already exists and does not carry the generated marker was written or edited
 * by hand, so overwriting it needs `force`. The check runs across every file before
 * anything is written, so a refusal leaves the install untouched rather than half-applied.
 */
export const writeSkillFiles = async (
  root: string,
  files: readonly SkillFile[],
  force: boolean
): Promise<string[]> => {
  const targets = files.map((file) => ({ ...file, absolutePath: join(root, file.relativePath) }));

  if (!force) {
    for (const target of targets) {
      const existing = await readIfPresent(target.absolutePath);

      if (existing !== undefined && !hasGeneratedMarker(existing)) {
        throw new CliError(
          `Refusing to overwrite ${target.absolutePath} — it was not written by Heimdall. Re-run with --force to replace it.`,
          { code: 'SKILL_FILE_NOT_GENERATED', exitCode: EXIT_CODE.CONFLICT }
        );
      }
    }
  }

  const written: string[] = [];

  for (const target of targets) {
    await mkdir(dirname(target.absolutePath), { recursive: true });
    await writeFile(target.absolutePath, target.contents, 'utf8');
    written.push(target.absolutePath);
  }

  return written;
};
