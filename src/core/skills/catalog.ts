import { CLI_VERSION, SKILL_BUNDLE } from './generated/bundle.ts';
import type { Skill } from './types.ts';

export { CLI_VERSION };

/** The skills compiled into this binary by `scripts/generate-skills.js`. */
export const listSkills = (): readonly Skill[] => {
  if (SKILL_BUNDLE.length === 0) {
    throw new Error('Skill bundle is empty — run `npm run generate:skills`.');
  }

  return SKILL_BUNDLE;
};
