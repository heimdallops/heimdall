// SDK: @anthropic-ai/claude-agent-sdk
//
// Streaming is enabled via `options.includePartialMessages: true` in the
// `query()` call. When enabled, `SDKPartialAssistantMessage` events (type:
// 'stream_event') are emitted through the async generator before the full
// `SDKAssistantMessage` arrives.
//
// Each `SDKPartialAssistantMessage` carries a `BetaRawMessageStreamEvent` in
// its `event` field. Text deltas come as `BetaRawContentBlockDeltaEvent`
// (type: 'content_block_delta') with a delta of type `BetaTextDelta`
// (type: 'text_delta', text: string).
//
// The session ID appears on most messages as the `session_id` string field.
// `SDKUserMessage.session_id` is optional, so we wait for the first message
// that carries a defined session_id before resolving the promise.
//
// Cancellation is passed via `options.abortController: AbortController`. The
// `AbortController` is set in `Options.abortController`. When aborted, the
// generator throws or terminates early.
//
// The SDK exports a single `query` function (not a class):
//   query({ prompt: string, options?: Options }): Query
// where `Query extends AsyncGenerator<SDKMessage, void>`.
// There is no client constructor — `query` is called directly as a module-level
// function. Credentials are read from the environment (ANTHROPIC_API_KEY) or
// the existing Claude Code installation; no explicit credential passing is
// required or supported in the SDK public API.

import { EventEmitter } from 'node:events';

import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { AbortError, query } from '@anthropic-ai/claude-agent-sdk';

import { PlatformCancellationError, PlatformError } from '../errors.ts';
import type { PlatformStream, StreamEventMap } from '../types.ts';
import type { ClaudeOptions } from './options.ts';

export class ClaudeStream extends EventEmitter implements PlatformStream {
  private readonly abortController: AbortController;
  private readonly sessionIdPromise: Promise<string>;
  private resolveSessionId!: (id: string) => void;
  private rejectSessionId!: (err: unknown) => void;

  constructor(prompt: string, options: ClaudeOptions, sessionId?: string) {
    super();
    // Prevent Node from throwing on unhandled 'error' events for callers
    // that only await sessionId() without registering an error listener.
    this.on('error', () => undefined);
    this.abortController = new AbortController();
    this.sessionIdPromise = new Promise((resolve, reject) => {
      this.resolveSessionId = resolve;
      this.rejectSessionId = reject;
    });
    void this.execute(prompt, options, sessionId);
  }

  override on<K extends keyof StreamEventMap>(
    event: K,
    handler: (...args: StreamEventMap[K]) => void
  ): this {
    return super.on(event, handler as (...args: unknown[]) => void);
  }

  cancel(): void {
    this.abortController.abort();
  }

  sessionId(): Promise<string> {
    return this.sessionIdPromise;
  }

  private async execute(prompt: string, options: ClaudeOptions, sessionId?: string): Promise<void> {
    let terminated = false;
    try {
      const sdkOptions = buildSdkOptions(options, this.abortController, sessionId);
      const stream = query({ prompt, options: sdkOptions });
      let sessionResolved = false;

      for await (const message of stream) {
        if (!sessionResolved && message.session_id !== undefined) {
          this.resolveSessionId(message.session_id);
          sessionResolved = true;
        }

        if (message.type === 'stream_event') {
          const { event } = message;

          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            this.emit('chunk', event.delta.text);
          }
        }
      }

      // The SDK may return early on abort without throwing AbortError.
      if (this.abortController.signal.aborted) {
        terminated = true;
        const cancellation = new PlatformCancellationError();
        this.rejectSessionId(cancellation);
        this.emit('error', cancellation);
      } else if (!sessionResolved) {
        terminated = true;
        const err = new PlatformError('PLATFORM_ERROR', 'Stream ended without a session ID');
        this.rejectSessionId(err);
        this.emit('error', err);
      }
    } catch (err) {
      terminated = true;
      if (err instanceof AbortError) {
        const cancellation = new PlatformCancellationError({ cause: err });
        this.rejectSessionId(cancellation);
        this.emit('error', cancellation);
      } else {
        const platformErr = new PlatformError(
          'PLATFORM_ERROR',
          'An unexpected error occurred during stream execution',
          { cause: err }
        );
        this.rejectSessionId(platformErr);
        this.emit('error', platformErr);
      }
    }

    if (!terminated) {
      this.emit('done');
    }
  }
}

const buildSdkOptions = (
  options: ClaudeOptions,
  abortController: AbortController,
  sessionId?: string
): Options => ({
  abortController,
  includePartialMessages: true,
  ...(options.model !== undefined && { model: options.model }),
  ...(options.reasoning_effort !== undefined && { effort: options.reasoning_effort }),
  ...(options.allowed_tools !== undefined && { allowedTools: options.allowed_tools }),
  ...(options.denied_tools !== undefined && { disallowedTools: options.denied_tools }),
  ...(options.skills !== undefined && { skills: options.skills }),
  ...(options.max_budget_usd !== undefined && { maxBudgetUsd: options.max_budget_usd }),
  ...(options.system_prompt !== undefined && { systemPrompt: options.system_prompt }),
  ...(options.sandbox !== undefined && { sandbox: options.sandbox }),
  ...(sessionId !== undefined && { resume: sessionId }),
});
