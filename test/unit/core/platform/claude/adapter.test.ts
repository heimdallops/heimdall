import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../../../../../src/core/platform/claude/adapter.ts';
import type { ClaudeOptions } from '../../../../../src/core/platform/claude/options.ts';

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/claude-agent-sdk
//
// The adapter passes the real `query` function from the SDK directly into
// ClaudeStream. By mocking the module here we intercept that call, allowing
// us to assert what the stream receives without spawning real agent processes.
// ---------------------------------------------------------------------------

interface QueryParams {
  prompt: string;
  options?: Record<string, unknown>;
}

const mockQueryCalls: QueryParams[] = [];
let mockQueryImpl: (params: QueryParams) => AsyncIterable<unknown>;

// Returns an AsyncIterable that yields a single assistant message so sessionId
// resolves and the "done" event fires. Uses a plain object with [Symbol.asyncIterator]
// to avoid async-generator require-await false-positives.
const defaultGen = (): AsyncIterable<{
  type: string;
  session_id: string;
  message: Record<string, never>;
  parent_tool_use_id: null;
  uuid: string;
}> => {
  interface Msg {
    type: string;
    session_id: string;
    message: Record<string, never>;
    parent_tool_use_id: null;
    uuid: string;
  }
  const messages: Msg[] = [
    {
      type: 'assistant',
      session_id: 'test-session-id',
      message: {},
      parent_tool_use_id: null,
      uuid: 'uuid-1',
    },
  ];
  let index = 0;

  return {
    [Symbol.asyncIterator](): AsyncIterator<Msg> {
      return {
        next(): Promise<IteratorResult<Msg>> {
          if (index < messages.length) {
            return Promise.resolve({ value: messages[index++]!, done: false });
          }

          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };
};

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: QueryParams): AsyncIterable<unknown> => {
    mockQueryCalls.push(params);

    return mockQueryImpl(params);
  },
}));

beforeEach(() => {
  mockQueryCalls.length = 0;
  mockQueryImpl = defaultGen;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const waitForEventNoArgs = (
  emitter: { once: (e: string, h: () => void) => void },
  event: string
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for: ${event}`));
    }, 2000);
    emitter.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });

const defaultOptions: ClaudeOptions = {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeAdapter', () => {
  describe('run()', () => {
    it('returns a PlatformStream immediately without awaiting anything', () => {
      const adapter = new ClaudeCodeAdapter('/some/cwd');
      const stream = adapter.run('Do something.', defaultOptions);

      // PlatformStream contract: must have on(), cancel(), and sessionId()
      expect(typeof stream.on).toBe('function');
      expect(typeof stream.cancel).toBe('function');
      expect(typeof stream.sessionId).toBe('function');
    });

    it('forwards the prompt to the SDK query function', async () => {
      const adapter = new ClaudeCodeAdapter('/some/cwd');
      const stream = adapter.run('My test prompt', defaultOptions);
      await waitForEventNoArgs(stream as never, 'done');

      expect(mockQueryCalls).toHaveLength(1);
      expect(mockQueryCalls[0]!.prompt).toBe('My test prompt');
    });

    it('forwards ClaudeOptions to the SDK via the stream options', async () => {
      const options: ClaudeOptions = {
        model: 'claude-opus-4-5',
        system_prompt: 'Be concise.',
        allowed_tools: ['Read', 'Write'],
      };

      const adapter = new ClaudeCodeAdapter('/some/cwd');
      const stream = adapter.run('prompt', options);
      await waitForEventNoArgs(stream as never, 'done');

      expect(mockQueryCalls).toHaveLength(1);
      const passedOptions = mockQueryCalls[0]!.options!;

      // The stream maps ClaudeOptions → SDK Options (camelCase)
      expect(passedOptions['model']).toBe('claude-opus-4-5');
      expect(passedOptions['systemPrompt']).toBe('Be concise.');
      expect(passedOptions['allowedTools']).toEqual(['Read', 'Write']);
    });

    it('passes sessionId as the resume option when provided', async () => {
      const adapter = new ClaudeCodeAdapter('/some/cwd');
      const stream = adapter.run('continue', defaultOptions, 'existing-session-123');
      await waitForEventNoArgs(stream as never, 'done');

      const passedOptions = mockQueryCalls[0]!.options!;
      expect(passedOptions['resume']).toBe('existing-session-123');
    });

    it('does not set resume option when sessionId is not provided', async () => {
      const adapter = new ClaudeCodeAdapter('/some/cwd');
      const stream = adapter.run('fresh prompt', defaultOptions);
      await waitForEventNoArgs(stream as never, 'done');

      const passedOptions = mockQueryCalls[0]!.options!;
      expect(passedOptions['resume']).toBeUndefined();
    });

    it('attaches an AbortController to the query options', async () => {
      const adapter = new ClaudeCodeAdapter('/some/cwd');
      const stream = adapter.run('prompt', defaultOptions);
      await waitForEventNoArgs(stream as never, 'done');

      const passedOptions = mockQueryCalls[0]!.options!;
      expect(passedOptions['abortController']).toBeInstanceOf(AbortController);
    });

    it('sets includePartialMessages in the query options', async () => {
      const adapter = new ClaudeCodeAdapter('/some/cwd');
      const stream = adapter.run('prompt', defaultOptions);
      await waitForEventNoArgs(stream as never, 'done');

      const passedOptions = mockQueryCalls[0]!.options!;
      expect(passedOptions['includePartialMessages']).toBe(true);
    });
  });
});
