import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { isSea } from 'node:sea';

import { PlatformError } from '../errors.ts';

const isExecutableFile = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);

    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const findOnPath = async (name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> => {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') {
      continue;
    }

    const candidate = join(dir, name);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
};

/**
 * Resolves the Claude Code executable the Agent SDK should spawn.
 *
 * A configured path always wins. Otherwise the npm install returns undefined so the SDK uses
 * its own version-matched binary from node_modules. The standalone (SEA) binary has no
 * node_modules, so it uses the user's installed `claude` from PATH.
 */
export const resolveClaudeCodeExecutable = async (
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> => {
  if (configured !== undefined) {
    if (!(await isExecutableFile(configured))) {
      throw new PlatformError(
        'CLAUDE_CODE_NOT_FOUND',
        'The configured Claude Code executable (claudeCodeExecutable / HEIMDALL_CLAUDE_CODE_EXECUTABLE) does not exist or is not executable.'
      );
    }

    return configured;
  }

  if (!isSea()) {
    return undefined;
  }

  const found = await findOnPath(process.platform === 'win32' ? 'claude.exe' : 'claude', env);
  if (found === undefined) {
    throw new PlatformError(
      'CLAUDE_CODE_NOT_FOUND',
      'Agent nodes need Claude Code, but `claude` was not found on PATH. Install Claude Code, or set claudeCodeExecutable in your heimdall config (or the HEIMDALL_CLAUDE_CODE_EXECUTABLE environment variable) to its path.'
    );
  }

  return found;
};
