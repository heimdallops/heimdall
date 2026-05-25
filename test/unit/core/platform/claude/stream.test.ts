import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeOptions } from '../../../../../src/core/platform/claude/options.ts';
import { ClaudeStream } from '../../../../../src/core/platform/claude/stream.ts';
import {
  PlatformCancellationError,
  PlatformError,
} from '../../../../../src/core/platform/errors.ts';

// ---------------------------------------------------------------------------
// Helpers to build synthetic SDK messages
// ---------------------------------------------------------------------------

const makeStreamEventMessage = (
  text: string,
  sessionId = 'session-abc'
): {
  type: 'stream_event';
  session_id: string;
  event: {
    type: 'content_block_delta';
    index: number;
    delta: { type: 'text_delta'; text: string };
  };
  parent_tool_use_id: null;
  uuid: `${string}-${string}-${string}-${string}-${string}`;
} => ({
  type: 'stream_event' as const,
  session_id: sessionId,
  event: {
    type: 'content_block_delta' as const,
    index: 0,
    delta: { type: 'text_delta' as const, text },
  },
  parent_tool_use_id: null,
  uuid: 'uuid-1' as `${string}-${string}-${string}-${string}-${string}`,
});

const makeAssistantMessage = (
  sessionId = 'session-abc'
): {
  type: 'assistant';
  session_id: string;
  message: {
    id: string;
    type: string;
    role: string;
    content: never[];
    model: string;
    stop_reason: null;
    stop_sequence: null;
    usage: { input_tokens: number; output_tokens: number };
  };
  parent_tool_use_id: null;
  uuid: `${string}-${string}-${string}-${string}-${string}`;
} => ({
  type: 'assistant' as const,
  session_id: sessionId,
  message: {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-3',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  parent_tool_use_id: null,
  uuid: 'uuid-2' as `${string}-${string}-${string}-${string}-${string}`,
});

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/claude-agent-sdk
//
// The real `query` function accepts { prompt, options } and returns a Query
// (AsyncGenerator<SDKMessage>). We type mockQueryImpl as returning
// AsyncIterable<unknown> so both sync and async generators satisfy the type —
// `for await...of` in production code works with both.
// ---------------------------------------------------------------------------

let mockQueryImpl: (params: { prompt: string; options?: unknown }) => AsyncIterable<unknown>;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: { prompt: string; options?: unknown }): AsyncIterable<unknown> =>
    mockQueryImpl(params),
}));

// Default: empty generator (completes immediately).
// Implemented as a plain AsyncIterable object to avoid the require-await
// false-positive that fires on async generators with no await expression.
const emptyGenerator = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator](): AsyncIterator<never> {
    return {
      next(): Promise<IteratorResult<never>> {
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  },
});

beforeEach(() => {
  mockQueryImpl = emptyGenerator;
});

// ---------------------------------------------------------------------------
// Helper: wait for an event to fire, with a timeout
// ---------------------------------------------------------------------------

const waitForEvent = <T>(emitter: ClaudeStream, event: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for event: ${event}`));
    }, 2000);
    emitter.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

const waitForEventNoArgs = (emitter: ClaudeStream, event: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for event: ${event}`));
    }, 2000);
    emitter.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });

const collectEvents = (
  emitter: ClaudeStream
): { chunks: string[]; done: Promise<void>; error: Promise<PlatformError> } => {
  const chunks: string[] = [];
  let doneResolve!: () => void;
  let errorResolve!: (err: PlatformError) => void;
  const done = new Promise<void>((res) => {
    doneResolve = res;
  });
  const error = new Promise<PlatformError>((res) => {
    errorResolve = res;
  });

  emitter.on('chunk', (delta) => chunks.push(delta));
  emitter.on('done', () => {
    doneResolve();
  });
  emitter.on('error', (err) => {
    errorResolve(err);
  });

  return { chunks, done, error };
};

