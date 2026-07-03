import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { EngineError, NodeError } from '../../../../src/core/engine/errors.ts';
import { ApprovalNode } from '../../../../src/core/engine/nodes/approval.ts';
import type {
  ExecutionContext,
  NodeRunOptions,
  NodeRunResult,
} from '../../../../src/core/engine/nodes/base.ts';
import type { BaseNodeData } from '../../../../src/core/engine/nodes/base.ts';
import { BaseNode } from '../../../../src/core/engine/nodes/base.ts';
import { BreakNode } from '../../../../src/core/engine/nodes/break.ts';
import type { SchedulerOptions } from '../../../../src/core/engine/scheduler.ts';
import { runScheduler } from '../../../../src/core/engine/scheduler.ts';

class StubNode extends BaseNode {
  public readonly capturedOptions: NodeRunOptions[] = [];
  private readonly result: NodeRunResult;

  constructor(data: BaseNodeData, result: NodeRunResult = { status: 'completed', result: {} }) {
    super(data);
    this.result = result;
  }

  public get runCount(): number {
    return this.capturedOptions.length;
  }

  public run(options: NodeRunOptions): Promise<NodeRunResult> {
    this.capturedOptions.push(options);

    return Promise.resolve(this.result);
  }
}

/** A node whose run() result is controlled externally via resolve/reject handles; captures the signal passed to run(). */
class DeferredNode extends BaseNode {
  private resolveRun!: (result: NodeRunResult) => void;
  private rejectRun!: (err: unknown) => void;
  public readonly started: Promise<void>;
  private signalStarted!: () => void;
  private readonly runResult: Promise<NodeRunResult>;
  public capturedSignal: AbortSignal | undefined;

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

  public run(options: NodeRunOptions): Promise<NodeRunResult> {
    this.capturedSignal = options.signal;
    this.signalStarted();

    return this.runResult;
  }
}

/** A node that returns a preset sequence of results across successive run() calls (last result repeats once exhausted). */
class SequencedNode extends BaseNode {
  private index = 0;
  private readonly results: NodeRunResult[];

  constructor(data: BaseNodeData, results: NodeRunResult[]) {
    super(data);
    this.results = results;
  }

  public get runCount(): number {
    return this.index;
  }

  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    const result = this.results[this.index] ?? this.results[this.results.length - 1]!;
    this.index += 1;

    return Promise.resolve(result);
  }
}

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  sessionDir: '/tmp/session',
  cwd: '/tmp/work',
  ...overrides,
});

const makeOptions = (overrides: Partial<SchedulerOptions> = {}): SchedulerOptions => ({
  emitter: createEngineEmitter(),
  sharedContextMap: new Map(),
  ...overrides,
});

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

const waitForEvent = <K extends keyof EngineEventMap>(
  emitter: EngineEmitter,
  event: K,
  predicate?: (payload: EngineEventMap[K][0]) => boolean
): Promise<EngineEventMap[K][0]> =>
  new Promise((resolve) => {
    const handler = (payload: EngineEventMap[K][0]): void => {
      if (!predicate || predicate(payload)) {
        emitter.off(event, handler);
        resolve(payload);
      }
    };
    emitter.on(event, handler);
  });

