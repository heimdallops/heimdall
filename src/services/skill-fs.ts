import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Filesystem reads shared by skill discovery and skill writing. Both need to ask "what is
 * there?" without treating an absent path as a failure — a fresh install and an empty
 * skills root are ordinary states, not errors.
 */

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT' ||
  (error as NodeJS.ErrnoException).code === 'ENOTDIR';

export const readIfPresent = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }

    throw error;
  }
};

export const listFilesRecursively = async (dir: string): Promise<string[]> => {
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  }

  const found: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await listFilesRecursively(path)));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }

  return found;
};

export const listDirectoryNames = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  }
};
