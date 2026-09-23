import { describe, expect, it, vi } from 'vitest';

import { createAdapterFactory } from '../../../../src/core/engine/adapter-factory.ts';
import type { PlatformAdapter } from '../../../../src/core/engine/nodes/base.ts';

// ---------------------------------------------------------------------------
// Minimal fake adapter used in factory-behavior tests
// ---------------------------------------------------------------------------

const makeFakeAdapter = (): PlatformAdapter => ({
  run: vi.fn(),
});

// ---------------------------------------------------------------------------
// createAdapterFactory — memoization and eviction behavior
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
      const rejection = new Error('transient construction failure');
      const stubCreate = vi
        .fn()
        .mockRejectedValueOnce(rejection)
        .mockResolvedValueOnce(fakeAdapter);
      const factory = createAdapterFactory(stubCreate);

      // First call must reject with the transient error
      await expect(factory('claude', '/work/c')).rejects.toThrow('transient construction failure');

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
