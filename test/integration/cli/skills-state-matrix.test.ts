import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

/**
 * End-to-end coverage organised by the state the target directory is already in, because that
 * is what decides what each command does. The suites elsewhere are organised by mechanism —
 * markers, `--force`, `--dry-run` — which leaves the state matrix itself hard to read and its
 * gaps hard to see.
 *
 * Every test runs the built CLI in its own temporary directory and asserts the *whole*
 * observable outcome: exit code, the machine-readable result, and the resulting file tree.
 * A test that only checks the exit code would pass while the command quietly did the wrong
 * thing, which is exactly how a reinstall reporting phantom removals would have gone unnoticed.
 */

const cliPath = resolve(process.cwd(), 'dist/index.js');

/** What this build ships. The matrix is defined relative to it. */
const BUNDLED = ['heimdall-workflows'];

const ROOTS: Record<string, string> = {
  claude: join('.claude', 'skills'),
  opencode: join('.agents', 'skills'),
  codex: join('.agents', 'skills'),
};

// realpath because macOS hands back /var/... from mkdtemp while the CLI reports /private/var/...,
// which would make every relative-path comparison spuriously fail.
const workdir = async (): Promise<string> =>
  realpath(await mkdtemp(join(tmpdir(), 'heimdall-matrix-')));

interface Entry {
  readonly path: string;
  readonly contents: string;
}

/** Every file under the platform's skills root, relative and sorted, with contents. */
const tree = async (cwd: string, platform = 'claude'): Promise<Entry[]> => {
  const root = join(cwd, ROOTS[platform] ?? '');
  const { stdout } = await execa('bash', ['-c', `find . -type f 2>/dev/null | sort`], {
    cwd: root,
    reject: false,
  });

  const paths = stdout.split('\n').filter((line) => line.startsWith('./'));

  return Promise.all(
    paths.map(async (path) => ({
      path: path.slice(2),
      contents: await readFile(join(root, path), 'utf8'),
    }))
  );
};

const paths = (entries: Entry[]): string[] => entries.map((entry) => entry.path);

interface InstallResult {
  readonly skills: string[];
  readonly files: string[];
  readonly removed: string[];
}

interface UninstallResult {
  readonly skills: string[];
  readonly removed: string[];
  readonly kept: string[];
}

interface ListResult {
  readonly skills: { name: string; files: number; kept: number; partial: boolean }[];
}

const relativise = (cwd: string, absolute: string[], platform = 'claude'): string[] =>
  absolute
    .map((path) =>
      relative(join(cwd, ROOTS[platform] ?? ''), path)
        .split(sep)
        .join('/')
    )
    .sort();

const run = async (
  cwd: string,
  args: string[]
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> => {
  const result = await execa('node', [cliPath, ...args], { cwd, reject: false });

  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};

const runJson = async <T>(cwd: string, args: string[]): Promise<T> => {
  const result = await run(cwd, [...args, '--json']);

  expect(result.exitCode, result.stderr).toBe(0);

  return JSON.parse(result.stdout) as T;
};

/** A skill Heimdall installed: marker-bearing, so discovery claims it. */
const plantHeimdall = async (
  cwd: string,
  name: string,
  extra: Record<string, string> = {},
  platform = 'claude'
): Promise<void> => {
  const dir = join(cwd, ROOTS[platform] ?? '', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 'Planted by a previous version.'\n---\n\n<!-- heimdall-generated: v0.0.1 — installed by \`heimdall skills install\`. -->\n\nold body\n`,
    'utf8'
  );

  for (const [path, contents] of Object.entries(extra)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), contents, 'utf8');
  }
};

