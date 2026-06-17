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

// Returns a temp cwd whose agent search cannot escape into real host
// directories. A `.git` marker bounds the upward walk at cwd (the git root is
// inclusive and terminal), and os.homedir() is pinned to a separate empty temp
// dir. Without this, the adapter walks up through shared ancestors of $TMPDIR
// (and scans the real ~/.claude/agents) and picks up stray host agent files,
// which breaks exact-count assertions. Use this for tests that exercise a
// single cwd; the walk/boundary tests build their own bounded trees instead.
const makeIsolatedCwd = async (): Promise<string> => {
  const base = await makeTempDir();
  await mkdir(join(base, '.git'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(await makeTempDir());

  return base;
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
    const cwd = await makeIsolatedCwd();
    await writeAgent(cwd, 'foo.md', validAgent('foo', 'foo body'));
    await writeAgent(cwd, 'bar.md', validAgent('bar', 'bar body'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.size).toBe(2);
    expect(adapter.agents.has('foo')).toBe(true);
    expect(adapter.agents.has('bar')).toBe(true);
  });

  it('stores the raw file contents for each entry', async () => {
    const cwd = await makeIsolatedCwd();
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
    await mkdir(join(projectDir, '.git'), { recursive: true });

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

  it('walks from cwd up to the git root (inclusive) and stops there — agents above the git root are not discovered', async () => {
    const root = await makeTempDir();
    const fakeHome = join(root, 'home');
    const gitRoot = join(root, 'workspace');
    const cwd = join(gitRoot, 'project');
    await mkdir(fakeHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(join(gitRoot, '.git'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await writeAgent(root, 'above-root-agent.md', validAgent('above-root-agent'));
    await writeAgent(gitRoot, 'git-root-agent.md', validAgent('git-root-agent'));
    await writeAgent(cwd, 'cwd-agent.md', validAgent('cwd-agent'));
    await writeAgent(fakeHome, 'home-agent.md', validAgent('home-agent'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('cwd-agent')).toBe(true);
    expect(adapter.agents.has('git-root-agent')).toBe(true);
    expect(adapter.agents.has('home-agent')).toBe(true);
    expect(adapter.agents.has('above-root-agent')).toBe(false);
  });

  it('a .git FILE (worktree form) at the git root is recognized as the boundary', async () => {
    const root = await makeTempDir();
    const fakeHome = join(root, 'home');
    const gitRoot = join(root, 'workspace');
    const cwd = join(gitRoot, 'project');
    await mkdir(fakeHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(gitRoot, '.git'), 'gitdir: /some/other/path/.git', 'utf8');
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await writeAgent(root, 'above-root-agent.md', validAgent('above-root-agent'));
    await writeAgent(gitRoot, 'git-root-agent.md', validAgent('git-root-agent'));
    await writeAgent(cwd, 'cwd-agent.md', validAgent('cwd-agent'));
    await writeAgent(fakeHome, 'home-agent.md', validAgent('home-agent'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('cwd-agent')).toBe(true);
    expect(adapter.agents.has('git-root-agent')).toBe(true);
    expect(adapter.agents.has('home-agent')).toBe(true);
    expect(adapter.agents.has('above-root-agent')).toBe(false);
  });

  it('without a git repo, walks up ancestor directories (not just cwd)', async () => {
    const root = await makeTempDir();
    const fakeHome = join(root, 'home');
    const workspace = join(root, 'workspace');
    const cwd = join(workspace, 'project');
    await mkdir(fakeHome, { recursive: true });
    await mkdir(cwd, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await writeAgent(root, 'root-agent.md', validAgent('root-agent'));
    await writeAgent(workspace, 'ancestor-agent.md', validAgent('ancestor-agent'));
    await writeAgent(cwd, 'cwd-agent.md', validAgent('cwd-agent'));
    await writeAgent(fakeHome, 'home-agent.md', validAgent('home-agent'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('cwd-agent')).toBe(true);
    expect(adapter.agents.has('ancestor-agent')).toBe(true);
    expect(adapter.agents.has('root-agent')).toBe(true);
    expect(adapter.agents.has('home-agent')).toBe(true);
  });

  it('under home with no git repo, walk stops at the home boundary — agents above home are not discovered', async () => {
    const root = await makeTempDir();
    const fakeHome = join(root, 'home');
    const projDir = join(fakeHome, 'proj');
    const cwd = join(projDir, 'a');
    await mkdir(cwd, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    await writeAgent(root, 'above-home-agent.md', validAgent('above-home-agent'));
    await writeAgent(fakeHome, 'home-agent.md', validAgent('home-agent'));
    await writeAgent(projDir, 'proj-agent.md', validAgent('proj-agent'));
    await writeAgent(cwd, 'cwd-agent.md', validAgent('cwd-agent'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('cwd-agent')).toBe(true);
    expect(adapter.agents.has('proj-agent')).toBe(true);
    expect(adapter.agents.has('home-agent')).toBe(true);
    expect(adapter.agents.has('above-home-agent')).toBe(false);
  });

  it('lexicographically first file path wins within the same directory', async () => {
    const cwd = await makeIsolatedCwd();
    await writeAgent(cwd, 'aaa.md', validAgent('bot', 'aaa body'), 'alpha');
    await writeAgent(cwd, 'zzz.md', validAgent('bot', 'zzz body'), 'zeta');

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.get('bot')).toContain('aaa body');
  });

  it('skips files with unparseable YAML frontmatter without throwing', async () => {
    const cwd = await makeIsolatedCwd();
    await writeAgent(cwd, 'bad.md', '---\n: invalid: yaml: [\n---\nbody');
    await writeAgent(cwd, 'good.md', validAgent('good'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('good')).toBe(true);
    expect(adapter.agents.size).toBe(1);
  });

  it('skips files with no name field without throwing', async () => {
    const cwd = await makeIsolatedCwd();
    await writeAgent(cwd, 'noname.md', '---\nmodel: sonnet\n---\nbody');

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.size).toBe(0);
  });

  it('skips files where name is not a string', async () => {
    const cwd = await makeIsolatedCwd();
    await writeAgent(cwd, 'numname.md', '---\nname: 42\n---\nbody');

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.size).toBe(0);
  });

  it('skips an unreadable or missing .claude/agents/ directory without throwing', async () => {
    const cwd = await makeIsolatedCwd();
    // No .claude/agents/ created — directory simply doesn't exist

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.size).toBe(0);
  });

  it('includes an agent via a symlink that targets a file outside .claude/agents/', async () => {
    const cwd = await makeIsolatedCwd();
    const outsideDir = await makeTempDir();
    const agentsDir = join(cwd, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });

    const outsideFile = join(outsideDir, 'escape.md');
    await writeFile(outsideFile, validAgent('escape'), 'utf8');
    await symlink(outsideFile, join(agentsDir, 'escape.md'));

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('escape')).toBe(true);
    expect(adapter.agents.get('escape')).toBe(validAgent('escape'));
  });

  it('stores raw content so all frontmatter is available to parseAgent', async () => {
    const cwd = await makeIsolatedCwd();
    const raw = '---\nname: rich\nmodel: sonnet\ncustom_tag: hello\n---\nbody';
    await writeAgent(cwd, 'rich.md', raw);

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.get('rich')).toBe(raw);
  });

  it('follows symlinked directories inside .claude/agents/ and recurses through them fully', async () => {
    const cwd = await makeIsolatedCwd();
    const outsideDir = await makeTempDir();

    await writeFile(join(outsideDir, 'external-agent.md'), validAgent('external-agent'), 'utf8');

    const nestedSubDir = join(outsideDir, 'sub');
    await mkdir(nestedSubDir, { recursive: true });
    await writeFile(join(nestedSubDir, 'nested-agent.md'), validAgent('nested-agent'), 'utf8');

    const agentsDir = join(cwd, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await symlink(outsideDir, join(agentsDir, 'linked-dir'));

    await writeFile(join(agentsDir, 'real.md'), validAgent('real'), 'utf8');

    const adapter = await ClaudeCodeAdapter.create(cwd);

    expect(adapter.agents.has('real')).toBe(true);
    expect(adapter.agents.has('external-agent')).toBe(true);
    expect(adapter.agents.has('nested-agent')).toBe(true);
  });

  it('completes without hanging when a symlinked directory creates a cycle back to an ancestor', async () => {
    const cwd = await makeIsolatedCwd();

    const agentsDir = join(cwd, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });

    await writeFile(join(agentsDir, 'real.md'), validAgent('real'), 'utf8');

    await symlink(agentsDir, join(agentsDir, 'cycle-link'));

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutGuard = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new Error(
            'ClaudeCodeAdapter.create did not terminate within 3000ms — cycle guard may be broken'
          )
        );
      }, 3000);
    });

    const adapter = await Promise.race([ClaudeCodeAdapter.create(cwd), timeoutGuard]);
    clearTimeout(timeoutHandle);

    expect(adapter.agents.size).toBe(1);
    expect(adapter.agents.has('real')).toBe(true);
  });
});
