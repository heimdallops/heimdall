import { homedir } from 'node:os';
import { join, posix } from 'node:path';

import { markerText } from '../marker.ts';
import type { SkillPlatform } from '../platform.ts';
import type { Skill, SkillFile, SkillScope, SkillTarget } from '../types.ts';

const frontmatterValue = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The Agent Skills format (agentskills.io), which every supported agent reads identically —
 * only the root directory varies, hence `rootSegments`. Frontmatter stays at `name` and
 * `description`: the portable subset every agent accepts.
 */
class AgentSkillsTarget implements SkillTarget {
  public readonly platform: SkillPlatform;

  // Not parameter properties: those emit code, which `npm run dev`'s type stripping rejects.
  private readonly version: string;
  private readonly rootSegments: readonly string[];

  public constructor(platform: SkillPlatform, version: string, rootSegments: readonly string[]) {
    this.platform = platform;
    this.version = version;
    this.rootSegments = rootSegments;
  }

  public resolveRoot(scope: SkillScope, cwd: string): string {
    return join(scope === 'user' ? homedir() : cwd, ...this.rootSegments);
  }

  public manifestPath(skillName: string): string {
    return posix.join(skillName, 'SKILL.md');
  }

  public render(skill: Skill): SkillFile[] {
    const marker = markerText(this.version);

    return [
      {
        // Shared with discovery, so what is written and what is looked for cannot diverge.
        relativePath: this.manifestPath(skill.name),
        contents: [
          '---',
          `name: ${skill.name}`,
          `description: ${frontmatterValue(skill.description)}`,
          '---',
          '',
          `<!-- ${marker} -->`,
          '',
          skill.body,
          '',
        ].join('\n'),
      },
    ];
  }
}

/** Claude Code reads `<root>/.claude/skills/<name>/SKILL.md`. */
export const createClaudeSkillTarget = (version: string): SkillTarget =>
  new AgentSkillsTarget('claude', version, ['.claude', 'skills']);

/** OpenCode and Codex both read `.agents/skills`, the standard's tool-neutral location. */
export const createAgentsDirSkillTarget = (platform: SkillPlatform, version: string): SkillTarget =>
  new AgentSkillsTarget(platform, version, ['.agents', 'skills']);