// ---------------------------------------------------------------------------
// AsyncIterable factories: avoid async generators so require-await does not fire
// on generators that only yield without awaiting.
// ---------------------------------------------------------------------------

const makeIterable = <T>(items: T[]): AsyncIterable<T> => ({
  [Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0;

    return {
      next(): Promise<IteratorResult<T>> {
        if (index < items.length) {
          return Promise.resolve({ value: items[index++]!, done: false });
        }

        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  },
});

// Iterable that rejects on the first iteration step
const makeThrowingIterable = (message: string): AsyncIterable<never> => ({
  [Symbol.asyncIterator](): AsyncIterator<never> {
    return {
      next(): Promise<IteratorResult<never>> {
        return Promise.reject(new Error(message));
      },
    };
  },
});

const defaultOptions: ClaudeOptions = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeStream', () => {
  describe('"chunk" events', () => {
    it('emits a "chunk" event for each text delta from the SDK', async () => {
      mockQueryImpl = (): AsyncIterable<unknown> =>
        makeIterable([
          makeStreamEventMessage('Hello, ', 'session-1'),
          makeStreamEventMessage('world!', 'session-1'),
        ]);

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'say hello',
        defaultOptions
      );
      const { chunks, done } = collectEvents(stream);
      await done;

      expect(chunks).toEqual(['Hello, ', 'world!']);
    });

    it('does not emit a "chunk" event for non-text-delta stream events', async () => {
      mockQueryImpl = (): AsyncIterable<unknown> =>
        makeIterable([
          {
            type: 'stream_event' as const,
            session_id: 'session-1',
            event: { type: 'message_start' as const, message: {} },
            parent_tool_use_id: null,
            uuid: 'uuid-x' as `${string}-${string}-${string}-${string}-${string}`,
          },
        ]);

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );
      const { chunks, done } = collectEvents(stream);
      await done;

      expect(chunks).toHaveLength(0);
    });

    it('does not emit a "chunk" event for empty string deltas', async () => {
      mockQueryImpl = (): AsyncIterable<unknown> =>
        makeIterable([makeStreamEventMessage('', 'session-1')]);

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );
      const { chunks, done } = collectEvents(stream);
      await done;

      expect(chunks).toHaveLength(0);
    });
  });

  describe('"done" event', () => {
    it('emits "done" after the SDK async iterable completes', async () => {
      mockQueryImpl = (): AsyncIterable<unknown> =>
        makeIterable([makeStreamEventMessage('text', 'session-1')]);

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );

      await expect(waitForEventNoArgs(stream, 'done')).resolves.toBeUndefined();
    });

    it('emits "done" even when the SDK yields no messages', async () => {
      mockQueryImpl = emptyGenerator;

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );

      await expect(waitForEventNoArgs(stream, 'done')).resolves.toBeUndefined();
    });
  });

  describe('sessionId()', () => {
    it('resolves to the session_id from the first SDK message that has one', async () => {
      mockQueryImpl = (): AsyncIterable<unknown> =>
        makeIterable([
          makeStreamEventMessage('delta', 'session-xyz'),
          makeStreamEventMessage('more', 'session-xyz'),
        ]);

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );

      await expect(stream.sessionId()).resolves.toBe('session-xyz');
    });

    it('resolves session_id from a non-text-delta message (e.g. assistant message)', async () => {
      mockQueryImpl = (): AsyncIterable<unknown> =>
        makeIterable([makeAssistantMessage('session-from-assistant')]);

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );

      await expect(stream.sessionId()).resolves.toBe('session-from-assistant');
    });

    it('rejects sessionId() when stream completes without a session_id', async () => {
      // SDK completes successfully but never emits a message containing a session_id
      mockQueryImpl = emptyGenerator;

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );

      // Wait for the stream to finish so the rejection is settled before we inspect it
      await waitForEventNoArgs(stream, 'done');

      await expect(stream.sessionId()).rejects.toBeInstanceOf(PlatformError);

      const err = await stream.sessionId().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlatformError);
      expect((err as PlatformError).code).toBe('PLATFORM_ERROR');
      expect((err as PlatformError).message).toContain('session_id');
    });
  });

  describe('cancel()', () => {
    it('aborts the request and emits "error" with PlatformCancellationError', async () => {
      let generatorReady!: () => void;
      const generatorStarted = new Promise<void>((r) => {
        generatorReady = r;
      });

      mockQueryImpl = (params): AsyncIterable<unknown> => {
        const opts = params.options as Record<string, unknown> | undefined;
        const ctrl = opts?.['abortController'] as AbortController | undefined;
        const signal = ctrl?.signal;

        return (async function* (): AsyncGenerator<never> {
          await new Promise<void>((_, reject) => {
            signal!.addEventListener('abort', () => {
              reject(new Error('Aborted'));
            });
            generatorReady();
          });
        })();
      };

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );

      // Suppress the expected sessionId rejection so it doesn't leak as unhandled
      stream.sessionId().catch(() => {
        // intentionally suppressed
      });

      // Wait until the generator has registered its abort listener
      await generatorStarted;

      stream.cancel();

      const err = await waitForEvent<PlatformError>(stream, 'error');

      expect(err).toBeInstanceOf(PlatformCancellationError);
      expect(err.code).toBe('PLATFORM_CANCELLED');
    });

    it('rejects sessionId() with PlatformCancellationError when cancelled before session_id is seen', async () => {
      let generatorReady!: () => void;
      const generatorStarted = new Promise<void>((r) => {
        generatorReady = r;
      });

      mockQueryImpl = (params): AsyncIterable<unknown> => {
        const opts = params.options as Record<string, unknown> | undefined;
        const ctrl = opts?.['abortController'] as AbortController | undefined;
        const signal = ctrl?.signal;

        return (async function* (): AsyncGenerator<never> {
          await new Promise<void>((_, reject) => {
            signal!.addEventListener('abort', () => {
              reject(new Error('Aborted'));
            });
            generatorReady();
          });
        })();
      };

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );

      // Suppress the error event so EventEmitter doesn't throw
      stream.on('error', () => {
        // intentionally suppressed
      });

      // Wait until the generator has registered its abort listener
      await generatorStarted;

      stream.cancel();

      await expect(stream.sessionId()).rejects.toBeInstanceOf(PlatformCancellationError);
    });

    it('emits PlatformCancellationError when both abort and SDK error arrive concurrently', async () => {
      // Arrange: the generator signals it is ready, then we trigger both cancel()
      // and a simulated SDK error at the same time. The abort flag takes precedence
      // in the catch block, so the emitted error must be PlatformCancellationError.
      let generatorReady!: () => void;
      const generatorStarted = new Promise<void>((r) => {
        generatorReady = r;
      });

      mockQueryImpl = (params): AsyncIterable<unknown> => {
        const opts = params.options as Record<string, unknown> | undefined;
        const ctrl = opts?.['abortController'] as AbortController | undefined;
        const signal = ctrl?.signal;

        return (async function* (): AsyncGenerator<never> {
          await new Promise<void>((_, reject) => {
            // Reject on abort (simulates the SDK throwing when the signal fires)
            signal!.addEventListener('abort', () => {
              reject(new Error('SDK error on abort'));
            });
            generatorReady();
          });
        })();
      };

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );

      // Suppress the expected sessionId rejection so it doesn't leak as unhandled
      stream.sessionId().catch(() => {
        // intentionally suppressed
      });

      // Wait until the generator has registered its abort listener
      await generatorStarted;

      // cancel() sets abortController.signal.aborted = true, then the generator
      // throws its own error — both arrive concurrently in the catch block.
      stream.cancel();

      const err = await waitForEvent<PlatformError>(stream, 'error');

      // Cancellation must win: the abort flag takes precedence over any SDK error
      expect(err).toBeInstanceOf(PlatformCancellationError);
      expect(err.code).toBe('PLATFORM_CANCELLED');
    });
  });

  describe('SDK failure', () => {
    it('emits "error" with PlatformError when the SDK throws', async () => {
      mockQueryImpl = (): AsyncIterable<unknown> => makeThrowingIterable('SDK network failure');

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );
      // Consume the sessionId rejection so it doesn't leak
      stream.sessionId().catch(() => {
        // intentionally suppressed
      });

      const err = await waitForEvent<PlatformError>(stream, 'error');

      expect(err).toBeInstanceOf(PlatformError);
      expect(err.code).toBe('PLATFORM_ERROR');
      expect(err.message).toBe('SDK network failure');
    });

    it('rejects sessionId() with PlatformError when the SDK throws before yielding a session_id', async () => {
      mockQueryImpl = (): AsyncIterable<unknown> =>
        makeThrowingIterable('SDK failure before session');

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );

      // Suppress the error event so EventEmitter doesn't throw for the unhandled error emission
      stream.on('error', () => {
        // intentionally suppressed
      });

      await expect(stream.sessionId()).rejects.toBeInstanceOf(PlatformError);
    });

    it('surfaces SDK error message in the emitted PlatformError', async () => {
      mockQueryImpl = (): AsyncIterable<unknown> => makeThrowingIterable('connection refused');

      const stream = new ClaudeStream(
        (await import('@anthropic-ai/claude-agent-sdk')).query,
        'prompt',
        defaultOptions
      );
      // Consume the sessionId rejection so it doesn't leak
      stream.sessionId().catch(() => {
        // intentionally suppressed
      });

      const err = await waitForEvent<PlatformError>(stream, 'error');

      expect(err.message).toBe('connection refused');
    });
  });

  describe('independent state between instances', () => {
    it('two concurrent ClaudeStream instances do not share AbortControllers', async () => {
      const abortSignals: AbortSignal[] = [];

      mockQueryImpl = (params): AsyncIterable<unknown> => {
        const opts = params.options as Record<string, unknown> | undefined;
        const ctrl = opts?.['abortController'] as AbortController | undefined;
        if (ctrl) {
          abortSignals.push(ctrl.signal);
        }

        return makeIterable([makeStreamEventMessage('data', 'session-a')]);
      };

      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const stream1 = new ClaudeStream(query, 'prompt1', defaultOptions);
      const stream2 = new ClaudeStream(query, 'prompt2', defaultOptions);

      const { done: done1 } = collectEvents(stream1);
      const { done: done2 } = collectEvents(stream2);
      await Promise.all([done1, done2]);

      expect(abortSignals).toHaveLength(2);
      expect(abortSignals[0]).not.toBe(abortSignals[1]);
    });

    it('cancelling one stream does not affect the other', async () => {
      // Track which stream gets aborted by capturing signals
      const signals: AbortSignal[] = [];
      mockQueryImpl = (params): AsyncIterable<unknown> => {
        const opts = params.options as Record<string, unknown> | undefined;
        const ctrl = opts?.['abortController'] as AbortController | undefined;
        if (ctrl) {
          signals.push(ctrl.signal);
        }

        return makeIterable([makeStreamEventMessage('data', 'session-x')]);
      };

      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const stream1 = new ClaudeStream(query, 'p1', defaultOptions);
      const stream2 = new ClaudeStream(query, 'p2', defaultOptions);

      const { done: done1 } = collectEvents(stream1);
      const { done: done2 } = collectEvents(stream2);
      await Promise.all([done1, done2]);

      // Abort stream1 after both complete
      stream1.cancel();

      // The abort signal for stream2 must NOT be aborted
      expect(signals[1]!.aborted).toBe(false);
      // The abort signal for stream1 must be aborted
      expect(signals[0]!.aborted).toBe(true);
    });
  });
});
