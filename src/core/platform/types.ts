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
 * Errors are reported through two channels. Most failures arrive via the
 * `error` event. However, `sessionId()` returns a `Promise<string>` that may
 * also reject — with `PlatformCancellationError` if the stream is cancelled
 * before a session ID is observed, or with `PlatformError` if the stream ends
 * in failure. Callers must handle both the `error` event and potential
 * rejections from `sessionId()`.
 */
export interface PlatformStream {
  on<K extends keyof StreamEventMap>(event: K, handler: (...args: StreamEventMap[K]) => void): this;
  cancel(): void;
  sessionId(): Promise<string>;
}

// PlatformAdapter provides a common interface for interacting with different
// AI platforms such as Claude Code, OpenCode, and Codex.
export interface PlatformAdapter<TOptions extends BasePlatformOptions> {
  run(prompt: string, options: TOptions, sessionId?: string): PlatformStream;
  findAgent(name: string): Promise<string>;
  parseAgent(content: string): { prompt: string; options: TOptions };
}
