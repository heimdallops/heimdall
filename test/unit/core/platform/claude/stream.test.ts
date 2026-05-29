import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeStream } from '../../../../../src/core/platform/claude/stream.ts';
import {
  PlatformCancellationError,
  PlatformError,
} from '../../../../../src/core/platform/errors.ts';

// ---------------------------------------------------------------------------
// SDK mock helpers
// ---------------------------------------------------------------------------

type SDKMessage = Record<string, unknown>;

let mockGeneratorFactory: () => AsyncGenerator<SDKMessage, void>;
let capturedAbortController: AbortController | undefined;

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  class AbortError extends Error {
    constructor(message?: string) {
      super(message ?? 'Aborted');
      this.name = 'AbortError';
    }
  }

  const query = vi.fn((_params: { prompt: string; options?: Record<string, unknown> }) => {
    const opts = _params.options;

    capturedAbortController = opts?.['abortController'] as AbortController | undefined;

    const gen = mockGeneratorFactory();

    return gen;
  });

  return { AbortError, query };
});

// Utility: build a minimal SDKPartialAssistantMessage with a text_delta
const makeChunk = (text: string, sessionId = 'sess-1'): SDKMessage => ({
  type: 'stream_event',
  session_id: sessionId,
  event: {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text },
  },
});

// Utility: build a minimal SDKAssistantMessage (full message, no text deltas)
const makeAssistantMessage = (sessionId = 'sess-1'): SDKMessage => ({
  type: 'assistant',
  session_id: sessionId,
  message: {},
  parent_tool_use_id: null,
  uuid: 'uuid-1',
});

// Utility: build a minimal SDKResultSuccess (terminal completion)
const makeResultMessage = (sessionId = 'sess-1'): SDKMessage => ({
  type: 'result',
  subtype: 'success',
  session_id: sessionId,
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: 'done',
  stop_reason: null,
  total_cost_usd: 0,
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: 'uuid-2',
});

// Utility: wait for all pending microtasks / promises to settle
const flushMicrotasks = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

// Collect events emitted on a ClaudeStream into typed arrays
interface Captured {
  chunks: string[];
  done: boolean;
  errors: PlatformError[];
}

const captureEvents = (stream: ClaudeStream): Captured => {
  const result: Captured = { chunks: [], done: false, errors: [] };

  stream.on('chunk', (delta) => result.chunks.push(delta));
  stream.on('done', () => (result.done = true));
  stream.on('error', (err) => result.errors.push(err));

  return result;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedAbortController = undefined;
});

