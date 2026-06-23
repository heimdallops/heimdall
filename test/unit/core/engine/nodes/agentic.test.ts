import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { createEngineEmitter } from '../../../../../src/core/engine/emitter.ts';
import { NodeError } from '../../../../../src/core/engine/errors.ts';
import {
  AgentNode,
  PromptFileNode,
  PromptNode,
} from '../../../../../src/core/engine/nodes/agentic.ts';
import type {
  ExecutionContext,
  NodeRunCompleted,
  NodeRunFailed,
  NodeRunOptions,
  PlatformAdapter,
  PlatformRuntime,
  PlatformStream,
} from '../../../../../src/core/engine/nodes/base.ts';
import type { Platform } from '../../../../../src/core/platform/index.ts';

// ---------------------------------------------------------------------------
// Fake PlatformStream
// ---------------------------------------------------------------------------

/**
 * A test-driven PlatformStream. on() records handlers; emitChunk/emitDone/emitError
 * fire them. The node registers its handlers synchronously when adapter.run() returns,
 * so sequence every emit through afterAdapterCalled() — emitting before the handlers
 * are registered drops the event.
 */
class FakeStream implements PlatformStream {
  private readonly handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  private readonly _sessionIdPromise: Promise<string>;
  private resolveSessionId!: (id: string) => void;
  private rejectSessionId!: (err: unknown) => void;
  public cancelCalled = false;

  public constructor() {
    this._sessionIdPromise = new Promise<string>((res, rej) => {
      this.resolveSessionId = res;
      this.rejectSessionId = rej;
    });
    // Prevent unhandled rejection when sessionId() is never awaited by the test
    this._sessionIdPromise.catch(() => undefined);
  }

