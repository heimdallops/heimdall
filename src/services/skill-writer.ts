import { mkdir, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { hasGeneratedMarker, type SkillFile } from '../core/skills/index.ts';
import { CliError, EXIT_CODE } from '../errors/cli-error.ts';

export interface SkillWriteResult {
  readonly written: string[];
  /** Files a previous install wrote that this render no longer produces. */
  readonly removed: string[];
}

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

const listFilesRecursively = async (dir: string): Promise<string[]> => {
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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

// The directories this install owns: the first segment of each rendered path is the skill's own
// name. Scoping to these matters — the skills root holds skills from other sources, and nothing
// outside a directory Heimdall renders into may be considered for removal.
const ownedDirectories = (root: string, files: readonly SkillFile[]): string[] => [
  ...new Set(
    files.flatMap((file) => {
      const [owner] = file.relativePath.split(/[\\/]/);

      return owner === undefined || owner === '' ? [] : [join(root, owner)];
    })
  ),
];

/**
 * Files under the owned skill directories that a previous install wrote and this one does not.
 *
 * Only marker-bearing files qualify: the marker is what proves Heimdall wrote the file, so a file
 * the user added to the skill directory is left alone. `force` is deliberately not consulted — it
 * governs overwriting a user's edits at a path being written, never deleting a file elsewhere.
 */
export const findOrphanedFiles = async (
  root: string,
  files: readonly SkillFile[]
): Promise<string[]> => {
  const rendered = new Set(files.map((file) => join(root, file.relativePath)));
  const orphans: string[] = [];

  for (const directory of ownedDirectories(root, files)) {
    for (const path of await listFilesRecursively(directory)) {
      if (rendered.has(path)) {
        continue;
      }

      const contents = await readIfPresent(path);

      if (contents !== undefined && hasGeneratedMarker(contents)) {
        orphans.push(path);
      }
    }
  }

  return orphans.sort();
};

// Walks up from a removed file's directory, dropping directories left empty by the removal, and
// stops at the first one that is not — or at `stopAt`, which is the skill's own directory and is
// never removed.
const removeEmptyParents = async (from: string, stopAt: string): Promise<void> => {
  let current = from;

  while (current.startsWith(stopAt + sep)) {
    try {
      await rmdir(current);
    } catch {
      // Not empty, or already gone. Either way there is nothing further up to drop.
      return;
    }

    current = dirname(current);
  }
};

/**
 * Writes rendered skill files under `root`, returning the absolute paths written and removed.
 *
 * A file that already exists and does not carry the generated marker was written or edited
 * by hand, so overwriting it needs `force`. The check runs across every file before
 * anything is written, so a refusal leaves the install untouched rather than half-applied.
 *
 * Files a previous install wrote that this render no longer produces are removed, so a reinstall
 * converges on exactly what the current version ships. Without this, a reference dropped or
 * renamed between versions would linger — still carrying the marker, so nothing would ever flag
 * it — while the skill body presents `references/` as authoritative.
 */
export const writeSkillFiles = async (
  root: string,
  files: readonly SkillFile[],
  force: boolean
): Promise<SkillWriteResult> => {
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

  // Resolved before the write so an orphan is identified by what the previous install left,
  // not by what this one has already overwritten.
  const orphans = await findOrphanedFiles(root, files);
  const written: string[] = [];

  for (const target of targets) {
    await mkdir(dirname(target.absolutePath), { recursive: true });
    await writeFile(target.absolutePath, target.contents, 'utf8');
    written.push(target.absolutePath);
  }

  const owned = ownedDirectories(root, files);

  for (const orphan of orphans) {
    await rm(orphan, { force: true });

    const skillDirectory = owned.find((directory) => orphan.startsWith(directory + sep));

    if (skillDirectory !== undefined) {
      await removeEmptyParents(dirname(orphan), skillDirectory);
    }
  }

  return { written, removed: orphans };
};
