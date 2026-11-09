import process from 'node:process';

import type { PlatformAdapter, PlatformStream } from '../types.ts';
import type { ClaudeOptions } from './options.ts';
import { ClaudeStream } from './stream.ts';

/**
 * Adapter for Claude Code agents.
 */
export class ClaudeCodeAdapter implements PlatformAdapter<ClaudeOptions> {
  private readonly cwd: string;
  private readonly executablePath: string | undefined;

  /**
   * @param executablePath - Claude Code executable for the SDK to spawn; when undefined the SDK
   *   uses the binary from its own platform package.
   */
  constructor(cwd: string = process.cwd(), executablePath?: string) {
    this.cwd = cwd;
    this.executablePath = executablePath;
  }

  run(prompt: string, options: ClaudeOptions, sessionId?: string): PlatformStream {
    return new ClaudeStream(prompt, options, sessionId, this.cwd, this.executablePath);
  }
}
