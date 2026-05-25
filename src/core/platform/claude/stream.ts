import { EventEmitter } from 'node:events';

import {
  type Options,
  type query as QueryFn,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { PlatformCancellationError, PlatformError } from '../errors.ts';
import type { PlatformStream, StreamEventMap } from '../types.ts';
import type { ClaudeOptions } from './options.ts';

type QueryFunction = typeof QueryFn;

const buildQueryOptions = (options: ClaudeOptions, sessionId?: string): Options => {
  const opts: Options = {
    includePartialMessages: true,
  };

  if (options.model !== undefined) {
    opts.model = options.model;
  }

  if (options.allowed_tools !== undefined) {
    opts.allowedTools = options.allowed_tools;
  }

  if (options.denied_tools !== undefined) {
    opts.disallowedTools = options.denied_tools;
  }

  if (options.max_budget_usd !== undefined) {
    opts.maxBudgetUsd = options.max_budget_usd;
  }

  if (options.system_prompt !== undefined) {
    opts.systemPrompt = options.system_prompt;
  }

  if (options.skills !== undefined) {
    opts.skills = options.skills;
  }

  if (sessionId !== undefined) {
    opts.resume = sessionId;
  }

  return opts;
};

const extractTextDelta = (message: SDKMessage): string | null => {
  if (message.type !== 'stream_event') {
    return null;
  }

  const { event } = message;

  if (event.type !== 'content_block_delta') {
    return null;
  }

  if (event.delta.type !== 'text_delta') {
    return null;
  }

  return event.delta.text;
};

export class ClaudeStream extends EventEmitter implements PlatformStream {
  private readonly abortController: AbortController;
  private readonly sessionIdPromise: Promise<string>;
  private resolveSessionId!: (id: string) => void;
  private rejectSessionId!: (err: Error) => void;

  constructor(queryFn: QueryFunction, prompt: string, options: ClaudeOptions, sessionId?: string) {
    super();
    this.abortController = new AbortController();

    this.sessionIdPromise = new Promise<string>((resolve, reject) => {
      this.resolveSessionId = resolve;
      this.rejectSessionId = reject;
    });
    this.sessionIdPromise.catch(() => undefined);

    const queryOptions = buildQueryOptions(options, sessionId);
    queryOptions.abortController = this.abortController;

    void this.run(queryFn, prompt, queryOptions);
  }

  private async run(queryFn: QueryFunction, prompt: string, options: Options): Promise<void> {
    let sessionIdResolved = false;

    try {
      const q = queryFn({ prompt, options });

      for await (const message of q) {
        if (!sessionIdResolved && 'session_id' in message && message.session_id) {
          this.resolveSessionId(message.session_id);
          sessionIdResolved = true;
        }

        const delta = extractTextDelta(message);

        if (delta !== null && delta.length > 0) {
          this.emit('chunk', delta);
        }
      }

      if (!this.abortController.signal.aborted) {
        if (!sessionIdResolved) {
          this.rejectSessionId(
            new PlatformError('Stream completed without a session_id', 'PLATFORM_ERROR')
          );
        }

        this.emit('done');
        this.removeAllListeners();
      }
    } catch (err: unknown) {
      // Cancellation intentionally takes precedence over concurrent SDK errors during teardown
      if (this.abortController.signal.aborted) {
        const cancelError = new PlatformCancellationError();

        if (!sessionIdResolved) {
          this.rejectSessionId(cancelError);
        }

        this.emit('error', cancelError);
        this.removeAllListeners();

        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      const platformError = new PlatformError(message, 'PLATFORM_ERROR', err);

      if (!sessionIdResolved) {
        this.rejectSessionId(platformError);
      }

      this.emit('error', platformError);
      this.removeAllListeners();
    }
  }

  override on<K extends keyof StreamEventMap>(
    event: K,
    handler: (...args: StreamEventMap[K]) => void
  ): this {
    // EventEmitter's overloads don't accept typed tuple spread signatures
    return super.on(event, handler as (...args: unknown[]) => void);
  }

  cancel(): void {
    this.abortController.abort();
  }

  sessionId(): Promise<string> {
    return this.sessionIdPromise;
  }
}
