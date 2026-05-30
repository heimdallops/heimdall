import { readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import process from 'node:process';

import matter from 'gray-matter';
import yaml from 'js-yaml';

import { PlatformAgentNotFoundError, PlatformError } from '../errors.ts';
import type { PlatformAdapter, PlatformStream } from '../types.ts';
import type { ClaudeOptions } from './options.ts';
import { claudeOptionsSchema } from './options.ts';
import { ClaudeStream } from './stream.ts';

async function enumerateMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await enumerateMdFiles(fullPath)));
    } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

const FIELD_ALIASES: Record<string, string> = { tools: 'allowed_tools' };
const ARRAY_COERCE_KEYS = new Set(['allowed_tools', 'denied_tools']);

export class ClaudeCodeAdapter implements PlatformAdapter<ClaudeOptions> {
  private readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  run(prompt: string, options: ClaudeOptions, sessionId?: string): PlatformStream {
    return new ClaudeStream(prompt, options, sessionId);
  }

  async findAgent(name: string): Promise<string> {
    // Explicit paths are caller-trusted: no containment check and no existence verification.
    if (isAbsolute(name) || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      return isAbsolute(name) ? name : resolve(this.cwd, name);
    }

    const home = os.homedir();

    // Walk up from cwd to (and including) home, collecting each directory to probe.
    // If cwd is not under home, home is still appended as a final fallback.
    const searchDirs: string[] = [];
    let dir = resolve(this.cwd);
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
      const realSearchDir = await realpath(searchDir).catch(() => searchDir);
      const base = resolve(realSearchDir, '.claude', 'agents');

      const candidates = await enumerateMdFiles(base);
      const matches: string[] = [];

      for (const candidate of candidates) {
        let real: string;
        try {
          real = await realpath(candidate);
        } catch {
          continue;
        }

        if (!real.startsWith(base + sep) && real !== base) continue;

        let content: string;
        try {
          content = await readFile(real, 'utf8');
        } catch {
          continue;
        }

        try {
          const { data } = matter(content, {
            engines: { yaml: (s: string) => yaml.load(s) as Record<string, unknown> },
          });
          const agentName = data['name'];
          if (typeof agentName === 'string' && agentName.length > 0 && agentName === name) {
            matches.push(real);
          }
        } catch {
          continue;
        }
      }

      if (matches.length > 0) {
        return matches.sort()[0] as string;
      }
    }

    throw new PlatformAgentNotFoundError(name);
  }

  parseAgent(content: string): { prompt: string; options: ClaudeOptions } {
    const { data: rawFrontmatter, content: body } = matter(content, {
      engines: { yaml: (s: string) => yaml.load(s) as Record<string, unknown> },
    });

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
  }
}
