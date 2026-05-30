import type { PlatformError } from './errors.ts';

export interface BasePlatformOptions {
  model?: string | undefined;
}

// Map-keyed so `on()` is a single generic overload rather than one overload per event.
export interface StreamEventMap {
  chunk: [delta: string];
  done: [];
  error: [err: PlatformError];
}

/**
 * Errors arrive through the `error` event rather than as promise rejections,
 * so callers observe all failures through a single listener path.
 */
export interface PlatformStream {
  on<K extends keyof StreamEventMap>(event: K, handler: (...args: StreamEventMap[K]) => void): this;
  start(): Promise<void>;
  cancel(): void;
  sessionId(): Promise<string>;
}

// Abstraction boundary between the engine and a concrete AI platform SDK.
export interface PlatformAdapter<TOptions extends BasePlatformOptions> {
  run(prompt: string, options: TOptions, sessionId?: string): PlatformStream;
  findAgent(name: string): Promise<string>;
  parseAgent(content: string): { prompt: string; options: TOptions };
}
