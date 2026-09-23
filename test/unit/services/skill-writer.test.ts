import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SkillFile } from '../../../src/core/skills/index.ts';
import { markerText } from '../../../src/core/skills/marker.ts';
import { CliError } from '../../../src/errors/cli-error.ts';
import { findOrphanedFiles, writeSkillFiles } from '../../../src/services/skill-writer.ts';

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

describe('writeSkillFiles — stale files from an earlier version', () => {
  // The case this exists for: a reference dropped or renamed between versions. It carries the
  // marker from the install that wrote it, so nothing else would ever flag it, while the skill
  // body presents references/ as authoritative.
  it('removes a marked file the current render no longer produces', async () => {
    const root = await makeRoot();
    const stale = await seed(root, 'demo/references/gone.yaml', `# ${markerText('0.0.1')}\nold`);

    const { removed } = await writeSkillFiles(root, files, false);

    expect(removed).toEqual([stale]);
    await expect(readFile(stale, 'utf8')).rejects.toThrow();
  });

  it('keeps every file the current render does produce', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/a.yaml', `# ${markerText('0.0.1')}\nold`);

    const { removed } = await writeSkillFiles(root, files, false);

    expect(removed).toEqual([]);
    expect(await readFile(join(root, 'demo/references/a.yaml'), 'utf8')).toContain('fresh');
  });

  it('leaves an unmarked file alone — the user put it there', async () => {
    const root = await makeRoot();
    const mine = await seed(root, 'demo/references/notes.md', 'my own notes');

    const { removed } = await writeSkillFiles(root, files, false);

    expect(removed).toEqual([]);
    expect(await readFile(mine, 'utf8')).toBe('my own notes');
  });

  it('leaves an unmarked file alone even when forced', async () => {
    const root = await makeRoot();
    const mine = await seed(root, 'demo/references/notes.md', 'my own notes');

    // force governs overwriting a user's edits at a path being written; it must not widen into
    // deleting files elsewhere in the directory.
    const { removed } = await writeSkillFiles(root, files, true);

    expect(removed).toEqual([]);
    expect(await readFile(mine, 'utf8')).toBe('my own notes');
  });

  it('never touches a sibling skill it does not own', async () => {
    const root = await makeRoot();
    // The skills root is shared: other tools and the user's own skills live beside this one.
    const other = await seed(root, 'other-skill/SKILL.md', `<!-- ${markerText('0.0.1')} -->\nold`);

    const { removed } = await writeSkillFiles(root, files, false);

    expect(removed).toEqual([]);
    expect(await readFile(other, 'utf8')).toContain('old');
  });

  it('drops a directory left empty by the removal', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/legacy/old.yaml', `# ${markerText('0.0.1')}\nold`);

    await writeSkillFiles(root, files, false);

    await expect(readdir(join(root, 'demo/references/legacy'))).rejects.toThrow();
    // The skill's own directory survives even so.
    expect(await readFile(join(root, 'demo/SKILL.md'), 'utf8')).toContain('fresh');
  });

  it('converges on the current render when run twice', async () => {
    const root = await makeRoot();
    await seed(root, 'demo/references/gone.yaml', `# ${markerText('0.0.1')}\nold`);

    await writeSkillFiles(root, files, false);
    const second = await writeSkillFiles(root, files, false);

    expect(second.removed).toEqual([]);
    expect(await readdir(join(root, 'demo/references'))).toEqual(['a.yaml']);
  });
});

describe('findOrphanedFiles', () => {
  it('reports what a real install would remove, without removing it', async () => {
    const root = await makeRoot();
    const stale = await seed(root, 'demo/references/gone.yaml', `# ${markerText('0.0.1')}\nold`);

    // This is what --dry-run calls, so it must see the orphan and leave it on disk.
    expect(await findOrphanedFiles(root, files)).toEqual([stale]);
    expect(await readFile(stale, 'utf8')).toContain('old');
  });

  it('reports nothing for a fresh install', async () => {
    const root = await makeRoot();

    expect(await findOrphanedFiles(root, files)).toEqual([]);
  });
});
