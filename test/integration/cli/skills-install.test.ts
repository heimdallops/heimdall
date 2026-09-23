import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const cliPath = resolve(process.cwd(), 'dist/index.js');

const install = ['skills', 'install', 'claude'];
const skillMd = join('.claude', 'skills', 'heimdall-workflows', 'SKILL.md');
const referenceYaml = join(
  '.claude',
  'skills',
  'heimdall-workflows',
  'references',
  'workflow.yaml'
);

const workdir = async (): Promise<string> => mkdtemp(join(tmpdir(), 'heimdall-skills-'));

describe('heimdall skills install', () => {
  it('installs the skill into the project scope', async () => {
    const cwd = await workdir();

    const result = await execa('node', [cliPath, ...install], { cwd, reject: false });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(skillMd);
    expect(await readFile(join(cwd, skillMd), 'utf8')).toContain('name: heimdall-workflows');
  });

  it('installs the bundled schema references alongside the skill', async () => {
    const cwd = await workdir();

    await execa('node', [cliPath, ...install], { cwd, reject: false });

    expect(await readFile(join(cwd, referenceYaml), 'utf8')).toContain(
      'Root schema for a Heimdall workflow definition'
    );
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

    expect(result.exitCode).toBe(5);
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
    const result = await execa('node', [cliPath, 'skills', 'install', 'opencode'], {
      cwd: await workdir(),
      reject: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Unsupported platform "opencode"');
    expect(result.stderr).toContain('claude');
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
});
