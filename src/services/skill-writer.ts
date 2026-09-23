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

// Walks up from a removed file's directory, dropping directories left empty by the removal, and
// stops at the first one that is not — or at `stopAt`, which is never removed.
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
 * Deletes the marker-bearing files of already-discovered skills.
 *
 * Discovery decided what is ours; this only enforces the two rules that bound the damage.
 * Nothing outside a discovered skill's own directory is touched, and only files carrying
 * the marker are deleted — a file the user added survives, and keeps its directory alive
 * with it. A partial install (marked files, no marked manifest) needs `force`, because the
 * evidence that the directory is ours is weaker there.
 *
 * `force` widens what counts as ours. It never widens what may be destroyed.
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

    // The skill's own directory goes too, but only once nothing of the user's is left in it.
    try {
      await rmdir(skill.directory);
    } catch {
      // Still holds files the user added. Leaving it is the point.
    }
  }

  return { removed, kept };
};

/**
 * What a real install would remove: every marked file of a discovered skill that this
 * render does not write back. Reads no disk of its own, so `--dry-run` previews removals
 * through the same reasoning the write path applies.
 */
export const plannedRemovals = (
  root: string,
  files: readonly SkillFile[],
  staleSkills: readonly InstalledSkill[]
): string[] => {
  const rendered = new Set(files.map((file) => join(root, file.relativePath)));

  return staleSkills.flatMap((skill) => skill.files.filter((path) => !rendered.has(path))).sort();
};

/**
 * Writes rendered skill files under `root`, returning the absolute paths written and removed.
 *
 * A file that already exists and does not carry the generated marker was written or edited
 * by hand, so overwriting it needs `force`. The check runs across every file before
 * anything is written, so a refusal leaves the install untouched rather than half-applied.
 *
 * `staleSkills` are skills discovered on disk that this render does not produce — a skill
 * dropped or renamed between versions. Their marked files are removed so an install
 * converges on exactly what the current version ships, rather than leaving content the
 * agent would go on loading as authoritative.
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

    // Only a skill this render does not produce at all can lose its directory; one being
    // reinstalled has just had its files written back.
    if (!skill.files.some((path) => rendered.has(path))) {
      try {
        await rmdir(skill.directory);
      } catch {
        // Still holds files the user added, or files just written. Either way it stays.
      }
    }
  }

  return { written, removed: removed.sort() };
};
