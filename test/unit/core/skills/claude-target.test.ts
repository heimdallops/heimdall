import { homedir } from 'node:os';
import { join } from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  createSkillTarget,
  hasGeneratedMarker,
  type Skill,
} from '../../../../src/core/skills/index.ts';

const skill: Skill = {
  name: 'demo-skill',
  description: "A description with an apostrophe: don't break the frontmatter.",
  body: '# Demo\n\nBody text.',
};

const target = createSkillTarget('claude', '9.9.9');

const frontmatter = (contents: string): Record<string, unknown> => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(contents);
  expect(match).not.toBeNull();

  return load(match?.[1] ?? '') as Record<string, unknown>;
};

describe('claude skill target', () => {
  it('resolves project scope against the given cwd', () => {
    expect(target.resolveRoot('project', '/repo')).toBe(join('/repo', '.claude', 'skills'));
  });

  it('resolves user scope against the home directory, ignoring cwd', () => {
    expect(target.resolveRoot('user', '/repo')).toBe(join(homedir(), '.claude', 'skills'));
  });

  it('renders a single SKILL.md under the skill name', () => {
    const paths = target.render(skill).map((file) => file.relativePath);

    expect(paths).toEqual(['demo-skill/SKILL.md']);
  });

  it('writes parseable frontmatter carrying the name and description', () => {
    const skillFile = target.render(skill).find((file) => file.relativePath.endsWith('SKILL.md'));
    const parsed = frontmatter(skillFile?.contents ?? '');

    expect(parsed['name']).toBe('demo-skill');
    expect(parsed['description']).toBe(skill.description);
  });

  it('keeps the authored body below the frontmatter', () => {
    const skillFile = target.render(skill).find((file) => file.relativePath.endsWith('SKILL.md'));

    expect(skillFile?.contents).toContain('# Demo\n\nBody text.');
  });

  it('stamps every rendered file with the generated marker', () => {
    for (const file of target.render(skill)) {
      expect(hasGeneratedMarker(file.contents)).toBe(true);
    }
  });

  it('renders identically on repeated calls, so render performs no I/O or mutation', () => {
    expect(target.render(skill)).toEqual(target.render(skill));
  });

  it('names the manifest that identifies an installed skill', () => {
    expect(target.manifestPath('demo')).toBe('demo/SKILL.md');
  });

  it('renders its manifest at exactly the path discovery looks for', () => {
    const rendered = target.render(skill).map((file) => file.relativePath);

    // Drift here would make a skill uninstallable: written to one path, sought at another.
    expect(rendered).toContain(target.manifestPath(skill.name));
  });
});
