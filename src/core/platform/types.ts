import type { PlatformError } from './errors.ts';

export interface BasePlatformOptions {
  model?: string | undefined;
}

/**
 * Events emitted by a PlatformStream.
 *
 * - `chunk`: Fired for each incremental text delta as the model streams output.
 *   The delta is the raw string fragment; callers concatenate to build the full response.
 * - `done`: Fired once when the stream ends cleanly (the generator exhausted without error
 *   and without being cancelled). Never fires after `error`.
 * - `error`: Fired at most once when the stream terminates abnormally. The argument is
 *   a `PlatformError` (or `PlatformCancellationError`). After `error`, `done` is not emitted.
 *   Callers must also handle rejections from `sessionId()` — see that method's docs.
 */
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
  /**
   * Registers a typed event listener. See {@link StreamEventMap} for the full event list
   * and their payloads.
   */
  on<K extends keyof StreamEventMap>(event: K, handler: (...args: StreamEventMap[K]) => void): this;
  /**
   * Requests cancellation of the in-flight stream. Idempotent — calling it more than once
   * is safe. If the stream has already completed cleanly, the call is a no-op and no
   * additional events are emitted. Otherwise, the stream emits `error` with a
   * `PlatformCancellationError`.
   */
  cancel(): void;
  /**
   * Resolves with the platform session ID once the first SDK message carrying a session_id
   * is received. Useful for resuming conversations across runs.
   *
   * The promise rejects in two cases:
   * - `PlatformCancellationError` — cancel() was called before any session_id arrived.
   * - `PlatformError` — the stream terminated with an error before any session_id arrived.
   *
   * Callers that only listen to `error` events must also attach a rejection handler here
   * to avoid unhandled promise rejection warnings.
   */
  sessionId(): Promise<string>;
}

// PlatformAdapter provides a common interface for interacting with different
// AI platforms such as Claude Code, OpenCode, and Codex.
export interface PlatformAdapter<TOptions extends BasePlatformOptions> {
  /**
   * Starts a streaming prompt execution and returns a handle to the in-flight stream.
   * The stream begins executing immediately upon construction — callers must attach
   * event listeners synchronously after calling `run()` to avoid missing early events.
   *
   * @param prompt - The user message to send.
   * @param options - Platform-specific options (model, tools, budget, etc.).
   * @param sessionId - If provided, resumes a prior conversation session. The platform
   *   will attempt to continue from the session's context.
   * @returns A `PlatformStream` that emits `chunk`, `done`, and `error` events.
   */
  run(prompt: string, options: TOptions, sessionId?: string): PlatformStream;
  /**
   * Looks up an agent by name and returns its raw file contents. The resolution
   * strategy — where agents are searched for and how their identity is
   * determined — is platform-specific.
   *
   * @param name - The agent name to search for.
   * @returns The raw file contents of the agent.
   * @throws `PlatformAgentNotFoundError` if no agent with the given name exists.
   */
  findAgent(name: string): Promise<string>;
  /**
   * Parses a raw agent file (as returned by `findAgent`) into a prompt and platform options.
   *
   * Frontmatter (between `---` delimiters) is extracted and validated against the platform's
   * options schema. Unknown or invalid fields are silently dropped. The body below the
   * frontmatter becomes the prompt (trimmed).
   *
   * @param content - Raw agent file contents (frontmatter + body).
   * @returns An object with:
   *   - `prompt`: The agent's system/body text.
   *   - `options`: Validated platform options derived from the frontmatter.
   */
  parseAgent(content: string): { prompt: string; options: TOptions };
}
