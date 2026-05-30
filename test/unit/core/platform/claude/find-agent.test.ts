import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  describe('bare name resolution', () => {
    it('finds agent in <cwd>/.claude/agents/<name>.md', async () => {
      const cwd = await makeTempDir();
      await createAgentFile(cwd, 'my-agent');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('my-agent');

      expect(result).toBe(await realpath(join(cwd, '.claude', 'agents', 'my-agent.md')));
    });

    it('falls back to ~/.claude/agents/<name>.md when not in project', async () => {
      const cwd = await makeTempDir(); // no agents here
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      await createAgentFile(fakeHome, 'home-agent');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('home-agent');

      expect(result).toBe(await realpath(join(fakeHome, '.claude', 'agents', 'home-agent.md')));
    });

    it('prefers project path over home path when both exist', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      await createAgentFile(cwd, 'shared-agent');
      await createAgentFile(fakeHome, 'shared-agent');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('shared-agent');

      expect(result).toBe(await realpath(join(cwd, '.claude', 'agents', 'shared-agent.md')));
    });

    it('throws PlatformAgentNotFoundError when agent does not exist anywhere', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      const adapter = new ClaudeCodeAdapter(cwd);
      await expect(adapter.findAgent('nonexistent-agent')).rejects.toBeInstanceOf(
        PlatformAgentNotFoundError
      );
    });

    it('PlatformAgentNotFoundError carries the missing agent name and correct code', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      const adapter = new ClaudeCodeAdapter(cwd);
      await expect(adapter.findAgent('missing')).rejects.toMatchObject({
        code: 'PLATFORM_AGENT_NOT_FOUND',
        agentName: 'missing',
      });
    });

    it('finds agent placed in an ancestor directory of cwd', async () => {
      // directory layout: fakeHome/project/subdir  (cwd = subdir, agent only in project)
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      const projectDir = join(fakeHome, 'project');
      const cwd = join(projectDir, 'subdir');
      await mkdir(cwd, { recursive: true });
      await createAgentFile(projectDir, 'ancestor-agent');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('ancestor-agent');

      expect(result).toBe(
        await realpath(join(projectDir, '.claude', 'agents', 'ancestor-agent.md'))
      );
    });

    it('prefers a closer ancestor over a farther one', async () => {
      // layout: fakeHome/parent/child  (cwd = child, agent in both parent and child)
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      const parentDir = join(fakeHome, 'parent');
      const childDir = join(parentDir, 'child');
      await mkdir(childDir, { recursive: true });
      await createAgentFile(parentDir, 'layered-agent');
      await createAgentFile(childDir, 'layered-agent');

      const adapter = new ClaudeCodeAdapter(childDir);
      const result = await adapter.findAgent('layered-agent');

      expect(result).toBe(await realpath(join(childDir, '.claude', 'agents', 'layered-agent.md')));
    });

    it('skips a symlink inside .claude/agents/ that points outside the trusted base directory', async () => {
      const cwd = await makeTempDir();
      const outsideDir = await makeTempDir();
      const agentsDir = join(cwd, '.claude', 'agents');
      await mkdir(agentsDir, { recursive: true });

      const outsideFile = join(outsideDir, 'secret.md');
      await writeFile(outsideFile, `---\nname: escape\n---\n# escape\n`, 'utf8');

      await symlink(outsideFile, join(agentsDir, 'escape.md'));

      const adapter = new ClaudeCodeAdapter(cwd);
      await expect(adapter.findAgent('escape')).rejects.toBeInstanceOf(PlatformAgentNotFoundError);
    });
  });

  describe('subdirectory resolution', () => {
    it('finds agent nested one level deep in .claude/agents/<subdir>/<name>.md', async () => {
      const cwd = await makeTempDir();
      await createAgentFile(cwd, 'nested-agent', 'review');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('nested-agent');

      expect(result).toBe(
        await realpath(join(cwd, '.claude', 'agents', 'review', 'nested-agent.md'))
      );
    });

    it('finds agent nested multiple levels deep', async () => {
      const cwd = await makeTempDir();
      await createAgentFile(cwd, 'deep-agent', 'a/b/c');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('deep-agent');

      expect(result).toBe(
        await realpath(join(cwd, '.claude', 'agents', 'a', 'b', 'c', 'deep-agent.md'))
      );
    });

    it('matches by frontmatter name regardless of filename', async () => {
      const cwd = await makeTempDir();
      const agentsDir = join(cwd, '.claude', 'agents', 'tools');
      await mkdir(agentsDir, { recursive: true });
      // filename differs from the name frontmatter field
      await writeFile(
        join(agentsDir, 'something-else.md'),
        `---\nname: my-tool\n---\n# tool\n`,
        'utf8'
      );

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('my-tool');

      expect(result).toBe(await realpath(join(agentsDir, 'something-else.md')));
    });

    it('skips files with no name frontmatter field', async () => {
      const cwd = await makeTempDir();
      const agentsDir = join(cwd, '.claude', 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, 'noname.md'), `# no frontmatter name\n`, 'utf8');

      const adapter = new ClaudeCodeAdapter(cwd);
      await expect(adapter.findAgent('noname')).rejects.toBeInstanceOf(PlatformAgentNotFoundError);
    });

    it('returns the lexicographically smallest real path when duplicate names exist in one scope', async () => {
      const cwd = await makeTempDir();
      const agentsDir = join(cwd, '.claude', 'agents');
      await mkdir(join(agentsDir, 'aaa'), { recursive: true });
      await mkdir(join(agentsDir, 'zzz'), { recursive: true });
      await writeFile(
        join(agentsDir, 'aaa', 'bot.md'),
        `---\nname: bot\n---\n# bot\n`,
        'utf8'
      );
      await writeFile(
        join(agentsDir, 'zzz', 'bot.md'),
        `---\nname: bot\n---\n# bot\n`,
        'utf8'
      );

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('bot');

      expect(result).toBe(await realpath(join(agentsDir, 'aaa', 'bot.md')));
    });

    it('subdirectory agent in closer ancestor scope wins over flat agent in farther scope', async () => {
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      const projectDir = join(fakeHome, 'project');
      const cwd = join(projectDir, 'subdir');
      await mkdir(cwd, { recursive: true });
      await createAgentFile(projectDir, 'shared', 'research');
      await createAgentFile(fakeHome, 'shared');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('shared');

      expect(result).toBe(
        await realpath(join(projectDir, '.claude', 'agents', 'research', 'shared.md'))
      );
    });
  });

  describe('path-style names', () => {
    it('treats names containing "/" as a path and skips search', async () => {
      const cwd = await makeTempDir();
      await mkdir(join(cwd, 'custom'), { recursive: true });
      await writeFile(join(cwd, 'custom', 'agent.md'), '# custom\n', 'utf8');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('custom/agent.md');

      expect(result).toBe(join(cwd, 'custom', 'agent.md'));
    });

    it('treats names starting with "." as a path and skips search', async () => {
      const cwd = await makeTempDir();
      await writeFile(join(cwd, 'agent.md'), '# dot agent\n', 'utf8');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('./agent.md');

      expect(result).toBe(join(cwd, 'agent.md'));
    });

    it('returns an absolute path unchanged when it starts with "/"', async () => {
      const cwd = await makeTempDir();
      const absPath = join(cwd, 'absolute-agent.md');
      await writeFile(absPath, '# abs\n', 'utf8');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent(absPath);

      expect(result).toBe(absPath);
    });

    it('resolves a relative path (with "/") correctly against cwd', async () => {
      const cwd = await makeTempDir();
      const subdir = join(cwd, 'agents');
      await mkdir(subdir, { recursive: true });
      await writeFile(join(subdir, 'special.md'), '# special\n', 'utf8');

      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('agents/special.md');

      expect(result).toBe(join(cwd, 'agents', 'special.md'));
    });

    it('returns resolved path without checking existence for a path-style name', async () => {
      // File does not exist — findAgent should still return the resolved path
      const cwd = await makeTempDir();
      const adapter = new ClaudeCodeAdapter(cwd);
      const result = await adapter.findAgent('does-not-exist/agent.md');
      expect(result).toBe(join(cwd, 'does-not-exist', 'agent.md'));
    });
  });
});
