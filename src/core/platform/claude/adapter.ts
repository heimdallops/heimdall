import type { PlatformAdapter, PlatformStream } from '../types.ts';
import type { ClaudeOptions } from './options.ts';
import { ClaudeStream } from './stream.ts';

export class ClaudeCodeAdapter implements PlatformAdapter<ClaudeOptions> {
  run(prompt: string, options: ClaudeOptions, sessionId?: string): PlatformStream {
    return new ClaudeStream(prompt, options, sessionId);
  }

  findAgent(_name: string): Promise<string> {
    throw new Error('Not implemented yet');
  }

  parseAgent(_content: string): { prompt: string; options: ClaudeOptions } {
    throw new Error('Not implemented yet');
  }
}
