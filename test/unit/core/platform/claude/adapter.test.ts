import { describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../../../../../src/core/platform/claude/adapter.ts';

// SDK mock — same shape as stream.test.ts
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

describe('ClaudeCodeAdapter', () => {
  describe('run()', () => {
    it('forwards all ClaudeOptions fields with correct SDK key renames', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryMock = vi.mocked(mockedQuery);
      queryMock.mockClear();

      const adapter = await ClaudeCodeAdapter.create();
      const stream = adapter.run('prompt', {
        model: 'claude-opus-4-5',
        reasoning_effort: 'high',
        allowed_tools: ['Read'],
        disallowed_tools: ['Bash'],
        skills: [],
        max_budget_usd: 5.0,
        system_prompt: 'You are helpful.',
        sandbox: { type: 'docker' },
      });
      await stream.start();

      const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
      expect(opts['model']).toBe('claude-opus-4-5');
      expect(opts['effort']).toBe('high');
      expect(opts['allowedTools']).toEqual(['Read']);
      expect(opts['disallowedTools']).toEqual(['Bash']);
      expect(opts['skills']).toEqual([]);
      expect(opts['maxBudgetUsd']).toBe(5.0);
      expect(opts['systemPrompt']).toBe('You are helpful.');
      expect(opts['sandbox']).toEqual({ type: 'docker' });
    });

    it('passes sessionId through to the SDK as the resume option when provided', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryMock = vi.mocked(mockedQuery);
      queryMock.mockClear();

      const adapter = await ClaudeCodeAdapter.create();
      await adapter.run('continue prompt', {}, 'resume-session-id').start();

      expect(queryMock).toHaveBeenCalledOnce();
      const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
      expect(opts['resume']).toBe('resume-session-id');
    });

    it('does not set resume option when no sessionId argument is provided', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryMock = vi.mocked(mockedQuery);
      queryMock.mockClear();

      const adapter = await ClaudeCodeAdapter.create();
      await adapter.run('fresh prompt', {}).start();

      const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
      expect(opts['resume']).toBeUndefined();
    });

    it('sets includePartialMessages to true in all run() calls', async () => {
      const { query: mockedQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const queryMock = vi.mocked(mockedQuery);
      queryMock.mockClear();

      const adapter = await ClaudeCodeAdapter.create();
      await adapter.run('any prompt', {}).start();

      const opts = queryMock.mock.calls[0]![0].options as Record<string, unknown>;
      expect(opts['includePartialMessages']).toBe(true);
    });

    it('returns a stream that emits done on completion', async () => {
      const adapter = await ClaudeCodeAdapter.create();
      const stream = adapter.run('hello', {});
      const donePromise = new Promise<void>((resolve) => stream.on('done', resolve));
      void stream.start();
      await donePromise;
    });

    it('sessionId() resolves to the session id emitted by the SDK', async () => {
      const adapter = await ClaudeCodeAdapter.create();
      const stream = adapter.run('hello', {});
      void stream.start();
      await expect(stream.sessionId()).resolves.toBe('adapter-session');
    });
  });
});
