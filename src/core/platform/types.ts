import type { PlatformError } from './errors.ts';

export interface BasePlatformOptions {
  model?: string | undefined;
}

/**
 * Typed event signatures for a `PlatformStream`. Keeping them in a map lets
 * `on()` be a single generic overload instead of one overload per event,
 * and gives callers compile-time guarantees about handler argument shapes.
 */
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

/**
 * Defines the contract that a platform integration must satisfy. Commands and
 * engine nodes depend on this interface rather than on any concrete SDK, so
 * swapping or mocking the underlying platform requires only a new implementation
 * of this interface.
 *
 * - `findAgent` resolves a bare agent name to an absolute file path, searching
 *   from the caller's working directory up to the user's home directory.
 * - `parseAgent` extracts the system prompt and platform options from a
 *   Markdown agent file (YAML front-matter + body).
 * - `run` creates a stream for a single invocation. Attach listeners before
 *   calling `start()` on the returned `PlatformStream`.
 */
export interface PlatformAdapter<TOptions extends BasePlatformOptions> {
  run(prompt: string, options: TOptions, sessionId?: string): PlatformStream;
  findAgent(name: string): Promise<string>;
  parseAgent(content: string): { prompt: string; options: TOptions };
}
