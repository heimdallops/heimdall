import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSkillTarget } from '../../../src/core/skills/index.ts';
import { markerText } from '../../../src/core/skills/marker.ts';
import { discoverInstalledSkills } from '../../../src/services/skill-discovery.ts';

const target = createSkillTarget('claude', '1.0.0');

const makeRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'heimdall-skill-discovery-'));

const seed = async (root: string, relativePath: string, contents: string): Promise<string> => {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');

  return path;
};

const marked = (version: string, body = 'x'): string => `<!-- ${markerText(version)} -->\n${body}`;

describe('discoverInstalledSkills', () => {
  it('finds a skill by its marked manifest', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', marked('1.0.0'));
    await seed(root, 'demo/references/a.yaml', `# ${markerText('1.0.0')}\na`);

    const found = await discoverInstalledSkills(root, target);

    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('demo');
    expect(found[0]?.files).toHaveLength(2);
    expect(found[0]?.partial).toBe(false);
  });

  // The whole reason discovery is disk-driven: this name is not in the bundle and never will
  // be again, but the marker is still there, so it is still removable.
  it('finds a skill the bundle has never heard of', async () => {
    const root = await makeRoot();
    await seed(root, 'heimdall-retired-v1/SKILL.md', marked('0.0.1'));

    const found = await discoverInstalledSkills(root, target);

    expect(found.map((skill) => skill.name)).toEqual(['heimdall-retired-v1']);
  });

  it('reads back the version the install recorded', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', marked('0.3.1'));

    const found = await discoverInstalledSkills(root, target);

    expect(found[0]?.version).toBe('0.3.1');
  });

  it('ignores a directory with no marked file at all', async () => {
    const root = await makeRoot();
    await seed(root, 'someone-elses-skill/SKILL.md', 'hand written, not ours');

    expect(await discoverInstalledSkills(root, target)).toEqual([]);
  });

  it('separates files it wrote from files the user added', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', marked('1.0.0'));
    const mine = await seed(root, 'demo/notes.md', 'my own notes');

    const found = await discoverInstalledSkills(root, target);

    expect(found[0]?.kept).toEqual([mine]);
    expect(found[0]?.files).not.toContain(mine);
  });

  it('flags a directory with marked files but no marked manifest as partial', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/a.yaml', `# ${markerText('1.0.0')}\na`);

    const found = await discoverInstalledSkills(root, target);

    expect(found[0]?.partial).toBe(true);
    expect(found[0]?.version).toBeUndefined();
  });

  it('treats a hand-edited manifest as partial rather than claiming it', async () => {
    const root = await makeRoot();
    // The user stripped the marker from SKILL.md but the references still carry it.
    await seed(root, 'demo/SKILL.md', 'hand written');
    await seed(root, 'demo/references/a.yaml', `# ${markerText('1.0.0')}\na`);

    const found = await discoverInstalledSkills(root, target);

    expect(found[0]?.partial).toBe(true);
    expect(found[0]?.kept).toEqual([join(root, 'demo/SKILL.md')]);
  });

  it('returns nothing for a root that does not exist', async () => {
    expect(await discoverInstalledSkills(join(tmpdir(), 'heimdall-absent-root'), target)).toEqual(
      []
    );
  });

  it('ignores loose files sitting in the skills root', async () => {
    const root = await makeRoot();
    await seed(root, 'heimdall-workflows.zip', 'binary-ish');

    expect(await discoverInstalledSkills(root, target)).toEqual([]);
  });

  it('returns skills sorted by name', async () => {
    const root = await makeRoot();
    await seed(root, 'zebra/SKILL.md', marked('1.0.0'));
    await seed(root, 'alpha/SKILL.md', marked('1.0.0'));

    const found = await discoverInstalledSkills(root, target);

    expect(found.map((skill) => skill.name)).toEqual(['alpha', 'zebra']);
  });
});
