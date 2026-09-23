import type { Platform } from '../platform/platform.ts';
import { createClaudeSkillTarget } from './targets/claude.ts';
import type { SkillTarget } from './types.ts';

export const createSkillTarget = (platform: Platform, version: string): SkillTarget => {
  switch (platform) {
    case 'claude':
      return createClaudeSkillTarget(version);
    default: {
      // Compile-time exhaustiveness: a new platform enum member fails to assign to never,
      // forcing a matching case above.
      const _exhaustive: never = platform;

      throw new Error(`Unsupported platform: ${String(_exhaustive)}`);
    }
  }
};
