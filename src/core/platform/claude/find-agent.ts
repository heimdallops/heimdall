import { access, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PlatformAgentNotFoundError } from '../errors.ts';

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
};

/**
 * Resolves an agent name to an absolute path within cwd or the home directory.
 * Bare names are looked up in .claude/agents/; path-like names (containing "/" or
 * starting with ".") are resolved directly — existence is not checked because the
 * caller reads the file and surfaces a more descriptive error than a generic not-found.
 */
export const findAgent = async (name: string, cwd: string): Promise<string> => {
  if (name.includes('/') || name.startsWith('.')) {
    const resolved = path.resolve(cwd, name);
    const [realCwd, realHome] = await Promise.all([
      realpath(path.resolve(cwd)).catch(() => path.resolve(cwd)),
      realpath(path.resolve(os.homedir())).catch(() => path.resolve(os.homedir())),
    ]);

    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      // File doesn't exist yet; resolve against realCwd so the root-prefix check below still works
      real = path.resolve(realCwd, path.relative(path.resolve(cwd), resolved));
    }

    const allowedRoots = [realCwd, realHome];
    const isAllowed = allowedRoots.some(
      (root) => real.startsWith(`${root}${path.sep}`) || real === root
    );

    if (!isAllowed) {
      throw new PlatformAgentNotFoundError(name);
    }

    return real;
  }

  const candidates = [
    path.join(cwd, '.claude', 'agents', `${name}.md`),
    path.join(os.homedir(), '.claude', 'agents', `${name}.md`),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return realpath(candidate);
    }
  }

  throw new PlatformAgentNotFoundError(name);
};
