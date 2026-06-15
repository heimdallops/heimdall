import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

import matter from 'gray-matter';
import yaml from 'js-yaml';

import { PlatformAgentNotFoundError } from '../errors.ts';
import type { PlatformAdapter, PlatformStream } from '../types.ts';
import type { ClaudeOptions } from './options.ts';
import { claudeOptionsSchema } from './options.ts';
import { ClaudeStream } from './stream.ts';

const FIELD_ALIASES: Record<string, string> = { tools: 'allowed_tools' };
const ARRAY_COERCE_KEYS = new Set(['allowed_tools', 'disallowed_tools']);

// gray-matter supports `---js` frontmatter that executes JavaScript at parse time.
// Agent files come from the filesystem and may be untrusted; permitting JS frontmatter
// would allow arbitrary code execution inside the Heimdall process.
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

/**
 * Adapter for Claude Code agents.
 *
 * Discovers agents from `.claude/agents/` directories, mirroring Claude Code:
 * walks up from cwd, stopping at the first of: the git repository root
 * (inclusive), the home directory (inclusive), or the filesystem root — in that
 * priority order, so a git root inside the home tree stops the walk before home
 * does; then includes `~/.claude/agents` (user scope, lowest precedence). A git
 * repository is not required. Each directory is scanned recursively; symlinked
 * directories and symlinked agent files are followed fully. Agents are
 * identified by the frontmatter `name` field (not the filename); the first match
 * wins when a name appears more than once.
 */
export class ClaudeCodeAdapter implements PlatformAdapter<ClaudeOptions> {
  private readonly cwd: string;
  readonly agents: ReadonlyMap<string, string>;

  private constructor(cwd: string, agents: Map<string, string>) {
    this.cwd = cwd;
    this.agents = agents;
  }

  static async create(cwd: string = process.cwd()): Promise<ClaudeCodeAdapter> {
    const home = os.homedir();
    const searchDirs = await ClaudeCodeAdapter.buildSearchDirs(resolve(cwd), home);
    const agents = await ClaudeCodeAdapter.scanAgents(searchDirs);

    return new ClaudeCodeAdapter(cwd, agents);
  }

  private static async buildSearchDirs(cwd: string, home: string): Promise<string[]> {
    // Project scope: walk up from cwd, nearest first. Stop at the first of —
    // git root (inclusive), home directory (inclusive), or filesystem root.
    // `.git` is a file for worktrees (how Heimdall runs) and submodules, so
    // existence — not type — marks the git root. The git check runs first so a
    // git root at or below home still wins; home bounds the walk to user scope
    // when there is no enclosing repo.
    const projectDirs: string[] = [];
    let dir = cwd;
    while (true) {
      projectDirs.push(dir);

      const isGitRoot = await stat(resolve(dir, '.git')).then(
        () => true,
        () => false
      );
      if (isGitRoot) {
        break;
      }

      if (dir === home) {
        break;
      }

      const parent = resolve(dir, '..');
      if (parent === dir) {
        break;
      }

      dir = parent;
    }

    // Append home as the user scope exactly once, at lowest precedence.
    return [...projectDirs.filter((d) => d !== home), home];
  }

  // Recurses into both real and symlinked directories — symlinks are followed
  // fully, mirroring Claude Code — with a visited-realpath set guarding against
  // symlink cycles.
  private static async enumerateMdFiles(dir: string, visited: Set<string>): Promise<string[]> {
    const realDir = await realpath(dir).catch(() => undefined);
    if (realDir !== undefined && visited.has(realDir)) {
      return [];
    }

    const readTarget = realDir ?? dir;
    let entries;
    try {
      entries = await readdir(readTarget, { withFileTypes: true });
    } catch {
      return [];
    }

    if (realDir !== undefined) {
      visited.add(realDir);
    }

    const results: string[] = [];
    for (const entry of entries) {
      const fullPath = resolve(readTarget, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await ClaudeCodeAdapter.enumerateMdFiles(fullPath, visited)));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      } else if (entry.isSymbolicLink()) {
        const targetStat = await stat(fullPath).catch(() => undefined);
        if (targetStat?.isDirectory()) {
          results.push(...(await ClaudeCodeAdapter.enumerateMdFiles(fullPath, visited)));
        } else if (targetStat?.isFile() && entry.name.endsWith('.md')) {
          const target = await realpath(fullPath).catch(() => undefined);
          if (target !== undefined) {
            results.push(target);
          }
        }
      }
    }

    return results;
  }

  private static async scanAgents(searchDirs: string[]): Promise<Map<string, string>> {
    const cache = new Map<string, string>();
    const visited = new Set<string>();
    for (const searchDir of searchDirs) {
      const agentsDir = resolve(searchDir, '.claude', 'agents');
      const candidates = (await ClaudeCodeAdapter.enumerateMdFiles(agentsDir, visited)).sort();
      for (const candidate of candidates) {
        try {
          const content = await readFile(candidate, 'utf8');
          const { data } = matter(content, MATTER_OPTIONS) as {
            data: Record<string, unknown>;
            content: string;
          };

          const { name } = data;
          if (typeof name !== 'string' || name.length === 0) {
            continue;
          }

          if (!cache.has(name)) {
            cache.set(name, content);
          }
        } catch {
          continue;
        }
      }
    }

    return cache;
  }

  run(prompt: string, options: ClaudeOptions, sessionId?: string): PlatformStream {
    return new ClaudeStream(prompt, options, sessionId);
  }

  /**
   * Resolves `name` from the agent cache built at construction time.
   *
   * @throws {PlatformAgentNotFoundError} when no agent with that name was found during the scan.
   */
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
