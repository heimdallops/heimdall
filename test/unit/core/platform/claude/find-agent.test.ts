import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { findAgent } from '../../../../../src/core/platform/claude/find-agent.ts';
import { PlatformAgentNotFoundError } from '../../../../../src/core/platform/errors.ts';

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createAgentFile = async (dir: string, name: string): Promise<void> => {
  const agentsDir = join(dir, '.claude', 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, `${name}.md`), `# ${name}\n`, 'utf8');
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findAgent', () => {
  describe('bare name resolution', () => {
    it('finds agent in <cwd>/.claude/agents/<name>.md', async () => {
      const cwd = await makeTempDir();
      await createAgentFile(cwd, 'my-agent');

      const result = await findAgent('my-agent', cwd);

      expect(result).toBe(await realpath(join(cwd, '.claude', 'agents', 'my-agent.md')));
    });

    it('falls back to ~/.claude/agents/<name>.md when not in project', async () => {
      const cwd = await makeTempDir(); // no agents here
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      await createAgentFile(fakeHome, 'home-agent');

      const result = await findAgent('home-agent', cwd);

      expect(result).toBe(await realpath(join(fakeHome, '.claude', 'agents', 'home-agent.md')));
    });

    it('prefers project path over home path when both exist', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      await createAgentFile(cwd, 'shared-agent');
      await createAgentFile(fakeHome, 'shared-agent');

      const result = await findAgent('shared-agent', cwd);

      expect(result).toBe(await realpath(join(cwd, '.claude', 'agents', 'shared-agent.md')));
    });

    it('throws PlatformAgentNotFoundError when agent does not exist anywhere', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      await expect(findAgent('nonexistent-agent', cwd)).rejects.toBeInstanceOf(
        PlatformAgentNotFoundError
      );
    });

    it('PlatformAgentNotFoundError carries the missing agent name and correct code', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

      await expect(findAgent('missing', cwd)).rejects.toMatchObject({
        code: 'PLATFORM_AGENT_NOT_FOUND',
        agentName: 'missing',
      });
    });

    it('skips a symlink inside .claude/agents/ that points outside the trusted base directory', async () => {
      const cwd = await makeTempDir();
      const outsideDir = await makeTempDir();
      const agentsDir = join(cwd, '.claude', 'agents');
      await mkdir(agentsDir, { recursive: true });

      // Create a real file outside the trusted base
      const outsideFile = join(outsideDir, 'secret.md');
      await writeFile(outsideFile, '# secret\n', 'utf8');

      // Create a symlink inside agents/ pointing to that outside file
      await symlink(outsideFile, join(agentsDir, 'escape.md'));

      // findAgent should not return the symlink target — it must throw
      await expect(findAgent('escape', cwd)).rejects.toBeInstanceOf(PlatformAgentNotFoundError);
    });
  });

  describe('path-style names', () => {
    it('treats names containing "/" as a path and skips search', async () => {
      const cwd = await makeTempDir();
      await mkdir(join(cwd, 'custom'), { recursive: true });
      await writeFile(join(cwd, 'custom', 'agent.md'), '# custom\n', 'utf8');

      const result = await findAgent('custom/agent.md', cwd);

      // Relative path should resolve relative to cwd
      expect(result).toBe(`${cwd}/custom/agent.md`);
    });

    it('treats names starting with "." as a path and skips search', async () => {
      const cwd = await makeTempDir();
      await writeFile(join(cwd, 'agent.md'), '# dot agent\n', 'utf8');

      const result = await findAgent('./agent.md', cwd);

      expect(result).toBe(`${cwd}/agent.md`);
    });

    it('returns an absolute path unchanged when it starts with "/"', async () => {
      const cwd = await makeTempDir();
      const absPath = join(cwd, 'absolute-agent.md');
      await writeFile(absPath, '# abs\n', 'utf8');

      const result = await findAgent(absPath, cwd);

      expect(result).toBe(absPath);
    });

    it('resolves a relative path (with "/") correctly against cwd', async () => {
      const cwd = await makeTempDir();
      const subdir = join(cwd, 'agents');
      await mkdir(subdir, { recursive: true });
      await writeFile(join(subdir, 'special.md'), '# special\n', 'utf8');

      const result = await findAgent('agents/special.md', cwd);

      expect(result).toBe(`${cwd}/agents/special.md`);
    });
  });
});
