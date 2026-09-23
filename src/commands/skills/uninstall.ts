import { confirm } from '@inquirer/prompts';

import type { CliContext } from '../../cli/context.ts';
import type { Platform } from '../../core/platform/platform.ts';
import {
  CLI_VERSION,
  createSkillTarget,
  type InstalledSkill,
  type SkillScope,
} from '../../core/skills/index.ts';
import { CliError, EXIT_CODE } from '../../errors/cli-error.ts';
import { discoverInstalledSkills } from '../../services/skill-discovery.ts';
import { removeSkillFiles } from '../../services/skill-writer.ts';

export interface SkillsUninstallInput {
  readonly platform: Platform;
  readonly scope: SkillScope;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly yes: boolean;
}

export interface SkillsUninstallResult {
  readonly platform: Platform;
  readonly scope: SkillScope;
  readonly skills: string[];
  readonly removed: string[];
  /** Files left in place because Heimdall did not write them. */
  readonly kept: string[];
  readonly dryRun: boolean;
}

const describe = (skill: InstalledSkill): string => {
  const version = skill.version === undefined ? '' : ` (installed by v${skill.version})`;
  const partial = skill.partial ? ' [no generated SKILL.md]' : '';

  return `${skill.name}${version}${partial} — ${skill.files.length} file(s)`;
};

const empty = (input: SkillsUninstallInput, skills: string[] = []): SkillsUninstallResult => ({
  platform: input.platform,
  scope: input.scope,
  skills,
  removed: [],
  kept: [],
  dryRun: input.dryRun,
});

export const run = async (
  ctx: CliContext,
  input: SkillsUninstallInput
): Promise<SkillsUninstallResult> => {
  const target = createSkillTarget(input.platform, CLI_VERSION);
  const root = target.resolveRoot(input.scope, ctx.cwd);

  // Never consults the catalog: a skill renamed or retired since it was installed is absent
  // from the bundle, and that is exactly the skill that needs removing.
  const installed = await discoverInstalledSkills(root, target);

  if (installed.length === 0) {
    if (ctx.config.json) {
      ctx.printer.out(JSON.stringify(empty(input), null, 2));
    } else {
      ctx.printer.info(`No Heimdall skills installed for ${input.platform} in ${root}.`);
    }

    return empty(input);
  }

  const names = installed.map((skill) => skill.name);

  if (input.dryRun) {
    const result: SkillsUninstallResult = {
      platform: input.platform,
      scope: input.scope,
      skills: names,
      removed: installed.flatMap((skill) => skill.files),
      kept: installed.flatMap((skill) => skill.kept),
      dryRun: true,
    };

    if (ctx.config.json) {
      ctx.printer.out(JSON.stringify(result, null, 2));

      return result;
    }

    ctx.printer.info(`Would remove ${installed.length} skill(s) from ${root}:`);

    for (const skill of installed) {
      ctx.printer.info(`  ${describe(skill)}`);
    }

    for (const path of result.removed) {
      ctx.printer.out(path);
    }

    return result;
  }

  // Uninstall is the only thing this CLI does that destroys files it did not create in the
  // same run, so it asks first. --json and --dry-run never reach here.
  if (!input.yes) {
    if (process.stdin.isTTY !== true) {
      throw new CliError(
        `Refusing to remove ${installed.length} skill(s) without confirmation. Re-run with --yes to confirm, or --dry-run to see what would be removed.`,
        { code: 'SKILLS_UNINSTALL_NOT_CONFIRMED', exitCode: EXIT_CODE.USAGE }
      );
    }

    ctx.printer.info(`About to remove ${installed.length} skill(s) from ${root}:`);

    for (const skill of installed) {
      ctx.printer.info(`  ${describe(skill)}`);
    }

    if (!(await confirm({ message: 'Remove them?', default: false }))) {
      ctx.printer.info('Nothing removed.');

      return empty(input, names);
    }
  }

  const { removed, kept } = await removeSkillFiles(installed, input.force);

  const result: SkillsUninstallResult = {
    platform: input.platform,
    scope: input.scope,
    skills: names,
    removed,
    kept,
    dryRun: false,
  };

  if (ctx.config.json) {
    ctx.printer.out(JSON.stringify(result, null, 2));

    return result;
  }

  for (const path of removed) {
    ctx.printer.out(path);
  }

  // Said plainly rather than left implicit: the directory is still there, and why.
  if (kept.length > 0) {
    ctx.printer.info(`Kept ${kept.length} file(s) Heimdall did not write:`);

    for (const path of kept) {
      ctx.printer.info(`  ${path}`);
    }
  }

  ctx.printer.success(`Removed ${names.length} skill(s) for ${input.platform}.`);

  return result;
};
