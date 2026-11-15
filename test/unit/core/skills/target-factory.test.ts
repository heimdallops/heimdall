import { describe, expect, it } from 'vitest';

import type { SkillPlatform } from '../../../../src/core/skills/index.ts';
import { createSkillTarget, skillPlatformSchema } from '../../../../src/core/skills/index.ts';

describe('skill target factory', () => {
  it('has a target for every supported platform', () => {
    // The factory's `never` guard fails the build when a platform is added without a case;
    // this catches the same gap at runtime for anything that reaches it dynamically.
    for (const platform of skillPlatformSchema.options) {
      expect(createSkillTarget(platform, '1.0.0').platform).toBe(platform);
    }
  });

  it('supports exactly claude, opencode, and codex', () => {
    expect([...skillPlatformSchema.options]).toEqual(['claude', 'opencode', 'codex']);
  });

  it('throws for a platform outside the enum', () => {
    expect(() => createSkillTarget('cursor' as SkillPlatform, '1.0.0')).toThrow(
      /Unsupported platform/
    );
  });
});

describe('skill roots per platform', () => {
  it.each([
    ['claude', '.claude'],
    ['opencode', '.agents'],
    ['codex', '.agents'],
  ] as const)('installs %s skills under %s/skills', (platform, dir) => {
    const root = createSkillTarget(platform, '1.0.0').resolveRoot('project', '/repo');

    expect(root).toBe(`/repo/${dir}/skills`);
  });

  // OpenCode and Codex read the standard's tool-neutral location, so one layout serves
  // both. They stay separate platform values because the user names the agent, not the
  // directory convention behind it.
  it('gives opencode and codex the same root', () => {
    const opencode = createSkillTarget('opencode', '1.0.0').resolveRoot('project', '/repo');
    const codex = createSkillTarget('codex', '1.0.0').resolveRoot('project', '/repo');

    expect(opencode).toBe(codex);
  });

  it('renders byte-identical files for every platform', () => {
    // The Agent Skills format is an open standard: only the root varies between agents.
    const skill = {
      name: 'demo',
      description: 'A demo skill.',
      body: '# Demo',
      references: [{ path: 'a.yaml', contents: 'name: a\n' }],
    };
    const rendered = skillPlatformSchema.options.map((platform) =>
      JSON.stringify(createSkillTarget(platform, '1.0.0').render(skill))
    );

    expect(new Set(rendered).size).toBe(1);
  });
});
