import type { CliContext } from '../../cli/context.ts';
import {
  CLI_VERSION,
  createSkillTarget,
  type SkillPlatform,
  type SkillScope,
} from '../../core/skills/index.ts';
import { discoverInstalledSkills } from '../../services/skill-discovery.ts';

export interface SkillsListInput {
  readonly platform: SkillPlatform;
  readonly scope: SkillScope;
}

export interface SkillsListEntry {
  readonly name: string;
  readonly directory: string;
  readonly files: number;
  readonly kept: number;
  /** Version recorded by the install that wrote it; absent on a partial install. */
  readonly version: string | undefined;
  readonly partial: boolean;
}

export interface SkillsListResult {
  readonly platform: SkillPlatform;
  readonly scope: SkillScope;
  readonly root: string;
  readonly skills: SkillsListEntry[];
}

export const run = async (ctx: CliContext, input: SkillsListInput): Promise<SkillsListResult> => {
  const target = createSkillTarget(input.platform, CLI_VERSION);
  const root = target.resolveRoot(input.scope, ctx.cwd);

  // The same disk-driven discovery uninstall uses, so what list shows is exactly what
  // uninstall would act on — including a skill this build no longer ships.
  const installed = await discoverInstalledSkills(root, target);

  const result: SkillsListResult = {
    platform: input.platform,
    scope: input.scope,
    root,
    skills: installed.map((skill) => ({
      name: skill.name,
      directory: skill.directory,
      files: skill.files.length,
      kept: skill.kept.length,
      version: skill.version,
      partial: skill.partial,
    })),
  };

  if (ctx.config.json) {
    ctx.printer.out(JSON.stringify(result, null, 2));

    return result;
  }

  if (result.skills.length === 0) {
    ctx.printer.info(`No Heimdall skills installed for ${input.platform} in ${root}.`);

    return result;
  }

  for (const skill of result.skills) {
    const version = skill.version === undefined ? 'unknown version' : `v${skill.version}`;
    const kept = skill.kept > 0 ? `, ${skill.kept} kept` : '';
    const partial = skill.partial ? ' (partial install — no generated SKILL.md)' : '';

    ctx.printer.out(`${skill.name}  ${version}  ${skill.files} file(s)${kept}${partial}`);
  }

  return result;
};
