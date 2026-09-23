import { join } from 'node:path';

import {
  hasGeneratedMarker,
  type InstalledSkill,
  markerVersion,
  type SkillTarget,
} from '../core/skills/index.ts';
import { listDirectoryNames, listFilesRecursively, readIfPresent } from './skill-fs.ts';

/**
 * Finds the skills Heimdall has installed under `root`, by reading the filesystem.
 *
 * **The catalog is deliberately not consulted.** A skill that was renamed, retired, or
 * installed by an older CLI is no longer in the bundle, and that is exactly the skill a
 * user needs to be able to remove. Recognition therefore rests on the generated marker,
 * which every installed file carries, rather than on whether this build still ships the
 * name.
 *
 * A directory is skipped entirely unless something in it carries the marker, so the
 * user's own skills and other tools' skills — which share this root — are never claimed.
 */
export const discoverInstalledSkills = async (
  root: string,
  target: SkillTarget
): Promise<InstalledSkill[]> => {
  const discovered: InstalledSkill[] = [];

  for (const name of await listDirectoryNames(root)) {
    const directory = join(root, name);
    const manifest = join(root, target.manifestPath(name));
    const manifestContents = await readIfPresent(manifest);
    const manifestIsOurs = manifestContents !== undefined && hasGeneratedMarker(manifestContents);

    const files: string[] = [];
    const kept: string[] = [];

    for (const path of await listFilesRecursively(directory)) {
      const contents = await readIfPresent(path);

      if (contents !== undefined && hasGeneratedMarker(contents)) {
        files.push(path);
      } else {
        kept.push(path);
      }
    }

    if (files.length === 0) {
      continue;
    }

    discovered.push({
      name,
      directory,
      files: files.sort(),
      kept: kept.sort(),
      version: manifestIsOurs ? markerVersion(manifestContents) : undefined,
      // Marked files but no marked manifest: an interrupted write, or a manifest the user
      // deleted. Still ours by the evidence, but weakly enough to want confirmation.
      partial: !manifestIsOurs,
    });
  }

  return discovered;
};
