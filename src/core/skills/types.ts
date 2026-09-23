import type { Platform } from '../platform/platform.ts';

/** A supporting file installed alongside the skill body, e.g. a JSON Schema. */
export interface SkillReference {
  /** Path relative to the installed skill's own directory. */
  readonly path: string;
  readonly contents: string;
}

/** A skill as authored under `skills/`, independent of any platform's file layout. */
export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly references: readonly SkillReference[];
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
  readonly platform: Platform;
  /** Absolute directory that rendered `relativePath`s are resolved against. */
  resolveRoot(scope: SkillScope, cwd: string): string;
  /** Pure — performs no I/O, so `--dry-run` is the same code path as a real install. */
  render(skill: Skill): SkillFile[];
}