describe('runScheduler', () => {
  let emitter: ReturnType<typeof createEngineEmitter>;
  let options: SchedulerOptions;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    emitter = createEngineEmitter();
    options = makeOptions({ emitter });
  });

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

  describe('skip propagation', () => {
    it('runs a node whose if expression evaluates to true', async () => {
      const node = new StubNode({ id: 'gated', if: 'true' });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      const result = await runScheduler([node], makeCtx(), options);

      expect(node.runCount).toBe(1);
      expect(skipped).toHaveLength(0);
      expect(result.outcome).toBe('completed');
      expect(result.success).toBe(true);
    });

    it('skips a node whose if expression evaluates to false', async () => {
      const node = new StubNode({ id: 'gated', if: 'false' });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      await runScheduler([node], makeCtx(), options);

      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.nodeId).toBe('gated');
      expect(node.capturedOptions).toHaveLength(0);
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

    it('skips an if:false node whose dependency completed, and transitively skips its dependent', async () => {
      // B's if is evaluated on the re-scan after A settles, not on the initial dispatch scan.
      const nodeA = new StubNode({ id: 'nodeA' });
      const nodeB = new StubNode({ id: 'nodeB', depends_on: ['nodeA'], if: 'false' });
      const nodeC = new StubNode({ id: 'nodeC', depends_on: ['nodeB'] });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      await runScheduler([nodeA, nodeB, nodeC], makeCtx(), options);

      expect(nodeA.runCount).toBe(1);
      expect(nodeB.runCount).toBe(0);
      expect(nodeC.runCount).toBe(0);
      const skippedIds = skipped.map((e) => e.nodeId);
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

  describe('skip propagation through control-flow nodes', () => {
    it('runs a node downstream of a skipped break — a skipped break does not cascade its skip', async () => {
      const stop = new BreakNode({ id: 'stop', if: 'false' });
      const after = new StubNode({ id: 'after', depends_on: ['stop'] });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      const result = await runScheduler([stop, after], makeCtx(), options);

      expect(after.runCount).toBe(1);
      const skippedIds = skipped.map((e) => e.nodeId);
      expect(skippedIds).toContain('stop');
      expect(skippedIds).not.toContain('after');
      expect(result.outcome).toBe('completed');
    });

    it('does not run a node downstream of a break that fires — the break halts the run', async () => {
      const stop = new BreakNode({ id: 'stop', if: 'true' });
      const after = new StubNode({ id: 'after', depends_on: ['stop'] });

      const result = await runScheduler([stop, after], makeCtx(), options);

      expect(after.runCount).toBe(0);
      expect(result.outcome).toBe('broke');
    });

    it('still skips a dependent when a data dependency is skipped, even if a skipped break is also a dependency', async () => {
      const data = new StubNode({ id: 'data', if: 'false' });
      const stop = new BreakNode({ id: 'stop', if: 'false' });
      const after = new StubNode({ id: 'after', depends_on: ['data', 'stop'] });
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');

      await runScheduler([data, stop, after], makeCtx(), options);

      expect(after.runCount).toBe(0);
      const skippedIds = skipped.map((e) => e.nodeId);
      expect(skippedIds).toContain('after');
    });
  });

  describe('failure stops new dispatches', () => {
    it('does not dispatch a node that is still pending (blocked by a dep) when a peer fails', async () => {
      // blocker keeps pendingNode from being dispatched initially.
      // When failingNode fails, pendingNode is still pending — FR-006 must prevent it from ever running.
      const failingNode = new DeferredNode({ id: 'failing' });
      const blocker = new DeferredNode({ id: 'blocker' });
      const pendingNode = new StubNode({ id: 'pending', depends_on: ['blocker'] });

      const schedulerDone = runScheduler([failingNode, blocker, pendingNode], makeCtx(), options);

      // Wait for failingNode and blocker to start (both are independent, dispatched immediately)
      await failingNode.started;
      await blocker.started;

      // Fail failingNode; pendingNode is still pending (blocker hasn't settled yet)
      failingNode.resolve({ status: 'failed', error: new Error('boom') });

      // Now settle blocker — pendingNode would be eligible, but FR-006 must block it
      blocker.resolve({ status: 'completed', result: {} });

      await schedulerDone;

      expect(pendingNode.runCount).toBe(0);
    });

    it('resolves with success: false when any node fails', async () => {
      const node = new StubNode({ id: 'nodeA' }, { status: 'failed', error: new Error('oops') });

      const result = await runScheduler([node], makeCtx(), options);

      expect(result.success).toBe(false);
    });

    it('resolves (does not throw) with outcome: completed and success: false when failure leaves a pending node undispatched', async () => {
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

      // Fail A; B is still in-flight — wait for the scheduler to process A's failure
      const nodeAFailed = waitForEvent(emitter, 'node_failed', (e) => e.nodeId === 'nodeA');
      nodeA.resolve({ status: 'failed', error: new Error('A failed') });
      await nodeAFailed;

      nodeB.resolve({ status: 'completed', result: { value: 'b' } });

      const result = await schedulerDone;

      // B ran to completion even though A failed
      expect(completedIds).toContain('nodeB');
      // But the overall result is still a failure
      expect(result.success).toBe(false);
    });
  });

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
      const exitNode = new StubNode(
        { id: 'exiter' },
        { status: 'exited', reason: 'stopping', failure: false }
      );
      const downstream = new StubNode({ id: 'downstream', depends_on: ['exiter'] });

      await runScheduler([exitNode, downstream], makeCtx(), options);

      expect(downstream.runCount).toBe(0);
    });
  });

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
      const breakNode = new DeferredNode({ id: 'breaker' });
      const blocker = new DeferredNode({ id: 'blocker' });
      const pendingNode = new StubNode({ id: 'pending', depends_on: ['blocker'] });

      const schedulerDone = runScheduler([breakNode, blocker, pendingNode], makeCtx(), options);

      // Wait for both independent nodes to start
      await Promise.all([breakNode.started, blocker.started]);

      // Break breakNode; pendingNode is still pending (blocker hasn't settled yet)
      breakNode.resolve({ status: 'break' });

      // Settle blocker — pendingNode would be eligible, but the break signal must block it
      blocker.resolve({ status: 'completed', result: {} });

      const result = await schedulerDone;

      expect(pendingNode.runCount).toBe(0);
      expect(result.outcome).toBe('broke');
      expect(result.success).toBe(true);
    });
  });

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
      const nodeB = new DeferredNode({ id: 'nodeB' });

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      // At this point the signal should not yet be aborted
      expect(nodeB.capturedSignal).toBeDefined();
      expect(nodeB.capturedSignal!.aborted).toBe(false);

      // Wait for the scheduler to process the exit and call controller.abort()
      const nodeAExited = waitForEvent(emitter, 'workflow_exited');
      nodeA.resolve({ status: 'exited', failure: false });
      await nodeAExited;

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

      // A exits, B gets cancelled — wait for the scheduler to mark B cancelled
      const nodeBCancelled = waitForEvent(emitter, 'node_cancelled', (e) => e.nodeId === 'nodeB');
      nodeA.resolve({ status: 'exited', failure: false });
      await nodeBCancelled;

      // Now B settles late — its result must be discarded
      nodeB.resolve({ status: 'completed', result: { leaked: true } });

      const result = await schedulerDone;

      expect(result.outcome).toBe('exited');
      const nodeBCompleted = completed.filter((e) => e.nodeId === 'nodeB');
      expect(nodeBCompleted).toHaveLength(0);
    });
  });

  describe('control-flow race: first exit/break wins', () => {
    it('break-then-exit: first settler (break) wins — outcome is broke, no workflow_exited emitted', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new DeferredNode({ id: 'nodeB' });
      const exitEvents: WorkflowExitedEvent[] = collectEvents(emitter, 'workflow_exited');

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      // Ensure both are in-flight before settling either
      await Promise.all([nodeA.started, nodeB.started]);

      // Wait for the scheduler to process A's break before resolving B
      const nodeBCancelled = waitForEvent(emitter, 'node_cancelled', (e) => e.nodeId === 'nodeB');
      nodeA.resolve({ status: 'break' });
      await nodeBCancelled;

      nodeB.resolve({ status: 'exited', failure: false });

      const result = await schedulerDone;

      expect(result.outcome).toBe('broke');
      expect(result.success).toBe(true);
      // The late exit settlement must be discarded — no workflow_exited event
      expect(exitEvents).toHaveLength(0);
    });

    it('exit-then-exit race: only the first exit wins — exactly one workflow_exited emitted with first reason', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new DeferredNode({ id: 'nodeB' });
      const exitEvents: WorkflowExitedEvent[] = collectEvents(emitter, 'workflow_exited');

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      // Wait for the scheduler to process A's exit before resolving B
      const nodeBCancelled = waitForEvent(emitter, 'node_cancelled', (e) => e.nodeId === 'nodeB');
      nodeA.resolve({ status: 'exited', reason: 'first', failure: false });
      await nodeBCancelled;

      nodeB.resolve({ status: 'exited', reason: 'second', failure: true });

      const result = await schedulerDone;

      expect(exitEvents).toHaveLength(1);
      expect(exitEvents[0]!.reason).toBe('first');
      expect(exitEvents[0]!.failure).toBe(false);

      expect(result.outcome).toBe('exited');
      expect(result.exitReason).toBe('first');
      expect(result.success).toBe(true);
    });
  });

  describe('failure before exit/break makes run unsuccessful', () => {
    it('failure then exit: prior failure is not masked — outcome: exited, success: false', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new DeferredNode({ id: 'nodeB' });

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      // Wait for the scheduler to process A's failure before resolving B
      const nodeAFailed = waitForEvent(emitter, 'node_failed', (e) => e.nodeId === 'nodeA');
      nodeA.resolve({ status: 'failed', error: new Error('A failed') });
      await nodeAFailed;

      nodeB.resolve({ status: 'exited', failure: false });

      const result = await schedulerDone;

      expect(result.outcome).toBe('exited');
      expect(result.success).toBe(false);
    });

    it('failure then break: prior failure is not masked — outcome: broke, success: false', async () => {
      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new DeferredNode({ id: 'nodeB' });

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      // Wait for the scheduler to process A's failure before resolving B
      const nodeAFailed = waitForEvent(emitter, 'node_failed', (e) => e.nodeId === 'nodeA');
      nodeA.resolve({ status: 'failed', error: new Error('A failed') });
      await nodeAFailed;

      nodeB.resolve({ status: 'break' });

      const result = await schedulerDone;

      expect(result.outcome).toBe('broke');
      expect(result.success).toBe(false);
    });
  });

  describe('evaluateIf error path', () => {
    it('resolves with success: false when if expression produces a non-boolean (e.g. numeric literal)', async () => {
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
      expect(failed[0]!.error).toBeInstanceOf(NodeError);
      const ifError = failed[0]!.error as NodeError;
      expect(ifError.message).toBe('Failed to evaluate if expression (node: "Bad If")');
      expect(ifError.code).toBe('ENGINE_NODE_IF_ERROR');
      expect((ifError.cause as Error).message).toMatch(/must evaluate to a boolean/);
    });

    it('does not dispatch a peer after an if-evaluation failure that occurs during a skip cascade', async () => {
      // S (if:false) → skipped first, triggering a re-scan; X (if:'42') → throws mid-scan; Y must never start.
      const S = new StubNode({ id: 'S', if: 'false' });
      const X = new StubNode({ id: 'X', if: '42' });
      const Y = new StubNode({ id: 'Y' });
      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');
      const skipped: NodeSkippedEvent[] = collectEvents(emitter, 'node_skipped');
      const started: NodeStartedEvent[] = collectEvents(emitter, 'node_started');

      const result = await runScheduler([S, X, Y], makeCtx(), options);

      expect(Y.runCount).toBe(0);
      expect(started.some((e) => e.nodeId === 'Y')).toBe(false);
      expect(result.success).toBe(false);
      expect(failed.some((e) => e.nodeId === 'X')).toBe(true);
      const xFailure = failed.find((e) => e.nodeId === 'X')!.error as NodeError;
      expect(xFailure.code).toBe('ENGINE_NODE_IF_ERROR');
      expect(skipped.some((e) => e.nodeId === 'S')).toBe(true);
    });
  });

  describe('retry behavior (runWithRetry)', () => {
    it('returns success when a node fails on the first attempt but succeeds on the second', async () => {
      vi.useFakeTimers();

      const node = new SequencedNode({ id: 'retryable', retries: { max_attempts: 1 } }, [
        { status: 'failed', error: new Error('first attempt failed') },
        { status: 'completed', result: { retried: true } },
      ]);

      const completed: NodeCompletedEvent[] = collectEvents(emitter, 'node_completed');
      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');

      const schedulerDone = runScheduler([node], makeCtx(), options);

      // Advance timers to cover the retry delay
      await vi.runAllTimersAsync();

      const result = await schedulerDone;

      expect(result.success).toBe(true);
      expect(node.runCount).toBe(2);
      expect(completed).toHaveLength(1);
      expect(failed).toHaveLength(0);
    });

    it('resolves with success: false and emits node_failed when all attempts are exhausted', async () => {
      vi.useFakeTimers();

      const error = new Error('always fails');
      const node = new StubNode(
        { id: 'always_fail', retries: { max_attempts: 2 } },
        { status: 'failed', error }
      );

      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');

      const schedulerDone = runScheduler([node], makeCtx(), options);

      await vi.runAllTimersAsync();

      const result = await schedulerDone;

      expect(result.success).toBe(false);
      expect(node.runCount).toBe(3); // initial attempt + max_attempts retries
      expect(failed).toHaveLength(1);
      expect(failed[0]!.nodeId).toBe('always_fail');
    });

    it('does not retry a node that returns exited — propagates immediately', async () => {
      const node = new StubNode(
        { id: 'exiter', retries: { max_attempts: 3 } },
        { status: 'exited', reason: 'done', failure: false }
      );

      const result = await runScheduler([node], makeCtx(), options);

      expect(node.runCount).toBe(1);
      expect(result.success).toBe(true);
      expect(result.exitReason).toBe('done');
    });

    it('does not retry a node that returns break — propagates immediately', async () => {
      const node = new StubNode(
        { id: 'breaker', retries: { max_attempts: 3 } },
        { status: 'break' }
      );

      const result = await runScheduler([node], makeCtx(), options);

      expect(node.runCount).toBe(1);
      expect(result.outcome).toBe('broke');
      expect(result.success).toBe(true);
    });

    it('emits node_failed with a timeout error when a node exceeds its timeout', async () => {
      vi.useFakeTimers();

      const node = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          return new Promise<NodeRunResult>(() => undefined);
        }
      })({ id: 'slow_node', timeout: 5000 });

      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');

      const schedulerDone = runScheduler([node], makeCtx(), options);

      await vi.advanceTimersByTimeAsync(6000);

      const result = await schedulerDone;

      expect(result.success).toBe(false);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.nodeId).toBe('slow_node');
      expect(failed[0]!.error).toBeInstanceOf(NodeError);
      const outerError = failed[0]!.error as NodeError;
      expect(outerError.message).toBe('Node failed (node: "slow_node")');
      expect(outerError.code).toBe('ENGINE_NODE_FAILED');
      const causeError = outerError.cause as NodeError;
      expect(causeError).toBeInstanceOf(NodeError);
      expect(causeError.message).toMatch(/timed out after \d+ms \(node: "slow_node"\)/i);
      expect(causeError.code).toBe('ENGINE_NODE_TIMEOUT');
    });
  });

  describe('sharedContextMap / predecessorSessionId wiring', () => {
    it('passes predecessorSessionId to node B when sharedContextMap maps B → A and A returns a sessionId', async () => {
      const nodeA = new StubNode(
        { id: 'a' },
        { status: 'completed', result: {}, sessionId: 'sess-abc' }
      );
      const nodeB = new StubNode({ id: 'b', depends_on: ['a'] });

      const sharedContextMap = new Map([['b', 'a']]);
      const runOptions = makeOptions({ emitter, sharedContextMap });

      await runScheduler([nodeA, nodeB], makeCtx(), runOptions);

      expect(nodeB.capturedOptions).toHaveLength(1);
      expect(nodeB.capturedOptions[0]!.predecessorSessionId).toBe('sess-abc');
    });

    it('does not pass predecessorSessionId to a node that is not in sharedContextMap', async () => {
      const nodeA = new StubNode(
        { id: 'a' },
        { status: 'completed', result: {}, sessionId: 'sess-abc' }
      );
      const nodeB = new StubNode({ id: 'b', depends_on: ['a'] });

      const runOptions = makeOptions({ emitter, sharedContextMap: new Map() });

      await runScheduler([nodeA, nodeB], makeCtx(), runOptions);

      expect(nodeB.capturedOptions).toHaveLength(1);
      expect(nodeB.capturedOptions[0]!.predecessorSessionId).toBeUndefined();
    });
  });

  describe('lifecycle events', () => {
    it('emits node_started with correct nodeId and nodeName', async () => {
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
      expect(failed[0]!.error).toBeInstanceOf(NodeError);
      const nodeError = failed[0]!.error as NodeError;
      expect(nodeError.message).toBe('Node failed (node: "Failer")');
      expect(nodeError.code).toBe('ENGINE_NODE_FAILED');
      expect(nodeError.nodeId).toBe('failer');
      expect(nodeError.nodeName).toBe('Failer');
      expect(nodeError.cause).toBe(boom);
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
      expect(startedIds[0]).toBe('step1');
      expect(startedIds[1]).toBe('step2');
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

  describe('approval flow', () => {
    it('blocks an approval node until the hook resolves, then emits node_completed for it', async () => {
      const gate = new ApprovalNode({
        id: 'gate',
        message: 'Deploy?',
        exitOnNo: false,
        enableFeedback: false,
      });
      const completed: NodeCompletedEvent[] = collectEvents(emitter, 'node_completed');
      // Register before starting the scheduler — approval_requested fires during dispatch.
      const requestArrived = waitForEvent(emitter, 'approval_requested');

      const schedulerDone = runScheduler([gate], makeCtx(), options);
      const request = await requestArrived;

      expect(request.nodeId).toBe('gate');
      // The node stays blocked until the hook resolves the request.
      expect(completed).toHaveLength(0);

      request.resolve({ approved: true });
      const result = await schedulerDone;

      expect(result.success).toBe(true);
      expect(completed).toHaveLength(1);
      expect(completed[0]!.nodeId).toBe('gate');
      expect(completed[0]!.result).toEqual({ approved: true });
    });
  });

  describe('retry jitter bounds (computeRetryDelay)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('lower bound: delay = 0.5 × exp when Math.random returns 0', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      const node = new SequencedNode(
        {
          id: 'min_jitter_node',
          retries: { max_attempts: 1, initial_delay_ms: 1000, max_delay_ms: 30000 },
        },
        [
          { status: 'failed', error: new Error('first') },
          { status: 'completed', result: {} },
        ]
      );

      const schedulerDone = runScheduler([node], makeCtx(), options);

      await vi.advanceTimersByTimeAsync(499);
      expect(node.runCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1);

      const result = await schedulerDone;

      expect(result.success).toBe(true);
      expect(node.runCount).toBe(2);
    });

    it('upper excursion: delay exceeds exp and reaches up to 1.5 × exp when unclamped (Math.random near 1)', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.9999);

      const node = new SequencedNode(
        {
          id: 'upper_jitter_node',
          retries: { max_attempts: 1, initial_delay_ms: 1000, max_delay_ms: 30000 },
        },
        [
          { status: 'failed', error: new Error('first') },
          { status: 'completed', result: {} },
        ]
      );

      const schedulerDone = runScheduler([node], makeCtx(), options);

      // At 1000 ms (= exp) the retry must NOT have fired yet — jitter pushes it above exp.
      await vi.advanceTimersByTimeAsync(1000);
      expect(node.runCount).toBe(1);

      // At ~1500 ms (= 1.5 × exp) the retry must have fired.
      await vi.advanceTimersByTimeAsync(500);

      const result = await schedulerDone;

      expect(result.success).toBe(true);
      expect(node.runCount).toBe(2);
    });

    it('hard ceiling: delay is clamped to max_delay_ms when 1.5 × exp exceeds max_delay_ms', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.9999);

      const node = new SequencedNode(
        {
          id: 'clamped_jitter_node',
          retries: { max_attempts: 1, initial_delay_ms: 1000, max_delay_ms: 1200 },
        },
        [
          { status: 'failed', error: new Error('first') },
          { status: 'completed', result: {} },
        ]
      );

      const schedulerDone = runScheduler([node], makeCtx(), options);

      await vi.advanceTimersByTimeAsync(1199);
      expect(node.runCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1);

      const result = await schedulerDone;

      expect(result.success).toBe(true);
      expect(node.runCount).toBe(2);
    });
  });

  describe('retry stops immediately on scheduler abort', () => {
    it('does not retry after the first failure when another node aborts the scheduler', async () => {
      vi.useFakeTimers();

      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new StubNode(
        { id: 'nodeB', retries: { max_attempts: 5, initial_delay_ms: 10000, max_delay_ms: 30000 } },
        { status: 'failed', error: new Error('b failed') }
      );

      // Register before runScheduler so we don't miss the synchronous node_started emit
      const nodeBStarted = waitForEvent(emitter, 'node_started', (e) => e.nodeId === 'nodeB');

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      // Wait until nodeB has been dispatched (run once) before aborting via nodeA
      await nodeA.started;
      await nodeBStarted;

      nodeA.resolve({ status: 'exited', failure: false });

      const result = await schedulerDone;

      expect(result.outcome).toBe('exited');
      expect(nodeB.runCount).toBe(1);
    });
  });

  describe('per-attempt timeout signal isolation', () => {
    it('aborts the signal passed to the timed-out node after the timeout fires', async () => {
      vi.useFakeTimers();

      let capturedSignal: AbortSignal | undefined;

      const node = new (class extends BaseNode {
        public run(runOptions: NodeRunOptions): Promise<NodeRunResult> {
          capturedSignal = runOptions.signal;

          return new Promise<NodeRunResult>(() => undefined);
        }
      })({ id: 'hanging_node', timeout: 3000 });

      const schedulerDone = runScheduler([node], makeCtx(), options);

      await Promise.resolve();
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(3001);

      expect(capturedSignal!.aborted).toBe(true);

      const result = await schedulerDone;
      expect(result.success).toBe(false);
    });

    it('does not abort a sibling node signal when a peer node times out', async () => {
      vi.useFakeTimers();

      const nodeA = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          return new Promise<NodeRunResult>(() => undefined);
        }
      })({ id: 'nodeA', timeout: 2000 });

      const nodeB = new DeferredNode({ id: 'nodeB' });

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await nodeB.started;

      expect(nodeB.capturedSignal).toBeDefined();
      expect(nodeB.capturedSignal!.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(2001);

      expect(nodeB.capturedSignal!.aborted).toBe(false);

      nodeB.resolve({ status: 'completed', result: {} });

      const result = await schedulerDone;
      expect(result.success).toBe(false);
    });

    it('retries a node whose first attempt timed out and succeeds on the second attempt', async () => {
      vi.useFakeTimers();

      let attempt = 0;
      const node = new (class extends BaseNode {
        public run(_options: NodeRunOptions): Promise<NodeRunResult> {
          attempt += 1;
          if (attempt === 1) {
            return new Promise<NodeRunResult>(() => undefined);
          }

          return Promise.resolve({ status: 'completed', result: { retried: true } });
        }
      })({
        id: 'timeout_retry_node',
        timeout: 1000,
        retries: { max_attempts: 1, initial_delay_ms: 200, max_delay_ms: 1000 },
      });

      const completed: NodeCompletedEvent[] = collectEvents(emitter, 'node_completed');

      const schedulerDone = runScheduler([node], makeCtx(), options);

      await vi.advanceTimersByTimeAsync(1001);

      await vi.advanceTimersByTimeAsync(1001);

      const result = await schedulerDone;

      expect(result.success).toBe(true);
      expect(attempt).toBe(2);
      expect(completed).toHaveLength(1);
      expect(completed[0]!.nodeId).toBe('timeout_retry_node');
    });
  });

  describe('timeout timer cleanup (no late firing when run beats the timeout)', () => {
    it('does not abort the attempt signal when the node completes before the timeout fires', async () => {
      vi.useFakeTimers();

      const node = new DeferredNode({ id: 'fast_node', timeout: 5000 });

      const completed: NodeCompletedEvent[] = collectEvents(emitter, 'node_completed');
      const failed: NodeFailedEvent[] = collectEvents(emitter, 'node_failed');
      const cancelled: NodeCancelledEvent[] = collectEvents(emitter, 'node_cancelled');

      const schedulerDone = runScheduler([node], makeCtx(), options);

      await node.started;
      node.resolve({ status: 'completed', result: { value: 'done' } });

      const result = await schedulerDone;

      expect(result.outcome).toBe('completed');
      expect(result.success).toBe(true);
      expect(completed).toHaveLength(1);
      expect(completed[0]!.nodeId).toBe('fast_node');

      const signal = node.capturedSignal!;
      expect(signal).toBeDefined();
      expect(signal.aborted).toBe(false);

      // Advance well past the original timeout — if the timer leaked, it would fire here
      // and call attemptController.abort(), making signal.aborted true.
      await vi.advanceTimersByTimeAsync(6000);

      expect(signal.aborted).toBe(false);

      expect(failed).toHaveLength(0);
      expect(cancelled).toHaveLength(0);
    });
  });

  describe('cancellation grace period', () => {
    it('resolves after CANCELLATION_GRACE_MS when an in-flight node never settles after abort', async () => {
      vi.useFakeTimers();

      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new DeferredNode({ id: 'nodeB' });

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      nodeA.resolve({ status: 'exited', failure: false });

      await waitForEvent(emitter, 'node_cancelled', (e) => e.nodeId === 'nodeB');

      let settled = false;
      void schedulerDone.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      const result = await schedulerDone;

      expect(result.outcome).toBe('exited');
      expect(result.success).toBe(true);
    });

    it('resolves promptly without waiting the grace period when the cancelled node settles quickly', async () => {
      vi.useFakeTimers();

      const nodeA = new DeferredNode({ id: 'nodeA' });
      const nodeB = new DeferredNode({ id: 'nodeB' });

      const schedulerDone = runScheduler([nodeA, nodeB], makeCtx(), options);

      await Promise.all([nodeA.started, nodeB.started]);

      nodeA.resolve({ status: 'exited', failure: false });

      await waitForEvent(emitter, 'node_cancelled', (e) => e.nodeId === 'nodeB');

      nodeB.resolve({ status: 'completed', result: {} });

      await vi.advanceTimersByTimeAsync(0);

      const result = await schedulerDone;

      expect(result.outcome).toBe('exited');
      expect(result.success).toBe(true);
    });
  });

  describe('deadlock detection', () => {
    it('rejects with EngineError code ENGINE_SCHEDULER_DEADLOCK when two nodes depend on each other', async () => {
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
