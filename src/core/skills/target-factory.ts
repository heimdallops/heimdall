import type { SkillPlatform } from './platform.ts';
import { createAgentsDirSkillTarget, createClaudeSkillTarget } from './targets/agent-skills.ts';
import type { SkillTarget } from './types.ts';

export const createSkillTarget = (platform: SkillPlatform, version: string): SkillTarget => {
  switch (platform) {
    case 'claude':
      return createClaudeSkillTarget(version);
    case 'opencode':
    case 'codex':
      return createAgentsDirSkillTarget(platform, version);
    default: {
      // Compile-time exhaustiveness: a new platform enum member fails to assign to never,
      // forcing a matching case above.
      const _exhaustive: never = platform;

      throw new Error(`Unsupported platform: ${String(_exhaustive)}`);
    }
  }
};
