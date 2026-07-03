import type { Platform } from '../platform/index.ts';
import { ClaudeCodeAdapter } from '../platform/index.ts';
import type { AdapterFactory, PlatformAdapter } from './nodes/base.ts';

export const createAdapter = async (platform: Platform, cwd: string): Promise<PlatformAdapter> => {
  switch (platform) {
    case 'claude':
      return new ClaudeCodeAdapter(cwd);
    default: {
      // Compile-time exhaustiveness: a new platform enum member fails to assign to never,
      // forcing a matching case above.
      const _exhaustive: never = platform;

      throw new Error(`Unsupported platform: ${String(_exhaustive)}`);
    }
  }
};

/**
 * Builds a run-owned adapter factory that memoizes the pending construction
 * promise by `(platform, cwd)`.
 *
 * The pending promise is cached so concurrent calls under the parallel scheduler
 * dedupe onto a single construction. A rejected promise evicts its key so a
 * transient construction failure does not poison the rest of the run.
 *
 * @param create - construction seam, overridable in tests.
 */
export const createAdapterFactory = (create = createAdapter): AdapterFactory => {
  const cache = new Map<string, Promise<PlatformAdapter>>();

  return (platform, cwd) => {
    const key = `${platform}\0${cwd}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const pending = create(platform, cwd).then(
      (adapter) => adapter,
      (err) => {
        cache.delete(key);
        throw err;
      }
    );
    cache.set(key, pending);

    return pending;
  };
};
