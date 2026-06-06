import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  EngineEmitter,
  EngineEventMap,
  NodeCancelledEvent,
  NodeCompletedEvent,
  NodeFailedEvent,
  NodeSkippedEvent,
  NodeStartedEvent,
  WorkflowExitedEvent,
} from '../../../../src/core/engine/emitter.ts';
import { createEngineEmitter } from '../../../../src/core/engine/emitter.ts';
import { EngineError } from '../../../../src/core/engine/errors.ts';
import type {
  ExecutionContext,
  NodeRunOptions,
  NodeRunResult,
  PlatformAdapter,
} from '../../../../src/core/engine/nodes/base.ts';
import type { BaseNodeData } from '../../../../src/core/engine/nodes/base.ts';
import { BaseNode } from '../../../../src/core/engine/nodes/base.ts';
import type { SchedulerOptions } from '../../../../src/core/engine/scheduler.ts';
import { runScheduler } from '../../../../src/core/engine/scheduler.ts';

// ---------------------------------------------------------------------------
// Stub infrastructure
// ---------------------------------------------------------------------------

class StubNode extends BaseNode {
  private readonly result: NodeRunResult;

  constructor(data: BaseNodeData, result: NodeRunResult = { status: 'completed', result: {} }) {
    super(data);
    this.result = result;
  }

  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve(this.result);
  }
}

/**
 * A node whose run() result is controlled externally via resolve/reject
 * handles. Useful for verifying concurrent dispatch.
 */
class DeferredNode extends BaseNode {
  private resolveRun!: (result: NodeRunResult) => void;
  private rejectRun!: (err: unknown) => void;
  public readonly started: Promise<void>;
  private signalStarted!: () => void;
  private readonly runResult: Promise<NodeRunResult>;

  constructor(data: BaseNodeData) {
    super(data);
    this.started = new Promise<void>((res) => {
      this.signalStarted = res;
    });
    this.runResult = new Promise<NodeRunResult>((res, rej) => {
      this.resolveRun = res;
      this.rejectRun = rej;
    });
  }

  public resolve(result: NodeRunResult): void {
    this.resolveRun(result);
  }

  public reject(err: unknown): void {
    this.rejectRun(err);
  }

  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    this.signalStarted();

    return this.runResult;
  }
}

/**
 * A node that captures the NodeRunOptions it receives each time run() is
 * called — useful for asserting what the scheduler passes in.
 */
class CapturingNode extends BaseNode {
  public readonly capturedOptions: NodeRunOptions[] = [];
  private readonly result: NodeRunResult;

  constructor(data: BaseNodeData, result: NodeRunResult = { status: 'completed', result: {} }) {
    super(data);
    this.result = result;
  }

  public run(options: NodeRunOptions): Promise<NodeRunResult> {
    this.capturedOptions.push(options);

    return Promise.resolve(this.result);
  }
}

/**
 * A DeferredNode that also captures the AbortSignal passed by the scheduler.
 * Useful for asserting that controller.abort() is called after cancellation.
 */
class SignalCapturingDeferredNode extends DeferredNode {
  public capturedSignal: AbortSignal | undefined;

  public override run(options: NodeRunOptions): Promise<NodeRunResult> {
    this.capturedSignal = options.signal;

    return super.run(options);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const fakeAdapter: PlatformAdapter = {
  run: vi.fn(),
  findAgent: vi.fn(),
  parseAgent: vi.fn(),
};

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  sessionDir: '/tmp/session',
  ...overrides,
});

const makeOptions = (overrides: Partial<SchedulerOptions> = {}): SchedulerOptions => ({
  adapter: fakeAdapter,
  emitter: createEngineEmitter(),
  sharedContextMap: new Map(),
  ...overrides,
});

