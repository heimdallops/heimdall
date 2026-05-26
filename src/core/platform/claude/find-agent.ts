import { realpath } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

import { PlatformAgentNotFoundError } from '../errors.ts';

export const findAgent = async (name: string, cwd: string): Promise<string> => {
  if (
    isAbsolute(name) ||
    name.includes('/') ||
    name.includes('\\') ||
    name.startsWith('.')
  ) {
    return isAbsolute(name) ? name : resolve(cwd, name);
  }

  const cwdBase = resolve(cwd, '.claude', 'agents');
  const homeBase = resolve(os.homedir(), '.claude', 'agents');

  const [resolvedCwdBase, resolvedHomeBase] = await Promise.all([
    realpath(cwdBase).catch(() => cwdBase),
    realpath(homeBase).catch(() => homeBase),
  ]);

  const searchPaths: [string, string][] = [
    [resolve(cwdBase, `${name}.md`), resolvedCwdBase],
    [resolve(homeBase, `${name}.md`), resolvedHomeBase],
  ];

  for (const [candidate, resolvedBase] of searchPaths) {
    try {
      const real = await realpath(candidate); // throws on ENOENT; no access() needed
      if (real.startsWith(resolvedBase + sep) || real === resolvedBase) {
        return real;
      }
    } catch {
      // continue to next candidate
    }
  }

  throw new PlatformAgentNotFoundError(name);
};
