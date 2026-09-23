import { describe, expect, it } from 'vitest';

import { platformSchema } from '../../../../src/core/platform/platform.ts';
import { createSkillTarget } from '../../../../src/core/skills/index.ts';

describe('skill target factory', () => {
  it('returns the claude target for the claude platform', () => {
    expect(createSkillTarget('claude', '1.0.0').platform).toBe('claude');
  });

  it('has a target for every supported platform', () => {
    // The factory's `never` guard fails the build when a platform is added without a case;
    // this catches the same gap at runtime for anything that reaches it dynamically.
    for (const platform of platformSchema.options) {
      expect(createSkillTarget(platform, '1.0.0').platform).toBe(platform);
    }
  });

  it('throws for a platform outside the enum', () => {
    expect(() => createSkillTarget('opencode' as 'claude', '1.0.0')).toThrow(
      /Unsupported platform/
    );
  });
});
