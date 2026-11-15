import { join } from 'node:path';

import {
  hasGeneratedMarker,
  type InstalledSkill,
  markerVersion,
  type SkillTarget,
} from '../core/skills/index.ts';
import { listDirectoryNames, listFilesRecursively, readIfPresent } from './skill-fs.ts';

/**
 * Finds installed skills by marker, never by catalog lookup — a skill this build no longer
 * ships is exactly the one a user needs to remove. A directory with no marked file in it is
 * never claimed, so skills sharing this root are safe.
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
      partial: !manifestIsOurs,
    });
  }

  return discovered;
};