/** Someone else's skill: no marker, so Heimdall must never claim it. */
const plantForeign = async (cwd: string, name: string, platform = 'claude'): Promise<void> => {
  const dir = join(cwd, ROOTS[platform] ?? '', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\nnot ours\n`, 'utf8');
};

const FOREIGN = 'someone-elses-skill/SKILL.md';
const BUNDLED_FILES = BUNDLED.map((name) => `${name}/SKILL.md`);

describe('install — nothing installed yet', () => {
  it('installs the bundled set and reports no removals', async () => {
    const cwd = await workdir();

    const result = await runJson<InstallResult>(cwd, ['skills', 'install', 'claude']);

    expect(result.skills).toEqual(BUNDLED);
    expect(relativise(cwd, result.files)).toEqual(BUNDLED_FILES);
    expect(result.removed).toEqual([]);
    expect(paths(await tree(cwd))).toEqual(BUNDLED_FILES);
  });

  it('creates the skills root itself', async () => {
    const cwd = await workdir();

    await run(cwd, ['skills', 'install', 'claude']);

    expect(
      await readFile(join(cwd, ROOTS['claude'] ?? '', 'heimdall-workflows/SKILL.md'), 'utf8')
    ).toContain('name: heimdall-workflows');
  });
});

describe('install — the same set is already installed', () => {
  it('is idempotent: the tree is byte-identical and nothing is reported removed', async () => {
    const cwd = await workdir();
    await run(cwd, ['skills', 'install', 'claude']);
    const before = await tree(cwd);

    const result = await runJson<InstallResult>(cwd, ['skills', 'install', 'claude']);

    expect(result.removed).toEqual([]);
    expect(relativise(cwd, result.files)).toEqual(BUNDLED_FILES);
    expect(await tree(cwd)).toEqual(before);
  });

  it('reports the same result twice over', async () => {
    const cwd = await workdir();

    const first = await runJson<InstallResult>(cwd, ['skills', 'install', 'claude']);
    const second = await runJson<InstallResult>(cwd, ['skills', 'install', 'claude']);

    expect(second).toEqual(first);
  });

  it('needs no --force, because its own output carries the marker', async () => {
    const cwd = await workdir();
    await run(cwd, ['skills', 'install', 'claude']);

    const result = await run(cwd, ['skills', 'install', 'claude']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });
});

describe('install — skills are installed that do not match the current set', () => {
  it('removes a Heimdall skill this build no longer ships', async () => {
    const cwd = await workdir();
    await plantHeimdall(cwd, 'heimdall-retired');

    const result = await runJson<InstallResult>(cwd, ['skills', 'install', 'claude']);

    expect(relativise(cwd, result.removed)).toEqual(['heimdall-retired/SKILL.md']);
    expect(paths(await tree(cwd))).toEqual(BUNDLED_FILES);
  });

  it('removes files an older layout left inside a skill it still ships', async () => {
    const cwd = await workdir();
    await plantHeimdall(cwd, 'heimdall-workflows', {
      'references/workflow.yaml': '# heimdall-generated: v0.0.1\nold\n',
      'references/results/builtins.yaml': '# heimdall-generated: v0.0.1\nold\n',
    });

    const result = await runJson<InstallResult>(cwd, ['skills', 'install', 'claude']);

    expect(relativise(cwd, result.removed)).toEqual([
      'heimdall-workflows/references/results/builtins.yaml',
      'heimdall-workflows/references/workflow.yaml',
    ]);
    // Converges on exactly what this build ships — no empty directories left behind.
    expect(paths(await tree(cwd))).toEqual(BUNDLED_FILES);
  });

  it('handles a mix: one retired, one current, one not ours', async () => {
    const cwd = await workdir();
    await plantHeimdall(cwd, 'heimdall-retired');
    await plantHeimdall(cwd, 'heimdall-workflows', {
      'references/old.yaml': '# heimdall-generated: v0.0.1\n',
    });
    await plantForeign(cwd, 'someone-elses-skill');

    const result = await runJson<InstallResult>(cwd, ['skills', 'install', 'claude']);

    expect(relativise(cwd, result.removed)).toEqual([
      'heimdall-retired/SKILL.md',
      'heimdall-workflows/references/old.yaml',
    ]);
    expect(paths(await tree(cwd))).toEqual([...BUNDLED_FILES, FOREIGN].sort());
  });

  it('never touches a skill that is not ours', async () => {
    const cwd = await workdir();
    await plantForeign(cwd, 'someone-elses-skill');

    const result = await runJson<InstallResult>(cwd, ['skills', 'install', 'claude']);

    expect(result.removed).toEqual([]);
    expect(await readFile(join(cwd, ROOTS['claude'] ?? '', FOREIGN), 'utf8')).toContain('not ours');
  });

  it('keeps a retired skill alive when it holds a file the user added', async () => {
    const cwd = await workdir();
    await plantHeimdall(cwd, 'heimdall-retired', { 'notes.md': 'my own notes' });

    await run(cwd, ['skills', 'install', 'claude']);

    expect(paths(await tree(cwd))).toEqual([...BUNDLED_FILES, 'heimdall-retired/notes.md'].sort());
  });
});

describe('uninstall — nothing installed', () => {
  it('exits 0 and reports nothing', async () => {
    const cwd = await workdir();

    const result = await runJson<UninstallResult>(cwd, ['skills', 'uninstall', 'claude', '--yes']);

    expect(result.skills).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
  });

  it('says so in human output, without erroring', async () => {
    const cwd = await workdir();

    const result = await run(cwd, ['skills', 'uninstall', 'claude', '--yes']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No Heimdall skills installed');
  });

  it('is unaffected by a skill that is not ours', async () => {
    const cwd = await workdir();
    await plantForeign(cwd, 'someone-elses-skill');

    const result = await runJson<UninstallResult>(cwd, ['skills', 'uninstall', 'claude', '--yes']);

    expect(result.skills).toEqual([]);
    expect(paths(await tree(cwd))).toEqual([FOREIGN]);
  });
});

describe('uninstall — the installed set matches the current set', () => {
  it('removes everything and leaves the root empty', async () => {
    const cwd = await workdir();
    await run(cwd, ['skills', 'install', 'claude']);

    const result = await runJson<UninstallResult>(cwd, ['skills', 'uninstall', 'claude', '--yes']);

    expect(result.skills).toEqual(BUNDLED);
    expect(relativise(cwd, result.removed)).toEqual(BUNDLED_FILES);
    expect(result.kept).toEqual([]);
    expect(await tree(cwd)).toEqual([]);
  });

  it('is idempotent: a second run reports nothing left', async () => {
    const cwd = await workdir();
    await run(cwd, ['skills', 'install', 'claude']);
    await run(cwd, ['skills', 'uninstall', 'claude', '--yes']);

    const result = await runJson<UninstallResult>(cwd, ['skills', 'uninstall', 'claude', '--yes']);

    expect(result.removed).toEqual([]);
    expect(await tree(cwd)).toEqual([]);
  });
});

describe('uninstall — some installed skills match the current set and some do not', () => {
  it('removes both the current and the retired ones', async () => {
    const cwd = await workdir();
    await run(cwd, ['skills', 'install', 'claude']);
    await plantHeimdall(cwd, 'heimdall-retired');

    const result = await runJson<UninstallResult>(cwd, ['skills', 'uninstall', 'claude', '--yes']);

    expect(result.skills.sort()).toEqual(['heimdall-retired', ...BUNDLED].sort());
    expect(relativise(cwd, result.removed)).toEqual(
      ['heimdall-retired/SKILL.md', ...BUNDLED_FILES].sort()
    );
    expect(await tree(cwd)).toEqual([]);
  });

  it('removes ours and keeps what is not ours', async () => {
    const cwd = await workdir();
    await run(cwd, ['skills', 'install', 'claude']);
    await plantHeimdall(cwd, 'heimdall-retired');
    await plantForeign(cwd, 'someone-elses-skill');

    const result = await runJson<UninstallResult>(cwd, ['skills', 'uninstall', 'claude', '--yes']);

    expect(result.skills.sort()).toEqual(['heimdall-retired', ...BUNDLED].sort());
    expect(paths(await tree(cwd))).toEqual([FOREIGN]);
  });

  it('keeps a file the user added inside one of ours, and its directory', async () => {
    const cwd = await workdir();
    await run(cwd, ['skills', 'install', 'claude']);
    await plantHeimdall(cwd, 'heimdall-retired', { 'notes.md': 'my own notes' });

    const result = await runJson<UninstallResult>(cwd, ['skills', 'uninstall', 'claude', '--yes']);

    expect(relativise(cwd, result.kept)).toEqual(['heimdall-retired/notes.md']);
    expect(paths(await tree(cwd))).toEqual(['heimdall-retired/notes.md']);
  });
});

describe('list — across the same states', () => {
  it('reports nothing when nothing is installed', async () => {
    const cwd = await workdir();

    const result = await runJson<ListResult>(cwd, ['skills', 'list', 'claude']);

    expect(result.skills).toEqual([]);
  });

  it('reports the current set when it matches', async () => {
    const cwd = await workdir();
    await run(cwd, ['skills', 'install', 'claude']);

    const result = await runJson<ListResult>(cwd, ['skills', 'list', 'claude']);

    expect(result.skills.map((skill) => skill.name)).toEqual(BUNDLED);
    expect(result.skills[0]?.files).toBe(1);
    expect(result.skills[0]?.partial).toBe(false);
  });

  it('reports a mixed set, and agrees with what uninstall would remove', async () => {
    const cwd = await workdir();
    await run(cwd, ['skills', 'install', 'claude']);
    await plantHeimdall(cwd, 'heimdall-retired');
    await plantForeign(cwd, 'someone-elses-skill');

    const listed = await runJson<ListResult>(cwd, ['skills', 'list', 'claude']);
    const planned = await runJson<UninstallResult>(cwd, [
      'skills',
      'uninstall',
      'claude',
      '--dry-run',
    ]);

    // list must not report the foreign skill, and must agree with uninstall exactly — otherwise
    // the user is shown one set and a different set is acted on.
    expect(listed.skills.map((skill) => skill.name).sort()).toEqual(
      ['heimdall-retired', ...BUNDLED].sort()
    );
    expect(listed.skills.map((skill) => skill.name).sort()).toEqual(planned.skills.sort());
  });
});

describe('the matrix holds for every platform', () => {
  it.each(['claude', 'opencode', 'codex'] as const)(
    'install → list → uninstall round-trips for %s',
    async (platform) => {
      const cwd = await workdir();

      const installed = await runJson<InstallResult>(cwd, ['skills', 'install', platform]);
      expect(relativise(cwd, installed.files, platform)).toEqual(BUNDLED_FILES);

      const listed = await runJson<ListResult>(cwd, ['skills', 'list', platform]);
      expect(listed.skills.map((skill) => skill.name)).toEqual(BUNDLED);

      const removed = await runJson<UninstallResult>(cwd, [
        'skills',
        'uninstall',
        platform,
        '--yes',
      ]);
      expect(relativise(cwd, removed.removed, platform)).toEqual(BUNDLED_FILES);
      expect(await tree(cwd, platform)).toEqual([]);
    }
  );

  it('installing for one platform leaves another platform empty', async () => {
    const cwd = await workdir();

    await run(cwd, ['skills', 'install', 'claude']);

    expect(await tree(cwd, 'codex')).toEqual([]);
    expect(paths(await tree(cwd, 'claude'))).toEqual(BUNDLED_FILES);
  });
});
