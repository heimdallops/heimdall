import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SkillFile } from '../../../src/core/skills/index.ts';
import { markerText } from '../../../src/core/skills/marker.ts';
import { CliError } from '../../../src/errors/cli-error.ts';
import { writeSkillFiles } from '../../../src/services/skill-writer.ts';

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

afterEach(() => {
  roots.length = 0;
});

describe('writeSkillFiles', () => {
  it('writes every file and returns absolute paths', async () => {
    const root = await makeRoot();

    const written = await writeSkillFiles(root, files, false);

    expect(written).toEqual([join(root, 'demo/SKILL.md'), join(root, 'demo/references/a.yaml')]);
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
