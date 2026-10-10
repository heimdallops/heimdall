import type { CliContext } from '../../cli/context.ts';
import {
  CLI_VERSION,
  createSkillTarget,
  listSkills,
  type SkillPlatform,
  type SkillScope,
} from '../../core/skills/index.ts';
import { discoverInstalledSkills } from '../../services/skill-discovery.ts';
import { plannedRemovals, writeSkillFiles } from '../../services/skill-writer.ts';

export interface SkillsInstallInput {
  readonly platform: SkillPlatform;
  readonly scope: SkillScope;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export interface SkillsInstallResult {
  readonly platform: SkillPlatform;
  readonly scope: SkillScope;
  readonly skills: string[];
  readonly files: string[];
  /** Files a previous install wrote that this version no longer ships. */
  readonly removed: string[];
  readonly dryRun: boolean;
}

export const run = async (
  ctx: CliContext,
  input: SkillsInstallInput
): Promise<SkillsInstallResult> => {
  const skills = listSkills();
  const target = createSkillTarget(input.platform, CLI_VERSION);
  const root = target.resolveRoot(input.scope, ctx.cwd);
  const files = skills.flatMap((skill) => target.render(skill));

  // Sweep before writing so the result is exactly what this version ships. Partial installs
  // are left alone: install should not destroy a directory it cannot also replace.
  const installed = await discoverInstalledSkills(root, target);
  const sweepable = installed.filter((skill) => !skill.partial);
  const partial = installed.filter((skill) => skill.partial);

  const { written, removed } = input.dryRun
    ? {
        written: files.map((file) => `${root}/${file.relativePath}`),
        removed: plannedRemovals(root, files, sweepable),
      }
    : await writeSkillFiles(root, files, input.force, sweepable);

  const result: SkillsInstallResult = {
    platform: input.platform,
    scope: input.scope,
    skills: skills.map((skill) => skill.name),
    files: written,
    removed,
    dryRun: input.dryRun,
  };

  if (ctx.config.json) {
    ctx.printer.out(JSON.stringify(result, null, 2));

    return result;
  }

  if (input.dryRun) {
    ctx.printer.info(`Would install ${skills.length} skill(s) for ${input.platform}:`);
  }

  for (const path of written) {
    ctx.printer.out(path);
  }

  if (removed.length > 0) {
    ctx.printer.info(
      input.dryRun
        ? `Would remove ${removed.length} file(s) this version no longer ships:`
        : `Removed ${removed.length} file(s) this version no longer ships:`
    );

    for (const path of removed) {
      ctx.printer.info(`  ${path}`);
    }
  }

  for (const skill of partial) {
    ctx.printer.warn(
      `${skill.directory} holds files Heimdall wrote but no generated SKILL.md; left in place. Run 'heimdall skills uninstall ${input.platform} --force' to remove it.`
    );
  }

  return result;
};