  public on(event: string, handler: (...args: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(handler);

    return this;
  }

  public cancel(): void {
    this.cancelCalled = true;
  }

  public sessionId(): Promise<string> {
    return this._sessionIdPromise;
  }

  // Trigger helpers — call via afterAdapterCalled() so the node's handlers exist first.

  public emitChunk(delta: string): void {
    for (const h of this.handlers['chunk'] ?? []) {
      h(delta);
    }
  }

  /**
   * Emit done. If sessionId is provided the stream's sessionId() promise resolves with it;
   * otherwise it rejects (testing the "no session" path).
   */
  public emitDone(sid?: string): void {
    if (sid !== undefined) {
      this.resolveSessionId(sid);
    } else {
      this.rejectSessionId(new Error('no session id'));
    }

    for (const h of this.handlers['done'] ?? []) {
      h();
    }
  }

  public emitError(err: unknown): void {
    for (const h of this.handlers['error'] ?? []) {
      h(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Fake PlatformAdapter
// ---------------------------------------------------------------------------

interface AdapterCall {
  prompt: string;
  options: Record<string, unknown>;
  sessionId: string | undefined;
}

class FakeAdapter implements PlatformAdapter {
  public calls: AdapterCall[] = [];
  public stream: FakeStream;

  public constructor(stream?: FakeStream) {
    this.stream = stream ?? new FakeStream();
  }

  public run(prompt: string, options: Record<string, unknown>, sessionId?: string): PlatformStream {
    this.calls.push({ prompt, options, sessionId });

    return this.stream;
  }

  public findAgent(_name: string): Promise<string> {
    return Promise.resolve('');
  }

  public parseAgent(_content: string): { prompt: string; options: Record<string, unknown> } {
    return { prompt: '', options: {} };
  }
}

/**
 * Emits a chunk on the microtask immediately after run() returns, before any test code
 * touches the stream. The node must register its handlers synchronously when run()
 * returns to catch it; if a change ever attaches them after an await, the chunk fires
 * into that gap and is lost.
 */
class EagerAdapter extends FakeAdapter {
  public override run(
    prompt: string,
    options: Record<string, unknown>,
    sessionId?: string
  ): PlatformStream {
    const stream = super.run(prompt, options, sessionId);
    queueMicrotask(() => {
      this.stream.emitChunk('eager');
    });

    return stream;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emitter = createEngineEmitter();

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  sessionDir: '/tmp/session',
  cwd: '/tmp/work',
  ...overrides,
});

const makeRuntime = (
  adapter: FakeAdapter,
  overrides: Partial<PlatformRuntime> = {}
): PlatformRuntime => ({
  factory: () => Promise.resolve(adapter),
  defaultPlatform: 'claude',
  ...overrides,
});

const makeOptions = (
  runtime: PlatformRuntime,
  overrides: Partial<NodeRunOptions> = {}
): NodeRunOptions => ({
  ctx: makeCtx(),
  platform: runtime,
  emitter,
  signal: new AbortController().signal,
  ...overrides,
});

/**
 * Run fn once the node has called adapter.run(), by which point its stream handlers
 * are attached (the node registers them synchronously when run() returns). Polls the
 * observable call count rather than assuming a fixed number of ticks, so it holds no
 * matter how much async work resolvePrompt() does first. Sequence every stream emit
 * through this.
 */
const afterAdapterCalled = (adapter: FakeAdapter, fn: () => void): void => {
  const poll = (): void => {
    if (adapter.calls.length > 0) {
      fn();
    } else {
      setImmediate(poll);
    }
  };
  setImmediate(poll);
};

// ---------------------------------------------------------------------------
// Temp dir management for PromptFileNode tests
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

beforeEach(() => {
  tempDirs = [];
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(os.tmpdir(), 'heimdall-agentic-'));
  tempDirs.push(dir);

  return dir;
};

// ---------------------------------------------------------------------------
// PromptNode
// ---------------------------------------------------------------------------

describe('PromptNode', () => {
  describe('PromptNode.matches', () => {
    it('returns true when raw object has a prompt key', () => {
      expect(PromptNode.matches({ id: 'n1', prompt: 'Hello' })).toBe(true);
    });

    it('returns false when raw object has an agent key but no prompt key', () => {
      expect(PromptNode.matches({ id: 'n1', agent: 'my-agent' })).toBe(false);
    });

    it('returns false when raw object has a prompt_file key but no prompt key', () => {
      expect(PromptNode.matches({ id: 'n1', prompt_file: 'file.md' })).toBe(false);
    });

    it('returns false when raw object has no discriminating key', () => {
      expect(PromptNode.matches({ id: 'n1' })).toBe(false);
    });
  });

  describe('PromptNode.parse', () => {
    it('throws ZodError when id contains invalid characters', () => {
      expect(() => PromptNode.parse({ id: 'bad-id', prompt: 'Hello' })).toThrow(ZodError);
    });

    it('throws ZodError when prompt field is missing', () => {
      expect(() => PromptNode.parse({ id: 'n1' })).toThrow(ZodError);
    });

    it('produces a node that passes the prompt to the adapter when run', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'Hello World' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls).toHaveLength(1);
      expect(adapter.calls[0]!.prompt).toBe('Hello World');
    });
  });

  describe('prompt interpolation', () => {
    it('passes interpolated prompt to the adapter', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'Hello ${{ inputs.name }}' });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ inputs: { name: 'World' } });
      const runPromise = node.run(makeOptions(runtime, { ctx }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.prompt).toBe('Hello World');
    });

    it('keeps the literal text when there are no interpolation markers', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'No substitution here' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.prompt).toBe('No substitution here');
    });
  });

  describe('session wiring', () => {
    it('passes predecessorSessionId to adapter.run when context is shared', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi', context: 'shared' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime, { predecessorSessionId: 'sess-abc' }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.sessionId).toBe('sess-abc');
    });

    it('passes undefined to adapter.run when context is clean', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi', context: 'clean' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(
        makeOptions(runtime, { predecessorSessionId: 'sess-should-be-ignored' })
      );
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.sessionId).toBeUndefined();
    });

    it('passes undefined to adapter.run when context is absent', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(
        makeOptions(runtime, { predecessorSessionId: 'sess-should-be-ignored' })
      );
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.sessionId).toBeUndefined();
    });
  });

  describe('output_format', () => {
    it('passes output_format object to adapter.run options unchanged', async () => {
      const format = { type: 'json_schema', schema: { type: 'object' } };
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi', output_format: format });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.options['output_format']).toEqual(format);
    });

    it('does not include output_format in adapter options when it is absent', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect('output_format' in adapter.calls[0]!.options).toBe(false);
    });
  });

  describe('platform_options override', () => {
    it('node-level platform_options win over workflow defaultPlatformOptions per-key', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({
        id: 'n1',
        prompt: 'hi',
        platform_options: { model: 'node-model' },
      });
      const runtime = makeRuntime(adapter, {
        defaultPlatformOptions: { model: 'default-model', temperature: 0.5 },
      });
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.options['model']).toBe('node-model');
      expect(adapter.calls[0]!.options['temperature']).toBe(0.5);
    });

    it('workflow defaultPlatformOptions are used when no node-level options are set', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter, {
        defaultPlatformOptions: { model: 'default-model' },
      });
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.options['model']).toBe('default-model');
    });
  });

  describe('node-level platform override', () => {
    it('passes the node platform to the factory instead of the workflow defaultPlatform', async () => {
      const capturedPlatforms: string[] = [];
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi', platform: 'claude' });
      const runtime: PlatformRuntime = {
        factory: (p) => {
          capturedPlatforms.push(p);

          return Promise.resolve(adapter);
        },
        // Use a sentinel that differs from the node's own platform so the assertion only
        // passes when the node's platform ('claude') is actually used instead of the default.
        // Platform is a single-value enum ('claude'), so a double cast is required to produce
        // a distinguishable sentinel value without a compile error.
        defaultPlatform: 'other-platform' as unknown as Platform,
      };
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      // If the node-override logic were removed, the factory would receive 'other-platform'
      // and this assertion would fail — proving that node.platform is what drives the call.
      expect(capturedPlatforms).toHaveLength(1);
      expect(capturedPlatforms[0]).toBe('claude');
    });
  });

  describe('stream consumption', () => {
    it('concatenates chunk deltas into result.output on done', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitChunk('Hello');
        adapter.stream.emitChunk(', ');
        adapter.stream.emitChunk('World');
        adapter.stream.emitDone('sess-1');
      });
      const result = await runPromise;

      expect(result.status).toBe('completed');
      expect((result as NodeRunCompleted).result['output']).toBe('Hello, World');
    });

    it('result output is an empty string when no chunks are emitted before done', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      const result = await runPromise;

      expect(result.status).toBe('completed');
      expect((result as NodeRunCompleted).result['output']).toBe('');
    });

    it('includes sessionId from the stream on completion', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-xyz');
      });
      const result = await runPromise;

      expect(result.status).toBe('completed');
      expect((result as NodeRunCompleted).sessionId).toBe('sess-xyz');
    });

    it('omits sessionId from the result when stream sessionId() rejects', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      // sessionId() rejects when emitDone() is called with no sid; the node swallows the rejection
      // and omits sessionId from the result rather than propagating the error.
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone();
      });
      const result = await runPromise;

      expect(result.status).toBe('completed');
      expect('sessionId' in result).toBe(false);
    });

    it('returns status failed with the error when stream emits an error event', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      const boom = new Error('adapter blew up');
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitError(boom);
      });
      const result = await runPromise;

      expect(result.status).toBe('failed');
      expect((result as NodeRunFailed).error).toBe(boom);
    });
  });

  describe('signal / cancellation', () => {
    it('calls stream.cancel() when the abort signal fires after run starts', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter);
      const controller = new AbortController();

      const runPromise = node.run(makeOptions(runtime, { signal: controller.signal }));

      afterAdapterCalled(adapter, () => {
        controller.abort();
        // Settle the promise after aborting so run() doesn't hang
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.stream.cancelCalled).toBe(true);
    });

    it('calls stream.cancel() immediately when signal is already aborted before run', async () => {
      const adapter = new FakeAdapter();
      const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
      const runtime = makeRuntime(adapter);

      const runPromise = node.run(makeOptions(runtime, { signal: AbortSignal.abort() }));

      // cancel() does not emit a terminal event; the promise only settles when done/error fires.
      // Without this explicit emitDone the test would hang.
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.stream.cancelCalled).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Synchronous listener attachment (shared consumeStream invariant)
// ---------------------------------------------------------------------------

describe('synchronous listener attachment', () => {
  it('captures a chunk emitted on the microtask after adapter.run() returns', async () => {
    const adapter = new EagerAdapter();
    const node = PromptNode.parse({ id: 'n1', prompt: 'hi' });
    const runtime = makeRuntime(adapter);
    const runPromise = node.run(makeOptions(runtime));
    afterAdapterCalled(adapter, () => {
      adapter.stream.emitDone('sess-1');
    });
    const result = await runPromise;

    expect(result.status).toBe('completed');
    expect((result as NodeRunCompleted).result['output']).toBe('eager');
  });
});

// ---------------------------------------------------------------------------
// AgentNode
// ---------------------------------------------------------------------------

describe('AgentNode', () => {
  describe('AgentNode.matches', () => {
    it('returns true when raw object has an agent key', () => {
      expect(AgentNode.matches({ id: 'n1', agent: 'my-agent' })).toBe(true);
    });

    it('returns false when raw object has a prompt key but no agent key', () => {
      expect(AgentNode.matches({ id: 'n1', prompt: 'Hello' })).toBe(false);
    });

    it('returns false when raw object has a prompt_file key but no agent key', () => {
      expect(AgentNode.matches({ id: 'n1', prompt_file: 'file.md' })).toBe(false);
    });
  });

  describe('AgentNode.parse', () => {
    it('throws ZodError when id contains invalid characters', () => {
      expect(() => AgentNode.parse({ id: 'bad-id', agent: 'my-agent' })).toThrow(ZodError);
    });

    it('throws ZodError when agent field is missing', () => {
      expect(() => AgentNode.parse({ id: 'n1' })).toThrow(ZodError);
    });
  });

  describe('agent field forwarded unresolved', () => {
    it('passes the raw agent string to adapter options without interpolation', async () => {
      const adapter = new FakeAdapter();
      // The agent name contains an interpolation marker; it must NOT be evaluated
      const node = AgentNode.parse({ id: 'n1', agent: 'my-${{ inputs.x }}' });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ inputs: { x: 'agent' } });
      const runPromise = node.run(makeOptions(runtime, { ctx }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.options['agent']).toBe('my-${{ inputs.x }}');
    });

    it('includes agent in adapter options even when instructions is absent', async () => {
      const adapter = new FakeAdapter();
      const node = AgentNode.parse({ id: 'n1', agent: 'code-reviewer' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.options['agent']).toBe('code-reviewer');
    });
  });

  describe('instructions interpolation', () => {
    it('passes interpolated instructions as the prompt', async () => {
      const adapter = new FakeAdapter();
      const node = AgentNode.parse({
        id: 'n1',
        agent: 'reviewer',
        instructions: 'Review ${{ inputs.target }}',
      });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ inputs: { target: 'src/main.ts' } });
      const runPromise = node.run(makeOptions(runtime, { ctx }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.prompt).toBe('Review src/main.ts');
    });

    it('passes empty string as the prompt when instructions is absent', async () => {
      const adapter = new FakeAdapter();
      const node = AgentNode.parse({ id: 'n1', agent: 'reviewer' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.prompt).toBe('');
    });
  });

  describe('session wiring', () => {
    it('passes predecessorSessionId to adapter.run when context is shared', async () => {
      const adapter = new FakeAdapter();
      const node = AgentNode.parse({ id: 'n1', agent: 'reviewer', context: 'shared' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime, { predecessorSessionId: 'sess-def' }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.sessionId).toBe('sess-def');
    });

    it('passes undefined to adapter.run when context is clean even when predecessorSessionId is supplied', async () => {
      const adapter = new FakeAdapter();
      const node = AgentNode.parse({ id: 'n1', agent: 'reviewer', context: 'clean' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(
        makeOptions(runtime, { predecessorSessionId: 'sess-should-be-ignored' })
      );
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.sessionId).toBeUndefined();
    });

    it('passes undefined to adapter.run when context is absent', async () => {
      const adapter = new FakeAdapter();
      const node = AgentNode.parse({ id: 'n1', agent: 'reviewer' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime, { predecessorSessionId: 'sess-ignored' }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.sessionId).toBeUndefined();
    });
  });

  describe('stream outcomes', () => {
    it('result output is the concatenated chunk deltas on done', async () => {
      const adapter = new FakeAdapter();
      const node = AgentNode.parse({ id: 'n1', agent: 'reviewer' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitChunk('chunk-a');
        adapter.stream.emitChunk('chunk-b');
        adapter.stream.emitDone('sess-1');
      });
      const result = await runPromise;

      expect(result.status).toBe('completed');
      expect((result as NodeRunCompleted).result['output']).toBe('chunk-achunk-b');
    });

    it('returns status failed with the error when stream emits an error event', async () => {
      const adapter = new FakeAdapter();
      const node = AgentNode.parse({ id: 'n1', agent: 'reviewer' });
      const runtime = makeRuntime(adapter);
      const runPromise = node.run(makeOptions(runtime));
      const boom = new Error('stream failed');
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitError(boom);
      });
      const result = await runPromise;

      expect(result.status).toBe('failed');
      expect((result as NodeRunFailed).error).toBe(boom);
    });
  });
});

// ---------------------------------------------------------------------------
// PromptFileNode
// ---------------------------------------------------------------------------

describe('PromptFileNode', () => {
  describe('PromptFileNode.matches', () => {
    it('returns true when raw object has a prompt_file key', () => {
      expect(PromptFileNode.matches({ id: 'n1', prompt_file: 'prompt.md' })).toBe(true);
    });

    it('returns false when raw object has a prompt key but no prompt_file key', () => {
      expect(PromptFileNode.matches({ id: 'n1', prompt: 'Hello' })).toBe(false);
    });

    it('returns false when raw object has an agent key but no prompt_file key', () => {
      expect(PromptFileNode.matches({ id: 'n1', agent: 'my-agent' })).toBe(false);
    });
  });

  describe('PromptFileNode.parse', () => {
    it('throws ZodError when id contains invalid characters', () => {
      expect(() => PromptFileNode.parse({ id: 'bad-id', prompt_file: 'file.md' })).toThrow(
        ZodError
      );
    });

    it('throws ZodError when prompt_file field is missing', () => {
      expect(() => PromptFileNode.parse({ id: 'n1' })).toThrow(ZodError);
    });
  });

  describe('file reading and interpolation', () => {
    it('reads file contents and passes them to the adapter as the prompt', async () => {
      const cwd = await makeTempDir();
      await writeFile(join(cwd, 'prompt.md'), 'Hello from file', 'utf8');

      const adapter = new FakeAdapter();
      const node = PromptFileNode.parse({ id: 'n1', prompt_file: 'prompt.md' });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ cwd });
      const runPromise = node.run(makeOptions(runtime, { ctx }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.prompt).toBe('Hello from file');
    });

    it('interpolates CEL expressions in the file contents before passing to adapter', async () => {
      const cwd = await makeTempDir();
      await writeFile(join(cwd, 'prompt.md'), 'Hello ${{ inputs.name }}', 'utf8');

      const adapter = new FakeAdapter();
      const node = PromptFileNode.parse({ id: 'n1', prompt_file: 'prompt.md' });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ cwd, inputs: { name: 'World' } });
      const runPromise = node.run(makeOptions(runtime, { ctx }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.prompt).toBe('Hello World');
    });

    it('resolves the prompt_file path relative to ctx.cwd', async () => {
      const { mkdir } = await import('node:fs/promises');
      const cwd = await makeTempDir();
      await mkdir(join(cwd, 'prompts'));
      await writeFile(join(cwd, 'prompts', 'step1.md'), 'step content', 'utf8');

      const adapter = new FakeAdapter();
      const node = PromptFileNode.parse({ id: 'n1', prompt_file: 'prompts/step1.md' });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ cwd });
      const runPromise = node.run(makeOptions(runtime, { ctx }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.prompt).toBe('step content');
    });
  });

  describe('missing file failure', () => {
    it('does not call adapter.run when the file is missing, and throws NodeError', async () => {
      const cwd = await makeTempDir();
      const adapter = new FakeAdapter();
      const node = PromptFileNode.parse({ id: 'n1', prompt_file: 'nonexistent.md' });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ cwd });

      let caught: unknown;
      try {
        await node.run(makeOptions(runtime, { ctx }));
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(NodeError);
      expect((caught as NodeError).code).toBe('ENGINE_PROMPT_FILE_READ_ERROR');
      // The adapter must NOT have been called
      expect(adapter.calls).toHaveLength(0);
    });

    it('NodeError message identifies the missing file', async () => {
      const cwd = await makeTempDir();
      const adapter = new FakeAdapter();
      const node = PromptFileNode.parse({ id: 'n1', prompt_file: 'missing-prompt.md' });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ cwd });

      let caught: unknown;
      try {
        await node.run(makeOptions(runtime, { ctx }));
      } catch (err) {
        caught = err;
      }

      expect((caught as NodeError).message).toContain('missing-prompt.md');
    });
  });

  describe('session wiring', () => {
    it('passes predecessorSessionId to adapter.run when context is shared', async () => {
      const cwd = await makeTempDir();
      await writeFile(join(cwd, 'prompt.md'), 'hi', 'utf8');

      const adapter = new FakeAdapter();
      const node = PromptFileNode.parse({
        id: 'n1',
        prompt_file: 'prompt.md',
        context: 'shared',
      });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ cwd });
      const runPromise = node.run(makeOptions(runtime, { ctx, predecessorSessionId: 'sess-ghi' }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.sessionId).toBe('sess-ghi');
    });

    it('passes undefined to adapter.run when context is absent', async () => {
      const cwd = await makeTempDir();
      await writeFile(join(cwd, 'prompt.md'), 'hi', 'utf8');

      const adapter = new FakeAdapter();
      const node = PromptFileNode.parse({ id: 'n1', prompt_file: 'prompt.md' });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ cwd });
      const runPromise = node.run(
        makeOptions(runtime, { ctx, predecessorSessionId: 'sess-ignored' })
      );
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.sessionId).toBeUndefined();
    });

    it('passes undefined to adapter.run when context is clean even when predecessorSessionId is supplied', async () => {
      const cwd = await makeTempDir();
      await writeFile(join(cwd, 'prompt.md'), 'hi', 'utf8');

      const adapter = new FakeAdapter();
      const node = PromptFileNode.parse({
        id: 'n1',
        prompt_file: 'prompt.md',
        context: 'clean',
      });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ cwd });
      const runPromise = node.run(
        makeOptions(runtime, { ctx, predecessorSessionId: 'sess-should-be-ignored' })
      );
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitDone('sess-1');
      });
      await runPromise;

      expect(adapter.calls[0]!.sessionId).toBeUndefined();
    });
  });

  describe('stream outcomes', () => {
    it('result output is the concatenated chunks emitted by the adapter', async () => {
      const cwd = await makeTempDir();
      await writeFile(join(cwd, 'prompt.md'), 'file prompt', 'utf8');

      const adapter = new FakeAdapter();
      const node = PromptFileNode.parse({ id: 'n1', prompt_file: 'prompt.md' });
      const runtime = makeRuntime(adapter);
      const ctx = makeCtx({ cwd });
      const runPromise = node.run(makeOptions(runtime, { ctx }));
      afterAdapterCalled(adapter, () => {
        adapter.stream.emitChunk('response text');
        adapter.stream.emitDone('sess-1');
      });
      const result = await runPromise;

      expect(result.status).toBe('completed');
      expect((result as NodeRunCompleted).result['output']).toBe('response text');
    });
  });
});

