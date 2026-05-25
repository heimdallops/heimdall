import process from 'node:process';

import type { PlatformAdapter, PlatformStream } from '../types.ts';
import { findAgent as findAgentFn } from './find-agent.ts';
import type { ClaudeOptions } from './options.ts';
import { ClaudeStream } from './stream.ts';

export class ClaudeCodeAdapter implements PlatformAdapter<ClaudeOptions> {
  run(prompt: string, options: ClaudeOptions, sessionId?: string): PlatformStream {
    return new ClaudeStream(prompt, options, sessionId);
  }

  findAgent(name: string): Promise<string> {
    return findAgentFn(name, process.cwd());
  }

  parseAgent(_content: string): { prompt: string; options: ClaudeOptions } {
    throw new Error('Not implemented yet');
  }
}
