import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../../../../../src/core/platform/claude/adapter.ts';
import { PlatformAgentNotFoundError } from '../../../../../src/core/platform/errors.ts';

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(os.tmpdir(), 'heimdall-find-agent-'));
  tempDirs.push(dir);

  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const createAgentFile = async (dir: string, name: string, subdir?: string): Promise<void> => {
  const agentsDir = join(dir, '.claude', 'agents');
  const targetDir = subdir ? join(agentsDir, subdir) : agentsDir;
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, `${name}.md`), `---\nname: ${name}\n---\n# ${name}\n`, 'utf8');
};

describe('findAgent', () => {
  it('returns the raw file contents for a known agent name', async () => {
    const cwd = await makeTempDir();
    await createAgentFile(cwd, 'my-agent');

    const adapter = await ClaudeCodeAdapter.create(cwd);
    const content = await adapter.findAgent('my-agent');

    expect(typeof content).toBe('string');
    expect(content).toContain('my-agent');
  });

  it('throws PlatformAgentNotFoundError when agent is not in the cache', async () => {
    const cwd = await makeTempDir();
    const fakeHome = await makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const adapter = await ClaudeCodeAdapter.create(cwd);
    await expect(adapter.findAgent('nonexistent')).rejects.toBeInstanceOf(
      PlatformAgentNotFoundError
    );
  });

  it('PlatformAgentNotFoundError carries the missing agent name and correct code', async () => {
    const cwd = await makeTempDir();
    const fakeHome = await makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const adapter = await ClaudeCodeAdapter.create(cwd);
    await expect(adapter.findAgent('missing')).rejects.toMatchObject({
      code: 'PLATFORM_AGENT_NOT_FOUND',
      agentName: 'missing',
    });
  });

  it('finds agent in home directory when not present under cwd', async () => {
    const cwd = await makeTempDir();
    const fakeHome = await makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    await createAgentFile(fakeHome, 'home-agent');

    const adapter = await ClaudeCodeAdapter.create(cwd);
    const content = await adapter.findAgent('home-agent');

    expect(content).toContain('home-agent');
  });

  it('returns cwd-level content when the same name exists in both cwd and home', async () => {
    const fakeHome = await makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const cwd = join(fakeHome, 'project');
    await mkdir(cwd, { recursive: true });
    await createAgentFile(cwd, 'shared');
    await createAgentFile(fakeHome, 'shared');

    const adapter = await ClaudeCodeAdapter.create(cwd);
    const content = await adapter.findAgent('shared');

    expect(content).toContain('# shared');
  });

  it('finds an agent in a subdirectory of .claude/agents/', async () => {
    const cwd = await makeTempDir();
    await createAgentFile(cwd, 'nested-agent', 'review');

    const adapter = await ClaudeCodeAdapter.create(cwd);
    const content = await adapter.findAgent('nested-agent');

    expect(content).toContain('nested-agent');
  });

  it('matches by frontmatter name regardless of filename', async () => {
    const cwd = await makeTempDir();
    const agentsDir = join(cwd, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'something-else.md'),
      `---\nname: my-tool\n---\n# tool\n`,
      'utf8'
    );

    const adapter = await ClaudeCodeAdapter.create(cwd);
    const content = await adapter.findAgent('my-tool');

    expect(content).toContain('my-tool');
  });

  it('skips files with no name frontmatter field', async () => {
    const cwd = await makeTempDir();
    const agentsDir = join(cwd, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'noname.md'), `# no frontmatter name\n`, 'utf8');

    const adapter = await ClaudeCodeAdapter.create(cwd);
    await expect(adapter.findAgent('noname')).rejects.toBeInstanceOf(PlatformAgentNotFoundError);
  });

  it('does not crawl intermediate dirs when cwd is above home', async () => {
    const fakeHome = await makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const cwd = join(fakeHome, '..');
    await createAgentFile(fakeHome, 'home-only-agent');
    await createAgentFile(cwd, 'cwd-agent');

    const adapter = await ClaudeCodeAdapter.create(cwd);

    await expect(adapter.findAgent('home-only-agent')).resolves.toContain('home-only-agent');
    await expect(adapter.findAgent('cwd-agent')).resolves.toContain('cwd-agent');
  });

  it('skips a symlink inside .claude/agents/ that points outside the base directory', async () => {
    const cwd = await makeTempDir();
    const outsideDir = await makeTempDir();
    const agentsDir = join(cwd, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });

    const outsideFile = join(outsideDir, 'secret.md');
    await writeFile(outsideFile, `---\nname: escape\n---\n# escape\n`, 'utf8');
    await symlink(outsideFile, join(agentsDir, 'escape.md'));

    const adapter = await ClaudeCodeAdapter.create(cwd);
    await expect(adapter.findAgent('escape')).rejects.toBeInstanceOf(PlatformAgentNotFoundError);
  });
});
