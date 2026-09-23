import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const cliPath = resolve(process.cwd(), 'dist/index.js');

const install = ['skills', 'install', 'claude'];
const uninstall = ['skills', 'uninstall', 'claude'];
const list = ['skills', 'list', 'claude'];
const skillsRoot = join('.claude', 'skills');
const skillDir = join(skillsRoot, 'heimdall-workflows');

const workdir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'heimdall-uninstall-'));

// A skill from an older CLI that this build no longer ships — the case uninstall exists for.
const plantRetired = async (cwd: string, name = 'heimdall-retired'): Promise<string> => {
  const dir = join(cwd, skillsRoot, name);
  await mkdir(join(dir, 'references'), { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\n---\n\n<!-- heimdall-generated: v0.0.1 — installed by \`heimdall skills install\`. -->\nold\n`,
    'utf8'
  );
  await writeFile(
    join(dir, 'references', 'old.yaml'),
    '# heimdall-generated: v0.0.1\nold\n',
    'utf8'
  );

  return dir;
};

describe('heimdall skills uninstall', () => {
  it('removes an installed skill', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });

    const result = await execa('node', [cliPath, ...uninstall, '--yes'], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    await expect(readdir(join(cwd, skillDir))).rejects.toThrow();
  });

  // The acceptance test for the whole feature: if only the bundled skill goes, the
  // implementation has regressed to being catalog-driven.
  it('removes a skill this build has never heard of', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    const retired = await plantRetired(cwd);

    const result = await execa('node', [cliPath, ...uninstall, '--yes'], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    await expect(readdir(retired)).rejects.toThrow();
    await expect(readdir(join(cwd, skillDir))).rejects.toThrow();
  });

  it('keeps a file the user added, and its directory', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    const mine = join(cwd, skillDir, 'references', 'mine.md');
    await writeFile(mine, 'my own notes', 'utf8');

    const result = await execa('node', [cliPath, ...uninstall, '--yes'], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(await readFile(mine, 'utf8')).toBe('my own notes');
    expect(result.stderr).toContain('mine.md');
    await expect(readFile(join(cwd, skillDir, 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('never touches a skill directory that is not ours', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    const theirs = join(cwd, skillsRoot, 'someone-else');
    await mkdir(theirs, { recursive: true });
    await writeFile(join(theirs, 'SKILL.md'), 'not ours', 'utf8');

    await execa('node', [cliPath, ...uninstall, '--yes'], { cwd });

    expect(await readFile(join(theirs, 'SKILL.md'), 'utf8')).toBe('not ours');
  });

  it('removes nothing on --dry-run', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });

    const result = await execa('node', [cliPath, ...uninstall, '--dry-run'], {
      cwd,
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Would remove');
    expect(await readFile(join(cwd, skillDir, 'SKILL.md'), 'utf8')).toContain('Heimdall');
  });

  it('refuses without a TTY and without --yes', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });

    const result = await execa('node', [cliPath, ...uninstall], { cwd, reject: false });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('--yes');
    // Nothing removed: a refusal to confirm is not a licence to act.
    expect(await readFile(join(cwd, skillDir, 'SKILL.md'), 'utf8')).toContain('Heimdall');
  });

  it('exits 0 when nothing is installed', async () => {
    const cwd = await workdir();

    const result = await execa('node', [cliPath, ...uninstall, '--yes'], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('No Heimdall skills installed');
  });

  it('is idempotent', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    await execa('node', [cliPath, ...uninstall, '--yes'], { cwd });

    const result = await execa('node', [cliPath, ...uninstall, '--yes'], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
  });

  it('reports removals and kept files as JSON on stdout only', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    await writeFile(join(cwd, skillDir, 'references', 'mine.md'), 'mine', 'utf8');

    const result = await execa('node', [cliPath, ...uninstall, '--yes', '--json'], {
      cwd,
      reject: false,
    });
    const parsed = JSON.parse(result.stdout) as { removed: string[]; kept: string[] };

    expect(result.exitCode).toBe(0);
    expect(parsed.removed.length).toBeGreaterThan(0);
    expect(parsed.kept).toHaveLength(1);
  });

  it('refuses a partial install without --force and removes it with one', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    // Simulates an interrupted write, or a manifest the user deleted by hand.
    await execa('rm', [join(cwd, skillDir, 'SKILL.md')]);

    const refused = await execa('node', [cliPath, ...uninstall, '--yes'], { cwd, reject: false });

    expect(refused.exitCode).toBe(7);
    expect(refused.stderr).toContain('--force');

    const forced = await execa('node', [cliPath, ...uninstall, '--yes', '--force'], {
      cwd,
      reject: false,
    });

    expect(forced.exitCode).toBe(0);
    await expect(readdir(join(cwd, skillDir))).rejects.toThrow();
  });
});

