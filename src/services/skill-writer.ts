import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { hasGeneratedMarker, type InstalledSkill, type SkillFile } from '../core/skills/index.ts';
import { CliError, EXIT_CODE } from '../errors/cli-error.ts';
import { readIfPresent } from './skill-fs.ts';

export interface SkillWriteResult {
  readonly written: string[];
  /** Files a previous install wrote that this render no longer produces. */
  readonly removed: string[];
}

export interface SkillRemoveResult {
  readonly removed: string[];
  /** Files left in place because Heimdall did not write them. */
  readonly kept: string[];
}

/** Drops directories left empty by a removal, stopping at `stopAt`, which always survives. */
const removeEmptyParents = async (from: string, stopAt: string): Promise<void> => {
  let current = from;

  while (current.startsWith(stopAt + sep)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }

    current = dirname(current);
  }
};

/**
 * Deletes the marker-bearing files of already-discovered skills. `force` widens what counts
 * as ours (a partial install), never what may be destroyed.
 */
export const removeSkillFiles = async (
  skills: readonly InstalledSkill[],
  force: boolean
): Promise<SkillRemoveResult> => {
  if (!force) {
    const partial = skills.find((skill) => skill.partial);

    if (partial !== undefined) {
      throw new CliError(
        `Refusing to remove ${partial.directory} — it holds files Heimdall wrote but no generated SKILL.md, so it may be a partial install. Re-run with --force to remove it.`,
        { code: 'SKILL_PARTIAL_INSTALL', exitCode: EXIT_CODE.CONFLICT }
      );
    }
  }

  const removed: string[] = [];
  const kept: string[] = [];

  for (const skill of skills) {
    for (const path of skill.files) {
      await rm(path, { force: true });
      removed.push(path);
      await removeEmptyParents(dirname(path), skill.directory);
    }

    kept.push(...skill.kept);

    try {
      await rmdir(skill.directory);
    } catch {
      // Still holds files the user added, which is why it survives.
    }
  }

  return { removed, kept };
};

/** What `writeSkillFiles` would remove, without touching disk, for `--dry-run`. */
export const plannedRemovals = (
  root: string,
  files: readonly SkillFile[],
  staleSkills: readonly InstalledSkill[]
): string[] => {
  const rendered = new Set(files.map((file) => join(root, file.relativePath)));

  return staleSkills.flatMap((skill) => skill.files.filter((path) => !rendered.has(path))).sort();
};

/**
 * Writes the rendered files, then removes anything in `staleSkills` this render does not
 * write back, so an install converges on exactly what this version ships.
 */
export const writeSkillFiles = async (
  root: string,
  files: readonly SkillFile[],
  force: boolean,
  staleSkills: readonly InstalledSkill[] = []
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

  const rendered = new Set(targets.map((target) => target.absolutePath));
  const removed: string[] = [];
  const written: string[] = [];

  for (const target of targets) {
    await mkdir(dirname(target.absolutePath), { recursive: true });
    await writeFile(target.absolutePath, target.contents, 'utf8');
    written.push(target.absolutePath);
  }

  for (const skill of staleSkills) {
    for (const path of skill.files) {
      if (rendered.has(path)) {
        continue;
      }

      await rm(path, { force: true });
      removed.push(path);
      await removeEmptyParents(dirname(path), skill.directory);
    }

    // A skill being reinstalled has just had its files written back, so it keeps its directory.
    if (!skill.files.some((path) => rendered.has(path))) {
      try {
        await rmdir(skill.directory);
      } catch {
        // Still holds files, so it stays.
      }
    }
  }

  return { written, removed: removed.sort() };
};
