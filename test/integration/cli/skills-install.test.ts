import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const cliPath = resolve(process.cwd(), 'dist/index.js');

const install = ['skills', 'install', 'claude'];
const skillMd = join('.claude', 'skills', 'heimdall-workflows', 'SKILL.md');
const workdir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'heimdall-skills-'));

const staleReference = join(
  '.claude',
  'skills',
  'heimdall-workflows',
  'references',
  'retired_node.yaml'
);

describe('heimdall skills install', () => {
  it('installs the skill into the project scope', async () => {
    const cwd = await workdir();

    const result = await execa('node', [cliPath, ...install], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(skillMd);
    expect(await readFile(join(cwd, skillMd), 'utf8')).toContain('name: heimdall-workflows');
  });

  it('installs exactly one file — the skill is self-contained', async () => {
    const cwd = await workdir();

    await execa('node', [cliPath, ...install], { cwd, reject: false });

    // The body carries its own field reference, so there is nothing beside it to fall out of
    // step with the engine.
    expect(await readdir(join(cwd, '.claude', 'skills', 'heimdall-workflows'))).toEqual([
      'SKILL.md',
    ]);
    expect(await readFile(join(cwd, skillMd), 'utf8')).toContain('## Field reference');
  });

  it('installs from a directory with no repo files nearby, proving content is bundled', async () => {
    // A regression to reading loose markdown from disk instead of the generated bundle fails
    // here, where nothing but the CLI itself is reachable.
    const cwd = await workdir();

    const result = await execa('node', [cliPath, ...install], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(cwd, skillMd), 'utf8')).toContain('Heimdall Workflows');
  });

  it('writes nothing on --dry-run', async () => {
    const cwd = await workdir();

    const result = await execa('node', [cliPath, ...install, '--dry-run'], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(skillMd);
    await expect(readFile(join(cwd, skillMd), 'utf8')).rejects.toThrow();
  });

  it('prints the result as JSON on stdout only', async () => {
    const cwd = await workdir();

    const result = await execa('node', [cliPath, ...install, '--json'], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');

    const parsed = JSON.parse(String(result.stdout)) as { platform: string; files: string[] };
    expect(parsed.platform).toBe('claude');
    expect(parsed.files.length).toBeGreaterThan(0);
  });

  it('reinstalls over its own previous output', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd, reject: false });

    const result = await execa('node', [cliPath, ...install], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
  });

  it('refuses to overwrite a hand-edited skill file', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd, reject: false });
    await writeFile(join(cwd, skillMd), 'my own notes', 'utf8');

    const result = await execa('node', [cliPath, ...install], { cwd, reject: false });

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Refusing to overwrite');
    expect(await readFile(join(cwd, skillMd), 'utf8')).toBe('my own notes');
  });

  it('overwrites a hand-edited skill file with --force', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd, reject: false });
    await writeFile(join(cwd, skillMd), 'my own notes', 'utf8');

    const result = await execa('node', [cliPath, ...install, '--force'], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(cwd, skillMd), 'utf8')).toContain('name: heimdall-workflows');
  });

  it('rejects an unsupported platform and names the supported ones', async () => {
    const result = await execa('node', [cliPath, 'skills', 'install', 'cursor'], {
      cwd: await workdir(),
      reject: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported platform "cursor"');
    expect(result.stderr).toContain('claude, opencode, codex');
  });

  it.each(['opencode', 'codex'] as const)(
    'installs into .agents/skills for %s',
    async (platform) => {
      const cwd = await workdir();

      const result = await execa('node', [cliPath, 'skills', 'install', platform], {
        cwd,
        reject: false,
      });

      expect(result.exitCode).toBe(0);
      expect(
        await readFile(join(cwd, '.agents/skills/heimdall-workflows/SKILL.md'), 'utf8')
      ).toContain('name: heimdall-workflows');
      // The agent that reads .agents/skills must not have its skill land in Claude's root.
      await expect(readFile(join(cwd, skillMd), 'utf8')).rejects.toThrow();
    }
  );

  it('writes byte-identical content for every platform', async () => {
    // Agent Skills is one open format; only the directory differs between agents.
    const read = async (platform: string, dir: string): Promise<string> => {
      const cwd = await workdir();
      await execa('node', [cliPath, 'skills', 'install', platform], { cwd });

      return readFile(join(cwd, dir, 'skills/heimdall-workflows/SKILL.md'), 'utf8');
    };

    const [claude, opencode, codex] = await Promise.all([
      read('claude', '.claude'),
      read('opencode', '.agents'),
      read('codex', '.agents'),
    ]);

    expect(opencode).toBe(claude);
    expect(codex).toBe(claude);
  });

  it("keeps each platform's install independent", async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, 'skills', 'install', 'claude'], { cwd });
    await execa('node', [cliPath, 'skills', 'install', 'codex'], { cwd });

    // Installing for one agent must not sweep another agent's root.
    expect(await readFile(join(cwd, skillMd), 'utf8')).toContain('Heimdall');
    expect(
      await readFile(join(cwd, '.agents/skills/heimdall-workflows/SKILL.md'), 'utf8')
    ).toContain('Heimdall');
  });

  it('rejects a missing platform argument', async () => {
    const result = await execa('node', [cliPath, 'skills', 'install'], {
      cwd: await workdir(),
      reject: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("missing required argument 'platform'");
  });

  it('rejects an unsupported scope', async () => {
    const result = await execa('node', [cliPath, ...install, '--scope', 'nonsense'], {
      cwd: await workdir(),
      reject: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported scope "nonsense"');
  });

  it('installs into the home directory for user scope', async () => {
    const cwd = await workdir();
    const home = await workdir();

    const result = await execa('node', [cliPath, ...install, '--scope', 'user'], {
      cwd,
      env: { HOME: home },
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(home, skillMd), 'utf8')).toContain('name: heimdall-workflows');
    await expect(readFile(join(cwd, skillMd), 'utf8')).rejects.toThrow();
  });

  it('suppresses diagnostics with --quiet', async () => {
    const result = await execa('node', [cliPath, ...install, '--quiet'], {
      cwd: await workdir(),
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  // A version that drops or renames a file would otherwise leave the old one behind carrying
  // the generated marker, where an agent would go on reading it as part of the skill.
  it('removes a stale file a previous version installed', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    await mkdir(join(cwd, '.claude', 'skills', 'heimdall-workflows', 'references'), {
      recursive: true,
    });
    await mkdir(join(cwd, '.claude', 'skills', 'heimdall-workflows', 'references'), {
      recursive: true,
    });
    await writeFile(
      join(cwd, staleReference),
      '# heimdall-generated: v0.0.1 — installed by `heimdall skills install`.\nretired',
      'utf8'
    );

    const result = await execa('node', [cliPath, ...install], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('retired_node.yaml');
    await expect(readFile(join(cwd, staleReference), 'utf8')).rejects.toThrow();
  });

  it('leaves a file it did not write alone', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    await mkdir(join(cwd, '.claude', 'skills', 'heimdall-workflows', 'references'), {
      recursive: true,
    });
    const mine = join(cwd, '.claude', 'skills', 'heimdall-workflows', 'references', 'mine.md');
    await writeFile(mine, 'my own notes', 'utf8');

    const result = await execa('node', [cliPath, ...install], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(await readFile(mine, 'utf8')).toBe('my own notes');
  });

  it('reports a stale file on --dry-run without removing it', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    await mkdir(join(cwd, '.claude', 'skills', 'heimdall-workflows', 'references'), {
      recursive: true,
    });
    await mkdir(join(cwd, '.claude', 'skills', 'heimdall-workflows', 'references'), {
      recursive: true,
    });
    await writeFile(
      join(cwd, staleReference),
      '# heimdall-generated: v0.0.1 — installed by `heimdall skills install`.\nretired',
      'utf8'
    );

    const result = await execa('node', [cliPath, ...install, '--dry-run'], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Would remove');
    expect(await readFile(join(cwd, staleReference), 'utf8')).toContain('retired');
  });

  it('lists removals in the JSON result', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    await mkdir(join(cwd, '.claude', 'skills', 'heimdall-workflows', 'references'), {
      recursive: true,
    });
    await mkdir(join(cwd, '.claude', 'skills', 'heimdall-workflows', 'references'), {
      recursive: true,
    });
    await writeFile(
      join(cwd, staleReference),
      '# heimdall-generated: v0.0.1 — installed by `heimdall skills install`.\nretired',
      'utf8'
    );

    const result = await execa('node', [cliPath, ...install, '--json'], { cwd, reject: false });
    const parsed = JSON.parse(result.stdout) as { removed: string[] };

    expect(result.exitCode).toBe(0);
    expect(parsed.removed).toHaveLength(1);
    expect(parsed.removed[0]).toContain('retired_node.yaml');
  });

  // The gap the sweep closes: a whole skill this build no longer ships. Nothing derived from
  // the current render would ever visit its directory, so only disk-driven discovery finds it.
  it('removes a skill directory this version no longer ships', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    const retired = join(cwd, '.claude', 'skills', 'heimdall-retired');
    await mkdir(retired, { recursive: true });
    await writeFile(
      join(retired, 'SKILL.md'),
      '<!-- heimdall-generated: v0.0.1 — installed by `heimdall skills install`. -->\nold',
      'utf8'
    );

    const result = await execa('node', [cliPath, ...install], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('heimdall-retired');
    await expect(readFile(join(retired, 'SKILL.md'), 'utf8')).rejects.toThrow();
    // The skill this version does ship is installed as usual.
    expect(await readFile(join(cwd, skillMd), 'utf8')).toContain('Heimdall');
  });

  it('keeps a retired skill directory that holds a file you added', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    const retired = join(cwd, '.claude', 'skills', 'heimdall-retired');
    await mkdir(retired, { recursive: true });
    await writeFile(
      join(retired, 'SKILL.md'),
      '<!-- heimdall-generated: v0.0.1 — installed by `heimdall skills install`. -->\nold',
      'utf8'
    );
    await writeFile(join(retired, 'notes.md'), 'my own notes', 'utf8');

    await execa('node', [cliPath, ...install], { cwd });

    expect(await readFile(join(retired, 'notes.md'), 'utf8')).toBe('my own notes');
  });
});
