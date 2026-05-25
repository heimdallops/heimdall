import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { findAgent } from '../../../../../src/core/platform/claude/find-agent.ts';
import { PlatformAgentNotFoundError } from '../../../../../src/core/platform/errors.ts';

// We intercept os.homedir so home-directory resolution is deterministic in tests.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();

  return {
    ...actual,
    default: {
      ...actual,
      homedir: vi.fn(() => actual.homedir()),
    },
  };
});

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'heimdall-find-agent-'));
  tempDirs.push(dir);

  return dir;
};

const createAgentFile = async (dir: string, name: string): Promise<string> => {
  const agentsDir = path.join(dir, '.claude', 'agents');
  await mkdir(agentsDir, { recursive: true });
  const filePath = path.join(agentsDir, `${name}.md`);
  await writeFile(filePath, `# ${name}\nAgent prompt.`, 'utf8');

  return filePath;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('findAgent', () => {
  describe('bare name — project-local search', () => {
    it('returns absolute path when agent exists in <cwd>/.claude/agents/<name>.md', async () => {
      const cwd = await makeTempDir();
      await createAgentFile(cwd, 'my-agent');

      const result = await findAgent('my-agent', cwd);

      const expected = await realpath(path.join(cwd, '.claude', 'agents', 'my-agent.md'));
      expect(result).toBe(expected);
    });
  });

  describe('bare name — home directory fallback', () => {
    it('returns absolute path when agent exists only in ~/.claude/agents/<name>.md', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();

      vi.mocked(os.homedir).mockReturnValue(fakeHome);

      const agentsDir = path.join(fakeHome, '.claude', 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(path.join(agentsDir, 'home-agent.md'), '# home-agent', 'utf8');

      const result = await findAgent('home-agent', cwd);

      const expected = await realpath(path.join(fakeHome, '.claude', 'agents', 'home-agent.md'));
      expect(result).toBe(expected);
    });
  });

  describe('priority: project takes precedence over home', () => {
    it('returns the project path when both project and home paths exist', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();

      vi.mocked(os.homedir).mockReturnValue(fakeHome);

      await createAgentFile(cwd, 'shared-agent');

      const homeAgentsDir = path.join(fakeHome, '.claude', 'agents');
      await mkdir(homeAgentsDir, { recursive: true });
      await writeFile(path.join(homeAgentsDir, 'shared-agent.md'), '# home version', 'utf8');

      const result = await findAgent('shared-agent', cwd);

      const expected = await realpath(path.join(cwd, '.claude', 'agents', 'shared-agent.md'));
      expect(result).toBe(expected);
    });
  });

  describe('not found', () => {
    it('throws PlatformAgentNotFoundError when the agent does not exist in either location', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();

      vi.mocked(os.homedir).mockReturnValue(fakeHome);

      await expect(findAgent('missing-agent', cwd)).rejects.toThrow(PlatformAgentNotFoundError);
    });

    it('includes the agent name in the error', async () => {
      const cwd = await makeTempDir();
      const fakeHome = await makeTempDir();

      vi.mocked(os.homedir).mockReturnValue(fakeHome);

      let thrown: unknown;
      try {
        await findAgent('missing-agent', cwd);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(PlatformAgentNotFoundError);
      expect((thrown as PlatformAgentNotFoundError).agentName).toBe('missing-agent');
    });
  });

  describe('path-like names — direct resolution (no search)', () => {
    it('resolves a name containing "/" as a direct path relative to cwd', async () => {
      const cwd = await makeTempDir();
      const subdir = path.join(cwd, 'subdir');
      await mkdir(subdir, { recursive: true });
      await writeFile(path.join(subdir, 'agent.md'), '# agent', 'utf8');

      const result = await findAgent('subdir/agent.md', cwd);

      const expected = await realpath(path.join(cwd, 'subdir', 'agent.md'));
      expect(result).toBe(expected);
    });

    it('resolves a name starting with "." as a direct path relative to cwd', async () => {
      const cwd = await makeTempDir();
      await writeFile(path.join(cwd, 'local-agent.md'), '# local', 'utf8');

      const result = await findAgent('./local-agent.md', cwd);

      const expected = await realpath(path.join(cwd, 'local-agent.md'));
      expect(result).toBe(expected);
    });

    it('throws PlatformAgentNotFoundError for a path that traverses outside cwd and home', async () => {
      // The bounds check rejects paths that resolve outside both cwd and os.homedir().
      // A path like ../sibling/agent.md from cwd=parent/child resolves to parent/sibling/agent.md,
      // which is not within cwd (parent/child) or os.homedir().
      const parent = await makeTempDir();
      const cwd = path.join(parent, 'child');
      await mkdir(cwd);
      const fakeHome = await makeTempDir();
      vi.mocked(os.homedir).mockReturnValue(fakeHome);

      await expect(findAgent('../sibling/agent.md', cwd)).rejects.toThrow(
        PlatformAgentNotFoundError
      );
    });

    it('does not search .claude/agents for names containing "/"', async () => {
      const cwd = await makeTempDir();
      // Create a bare-name match in .claude/agents/ to confirm it is NOT consulted
      await createAgentFile(cwd, 'some');
      // Create the actual file the path-like name points to
      const subdir = path.join(cwd, 'some');
      await mkdir(subdir, { recursive: true });
      await writeFile(path.join(subdir, 'agent'), '# agent', 'utf8');

      const result = await findAgent('some/agent', cwd);

      const expected = await realpath(path.join(cwd, 'some', 'agent'));
      expect(result).toBe(expected);
      expect(result).not.toContain('.claude/agents');
    });
  });
});
