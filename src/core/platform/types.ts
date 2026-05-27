import type { PlatformError } from './errors.ts';

export interface BasePlatformOptions {
  model?: string | undefined;
}

export interface StreamEventMap {
  chunk: [delta: string];
  done: [];
  error: [err: PlatformError];
}

export interface PlatformStream {
  on<K extends keyof StreamEventMap>(event: K, handler: (...args: StreamEventMap[K]) => void): this;
  cancel(): void;
  sessionId(): Promise<string>;
}

export interface PlatformAdapter<TOptions extends BasePlatformOptions> {
  run(prompt: string, options: TOptions, sessionId?: string): PlatformStream;
  findAgent(name: string): Promise<string>;
  parseAgent(content: string): { prompt: string; options: TOptions };
}
