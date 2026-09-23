import type { CliContext } from '../../cli/context.ts';
import type { Platform } from '../../core/platform/platform.ts';
import {
  CLI_VERSION,
  createSkillTarget,
  listSkills,
  type SkillScope,
} from '../../core/skills/index.ts';
import { writeSkillFiles } from '../../services/skill-writer.ts';

export interface SkillsInstallInput {
  readonly platform: Platform;
  readonly scope: SkillScope;
  readonly force: boolean;
  readonly dryRun: boolean;
}

export interface SkillsInstallResult {
  readonly platform: Platform;
  readonly scope: SkillScope;
  readonly skills: string[];
  readonly files: string[];
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

  const written = input.dryRun
    ? files.map((file) => `${root}/${file.relativePath}`)
    : await writeSkillFiles(root, files, input.force);

  const result: SkillsInstallResult = {
    platform: input.platform,
    scope: input.scope,
    skills: skills.map((skill) => skill.name),
    files: written,
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

  return result;
};
