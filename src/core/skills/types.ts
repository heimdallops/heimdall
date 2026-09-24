import type { SkillPlatform } from './platform.ts';

/** A skill as authored under `skills/`, independent of any platform's file layout. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

/** Where a skill is installed: alongside a project, or for the user across all projects. */
export type SkillScope = 'project' | 'user';

/** One file to write, positioned relative to the target's resolved root. */
export interface SkillFile {
  readonly relativePath: string;
  readonly contents: string;
}

/**
 * Owns placement and file shape for one platform — not the skill's content, which is
 * authored once and shared. Deliberately separate from `PlatformAdapter`: that interface
 * is about running prompts, and installing files is an unrelated concern.
 */
export interface SkillTarget {
  readonly platform: SkillPlatform;
  /** Absolute directory that rendered `relativePath`s are resolved against. */
  resolveRoot(scope: SkillScope, cwd: string): string;
  /** Pure — performs no I/O, so `--dry-run` is the same code path as a real install. */
  render(skill: Skill): SkillFile[];
  /**
   * Path, relative to the skills root, of the file whose presence and marker identify
   * `skillName` as installed by Heimdall. Pure — performs no I/O.
   *
   * This is what lets removal work without the catalog: a skill is recognized by what is
   * on disk, not by whether this build still ships it.
   */
  manifestPath(skillName: string): string;
}

/**
 * A skill found on disk rather than in the bundle.
 *
 * `files` are the marker-bearing paths — the ones Heimdall wrote and may remove. `kept`
 * are everything else in the directory: files the user added, which are never removed and
 * whose presence keeps the directory alive.
 */
export interface InstalledSkill {
  readonly name: string;
  readonly directory: string;
  readonly files: readonly string[];
  readonly kept: readonly string[];
  /** Version recorded in the manifest's marker, when it records one. */
  readonly version: string | undefined;
  /**
   * True when the directory holds marker-bearing files but no marker-bearing manifest —
   * an interrupted write, or a manifest deleted by hand. The evidence that the directory
   * is ours is weaker, so removal requires `force`.
   */
  readonly partial: boolean;
}
