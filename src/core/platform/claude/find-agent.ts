import { access } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { PlatformAgentNotFoundError } from '../errors.ts';

export const findAgent = async (name: string, cwd: string): Promise<string> => {
  if (name.includes('/') || name.startsWith('.')) {
    return isAbsolute(name) ? name : resolve(cwd, name);
  }

  const searchPaths = [
    resolve(cwd, '.claude', 'agents', `${name}.md`),
    resolve(os.homedir(), '.claude', 'agents', `${name}.md`),
  ];

  for (const candidate of searchPaths) {
    try {
      await access(candidate);

      return candidate;
    } catch {
      // not found at this path, continue
    }
  }

  throw new PlatformAgentNotFoundError(name);
};
