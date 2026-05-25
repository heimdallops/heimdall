import { query } from '@anthropic-ai/claude-agent-sdk';

import type { PlatformAdapter, PlatformStream } from '../types.ts';
import { findAgent } from './find-agent.ts';
import { type ClaudeOptions } from './options.ts';
import { parseAgent } from './parse-agent.ts';
import { ClaudeStream } from './stream.ts';

export class ClaudeCodeAdapter implements PlatformAdapter<ClaudeOptions> {
  private readonly cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
  }

  run(prompt: string, options: ClaudeOptions, sessionId?: string): PlatformStream {
    return new ClaudeStream(query, prompt, options, sessionId);
  }

  findAgent(name: string): Promise<string> {
    return findAgent(name, this.cwd);
  }

  parseAgent(content: string): { prompt: string; options: ClaudeOptions } {
    return parseAgent(content);
  }
}
