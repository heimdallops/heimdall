import { realpath } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import process from 'node:process';

import matter from 'gray-matter';

import { PlatformAgentNotFoundError, PlatformError } from '../errors.ts';
import type { PlatformAdapter, PlatformStream } from '../types.ts';
import type { ClaudeOptions } from './options.ts';
import { claudeOptionsSchema } from './options.ts';
import { ClaudeStream } from './stream.ts';

const FIELD_ALIASES: Record<string, string> = { tools: 'allowed_tools' };
const ARRAY_COERCE_KEYS = new Set(['allowed_tools', 'denied_tools']);

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

export const parseAgent = (content: string): { prompt: string; options: ClaudeOptions } => {
  const { data: rawFrontmatter, content: body } = matter(content);

  const aliased: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawFrontmatter)) {
    aliased[FIELD_ALIASES[key] ?? key] = value;
  }

  for (const key of ARRAY_COERCE_KEYS) {
    if (typeof aliased[key] === 'string') {
      aliased[key] = aliased[key]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const result = claudeOptionsSchema.partial().safeParse(aliased);
  if (!result.success) {
    const [issue] = result.error.issues;
    const fieldPath = issue?.path.join('.') ?? 'unknown';
    throw new PlatformError(
      'PLATFORM_ERROR',
      `Invalid agent frontmatter at '${fieldPath}': ${issue?.code ?? 'validation error'}`
    );
  }

  return { prompt: body.trim(), options: result.data };
};

export class ClaudeCodeAdapter implements PlatformAdapter<ClaudeOptions> {
  run(prompt: string, options: ClaudeOptions, sessionId?: string): PlatformStream {
    return new ClaudeStream(prompt, options, sessionId);
  }

  findAgent(name: string): Promise<string> {
    return findAgent(name, process.cwd());
  }

  parseAgent(content: string): { prompt: string; options: ClaudeOptions } {
    return parseAgent(content);
  }
}
