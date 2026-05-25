import { describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../../../../../src/core/platform/claude/adapter.ts';

// ---------------------------------------------------------------------------
// SDK mock — same shape as stream.test.ts
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  class AbortError extends Error {
    constructor(message?: string) {
      super(message ?? 'Aborted');
      this.name = 'AbortError';
    }
  }

  const query = vi.fn(async function* (_params: {
    prompt: string;
    options?: Record<string, unknown>;
  }): AsyncGenerator<Record<string, unknown>, void> {
    await Promise.resolve();
    // Minimal valid stream: one assistant message with a session_id then done
    yield {
      type: 'assistant',
      session_id: 'adapter-session',
      message: {},
      parent_tool_use_id: null,
      uuid: 'uuid-adapter',
    };
  });

  return { AbortError, query };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeAdapter', () => {
  describe('run()', () => {
    it('run() returns a stream that emits done on completion', async () => {
      const adapter = new ClaudeCodeAdapter();
      const stream = adapter.run('hello', {});

      let doneEmitted = false;
      stream.on('done', () => {
        doneEmitted = true;
      });

      // Wait for the mock generator to complete
      await stream.sessionId();
      // Flush remaining microtasks so the done event has time to fire
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(doneEmitted).toBe(true);
    });

    it('sessionId() resolves to the session id emitted by the SDK', async () => {
      const adapter = new ClaudeCodeAdapter();
      const stream = adapter.run('hello', {});

      await expect(stream.sessionId()).resolves.toBe('adapter-session');
    });

    it('forwards ClaudeOptions to the underlying stream (model propagates)', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryMock = vi.mocked(mockedQuery);
      queryMock.mockClear();

      const adapter = new ClaudeCodeAdapter();
      adapter.run('test prompt', { model: 'claude-opus-4-5', allowed_tools: ['Read', 'Write'] });

      expect(queryMock).toHaveBeenCalledOnce();
      interface MockCallArg {
        prompt: string;
        options: Record<string, unknown>;
      }
      const [call] = queryMock.mock.lastCall! as [MockCallArg];
      expect(call.prompt).toBe('test prompt');

      const { options: opts } = call;
      expect(opts['model']).toBe('claude-opus-4-5');
      expect(opts['allowedTools']).toEqual(['Read', 'Write']);
    });

    it('passes sessionId through to the SDK as the resume option when provided', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryMock = vi.mocked(mockedQuery);
      queryMock.mockClear();

      const adapter = new ClaudeCodeAdapter();
      adapter.run('continue prompt', {}, 'resume-session-id');

      expect(queryMock).toHaveBeenCalledOnce();
      const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
      expect(opts['resume']).toBe('resume-session-id');
    });

    it('does not set resume option when no sessionId argument is provided', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryMock = vi.mocked(mockedQuery);
      queryMock.mockClear();

      const adapter = new ClaudeCodeAdapter();
      adapter.run('fresh prompt', {});

      const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
      expect(opts['resume']).toBeUndefined();
    });

    it('sets includePartialMessages to true in all run() calls', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryMock = vi.mocked(mockedQuery);
      queryMock.mockClear();

      const adapter = new ClaudeCodeAdapter();
      adapter.run('any prompt', {});

      const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
      expect(opts['includePartialMessages']).toBe(true);
    });
  });
});