describe('ClaudeStream', () => {
  describe("'chunk' events", () => {
    it('fires with string deltas from partial message events', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield makeChunk('Hello');
        yield makeChunk(', world');
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();

      await flushMicrotasks();

      expect(captured.chunks).toEqual(['Hello', ', world']);
    });

    it('does not fire for non-text-delta stream events', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield {
          type: 'stream_event',
          session_id: 'sess-1',
          event: { type: 'message_start', message: {} },
        };
        yield makeChunk('actual text');
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();

      await flushMicrotasks();

      expect(captured.chunks).toEqual(['actual text']);
    });
  });

  describe("'done' event", () => {
    it('fires after all messages complete', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield makeChunk('text');
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();

      await flushMicrotasks();

      expect(captured.done).toBe(true);
    });

    it('fires even when no chunks are emitted', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield makeAssistantMessage();
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();

      await flushMicrotasks();

      expect(captured.done).toBe(true);
      expect(captured.chunks).toHaveLength(0);
    });
  });

  describe('sessionId()', () => {
    it('resolves from the first SDK message that contains a session_id', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield makeAssistantMessage('my-session-42');
        yield makeChunk('text', 'my-session-42');
      };

      const stream = new ClaudeStream('test prompt', {});
      stream.start();
      const id = await stream.sessionId();

      expect(id).toBe('my-session-42');
    });

    it('resolves from a stream_event message when it is first', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield makeChunk('hello', 'stream-session');
      };

      const stream = new ClaudeStream('test prompt', {});
      stream.start();
      const id = await stream.sessionId();

      expect(id).toBe('stream-session');
    });

    it('skips messages without session_id before resolving', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        // SDKUserMessage has optional session_id — emit one without it
        yield { type: 'user', message: {}, parent_tool_use_id: null };
        yield makeAssistantMessage('late-session');
      };

      const stream = new ClaudeStream('test prompt', {});
      stream.start();
      const id = await stream.sessionId();

      expect(id).toBe('late-session');
    });

    it('rejects sessionId() with PlatformError when stream ends without emitting a session_id', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        // Yield messages that have no session_id field
        yield { type: 'user', message: {}, parent_tool_use_id: null };
        yield { type: 'user', message: {}, parent_tool_use_id: null };
        // Stream ends normally without any session_id
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();

      await expect(stream.sessionId()).rejects.toMatchObject({
        code: 'PLATFORM_ERROR',
      });

      await flushMicrotasks();

      expect(captured.done).toBe(false);
      expect(captured.errors).toHaveLength(1);
      expect(captured.errors[0]).toBeInstanceOf(PlatformError);
      expect(captured.errors[0]!.code).toBe('PLATFORM_ERROR');
    });
  });

  describe('cancel()', () => {
    // Pre-execution cancel: start() and cancel() fire on the same tick, so cancel()
    // aborts the AbortController before execute() has called query(). These tests
    // cover the "cancel before execution begins" path.

    it("triggers 'error' event with PlatformCancellationError (pre-execution cancel)", async () => {
      const { AbortError: SDKAbortError } = await import('@anthropic-ai/claude-agent-sdk');

      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        // Simulate the SDK throwing AbortError when cancelled
        throw new SDKAbortError('aborted');
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();
      stream.sessionId().catch(() => undefined); // suppress unhandled promise rejection
      stream.cancel(); // fires before execute() has called query()

      await flushMicrotasks();

      expect(captured.errors).toHaveLength(1);
      const [firstCancelError] = captured.errors;
      expect(firstCancelError).toBeInstanceOf(PlatformCancellationError);
      expect(firstCancelError!.code).toBe('PLATFORM_CANCELLED');
    });

    it("does not emit 'done' after 'error' when AbortError is thrown on cancel (pre-execution cancel)", async () => {
      const { AbortError: SDKAbortError } = await import('@anthropic-ai/claude-agent-sdk');

      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        throw new SDKAbortError('aborted');
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();
      stream.sessionId().catch(() => undefined); // suppress unhandled promise rejection
      stream.cancel(); // fires before execute() has called query()

      await flushMicrotasks();

      expect(captured.errors).toHaveLength(1);
      expect(captured.done).toBe(false);
    });

    it('rejects sessionId() promise with PlatformCancellationError on cancel (pre-execution cancel)', async () => {
      const { AbortError: SDKAbortError } = await import('@anthropic-ai/claude-agent-sdk');

      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        throw new SDKAbortError('aborted');
      };

      const stream = new ClaudeStream('test prompt', {});
      stream.start();
      stream.cancel(); // fires before execute() has called query()

      await expect(stream.sessionId()).rejects.toBeInstanceOf(PlatformCancellationError);
    });

    it('emits PlatformCancellationError when SDK returns early without throwing on abort (pre-execution cancel)', async () => {
      // SDK may silently terminate the generator instead of throwing AbortError
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        // returns without yielding or throwing — simulates silent abort
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();
      stream.sessionId().catch(() => undefined);
      stream.cancel(); // fires before execute() has called query()

      await flushMicrotasks();

      expect(captured.errors).toHaveLength(1);
      expect(captured.errors[0]).toBeInstanceOf(PlatformCancellationError);
      expect(captured.errors[0]!.code).toBe('PLATFORM_CANCELLED');
      expect(captured.done).toBe(false);
    });

    it("emits 'done' when stream receives a result message even if abort signal is set (race)", async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield makeChunk('hello');
        yield makeResultMessage();
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();

      await flushMicrotasks();
      stream.cancel();

      await flushMicrotasks();

      expect(captured.chunks).toEqual(['hello']);
      expect(captured.done).toBe(true);
      expect(captured.errors).toHaveLength(0);
      await expect(stream.sessionId()).resolves.toBe('sess-1');
    });

    it('wraps AbortError thrown by the SDK mid-stream in PlatformCancellationError', async () => {
      const { AbortError: SDKAbortError } = await import('@anthropic-ai/claude-agent-sdk');

      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield makeChunk('first chunk'); // execution begins, chunk emitted
        throw new SDKAbortError('aborted'); // SDK throws unconditionally (no cancel() call)
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();
      stream.sessionId().catch(() => undefined); // suppress unhandled promise rejection

      await flushMicrotasks();

      expect(captured.chunks).toEqual(['first chunk']);
      expect(captured.errors).toHaveLength(1);
      expect(captured.errors[0]).toBeInstanceOf(PlatformCancellationError);
      expect(captured.errors[0]!.code).toBe('PLATFORM_CANCELLED');
      expect(captured.done).toBe(false);
    });

    it('emits PlatformCancellationError when cancel() is called after a chunk arrives (mid-stream cancel)', async () => {
      const { AbortError: SDKAbortError } = await import('@anthropic-ai/claude-agent-sdk');

      let resolveChunkBarrier!: () => void;
      const chunkBarrier = new Promise<void>((r) => {
        resolveChunkBarrier = r;
      });

      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield makeChunk('first chunk');
        await chunkBarrier; // suspend until cancel() fires
        throw new SDKAbortError('aborted');
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();
      stream.sessionId().catch(() => undefined);

      await flushMicrotasks(); // let the first chunk arrive
      expect(captured.chunks).toEqual(['first chunk']);

      stream.cancel();
      resolveChunkBarrier();

      await flushMicrotasks();

      expect(captured.errors).toHaveLength(1);
      expect(captured.errors[0]).toBeInstanceOf(PlatformCancellationError);
      expect(captured.done).toBe(false);
    });
  });

  describe('lifecycle edge cases', () => {
    it('cancel() before start() does not throw, and subsequent start() terminates cleanly', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        // returns without yielding — simulates silent abort after AbortController was
        // already aborted before query() was called
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);

      // cancel() before start() must not throw
      expect(() => stream.cancel()).not.toThrow();

      stream.start();
      stream.sessionId().catch(() => undefined); // suppress unhandled promise rejection
      await flushMicrotasks();

      // AbortController was already aborted, so execute() should emit a
      // PlatformCancellationError and not emit 'done'
      expect(captured.errors).toHaveLength(1);
      expect(captured.errors[0]).toBeInstanceOf(PlatformCancellationError);
      expect(captured.done).toBe(false);
    });

    it('start() called twice returns the same promise and emits no duplicate events', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        yield makeChunk('hello');
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);

      const promise1 = stream.start();
      const promise2 = stream.start();

      expect(promise1).toBe(promise2);

      await flushMicrotasks();

      // No duplicate chunk or done events from a second execute() invocation
      expect(captured.chunks).toEqual(['hello']);
      expect(captured.done).toBe(true);
    });

    it('sessionId() before start() rejects with PlatformError with code PLATFORM_ERROR', async () => {
      const stream = new ClaudeStream('test prompt', {});

      await expect(stream.sessionId()).rejects.toMatchObject({
        code: 'PLATFORM_ERROR',
      });
      await expect(stream.sessionId()).rejects.toBeInstanceOf(PlatformError);
    });
  });

  describe('SDK failure', () => {
    it("emits 'error' event with PlatformError when SDK throws a non-abort error", async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        throw new Error('network failure');
      };

      const stream = new ClaudeStream('test prompt', {});
      const captured = captureEvents(stream);
      stream.start();
      // Suppress unhandled rejection on the sessionId promise — error is captured via 'error' event
      stream.sessionId().catch(() => undefined);

      await flushMicrotasks();

      expect(captured.errors).toHaveLength(1);
      const [firstSdkError] = captured.errors;
      expect(firstSdkError).toBeInstanceOf(PlatformError);
      expect(firstSdkError!.code).toBe('PLATFORM_ERROR');
    });

    it('rejects sessionId() promise with PlatformError on SDK failure', async () => {
      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        throw new Error('internal SDK error');
      };

      const stream = new ClaudeStream('test prompt', {});
      stream.on('error', () => {
        // prevent unhandled error event crash
      });
      stream.start();

      await expect(stream.sessionId()).rejects.toBeInstanceOf(PlatformError);
    });
  });

  describe('concurrent instances', () => {
    it('two ClaudeStream instances do not share AbortController state', async () => {
      const controllers: (AbortController | undefined)[] = [];

      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        controllers.push(capturedAbortController);
        yield makeChunk('a', 'sess-a');
      };

      const streamA = new ClaudeStream('prompt A', {});
      captureEvents(streamA);
      streamA.start();
      await flushMicrotasks();
      const [controllerA] = controllers;

      mockGeneratorFactory = async function* (): AsyncGenerator<SDKMessage, void> {
        await Promise.resolve();
        controllers.push(capturedAbortController);
        yield makeChunk('b', 'sess-b');
      };

      const streamB = new ClaudeStream('prompt B', {});
      captureEvents(streamB);
      streamB.start();
      await flushMicrotasks();
      const [, controllerB] = controllers;

      expect(controllerA).toBeDefined();
      expect(controllerB).toBeDefined();
      expect(controllerA).not.toBe(controllerB);

      // Cancelling one must not affect the other
      streamA.cancel();
      expect(controllerA!.signal.aborted).toBe(true);
      expect(controllerB!.signal.aborted).toBe(false);
    });
  });
});