// Collect emitted events of a given type into an array
const collectEvents = <K extends keyof EngineEventMap>(
  emitter: EngineEmitter,
  event: K
): EngineEventMap[K][0][] => {
  const events: EngineEventMap[K][0][] = [];
  emitter.on(event, (payload) => {
    events.push(payload);
  });

  return events;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runScheduler', () => {
  let emitter: ReturnType<typeof createEngineEmitter>;
  let options: SchedulerOptions;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    emitter = createEngineEmitter();
    options = makeOptions({ emitter });
  });

  // -------------------------------------------------------------------------
  describe('dependency ordering', () => {
    it('does not start node B until node A has completed when B depends_on A', async () => {
      const order: string[] = [];

      const completedResult: NodeRunResult = { status: 'completed', result: { value: 'a' } };
      const nodeA = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          order.push('A:start');

          return Promise.resolve(completedResult).then((r) => {
            order.push('A:end');

            return r;
          });
        }
      })({ id: 'nodeA' });

      const nodeB = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          order.push('B:start');

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'nodeB', depends_on: ['nodeA'] });

      await runScheduler([nodeA, nodeB], makeCtx(), options);

      expect(order.indexOf('A:end')).toBeLessThan(order.indexOf('B:start'));
    });

    it('resolves with outcome: completed and success: true after A → B chain completes', async () => {
      const nodeA = new StubNode({ id: 'nodeA' }, { status: 'completed', result: { out: 1 } });
      const nodeB = new StubNode({ id: 'nodeB', depends_on: ['nodeA'] });

      const result = await runScheduler([nodeA, nodeB], makeCtx(), options);

      expect(result.outcome).toBe('completed');
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('concurrent dispatch', () => {
    it('dispatches two independent nodes concurrently — both start before either completes', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new DeferredNode({ id: 'nodeB' });

      // Start the scheduler without awaiting so both nodes can run concurrently with the test
      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      // Wait until both nodes have signalled they started
      await Promise.all([nodeA.started, nodeB.started]);

      // At this point neither has resolved yet, so they are truly concurrent
      nodeA.resolve({ status: 'completed', result: {} });
      nodeB.resolve({ status: 'completed', result: {} });

      const result = await schedulerDone;
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('skip propagation', () => {
    it('skips a node whose if expression evaluates to false', async () => {
      const node = new StubNode({ id: 'gated', if: 'false' });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      await runScheduler([node], makeCtx(), options);

      expect(skipped).toHaveLength(1);

      expect(skipped[0]!.nodeId).toBe('gated');
    });

    it('skips a direct dependent of a skipped node', async () => {
      const nodeA = new StubNode({ id: 'nodeA', if: 'false' });
      const nodeB = new StubNode({ id: 'nodeB', depends_on: ['nodeA'] });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      await runScheduler([nodeA, nodeB], makeCtx(), options);

      const skippedIds = skipped.map((e) => e.nodeId);
      expect(skippedIds).toContain('nodeA');
      expect(skippedIds).toContain('nodeB');
    });

    it('transitively skips C when A is skipped and C depends_on B which depends_on A', async () => {
      const nodeA = new StubNode({ id: 'nodeA', if: 'false' });
      const nodeB = new StubNode({ id: 'nodeB', depends_on: ['nodeA'] });
      const nodeC = new StubNode({ id: 'nodeC', depends_on: ['nodeB'] });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      await runScheduler([nodeA, nodeB, nodeC], makeCtx(), options);

      const skippedIds = skipped.map((e) => e.nodeId);
      expect(skippedIds).toContain('nodeA');
      expect(skippedIds).toContain('nodeB');
      expect(skippedIds).toContain('nodeC');
    });

    it('skips a node that depends on both a completed node and a skipped node', async () => {
      const nodeA = new StubNode({ id: 'nodeA' }, { status: 'completed', result: {} });
      const nodeB = new StubNode({ id: 'nodeB', if: 'false' });
      const nodeC = new StubNode({ id: 'nodeC', depends_on: ['nodeA', 'nodeB'] });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      await runScheduler([nodeA, nodeB, nodeC], makeCtx(), options);

      const skippedIds = skipped.map((e) => e.nodeId);
      expect(skippedIds).toContain('nodeB');
      expect(skippedIds).toContain('nodeC');
    });

    it('does not emit node_started for any skipped node', async () => {
      const nodeA = new StubNode({ id: 'nodeA', if: 'false' });
      const nodeB = new StubNode({ id: 'nodeB', depends_on: ['nodeA'] });
      const started: NodeStartedEvent[] = collectEvents(emitter, 'node_started');

      await runScheduler([nodeA, nodeB], makeCtx(), options);

      const startedIds = started.map((e) => e.nodeId);
      expect(startedIds).not.toContain('nodeA');
      expect(startedIds).not.toContain('nodeB');
    });
  });

  // -------------------------------------------------------------------------
  describe('failure stops new dispatches', () => {
    it('does not dispatch a node that is still pending (blocked by a dep) when a peer fails', async () => {
      // blocker keeps pendingNode from being dispatched initially.
      // When failingNode fails, pendingNode is still pending — FR-006 must prevent it from ever running.
      const runTracker = vi.fn<() => Promise<NodeRunResult>>().mockResolvedValue({
        status: 'completed',
        result: {},
      });

      const failingNode = new DeferredNode({ id: 'failing' });
      const blocker = new DeferredNode({ id: 'blocker' });
      const pendingNode = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          return runTracker();
        }
      })({ id: 'pending', depends_on: ['blocker'] });

      const schedulerDone = runScheduler([failingNode, blocker, pendingNode], makeCtx(), options);

      // Wait for failingNode and blocker to start (both are independent, dispatched immediately)
      await failingNode.started;
      await blocker.started;

      // Fail failingNode; pendingNode is still pending (blocker hasn't settled yet)
      failingNode.resolve({ status: 'failed', error: new Error('boom') });

      // Now settle blocker — pendingNode would be eligible, but FR-006 must block it
      blocker.resolve({ status: 'completed', result: {} });

      await schedulerDone;

      expect(runTracker).not.toHaveBeenCalled();
    });

    it('resolves with success: false when any node fails', async () => {
      const node = new StubNode({ id: 'nodeA' }, { status: 'failed', error: new Error('oops') });

      const result = await runScheduler([node], makeCtx(), options);

      expect(result.success).toBe(false);
    });

    it('resolves (does not throw) with outcome: completed and success: false when failure leaves a pending node undispatched', async () => {
      // failNode is independent; depNode depends on failNode, so it is initially pending.
      // failNode fails immediately, setting hasFailure. depNode remains pending and is never
      // dispatched — the scheduler must break quietly (not throw) and return success: false.
      const failNode = new StubNode({ id: 'fail' }, { status: 'failed', error: new Error('fail') });
      const depNode = new StubNode({ id: 'dep', depends_on: ['fail'] });

      const result = await runScheduler([failNode, depNode], makeCtx(), options);

      expect(result.outcome).toBe('completed');
      expect(result.success).toBe(false);
    });

    it('lets in-flight nodes run to natural completion before resolving with success: false', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new DeferredNode({ id: 'nodeB' });

      const completedIds: string[] = [];
      emitter.on('node_completed', (e) => completedIds.push(e.nodeId));

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      // Wait for both to start concurrently
      await Promise.all([nodeA.started, nodeB.started]);

      // Fail A; B is still in-flight
      nodeA.resolve({ status: 'failed', error: new Error('A failed') });

      // Yield enough microtask ticks for the scheduler to process A's failure,
      // then resolve B to ensure it completes naturally
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      nodeB.resolve({ status: 'completed', result: { value: 'b' } });

      const result = await schedulerDone;

      // B ran to completion even though A failed
      expect(completedIds).toContain('nodeB');
      // But the overall result is still a failure
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('needs / inputs / vars context threading', () => {
    it('populates needs with completed node results so downstream nodes can read them', async () => {
      const capturedNeeds = new Map<string, unknown>();

      const nodeA = new StubNode({ id: 'nodeA' }, { status: 'completed', result: { out: 42 } });

      const nodeB = new (class extends BaseNode {
        public run(opts: NodeRunOptions): Promise<NodeRunResult> {
          for (const [k, v] of opts.ctx.needs.entries()) {
            capturedNeeds.set(k, v);
          }

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'nodeB', depends_on: ['nodeA'] });

      await runScheduler([nodeA, nodeB], makeCtx(), options);

      expect(capturedNeeds.get('nodeA')).toEqual({ out: 42 });
    });

    it('threads inputs from ctx into every node run', async () => {
      const capturedInputs: Record<string, unknown>[] = [];

      const node = new (class extends BaseNode {
        public run(opts: NodeRunOptions): Promise<NodeRunResult> {
          capturedInputs.push(opts.ctx.inputs);

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'nodeA' });

      const ctx = makeCtx({ inputs: { env: 'production', version: '2' } });
      await runScheduler([node], ctx, options);

      expect(capturedInputs[0]).toEqual({ env: 'production', version: '2' });
    });

    it('threads vars from ctx into every node run', async () => {
      const capturedVars: Record<string, unknown>[] = [];

      const node = new (class extends BaseNode {
        public run(opts: NodeRunOptions): Promise<NodeRunResult> {
          capturedVars.push(opts.ctx.vars);

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'nodeA' });

      const ctx = makeCtx({ vars: { region: 'us-east-1', debug: 'true' } });
      await runScheduler([node], ctx, options);

      expect(capturedVars[0]).toEqual({ region: 'us-east-1', debug: 'true' });
    });

    it('makes upstream needs available to a downstream node that depends on a node with pre-existing needs', async () => {
      const existingNeeds = new Map([['seed', { value: 'seed-value' }]]);
      const ctx = makeCtx({ needs: existingNeeds });

      const capturedNeeds = new Map<string, unknown>();
      const node = new (class extends BaseNode {
        public run(opts: NodeRunOptions): Promise<NodeRunResult> {
          for (const [k, v] of opts.ctx.needs.entries()) {
            capturedNeeds.set(k, v);
          }

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'nodeA' });

      await runScheduler([node], ctx, options);

      expect(capturedNeeds.get('seed')).toEqual({ value: 'seed-value' });
    });
  });

  // -------------------------------------------------------------------------
  describe('sessionDir consistency', () => {
    it('passes the same sessionDir to all nodes in a single run', async () => {
      const seenSessionDirs: string[] = [];

      const makeRecordingNode = (id: string, deps?: string[]): BaseNode =>
        new (class extends BaseNode {
          public run(opts: NodeRunOptions): Promise<NodeRunResult> {
            seenSessionDirs.push(opts.ctx.sessionDir);

            return Promise.resolve({ status: 'completed', result: {} });
          }
        })({ id, ...(deps !== undefined ? { depends_on: deps } : {}) });

      const nodeA = makeRecordingNode('nodeA');
      const nodeB = makeRecordingNode('nodeB');
      const nodeC = makeRecordingNode('nodeC', ['nodeA', 'nodeB']);

      const ctx = makeCtx({ sessionDir: '/tmp/specific-session-123' });
      await runScheduler([nodeA, nodeB, nodeC], ctx, options);

      expect(seenSessionDirs).toHaveLength(3);
      expect(new Set(seenSessionDirs).size).toBe(1);
      expect(seenSessionDirs[0]).toBe('/tmp/specific-session-123');
    });
  });

  // -------------------------------------------------------------------------
  describe('exit node behavior', () => {
    it('emits workflow_exited with the reason when a node returns exited', async () => {
      const node = new StubNode(
        { id: 'exit_node' },
        { status: 'exited', reason: 'goal achieved', failure: false }
      );
      const exitEvents: WorkflowExitedEvent[] = collectEvents(emitter, 'workflow_exited');

      await runScheduler([node], makeCtx(), options);

      expect(exitEvents).toHaveLength(1);
      expect(exitEvents[0]!.reason).toBe('goal achieved');
      expect(exitEvents[0]!.failure).toBe(false);
    });

    it('resolves with outcome: exited, success: true, and exitReason when a node exits without failure', async () => {
      const node = new StubNode(
        { id: 'exit_node' },
        { status: 'exited', reason: 'done', failure: false }
      );

      const result = await runScheduler([node], makeCtx(), options);

      expect(result.outcome).toBe('exited');
      expect(result.success).toBe(true);
      expect(result.exitReason).toBe('done');
    });

    it('resolves with success: false when a node exits with failure: true', async () => {
      const node = new StubNode(
        { id: 'exit_node' },
        { status: 'exited', reason: 'fatal error', failure: true }
      );

      const result = await runScheduler([node], makeCtx(), options);

      expect(result.success).toBe(false);
      expect(result.exitReason).toBe('fatal error');
    });

    it('resolves without exitReason when the exited node provides no reason', async () => {
      const node = new StubNode({ id: 'exit_node' }, { status: 'exited', failure: false });

      const result = await runScheduler([node], makeCtx(), options);

      expect(result.success).toBe(true);
      expect(result.exitReason).toBeUndefined();
    });

    it('does not dispatch nodes that depend on an exited node', async () => {
      const runTracker = vi.fn<() => Promise<NodeRunResult>>().mockResolvedValue({
        status: 'completed',
        result: {},
      });

      const exitNode = new StubNode(
        { id: 'exiter' },
        { status: 'exited', reason: 'stopping', failure: false }
      );
      const downstream = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          return runTracker();
        }
      })({ id: 'downstream', depends_on: ['exiter'] });

      await runScheduler([exitNode, downstream], makeCtx(), options);

      expect(runTracker).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('break signal', () => {
    it('resolves with outcome: broke and success: true when a node returns break', async () => {
      const node = new StubNode({ id: 'breaker' }, { status: 'break' });

      const result = await runScheduler([node], makeCtx(), options);

      expect(result.outcome).toBe('broke');
      expect(result.success).toBe(true);
    });

    it('does not emit node_failed when a node returns break', async () => {
      const node = new StubNode({ id: 'breaker', name: 'Breaker' }, { status: 'break' });
      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');

      await runScheduler([node], makeCtx(), options);

      expect(failed).toHaveLength(0);
    });

    it('does not dispatch pending nodes after a node returns break', async () => {
      const runTracker = vi.fn<() => Promise<NodeRunResult>>().mockResolvedValue({
        status: 'completed',
        result: {},
      });

      const breakNode = new DeferredNode({ id: 'breaker' });
      const blocker = new DeferredNode({ id: 'blocker' });
      const pendingNode = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          return runTracker();
        }
      })({ id: 'pending', depends_on: ['blocker'] });

      const schedulerDone = runScheduler([breakNode, blocker, pendingNode], makeCtx(), options);

      // Wait for both independent nodes to start
      await breakNode.started;
      await blocker.started;

      // Break breakNode; pendingNode is still pending (blocker hasn't settled yet)
      breakNode.resolve({ status: 'break' });

      // Settle blocker — pendingNode would be eligible, but the break signal must block it
      blocker.resolve({ status: 'completed', result: {} });

      const result = await schedulerDone;

      expect(runTracker).not.toHaveBeenCalled();
      expect(result.outcome).toBe('broke');
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('cancellation', () => {
    it('emits node_cancelled for an in-flight peer when an exit node fires', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA', name: 'Node A' });
      const nodeB = new DeferredNode({ id: 'nodeB', name: 'Node B' });
      const cancelled: NodeCancelledEvent[] = collectEvents(emitter, 'node_cancelled');

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      nodeA.resolve({ status: 'exited', failure: false });
      nodeB.resolve({ status: 'completed', result: {} });

      const result = await schedulerDone;

      expect(result.outcome).toBe('exited');
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]!.nodeId).toBe('nodeB');
      expect(cancelled[0]!.nodeName).toBe('Node B');
    });

    it('emits node_cancelled for an in-flight peer when a break node fires', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA', name: 'Node A' });
      const nodeB = new DeferredNode({ id: 'nodeB', name: 'Node B' });
      const cancelled: NodeCancelledEvent[] = collectEvents(emitter, 'node_cancelled');

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      nodeA.resolve({ status: 'break' });
      nodeB.resolve({ status: 'completed', result: {} });

      const result = await schedulerDone;

      expect(result.outcome).toBe('broke');
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]!.nodeId).toBe('nodeB');
      expect(cancelled[0]!.nodeName).toBe('Node B');
    });

    it('aborts the signal delivered to in-flight nodes when an exit fires', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new SignalCapturingDeferredNode({ id: 'nodeB' });

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      // At this point the signal should not yet be aborted
      expect(nodeB.capturedSignal).toBeDefined();
      expect(nodeB.capturedSignal!.aborted).toBe(false);

      nodeA.resolve({ status: 'exited', failure: false });

      // Let the scheduler process the exit and call controller.abort()
      await Promise.resolve();
      await Promise.resolve();

      expect(nodeB.capturedSignal!.aborted).toBe(true);

      nodeB.resolve({ status: 'completed', result: {} });
      await schedulerDone;
    });

    it('discards a late settlement from a cancelled node — no node_completed emitted', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new DeferredNode({ id: 'nodeB' });
      const completed: NodeCompletedEvent[] = collectEvents(emitter, 'node_completed');

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      // A exits, B gets cancelled
      nodeA.resolve({ status: 'exited', failure: false });

      // Yield so the scheduler processes the exit and marks B cancelled
      await Promise.resolve();
      await Promise.resolve();

      // Now B settles late — its result must be discarded
      nodeB.resolve({ status: 'completed', result: { leaked: true } });

      const result = await schedulerDone;

      expect(result.outcome).toBe('exited');
      const nodeBCompleted = completed.filter((e) => e.nodeId === 'nodeB');
      expect(nodeBCompleted).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('evaluateIf error path', () => {
    it('resolves with success: false when if expression produces a non-boolean (e.g. numeric literal)', async () => {
      // CEL expression '42' evaluates to a number, not a boolean — evaluateIf throws
      const node = new StubNode({ id: 'bad_if', if: '42' });

      const result = await runScheduler([node], makeCtx(), options);

      expect(result.success).toBe(false);
    });

    it('emits node_failed when if expression produces a non-boolean', async () => {
      const nonBoolNode = new StubNode({ id: 'bad_if', name: 'Bad If', if: '42' });
      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');

      await runScheduler([nonBoolNode], makeCtx(), options);

      expect(failed).toHaveLength(1);
      expect(failed[0]!.nodeId).toBe('bad_if');
      expect(failed[0]!.error).toBeInstanceOf(Error);
    });
  });

  // -------------------------------------------------------------------------
  describe('retry behavior (runWithRetry)', () => {
    it('returns success when a node fails on the first attempt but succeeds on the second', async () => {
      vi.useFakeTimers();

      let attempt = 0;
      const node = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          attempt += 1;
          if (attempt === 1) {
            return Promise.resolve({ status: 'failed', error: new Error('first attempt failed') });
          }

          return Promise.resolve({ status: 'completed', result: { retried: true } });
        }
      })({ id: 'retryable', retries: { max_attempts: 1 } });

      const completed: NodeCompletedEvent[] = collectEvents(emitter, 'node_completed');
      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');

      const schedulerDone = runScheduler([node], makeCtx(), options);

      // Advance timers to cover the retry delay
      await vi.runAllTimersAsync();

      const result = await schedulerDone;

      expect(result.success).toBe(true);
      expect(attempt).toBe(2);
      expect(completed).toHaveLength(1);
      expect(failed).toHaveLength(0);
    });

    it('resolves with success: false and emits node_failed when all attempts are exhausted', async () => {
      vi.useFakeTimers();

      const error = new Error('always fails');
      const node = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          return Promise.resolve({ status: 'failed', error });
        }
      })({ id: 'always_fail', retries: { max_attempts: 2 } });

      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');

      const schedulerDone = runScheduler([node], makeCtx(), options);

      await vi.runAllTimersAsync();

      const result = await schedulerDone;

      expect(result.success).toBe(false);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.nodeId).toBe('always_fail');
    });

    it('does not retry a node that returns exited — propagates immediately', async () => {
      let callCount = 0;
      const node = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          callCount += 1;

          return Promise.resolve({ status: 'exited', reason: 'done', failure: false });
        }
      })({ id: 'exiter', retries: { max_attempts: 3 } });

      const result = await runScheduler([node], makeCtx(), options);

      expect(callCount).toBe(1);
      expect(result.success).toBe(true);
      expect(result.exitReason).toBe('done');
    });

    it('does not retry a node that returns break — propagates immediately', async () => {
      let callCount = 0;
      const node = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          callCount += 1;

          return Promise.resolve({ status: 'break' });
        }
      })({ id: 'breaker', retries: { max_attempts: 3 } });

      const result = await runScheduler([node], makeCtx(), options);

      expect(callCount).toBe(1);
      expect(result.outcome).toBe('broke');
      expect(result.success).toBe(true);
    });

    it('emits node_failed with a timeout error when a node exceeds its timeout', async () => {
      vi.useFakeTimers();

      const node = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          // This promise never resolves on its own — the timeout fires first
          return new Promise<NodeRunResult>((_resolve) => {
            // intentionally never resolved; timeout under test will fire
          });
        }
      })({ id: 'slow_node', timeout: 5000 });

      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');

      const schedulerDone = runScheduler([node], makeCtx(), options);

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(6000);

      const result = await schedulerDone;

      expect(result.success).toBe(false);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.nodeId).toBe('slow_node');
      expect((failed[0]!.error as Error).message).toMatch(/timed out/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('sharedContextMap / predecessorSessionId wiring', () => {
    it('passes predecessorSessionId to node B when sharedContextMap maps B → A and A returns a sessionId', async () => {
      const nodeA = new CapturingNode(
        { id: 'a' },
        { status: 'completed', result: {}, sessionId: 'sess-abc' }
      );
      const nodeB = new CapturingNode({ id: 'b', depends_on: ['a'] });

      const sharedContextMap = new Map([['b', 'a']]);
      const runOptions = makeOptions({ emitter, sharedContextMap });

      await runScheduler([nodeA, nodeB], makeCtx(), runOptions);

      expect(nodeB.capturedOptions).toHaveLength(1);
      expect(nodeB.capturedOptions[0]!.predecessorSessionId).toBe('sess-abc');
    });

    it('does not pass predecessorSessionId to a node that is not in sharedContextMap', async () => {
      const nodeA = new CapturingNode(
        { id: 'a' },
        { status: 'completed', result: {}, sessionId: 'sess-abc' }
      );
      const nodeB = new CapturingNode({ id: 'b', depends_on: ['a'] });

      // sharedContextMap does not include 'b'
      const runOptions = makeOptions({ emitter, sharedContextMap: new Map() });

      await runScheduler([nodeA, nodeB], makeCtx(), runOptions);

      expect(nodeB.capturedOptions).toHaveLength(1);
      expect(nodeB.capturedOptions[0]!.predecessorSessionId).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('lifecycle events', () => {
    it('emits node_started with correct nodeId and nodeName before run resolves', async () => {
      const node = new StubNode({ id: 'myNode', name: 'My Node' });
      const started: NodeStartedEvent[] = collectEvents(emitter, 'node_started');

      await runScheduler([node], makeCtx(), options);

      expect(started).toHaveLength(1);
      expect(started[0]!.nodeId).toBe('myNode');
      expect(started[0]!.nodeName).toBe('My Node');
    });

    it('uses id as nodeName when name is not set', async () => {
      const node = new StubNode({ id: 'unnamed_node' });
      const started: NodeStartedEvent[] = collectEvents(emitter, 'node_started');

      await runScheduler([node], makeCtx(), options);

      expect(started[0]!.nodeName).toBe('unnamed_node');
    });

    it('emits node_completed with correct nodeId, nodeName, and result', async () => {
      const node = new StubNode(
        { id: 'worker', name: 'Worker' },
        { status: 'completed', result: { output: 'done' } }
      );
      const completed: NodeCompletedEvent[] = collectEvents(emitter, 'node_completed');

      await runScheduler([node], makeCtx(), options);

      expect(completed).toHaveLength(1);
      expect(completed[0]!.nodeId).toBe('worker');
      expect(completed[0]!.nodeName).toBe('Worker');
      expect(completed[0]!.result).toEqual({ output: 'done' });
    });

    it('emits node_skipped with correct nodeId and nodeName for an if:false node', async () => {
      const node = new StubNode({ id: 'skippable', name: 'Skippable Step', if: 'false' });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      await runScheduler([node], makeCtx(), options);

      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.nodeId).toBe('skippable');
      expect(skipped[0]!.nodeName).toBe('Skippable Step');
    });

    it('emits node_failed with correct nodeId, nodeName, and error', async () => {
      const boom = new Error('something broke');
      const node = new StubNode(
        { id: 'failer', name: 'Failer' },
        { status: 'failed', error: boom }
      );
      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');

      await runScheduler([node], makeCtx(), options);

      expect(failed).toHaveLength(1);
      expect(failed[0]!.nodeId).toBe('failer');
      expect(failed[0]!.nodeName).toBe('Failer');
      expect(failed[0]!.error).toBe(boom);
    });

    it('emits node_started before node_completed for the same node', async () => {
      const node = new StubNode({ id: 'ordered' });
      const eventLog: string[] = [];

      emitter.on('node_started', () => eventLog.push('started'));
      emitter.on('node_completed', () => eventLog.push('completed'));

      await runScheduler([node], makeCtx(), options);

      expect(eventLog).toEqual(['started', 'completed']);
    });

    it('emits node_started for each node in a two-node linear chain', async () => {
      const nodeA = new StubNode({ id: 'step1' });
      const nodeB = new StubNode({ id: 'step2', depends_on: ['step1'] });
      const started: NodeStartedEvent[] = collectEvents(emitter, 'node_started');

      await runScheduler([nodeA, nodeB], makeCtx(), options);

      const startedIds = started.map((e) => e.nodeId);
      expect(startedIds).toContain('step1');
      expect(startedIds).toContain('step2');
    });

    it('emits node_completed in dependency order for a linear chain', async () => {
      const nodeA = new StubNode({ id: 'first' });
      const nodeB = new StubNode({ id: 'second', depends_on: ['first'] });
      const completed: NodeCompletedEvent[] = collectEvents(emitter, 'node_completed');

      await runScheduler([nodeA, nodeB], makeCtx(), options);

      expect(completed[0]!.nodeId).toBe('first');
      expect(completed[1]!.nodeId).toBe('second');
    });
  });

  // -------------------------------------------------------------------------
  describe('deadlock detection', () => {
    it('rejects with EngineError code ENGINE_SCHEDULER_DEADLOCK when two nodes depend on each other', async () => {
      // A depends_on B and B depends_on A — neither is ever eligible, nothing is dispatched,
      // and no exit/break/failure flag is set. This is an invariant violation (unvalidated input).
      const nodeA = new StubNode({ id: 'nodeA', depends_on: ['nodeB'] });
      const nodeB = new StubNode({ id: 'nodeB', depends_on: ['nodeA'] });

      await expect(runScheduler([nodeA, nodeB], makeCtx(), options)).rejects.toSatisfy(
        (err: unknown) => err instanceof EngineError && err.code === 'ENGINE_SCHEDULER_DEADLOCK'
      );
    });

    it('includes the pending node count in the deadlock error message', async () => {
      const nodeA = new StubNode({ id: 'nodeA', depends_on: ['nodeB'] });
      const nodeB = new StubNode({ id: 'nodeB', depends_on: ['nodeA'] });

      await expect(runScheduler([nodeA, nodeB], makeCtx(), options)).rejects.toThrow('2');
    });
  });
});
