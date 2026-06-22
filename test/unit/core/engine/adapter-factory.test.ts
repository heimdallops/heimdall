import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAdapter,
  createAdapterFactory,
} from '../../../../src/core/engine/adapter-factory.ts';
import type { PlatformAdapter } from '../../../../src/core/engine/nodes/base.ts';
import { PlatformAgentNotFoundError } from '../../../../src/core/platform/errors.ts';

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(os.tmpdir(), 'heimdall-adapter-factory-'));
  tempDirs.push(dir);

  return dir;
};

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Minimal fake adapter used in factory-behavior tests
// ---------------------------------------------------------------------------

const makeFakeAdapter = (): PlatformAdapter => ({
  run: vi.fn(),
  findAgent: vi.fn(),
  parseAgent: vi.fn(),
});

// ---------------------------------------------------------------------------
// Part A: createAdapter (integration with real ClaudeCodeAdapter)
// ---------------------------------------------------------------------------

describe('createAdapter', () => {
  it('returns an adapter whose findAgent resolves with the file contents for a known agent', async () => {
    const cwd = await makeTempDir();
    const agentsDir = join(cwd, '.claude', 'agents');
    await mkdir(agentsDir, { recursive: true });
    const content = '---\nname: foo\n---\nDo useful things.\n';
    await writeFile(join(agentsDir, 'foo.md'), content, 'utf8');

    const adapter = await createAdapter('claude', cwd);
    const found = await adapter.findAgent('foo');

    // The resolved value must be the raw file content (not just any truthy string)
    expect(found).toBe(content);
  });

  it('returns an adapter whose findAgent rejects with PlatformAgentNotFoundError for an unknown agent', async () => {
    const cwd = await makeTempDir();

    const adapter = await createAdapter('claude', cwd);

    await expect(adapter.findAgent('does-not-exist')).rejects.toBeInstanceOf(
      PlatformAgentNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// Part B: createAdapterFactory — memoization and eviction behavior
// ---------------------------------------------------------------------------

describe('createAdapterFactory', () => {
  describe('memoization', () => {
    it('calls the underlying create function exactly once for two sequential calls with the same (platform, cwd)', async () => {
      const fakeAdapter = makeFakeAdapter();
      const stubCreate = vi.fn().mockResolvedValue(fakeAdapter);
      const factory = createAdapterFactory(stubCreate);

      const first = await factory('claude', '/work/a');
      const second = await factory('claude', '/work/a');

      expect(stubCreate).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });
  });

  describe('concurrency deduplication', () => {
    it('calls the underlying create function exactly once when two concurrent calls share the same key', async () => {
      const fakeAdapter = makeFakeAdapter();
      const stubCreate = vi.fn().mockResolvedValue(fakeAdapter);
      const factory = createAdapterFactory(stubCreate);

      const [first, second] = await Promise.all([
        factory('claude', '/work/b'),
        factory('claude', '/work/b'),
      ]);

      expect(stubCreate).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });
  });

  describe('cache key includes cwd', () => {
    it('calls the underlying create function separately for two calls that differ only in cwd', async () => {
      const adapterA = makeFakeAdapter();
      const adapterB = makeFakeAdapter();
      const stubCreate = vi.fn().mockResolvedValueOnce(adapterA).mockResolvedValueOnce(adapterB);
      const factory = createAdapterFactory(stubCreate);

      const resultA = await factory('claude', '/work/a');
      const resultB = await factory('claude', '/work/b');

      expect(stubCreate).toHaveBeenCalledTimes(2);
      // Each cwd produces a distinct adapter instance
      expect(resultA).toBe(adapterA);
      expect(resultB).toBe(adapterB);
    });
  });

  describe('evict-on-reject', () => {
    it('evicts a rejected promise so the next call retries and resolves', async () => {
      const fakeAdapter = makeFakeAdapter();
      const rejection = new Error('transient scan failure');
      const stubCreate = vi
        .fn()
        .mockRejectedValueOnce(rejection)
        .mockResolvedValueOnce(fakeAdapter);
      const factory = createAdapterFactory(stubCreate);

      // First call must reject with the transient error
      await expect(factory('claude', '/work/c')).rejects.toThrow('transient scan failure');

      // Second call with the same key must retry (stubCreate called again) and resolve
      const result = await factory('claude', '/work/c');

      expect(stubCreate).toHaveBeenCalledTimes(2);
      expect(result).toBe(fakeAdapter);
    });
  });

  describe('independent factory instances do not share cache', () => {
    it('each factory created by createAdapterFactory owns its own cache, so two factories with the same (platform, cwd) each invoke create', async () => {
      const fakeAdapter = makeFakeAdapter();
      const stubCreate = vi.fn().mockResolvedValue(fakeAdapter);

      const factoryA = createAdapterFactory(stubCreate);
      const factoryB = createAdapterFactory(stubCreate);

      await factoryA('claude', '/work/shared');
      await factoryB('claude', '/work/shared');

      // Each factory has its own cache; neither can satisfy the other's miss.
      expect(stubCreate).toHaveBeenCalledTimes(2);
    });
  });
});
