import { readdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import { resolve, sep } from 'node:path';
import process from 'node:process';

import matter from 'gray-matter';
import yaml from 'js-yaml';

import { PlatformAgentNotFoundError, PlatformError } from '../errors.ts';
import type { PlatformAdapter, PlatformStream } from '../types.ts';
import type { ClaudeOptions } from './options.ts';
import { claudeOptionsSchema } from './options.ts';
import { ClaudeStream } from './stream.ts';

const enumerateMdFiles = async (dir: string): Promise<string[]> => {
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
};

const FIELD_ALIASES: Record<string, string> = { tools: 'allowed_tools' };
const ARRAY_COERCE_KEYS = new Set(['allowed_tools', 'disallowed_tools']);

export class ClaudeCodeAdapter implements PlatformAdapter<ClaudeOptions> {
  private readonly cwd: string;
  readonly agents: ReadonlyMap<string, string>;

  private constructor(cwd: string, agents: Map<string, string>) {
    this.cwd = cwd;
    this.agents = agents;
  }

  static async create(cwd: string = process.cwd()): Promise<ClaudeCodeAdapter> {
    const home = os.homedir();
    const searchDirs = ClaudeCodeAdapter.buildSearchDirs(resolve(cwd), home);
    const agents = await ClaudeCodeAdapter.scanAgents(searchDirs);

    return new ClaudeCodeAdapter(cwd, agents);
  }

  private static buildSearchDirs(cwd: string, home: string): string[] {
    const homePrefix = home.endsWith(sep) ? home : home + sep;
    // cwd is outside the home tree — no useful intermediate dirs, just check cwd then home.
    if (cwd !== home && !cwd.startsWith(homePrefix)) {
      return [cwd, home];
    }

    const searchDirs: string[] = [];
    let dir = cwd;
    while (true) {
      searchDirs.push(dir);
      if (dir === home) {
        break;
      }

      dir = resolve(dir, '..');
    }

    return searchDirs;
  }

  private static async scanAgents(searchDirs: string[]): Promise<Map<string, string>> {
    const cache = new Map<string, string>();
    for (const searchDir of searchDirs) {
      const realSearchDir = await realpath(searchDir).catch(() => searchDir);
      const base = resolve(realSearchDir, '.claude', 'agents');
      const candidates = (await enumerateMdFiles(base)).sort();
      for (const candidate of candidates) {
        let real: string;
        try {
          real = await realpath(candidate);
        } catch {
          continue;
        }

        if (!real.startsWith(base + sep) && real !== base) {
          continue;
        }

        let content: string;
        try {
          content = await readFile(real, 'utf8');
        } catch {
          continue;
        }

        let data: Record<string, unknown>;
        try {
          ({ data } = matter(content, {
            engines: { yaml: (s: string) => yaml.load(s) as Record<string, unknown> },
          }) as { data: Record<string, unknown>; content: string });
        } catch {
          continue;
        }

        const { name } = data;
        if (typeof name !== 'string' || name.length === 0) {
          continue;
        }

        if (!cache.has(name)) {
          cache.set(name, content);
        }
      }
    }

    return cache;
  }

  run(prompt: string, options: ClaudeOptions, sessionId?: string): PlatformStream {
    return new ClaudeStream(prompt, options, sessionId);
  }

  findAgent(name: string): Promise<string> {
    const content = this.agents.get(name);
    if (!content) {
      return Promise.reject(new PlatformAgentNotFoundError(name));
    }

    return Promise.resolve(content);
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
