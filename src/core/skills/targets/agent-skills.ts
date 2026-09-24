import { homedir } from 'node:os';
import { join, posix } from 'node:path';

import { markerText } from '../marker.ts';
import type { SkillPlatform } from '../platform.ts';
import type { Skill, SkillFile, SkillScope, SkillTarget } from '../types.ts';

const frontmatterValue = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * A target for the Agent Skills format: a directory per skill holding `SKILL.md` plus
 * `references/`, which every supported agent reads.
 *
 * The format is an open standard (agentskills.io), originally from Anthropic, so Claude
 * Code, OpenCode, and Codex all consume the same files — see `_docs/task-001/formats.md`.
 * The only thing that varies between them is which directory the skills live in, which is
 * why that is the sole constructor parameter.
 *
 * Frontmatter carries `name` and `description` and nothing else. That is the portable
 * subset: the spec requires both, OpenCode and Codex require both, and Claude Code's
 * extra fields (`allowed-tools`, `model`, `context`, …) sit outside the spec's allowlist,
 * so emitting any of them would make the skill less portable, not more capable.
 */
class AgentSkillsTarget implements SkillTarget {
  public readonly platform: SkillPlatform;

  // Parameter properties emit code, which `node --experimental-strip-types` (used by
  // `npm run dev`) rejects. Declare and assign instead.
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
        // Built from manifestPath so what render writes and what discovery looks for
        // cannot drift apart.
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

/**
 * OpenCode and Codex both read `.agents/skills` — the standard's tool-neutral location.
 * Codex reads only this one; OpenCode also scans `.claude/skills`, so a Claude install is
 * already visible to it. They are separate platform values because the user picks the agent
 * they are installing for, not the directory convention behind it.
 */
export const createAgentsDirSkillTarget = (platform: SkillPlatform, version: string): SkillTarget =>
  new AgentSkillsTarget(platform, version, ['.agents', 'skills']);
