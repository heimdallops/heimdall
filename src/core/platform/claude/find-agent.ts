import { realpath } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

import { PlatformAgentNotFoundError } from '../errors.ts';

export const findAgent = async (name: string, cwd: string): Promise<string> => {
  if (isAbsolute(name) || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    return isAbsolute(name) ? name : resolve(cwd, name);
  }

  const home = os.homedir();

  // Walk up from cwd to (and including) home, collecting each directory to probe.
  // If cwd is not under home, home is still appended as a final fallback.
  const searchDirs: string[] = [];
  let dir = resolve(cwd);
  let reachedHome = false;
  while (true) {
    searchDirs.push(dir);
    if (dir === home) {
      reachedHome = true;
      break;
    }

    const parent = resolve(dir, '..');
    if (parent === dir) {
      break;
    } // filesystem root

    dir = parent;
  }

  if (!reachedHome) {
    searchDirs.push(home);
  }

  for (const searchDir of searchDirs) {
    const base = resolve(searchDir, '.claude', 'agents');
    const candidate = resolve(base, `${name}.md`);
    try {
      const resolvedBase = await realpath(base).catch(() => base);
      const real = await realpath(candidate);
      if (real.startsWith(resolvedBase + sep) || real === resolvedBase) {
        return real;
      }
    } catch {
      // file does not exist at this level; try the next ancestor
    }
  }

  throw new PlatformAgentNotFoundError(name);
};
