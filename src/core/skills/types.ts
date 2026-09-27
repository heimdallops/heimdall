import type { SkillPlatform } from './platform.ts';

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export type SkillScope = 'project' | 'user';

export interface SkillFile {
  readonly relativePath: string;
  readonly contents: string;
}

/** Owns where a platform's skills live and what shape they take — never their content. */
export interface SkillTarget {
  readonly platform: SkillPlatform;
  resolveRoot(scope: SkillScope, cwd: string): string;
  /** Pure, so `--dry-run` renders exactly what a real install would write. */
  render(skill: Skill): SkillFile[];
  /** The file whose marker identifies `skillName` as installed, without consulting the catalog. */
  manifestPath(skillName: string): string;
}

/** A skill found on disk, which may be one this build no longer ships. */
export interface InstalledSkill {
  readonly name: string;
  readonly directory: string;
  /** Marker-bearing paths: the ones Heimdall wrote and may remove. */
  readonly files: readonly string[];
  /** Everything else in the directory. Never removed, and keeps the directory alive. */
  readonly kept: readonly string[];
  readonly version: string | undefined;
  /** Marked files but no marked manifest, so removal requires `force`. */
  readonly partial: boolean;
}