describe('heimdall skills list', () => {
  it('lists an installed skill with the version that wrote it', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });

    const result = await execa('node', [cliPath, ...list], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('heimdall-workflows');
    expect(result.stdout).toMatch(/v\d+\.\d+\.\d+/);
  });

  it.each(['opencode', 'codex'] as const)('lists what %s has installed', async (platform) => {
    const cwd = await workdir();
    await execa('node', [cliPath, 'skills', 'install', platform], { cwd });

    const result = await execa('node', [cliPath, 'skills', 'list', platform], {
      cwd,
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('heimdall-workflows');
  });

  it('reports nothing for a platform that has no install', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, 'skills', 'install', 'claude'], { cwd });

    const result = await execa('node', [cliPath, 'skills', 'list', 'codex'], {
      cwd,
      reject: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No Heimdall skills installed');
  });

  it('lists a skill this build no longer ships', async () => {
    const cwd = await workdir();
    await plantRetired(cwd);

    const result = await execa('node', [cliPath, ...list], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('heimdall-retired');
  });

  it('says so when nothing is installed', async () => {
    const cwd = await workdir();

    const result = await execa('node', [cliPath, ...list], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No Heimdall skills installed');
  });

  it('reports the same skills uninstall would act on', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    await plantRetired(cwd);

    const listed = await execa('node', [cliPath, ...list, '--json'], { cwd });
    const planned = await execa('node', [cliPath, ...uninstall, '--dry-run', '--json'], { cwd });

    const listedNames = (JSON.parse(listed.stdout) as { skills: { name: string }[] }).skills
      .map((skill) => skill.name)
      .sort();
    const plannedNames = (JSON.parse(planned.stdout) as { skills: string[] }).skills.sort();

    expect(listedNames).toEqual(plannedNames);
  });

  it('does not write anything', async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, ...install], { cwd });
    const before = await readdir(join(cwd, skillDir));

    await execa('node', [cliPath, ...list], { cwd });

    expect(await readdir(join(cwd, skillDir))).toEqual(before);
  });

  it.each(['opencode', 'codex'] as const)(
    'uninstalls from .agents/skills for %s',
    async (platform) => {
      const cwd = await workdir();
      await execa('node', [cliPath, 'skills', 'install', platform], { cwd });

      const result = await execa('node', [cliPath, 'skills', 'uninstall', platform, '--yes'], {
        cwd,
        reject: false,
      });

      expect(result.exitCode).toBe(0);
      await expect(readdir(join(cwd, '.agents', 'skills', 'heimdall-workflows'))).rejects.toThrow();
    }
  );

  // Each platform owns its own root, so acting on one must leave the others alone.
  it("never removes another platform's install", async () => {
    const cwd = await workdir();
    await execa('node', [cliPath, 'skills', 'install', 'claude'], { cwd });
    await execa('node', [cliPath, 'skills', 'install', 'codex'], { cwd });

    await execa('node', [cliPath, 'skills', 'uninstall', 'codex', '--yes'], { cwd });

    expect(await readFile(join(cwd, skillDir, 'SKILL.md'), 'utf8')).toContain('Heimdall');
    await expect(readdir(join(cwd, '.agents', 'skills', 'heimdall-workflows'))).rejects.toThrow();
  });
});
