import { readdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import { resolve, sep } from 'node:path';
import process from 'node:process';

import matter from 'gray-matter';
import yaml from 'js-yaml';

import { PlatformAgentNotFoundError } from '../errors.ts';
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

// gray-matter supports `---js` frontmatter that executes JavaScript at parse time.
//TODO: @c1moore @nolanrsherman Override the javascript engine to block arbitrary code execution in agent files.
const MATTER_OPTIONS = {
  engines: {
    yaml: (s: string) => {
      const parsed = yaml.load(s);

      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    },
    javascript: {
      parse: (_s: string): Record<string, unknown> => {
        throw new Error('JavaScript frontmatter is not permitted in agent files');
      },
      stringify: (): string => {
        throw new Error('not supported');
      },
    },
  },
} as const;

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
          ({ data } = matter(content, MATTER_OPTIONS) as {
            data: Record<string, unknown>;
            content: string;
          });
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
    const { data: rawFrontmatter, content: body } = matter(content, MATTER_OPTIONS);

    const aliased: Record<string, unknown> = {};

    // Pass 1: canonical (non-alias) keys take unconditional precedence
    for (const [key, value] of Object.entries(rawFrontmatter)) {
      if (!(key in FIELD_ALIASES)) {
        aliased[key] = value;
      }
    }

    // Pass 2: alias keys fill in only when no canonical key was present
    for (const [key, value] of Object.entries(rawFrontmatter)) {
      const canonicalKey = FIELD_ALIASES[key];
      if (canonicalKey !== undefined && !(canonicalKey in aliased)) {
        aliased[canonicalKey] = value;
      }
    }

    for (const key of ARRAY_COERCE_KEYS) {
      const raw = aliased[key];
      if (typeof raw === 'string') {
        aliased[key] = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    const options: ClaudeOptions = {};

    for (const [key, value] of Object.entries(aliased)) {
      const fieldSchema = claudeOptionsSchema.shape[key as keyof typeof claudeOptionsSchema.shape];
      if (fieldSchema === undefined) {
        // Unknown keys are silently ignored — they were never Heimdall's to validate.
        continue;
      }

      const result = fieldSchema.safeParse(value);
      if (result.success) {
        Object.assign(options, { [key]: result.data });
      }
    }

    return { prompt: body.trim(), options };
  }
}
