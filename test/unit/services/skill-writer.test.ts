import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { InstalledSkill, SkillFile } from '../../../src/core/skills/index.ts';
import { markerText } from '../../../src/core/skills/marker.ts';
import { CliError } from '../../../src/errors/cli-error.ts';
import { plannedRemovals, writeSkillFiles } from '../../../src/services/skill-writer.ts';

const files: SkillFile[] = [
  { relativePath: 'demo/SKILL.md', contents: `<!-- ${markerText('1.0.0')} -->\nfresh` },
  { relativePath: 'demo/references/a.yaml', contents: `# ${markerText('1.0.0')}\nfresh` },
];

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'heimdall-skill-writer-'));
  roots.push(root);

  return root;
};

const seed = async (root: string, relativePath: string, contents: string): Promise<string> => {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');

  return path;
};

// Stands in for what discoverInstalledSkills returns, so the writer's rules are tested
// without dragging the filesystem scan into every case.
const installed = (
  root: string,
  name: string,
  marked: string[],
  kept: string[] = []
): InstalledSkill => ({
  name,
  directory: join(root, name),
  files: marked.map((path) => join(root, path)),
  kept: kept.map((path) => join(root, path)),
  version: '0.0.1',
  partial: false,
});

afterEach(() => {
  roots.length = 0;
});

describe('writeSkillFiles', () => {
  it('writes every file and returns absolute paths', async () => {
    const root = await makeRoot();

    const { written, removed } = await writeSkillFiles(root, files, false);

    expect(written).toEqual([join(root, 'demo/SKILL.md'), join(root, 'demo/references/a.yaml')]);
    expect(removed).toEqual([]);
    expect(await readFile(written[0] ?? '', 'utf8')).toContain('fresh');
  });

  it('creates nested directories that do not exist yet', async () => {
    const root = await makeRoot();

    await writeSkillFiles(root, files, false);

    expect(await readFile(join(root, 'demo/references/a.yaml'), 'utf8')).toContain('fresh');
  });

  it('overwrites a file that carries the generated marker', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', `<!-- ${markerText('0.0.1')} -->\nstale`);

    await writeSkillFiles(root, files, false);

    expect(await readFile(join(root, 'demo/SKILL.md'), 'utf8')).toContain('fresh');
  });

  it('refuses to overwrite a file without the marker', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', 'hand written');

    await expect(writeSkillFiles(root, files, false)).rejects.toThrow(CliError);
  });

  it('leaves the install untouched when it refuses', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', 'hand written');

    await expect(writeSkillFiles(root, files, false)).rejects.toThrow();

    // The refusal must come before any write, so a later file in the same batch is not
    // created behind a rejected one.
    expect(await readFile(join(root, 'demo/SKILL.md'), 'utf8')).toBe('hand written');
    await expect(readFile(join(root, 'demo/references/a.yaml'), 'utf8')).rejects.toThrow();
  });

  it('reports a conflict exit code and stable error code', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', 'hand written');

    await writeSkillFiles(root, files, false).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe('SKILL_FILE_NOT_GENERATED');
      expect((error as CliError).exitCode).toBe(7);
    });

    expect.assertions(3);
  });

  it('overwrites an unmarked file when forced', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/SKILL.md', 'hand written');

    await writeSkillFiles(root, files, true);

    expect(await readFile(join(root, 'demo/SKILL.md'), 'utf8')).toContain('fresh');
  });
});

describe('writeSkillFiles — sweeping what this version no longer ships', () => {
  it('removes a marked file the current render no longer produces', async () => {
    const root = await makeRoot();
    const stale = await seed(root, 'demo/references/gone.yaml', `# ${markerText('0.0.1')}\nold`);

    const { removed } = await writeSkillFiles(root, files, false, [
      installed(root, 'demo', ['demo/SKILL.md', 'demo/references/gone.yaml']),
    ]);

    expect(removed).toEqual([stale]);
    await expect(readFile(stale, 'utf8')).rejects.toThrow();
  });

  it('keeps every file the current render does produce', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/a.yaml', `# ${markerText('0.0.1')}\nold`);

    const { removed } = await writeSkillFiles(root, files, false, [
      installed(root, 'demo', ['demo/SKILL.md', 'demo/references/a.yaml']),
    ]);

    expect(removed).toEqual([]);
    expect(await readFile(join(root, 'demo/references/a.yaml'), 'utf8')).toContain('fresh');
  });

  // The gap the sweep exists to close: a whole skill dropped from the bundle. Its directory
  // is not in the render at all, so nothing derived from the render would ever visit it.
  it('removes a skill directory this version no longer ships at all', async () => {
    const root = await makeRoot();
    await seed(root, 'retired/SKILL.md', `<!-- ${markerText('0.0.1')} -->\nold`);
    const reference = await seed(root, 'retired/references/b.yaml', `# ${markerText('0.0.1')}\nb`);

    const { removed } = await writeSkillFiles(root, files, false, [
      installed(root, 'retired', ['retired/SKILL.md', 'retired/references/b.yaml']),
    ]);

    expect(removed).toContain(reference);
    await expect(readdir(join(root, 'retired'))).rejects.toThrow();
    // The skill this version does ship is installed as usual.
    expect(await readFile(join(root, 'demo/SKILL.md'), 'utf8')).toContain('fresh');
  });

  it('keeps a retired skill directory alive when it holds a file the user added', async () => {
    const root = await makeRoot();
    await seed(root, 'retired/SKILL.md', `<!-- ${markerText('0.0.1')} -->\nold`);
    const mine = await seed(root, 'retired/notes.md', 'my own notes');

    await writeSkillFiles(root, files, false, [
      installed(root, 'retired', ['retired/SKILL.md'], ['retired/notes.md']),
    ]);

    expect(await readFile(mine, 'utf8')).toBe('my own notes');
  });

  it('never removes a file outside a swept skill, even when marked', async () => {
    const root = await makeRoot();
    const other = await seed(root, 'other-skill/SKILL.md', `<!-- ${markerText('0.0.1')} -->\nold`);

    const { removed } = await writeSkillFiles(root, files, false, [
      installed(root, 'demo', ['demo/SKILL.md']),
    ]);

    expect(removed).toEqual([]);
    expect(await readFile(other, 'utf8')).toContain('old');
  });
});

describe('plannedRemovals', () => {
  it('reports what a real install would remove, touching nothing', async () => {
    const root = await makeRoot();
    const stale = await seed(root, 'demo/references/gone.yaml', `# ${markerText('0.0.1')}\nold`);

    // This is what --dry-run calls, so it must see the orphan and leave it on disk.
    const planned = plannedRemovals(root, files, [
      installed(root, 'demo', ['demo/SKILL.md', 'demo/references/gone.yaml']),
    ]);

    expect(planned).toEqual([stale]);
    expect(await readFile(stale, 'utf8')).toContain('old');
  });

  it('reports nothing when nothing is installed', async () => {
    const root = await makeRoot();

    expect(plannedRemovals(root, files, [])).toEqual([]);
  });

  it('matches what the write path actually removes', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/gone.yaml', `# ${markerText('0.0.1')}\nold`);
    const stale = [installed(root, 'demo', ['demo/SKILL.md', 'demo/references/gone.yaml'])];

    const planned = plannedRemovals(root, files, stale);
    const { removed } = await writeSkillFiles(root, files, false, stale);

    expect(removed).toEqual(planned);
  });
});
