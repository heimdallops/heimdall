import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSkillTarget } from '../../../src/core/skills/index.ts';
import { markerText } from '../../../src/core/skills/marker.ts';
import { CliError } from '../../../src/errors/cli-error.ts';
import { discoverInstalledSkills } from '../../../src/services/skill-discovery.ts';
import { removeSkillFiles } from '../../../src/services/skill-writer.ts';

const target = createSkillTarget('claude', '1.0.0');

const makeRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'heimdall-skill-remove-'));

const seed = async (root: string, relativePath: string, contents: string): Promise<string> => {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');

  return path;
};

const marked = (version: string, body = 'x'): string => `<!-- ${markerText(version)} -->\n${body}`;

describe('removeSkillFiles', () => {
  it('removes the files and the directory that held them', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', marked('1.0.0'));
    await seed(root, 'demo/references/a.yaml', `# ${markerText('1.0.0')}\na`);

    const { removed } = await removeSkillFiles(await discoverInstalledSkills(root, target), false);

    expect(removed).toHaveLength(2);
    await expect(readdir(join(root, 'demo'))).rejects.toThrow();
    // The shared skills root itself survives — other tools keep their skills here.
    expect(await readdir(root)).toEqual([]);
  });

  it('removes a skill the bundle no longer ships', async () => {
    const root = await makeRoot();
    await seed(root, 'heimdall-retired-v1/SKILL.md', marked('0.0.1'));

    const { removed } = await removeSkillFiles(await discoverInstalledSkills(root, target), false);

    expect(removed).toHaveLength(1);
    await expect(readdir(join(root, 'heimdall-retired-v1'))).rejects.toThrow();
  });

  it('keeps a file the user added, and the directory with it', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', marked('1.0.0'));
    const mine = await seed(root, 'demo/notes.md', 'my own notes');

    const { removed, kept } = await removeSkillFiles(
      await discoverInstalledSkills(root, target),
      false
    );

    expect(removed).toEqual([join(root, 'demo/SKILL.md')]);
    expect(kept).toEqual([mine]);
    expect(await readFile(mine, 'utf8')).toBe('my own notes');
  });

  it('drops a nested directory emptied by the removal', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', marked('1.0.0'));
    await seed(root, 'demo/references/results/a.yaml', `# ${markerText('1.0.0')}\na`);

    await removeSkillFiles(await discoverInstalledSkills(root, target), false);

    await expect(readdir(join(root, 'demo/references'))).rejects.toThrow();
  });

  it('never touches a skill it did not identify as ours', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', marked('1.0.0'));
    const theirs = await seed(root, 'someone-else/SKILL.md', 'not ours');

    await removeSkillFiles(await discoverInstalledSkills(root, target), false);

    expect(await readFile(theirs, 'utf8')).toBe('not ours');
  });

  it('refuses a partial install without force', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/a.yaml', `# ${markerText('1.0.0')}\na`);

    const discovered = await discoverInstalledSkills(root, target);

    await expect(removeSkillFiles(discovered, false)).rejects.toThrow(CliError);
  });

  it('leaves everything in place when it refuses', async () => {
    const root = await makeRoot();
    const orphan = await seed(root, 'partial/references/a.yaml', `# ${markerText('1.0.0')}\na`);
    await seed(root, 'demo/SKILL.md', marked('1.0.0'));

    const discovered = await discoverInstalledSkills(root, target);

    await expect(removeSkillFiles(discovered, false)).rejects.toThrow();

    // The refusal precedes every deletion, so the healthy skill beside it is untouched too.
    expect(await readFile(orphan, 'utf8')).toContain('a');
    expect(await readFile(join(root, 'demo/SKILL.md'), 'utf8')).toContain('x');
  });

  it('reports a conflict exit code and stable error code for a partial install', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/a.yaml', `# ${markerText('1.0.0')}\na`);

    const discovered = await discoverInstalledSkills(root, target);

    await removeSkillFiles(discovered, false).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe('SKILL_PARTIAL_INSTALL');
      expect((error as CliError).exitCode).toBe(7);
    });

    expect.assertions(3);
  });

  it('removes a partial install when forced', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/a.yaml', `# ${markerText('1.0.0')}\na`);

    const { removed } = await removeSkillFiles(await discoverInstalledSkills(root, target), true);

    expect(removed).toHaveLength(1);
    await expect(readdir(join(root, 'demo'))).rejects.toThrow();
  });

  it('still keeps unmarked files when forced — force widens what is ours, not what dies', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/a.yaml', `# ${markerText('1.0.0')}\na`);
    const mine = await seed(root, 'demo/notes.md', 'my own notes');

    const { kept } = await removeSkillFiles(await discoverInstalledSkills(root, target), true);

    expect(kept).toEqual([mine]);
    expect(await readFile(mine, 'utf8')).toBe('my own notes');
  });

  it('removes nothing when nothing was discovered', async () => {
    expect(await removeSkillFiles([], false)).toEqual({ removed: [], kept: [] });
  });
});
