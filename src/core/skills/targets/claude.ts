import { homedir } from 'node:os';
import { join, posix } from 'node:path';

import { markerText } from '../marker.ts';
import type { Skill, SkillFile, SkillScope, SkillTarget } from '../types.ts';

const frontmatterValue = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Claude Code loads skills from `<root>/.claude/skills/<name>/SKILL.md`, where the file's
 * frontmatter carries the name and description used to decide when the skill applies.
 */
class ClaudeSkillTarget implements SkillTarget {
  public readonly platform = 'claude' as const;

  // A parameter property would emit code, which `node --experimental-strip-types`
  // (used by `npm run dev`) rejects. Declare and assign instead.
  private readonly version: string;

  public constructor(version: string) {
    this.version = version;
  }

  public resolveRoot(scope: SkillScope, cwd: string): string {
    return join(scope === 'user' ? homedir() : cwd, '.claude', 'skills');
  }

  public manifestPath(skillName: string): string {
    return posix.join(skillName, 'SKILL.md');
  }

  public render(skill: Skill): SkillFile[] {
    const marker = markerText(this.version);

    const files: SkillFile[] = [
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

    for (const reference of skill.references) {
      files.push({
        relativePath: posix.join(skill.name, 'references', reference.path),
        // A leading `#` comment is valid YAML, so the marker rides along without changing
        // how the schema parses.
        contents: `# ${marker}\n${reference.contents}`,
      });
    }

    return files;
  }
}

export const createClaudeSkillTarget = (version: string): SkillTarget =>
  new ClaudeSkillTarget(version);