// ---------------------------------------------------------------------------
// nodeRegistry integration — nodes self-register on import
// ---------------------------------------------------------------------------

describe('nodeRegistry integration', () => {
  it('PromptNode is discoverable via nodeRegistry.parseNode for a raw object with a prompt key', async () => {
    // Import the registry after the agentic module has side-effect-registered the nodes
    const { nodeRegistry } = await import('../../../../../src/core/engine/nodes/registry.ts');
    const node = nodeRegistry.parseNode({ id: 'n1', prompt: 'Hello' });
    // id is round-tripped through schema parsing and stored on the node; if parseNode routed the
    // discriminant to the wrong type or failed to construct the node this would throw or return
    // a node with no id.
    expect(node.id).toBe('n1');
  });

  it('AgentNode is discoverable via nodeRegistry.parseNode for a raw object with an agent key', async () => {
    const { nodeRegistry } = await import('../../../../../src/core/engine/nodes/registry.ts');
    const node = nodeRegistry.parseNode({ id: 'n1', agent: 'my-agent' });
    expect(node.id).toBe('n1');
  });

  it('PromptFileNode is discoverable via nodeRegistry.parseNode for a raw object with a prompt_file key', async () => {
    const { nodeRegistry } = await import('../../../../../src/core/engine/nodes/registry.ts');
    const node = nodeRegistry.parseNode({ id: 'n1', prompt_file: 'file.md' });
    expect(node.id).toBe('n1');
  });
});
