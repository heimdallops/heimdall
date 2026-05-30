import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../../../../../src/core/platform/claude/adapter.ts';

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(os.tmpdir(), 'heimdall-agent-cache-'));
  tempDirs.push(dir);

  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const writeAgent = async (
  dir: string,
  filename: string,
  rawContent: string,
  subdir?: string
): Promise<void> => {
  const agentsDir = join(dir, '.claude', 'agents');
  const targetDir = subdir ? join(agentsDir, subdir) : agentsDir;
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, filename), rawContent, 'utf8');
};

const validAgent = (name: string, body = '# body', extra = ''): string =>
  `---\nname: ${name}${extra ? `\n${extra}` : ''}\n---\n${body}`;

describe('agent cache', () => {
  it('contains one entry per valid named agent file', async () => {
    const cwd = await makeTempDir();
    await writeAgent(cwd, 'foo.md', validAgent('foo', 'foo body'));
    await writeAgent(cwd, 'bar.md', validAgent('bar', 'bar body'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.size).toBe(2);
    expect(adapter.agents.has('foo')).toBe(true);
    expect(adapter.agents.has('bar')).toBe(true);
  });

  it('stores the raw file contents for each entry', async () => {
    const cwd = await makeTempDir();
    const raw = validAgent('my-agent', 'hello world');
    await writeAgent(cwd, 'agent.md', raw);

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.get('my-agent')).toBe(raw);
  });

  it('collects entries from every .claude/agents/ directory along the walk', async () => {
    const fakeHome = await makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const projectDir = join(fakeHome, 'project');
    const cwd = join(projectDir, 'subdir');
    await mkdir(cwd, { recursive: true });

    await writeAgent(cwd, 'local.md', validAgent('local'));
    await writeAgent(projectDir, 'project.md', validAgent('project'));
    await writeAgent(fakeHome, 'global.md', validAgent('global'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('local')).toBe(true);
    expect(adapter.agents.has('project')).toBe(true);
    expect(adapter.agents.has('global')).toBe(true);
  });

  it('deeper directory wins on name collision', async () => {
    const fakeHome = await makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const projectDir = join(fakeHome, 'project');
    const cwd = join(projectDir, 'subdir');
    await mkdir(cwd, { recursive: true });

    await writeAgent(cwd, 'shared.md', validAgent('shared', 'local body'));
    await writeAgent(projectDir, 'shared.md', validAgent('shared', 'project body'));
    await writeAgent(fakeHome, 'shared.md', validAgent('shared', 'global body'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.get('shared')).toContain('local body');
  });

  it('does not include intermediate dirs when cwd is above home', async () => {
    const fakeHome = await makeTempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const cwd = join(fakeHome, '..');
    // agent placed at an intermediate level between cwd and home — must NOT appear in cache
    const intermediateCwd = join(cwd, '..');
    await writeAgent(intermediateCwd, 'noise.md', validAgent('noise'));
    await writeAgent(cwd, 'cwd-agent.md', validAgent('cwd-agent'));
    await writeAgent(fakeHome, 'home-agent.md', validAgent('home-agent'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('cwd-agent')).toBe(true);
    expect(adapter.agents.has('home-agent')).toBe(true);
    expect(adapter.agents.has('noise')).toBe(false);
  });

  it('lexicographically first file path wins within the same directory', async () => {
    const cwd = await makeTempDir();
    await writeAgent(cwd, 'aaa.md', validAgent('bot', 'aaa body'), 'alpha');
    await writeAgent(cwd, 'zzz.md', validAgent('bot', 'zzz body'), 'zeta');

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.get('bot')).toContain('aaa body');
  });

  it('skips files with unparseable YAML frontmatter without throwing', async () => {
    const cwd = await makeTempDir();
    await writeAgent(cwd, 'bad.md', '---\n: invalid: yaml: [\n---\nbody');
    await writeAgent(cwd, 'good.md', validAgent('good'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('good')).toBe(true);
    expect(adapter.agents.size).toBe(1);
  });

  it('skips files with no name field without throwing', async () => {
    const cwd = await makeTempDir();
    await writeAgent(cwd, 'noname.md', '---\nmodel: sonnet\n---\nbody');

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.size).toBe(0);
  });

  it('skips files where name is not a string', async () => {
    const cwd = await makeTempDir();
    await writeAgent(cwd, 'numname.md', '---\nname: 42\n---\nbody');

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.size).toBe(0);
  });

  it('skips an unreadable or missing .claude/agents/ directory without throwing', async () => {
    const cwd = await makeTempDir();
    // No .claude/agents/ created — directory simply doesn't exist

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.size).toBe(0);
  });

  it('skips a symlink that points outside the trusted base directory', async () => {
    const cwd = await makeTempDir();
    const outsideDir = await makeTempDir();
    const agentsDir = join(cwd, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });

    const outsideFile = join(outsideDir, 'escape.md');
    await writeFile(outsideFile, validAgent('escape'), 'utf8');
    await symlink(outsideFile, join(agentsDir, 'escape.md'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('escape')).toBe(false);
  });

  it('stores raw content so all frontmatter is available to parseAgent', async () => {
    const cwd = await makeTempDir();
    const raw = '---\nname: rich\nmodel: sonnet\ncustom_tag: hello\n---\nbody';
    await writeAgent(cwd, 'rich.md', raw);

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.get('rich')).toBe(raw);
  });
});
