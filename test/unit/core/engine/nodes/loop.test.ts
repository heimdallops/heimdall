import '../../../../../src/core/engine/nodes/bash.ts';

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import type { NodeResult } from '../../../../../src/core/engine/emitter.ts';
import { createEngineEmitter } from '../../../../../src/core/engine/emitter.ts';
import { EngineConfigError } from '../../../../../src/core/engine/errors.ts';
import type {
  BaseNodeData,
  ExecutionContext,
  NodeRunOptions,
  NodeRunResult,
  PlatformAdapter,
} from '../../../../../src/core/engine/nodes/base.ts';
import { BaseNode } from '../../../../../src/core/engine/nodes/base.ts';
import { BreakNode } from '../../../../../src/core/engine/nodes/break.ts';
import { LoopNode } from '../../../../../src/core/engine/nodes/loop.ts';

const fakeAdapter = {} as PlatformAdapter;

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  sessionDir: '/tmp/session',
  ...overrides,
});

const runLoop = (node: LoopNode, ctx: ExecutionContext = makeCtx()): Promise<NodeRunResult> =>
  node.run({
    ctx,
    adapter: fakeAdapter,
    emitter: createEngineEmitter(),
    signal: new AbortController().signal,
  });

// Stub body node — records the scope it received each time it runs.
class ScopeCapturingNode extends BaseNode {
  public readonly capturedScopes: ExecutionContext['scope'][] = [];
  private readonly nodeResult: NodeResult;

  public constructor(data: BaseNodeData, result: NodeResult = {}) {
    super(data);
    this.nodeResult = result;
  }

  public get runCount(): number {
    return this.capturedScopes.length;
  }

  public override run(options: NodeRunOptions): Promise<NodeRunResult> {
    this.capturedScopes.push(options.ctx.scope);

    return Promise.resolve({ status: 'completed', result: this.nodeResult });
  }
}

// A body node whose run result is supplied as a factory so each call can return a different result.
class FactoryNode extends BaseNode {
  private runIndex = 0;
  private readonly factory: (callIndex: number) => NodeRunResult;

  public constructor(data: BaseNodeData, factory: (callIndex: number) => NodeRunResult) {
    super(data);
    this.factory = factory;
  }

  public get runCount(): number {
    return this.runIndex;
  }

  public override run(_options: NodeRunOptions): Promise<NodeRunResult> {
    const result = this.factory(this.runIndex);
    this.runIndex += 1;

    return Promise.resolve(result);
  }
}

// Build a LoopNode directly — bypasses Workflow.from and the registry so tests
// are not coupled to YAML parsing for the core iteration behavior.
const makeLoopNode = (
  opts: {
    id?: string;
    until?: string;
    max_iterations?: number;
    outputs?: Record<string, string>;
    depends_on?: string[];
  },
  bodyNodes: BaseNode[]
): LoopNode =>
  new LoopNode({
    id: opts.id ?? 'loop1',
    ...(opts.depends_on !== undefined ? { depends_on: opts.depends_on } : {}),
    until: opts.until,
    maxIterations: opts.max_iterations,
    bodyNodes,
    outputs: opts.outputs,
  });

describe('LoopNode', () => {
  describe('until exits after N iterations', () => {
    it('runs the body exactly twice when until becomes true after 2 iterations', async () => {
      // scope.iteration is 0 on first run, 1 on second — after second completes it equals 2,
      // so "scope.iteration >= 2" becomes true and the loop exits.
      const body = new ScopeCapturingNode({ id: 'step' }, { value: 'x' });
      const loop = makeLoopNode({ until: 'scope.iteration >= 2' }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(2);
      expect(
        (result as { status: 'completed'; result: NodeResult }).result['total_iterations']
      ).toBe(2);
    });

    it('runs exactly once when until is satisfied after the first iteration', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ until: 'scope.iteration >= 1' }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(1);
      expect(
        (result as { status: 'completed'; result: NodeResult }).result['total_iterations']
      ).toBe(1);
    });
  });

  describe('max_iterations exits successfully', () => {
    it('runs exactly max_iterations times and resolves completed (not failed) when until never becomes true', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ until: 'false', max_iterations: 3 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(3);
      expect(
        (result as { status: 'completed'; result: NodeResult }).result['total_iterations']
      ).toBe(3);
    });

    it('resolves completed when only max_iterations is set (no until)', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 2 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(2);
      expect(
        (result as { status: 'completed'; result: NodeResult }).result['total_iterations']
      ).toBe(2);
    });
  });

  describe('BreakNode exits the loop early', () => {
    it('stops iterating when a BreakNode fires — body runs fewer times than max_iterations', async () => {
      // The break node fires unconditionally during the first (uncompleted) iteration.
      // total_iterations = 0 because the break fires before any iteration fully completes.
      const breakRaw = { id: 'stopper', break: true };
      const loop = LoopNode.parse({
        id: 'loop1',
        loop: {
          max_iterations: 10,
          nodes: [breakRaw],
        },
      });

      const completedEvents: string[] = [];
      const emitter = createEngineEmitter();
      emitter.on('node_completed', (e) => completedEvents.push(e.nodeId));

      const result = await loop.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter,
        signal: new AbortController().signal,
      });

      // The BreakNode is a control-flow signal — it does NOT emit node_completed.
      expect(completedEvents).not.toContain('stopper');

      // The loop itself resolves as completed (break is normal exit, not failure).
      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      // total_iterations = 0: the break fires before any iteration fully completes
      expect(loopResult['total_iterations']).toBe(0);
    });

    it('stops before the cap — a conditional break after 1 full iteration yields total_iterations 1', async () => {
      // Iteration 0 (scope.iteration=0): work runs, stopper if=false → skipped; full iteration completes (completedIterations → 1)
      // Iteration 1 (scope.iteration=1): work runs, stopper if=true → breaks; iteration 1 does not complete → total_iterations stays 1
      const loop = LoopNode.parse({
        id: 'loop1',
        loop: {
          max_iterations: 10,
          nodes: [
            { id: 'work', bash: 'true' },
            { id: 'stopper', break: true, if: 'scope.iteration >= 1', depends_on: ['work'] },
          ],
        },
      });

      const result = await loop.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['total_iterations']).toBe(1);
    });
  });

  describe('scope.iteration starts at 0 and increments', () => {
    it('delivers scope.iteration = 0 on the first body execution', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 1 }, [body]);

      await runLoop(loop);

      expect(body.capturedScopes[0]?.iteration).toBe(0);
    });

    it('delivers scope.iteration = 0, 1, 2 across three iterations', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 3 }, [body]);

      await runLoop(loop);

      const iterations = body.capturedScopes.map((s) => s?.iteration);
      expect(iterations).toEqual([0, 1, 2]);
    });

    it('exits after exactly 2 body runs when until uses scope.iteration >= 2', async () => {
      // Validates that the until expression sees the UPDATED iteration count (post-completion).
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ until: 'scope.iteration >= 2' }, [body]);

      await runLoop(loop);

      expect(body.runCount).toBe(2);
      const iterations = body.capturedScopes.map((s) => s?.iteration);
      // Body sees 0 and 1 (scope.iteration is completedIterations at the START of each iteration)
      expect(iterations).toEqual([0, 1]);
    });
  });

  describe('outputs evaluated at exit from final iteration context', () => {
    it('resolves output.last_value from scope.nodes.<id> of the final iteration', async () => {
      // Each iteration: body produces { count: i+1 }.
      let callIndex = 0;
      const body = new FactoryNode({ id: 'counter' }, () => {
        callIndex++;

        return { status: 'completed', result: { count: callIndex } };
      });

      const loop = makeLoopNode(
        {
          max_iterations: 3,
          outputs: { last_count: 'scope.nodes.counter.count' },
        },
        [body]
      );

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      // After 3 iterations, counter ran 3 times → last result is { count: 3 }
      expect(loopResult['output']).toEqual({ last_count: 3 });
    });

    it('resolves output.final_iter from scope.iteration (equals total_iterations on normal exit)', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode(
        {
          max_iterations: 2,
          outputs: { final_iter: 'scope.iteration' },
        },
        [body]
      );

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      // scope.iteration in evaluateOutputs is completedIterations = 2
      expect(loopResult['output']).toEqual({ final_iter: 2 });
    });
  });

  describe('scope.nodes', () => {
    it('until and outputs read scope.nodes from the just-completed iteration', async () => {
      // Iteration 0 (scope.iteration=0): body runs → result { val: 1 }. After completion,
      //   until sees scope.iteration=1, scope.nodes.counter.val=1.
      // Iteration 1 (scope.iteration=1): body runs → result { val: 2 }. After completion,
      //   until sees scope.iteration=2, scope.nodes.counter.val=2. >= 2 → stop.
      // outputs also sees scope.nodes from the final completed iteration: { val: 2 }.
      let callCount = 0;
      const body = new FactoryNode({ id: 'counter' }, () => {
        callCount++;

        return { status: 'completed', result: { val: callCount } };
      });

      const loop = makeLoopNode(
        {
          until: 'scope.nodes.counter.val >= 2',
          outputs: { last_val: 'scope.nodes.counter.val' },
        },
        [body]
      );

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['output']).toEqual({ last_val: 2 });
      expect(loopResult['total_iterations']).toBe(2);
    });

    it('body node sees scope.nodes from the previous completed iteration, not the current one', async () => {
      // A body node that both captures the scope it receives AND returns a distinct per-iteration
      // result. This proves the one-iteration lag: when the body runs in iteration N it sees
      // scope.nodes populated from iteration N-1 (or empty on iteration 0).
      //
      // Iteration 0 (scope.iteration=0):
      //   scope.nodes passed to body is empty (no previous iteration).
      //   Body returns { pass: 0 }.
      // Iteration 1 (scope.iteration=1):
      //   scope.nodes passed to body contains the snapshot from iteration 0 → { pass: 0 }.
      //   Body returns { pass: 1 }.
      const capturedScopes: ExecutionContext['scope'][] = [];

      // Inline class that captures scope AND returns a distinct per-iteration result.
      const scopeAndResultNode = new (class extends BaseNode {
        private callIdx = 0;

        public override run(opts: NodeRunOptions): Promise<NodeRunResult> {
          capturedScopes.push(opts.ctx.scope);
          const result = { pass: this.callIdx++ };

          return Promise.resolve({ status: 'completed', result });
        }
      })({ id: 'tracker' });

      const loop = makeLoopNode({ max_iterations: 2 }, [scopeAndResultNode]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      // Iteration 0: scope.nodes has NO entry for 'tracker' — empty map, no prior iteration.
      expect(capturedScopes[0]?.nodes.has('tracker')).toBe(false);
      expect(capturedScopes[0]?.nodes.size).toBe(0);
      // Iteration 1: scope.nodes contains iteration 0's result for 'tracker' → { pass: 0 }.
      expect(capturedScopes[1]?.nodes.has('tracker')).toBe(true);
      expect(capturedScopes[1]?.nodes.get('tracker')).toEqual({ pass: 0 });
    });

    it('on break: outputs reflect the partial iteration', async () => {
      // Body nodes run serially (stopper depends_on counter) each iteration:
      //   counter: runs every iteration and increments its val
      //   stopper: a real BreakNode guarded by if='scope.iteration >= 1'; skipped on iteration 0,
      //            fires on iteration 1
      //
      // Iteration 0 (scope.iteration=0): counter runs → {val:0}; stopper if=false → skipped.
      //   Full iteration completes → lastFullNodes = { counter:{val:0} }, completedIterations = 1.
      // Iteration 1 (scope.iteration=1): counter runs → {val:1}; stopper if=true → breaks.
      //   The partial iteration does NOT increment completedIterations → total_iterations = 1.
      //   partialNodes (the snapshot on break) = { counter:{val:1} }  (stopper broke — not in snapshot)
      //
      // outputs.final_val = scope.nodes.counter.val → 1 (counter completed in the partial iteration)
      // total_iterations = 1 (only iteration 0 fully completed; the broken iteration 1 is not counted)

      let counterIdx = 0;
      const loop = new LoopNode({
        id: 'loop1',
        maxIterations: 10,
        bodyNodes: [
          new FactoryNode({ id: 'counter' }, () => {
            const val = counterIdx++;

            return { status: 'completed', result: { val } };
          }),
          new BreakNode({ id: 'stopper', if: 'scope.iteration >= 1', depends_on: ['counter'] }),
        ],
        outputs: { final_val: 'scope.nodes.counter.val' },
      });

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      // Only iteration 0 fully completed; the partial broken iteration 1 is not counted
      expect(loopResult['total_iterations']).toBe(1);
      // counter completed in the partial iteration with val=1, so outputs see that value
      expect(loopResult['output']).toEqual({ final_val: 1 });
    });

    it('on break: a node absent in the partial iteration is undefined, not backfilled', async () => {
      // Setup: body has three nodes — worker, optional, and stopper.
      //   optional: a FactoryNode guarded by if='scope.iteration < 1'; runs on iteration 0 only.
      //   stopper: a real BreakNode guarded by if='scope.iteration >= 1', depends_on=['worker'];
      //            skipped on iteration 0, fires on iteration 1 after worker completes.
      //
      // Iteration 0 (scope.iteration=0): worker → completed {pass:1}; optional if=true → completed
      //   {kept:true}; stopper if=false → skipped.
      //   Full iteration completes → lastFullNodes = { worker:{pass:1}, optional:{kept:true} },
      //   completedIterations = 1.
      //
      // Iteration 1 (scope.iteration=1): worker → completed {pass:2}; optional if=false → skipped
      //   (absent from snapshot); stopper if=true → fires (break) after worker completes.
      //   partialNodes = { worker:{pass:2} }  (only nodes that completed before the break)
      //
      // scope.nodes on break = partialNodes (clean snapshot, NO cross-iteration backfill).
      // 'optional' is absent → scope.nodes.optional is undefined.
      // A guarded reference returns the fallback; an unguarded reference throws ENGINE_CEL_ERROR.
      let workerCallIdx = 0;
      const loop = new LoopNode({
        id: 'loop1',
        maxIterations: 10,
        until: undefined,
        bodyNodes: [
          // worker: runs every iteration, increments pass
          new FactoryNode({ id: 'worker' }, () => {
            workerCallIdx++;

            return { status: 'completed', result: { pass: workerCallIdx } };
          }),
          // optional: only runs on iteration 0 (if=false on iteration 1)
          new FactoryNode({ id: 'optional', if: 'scope.iteration < 1' }, () => ({
            status: 'completed',
            result: { kept: true },
          })),
          // stopper: a real BreakNode that fires on iteration 1 after worker completes
          new BreakNode({ id: 'stopper', if: 'scope.iteration >= 1', depends_on: ['worker'] }),
        ],
        outputs: {
          // worker completed in the partial iteration — its value IS present
          worker_pass: 'scope.nodes.worker.pass',
          // optional was skipped in the partial iteration — it is ABSENT (not backfilled from iter 0)
          // has() guard returns the fallback, proving it is undefined, not the prior iteration's value
          kept: 'has(scope.nodes.optional) ? scope.nodes.optional.kept : "absent"',
        },
      });

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      // Only iteration 0 fully completed; the broken iteration 1 is not counted
      expect(loopResult['total_iterations']).toBe(1);
      // worker completed in the partial iteration (pass=2) — present in the snapshot
      expect(loopResult['output']).toMatchObject({ worker_pass: 2 });
      // optional was absent in the partial iteration — NOT backfilled from iter 0;
      // the has() guard returns "absent", proving scope.nodes.optional is undefined
      expect(loopResult['output']).toMatchObject({ kept: 'absent' });
    });
  });

  describe('absent node in scope.nodes causes a CEL error, not a crash', () => {
    it('throws a NodeError (ENGINE_CEL_ERROR) when outputs reference a node that never ran', async () => {
      // Body: a node that always skips (if: false). scope.nodes.never_ran is absent.
      // outputs referencing it should throw ENGINE_CEL_ERROR from evaluateOutputs.
      const loop = LoopNode.parse({
        id: 'loop1',
        loop: {
          max_iterations: 1,
          nodes: [{ id: 'ghost', bash: 'true', if: 'false' }],
          outputs: { val: 'scope.nodes.ghost.output' },
        },
      });

      await expect(
        loop.run({
          ctx: makeCtx(),
          adapter: fakeAdapter,
          emitter: createEngineEmitter(),
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
    });

    it('resolves completed with a default value when outputs use has() to guard an absent node', async () => {
      // has() is the safe escape hatch: if the node never ran, scope.nodes.ghost is absent,
      // and has(scope.nodes.ghost) returns false, so the ternary falls back to "default".
      const loop = LoopNode.parse({
        id: 'loop1',
        loop: {
          max_iterations: 1,
          nodes: [{ id: 'ghost', bash: 'true', if: 'false' }],
          outputs: { val: 'has(scope.nodes.ghost) ? scope.nodes.ghost.output : "default"' },
        },
      });

      const result = await loop.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect((result as { status: 'completed'; result: NodeResult }).result['output']).toEqual({
        val: 'default',
      });
    });
  });

  describe('nested loops expose scope.outer', () => {
    it("inner loop body sees scope.outer.iteration equal to the enclosing loop's iteration count", async () => {
      const outerIterationsSeen: number[] = [];

      const innerBodyNode = new (class extends BaseNode {
        public override run(opts: NodeRunOptions): Promise<NodeRunResult> {
          outerIterationsSeen.push(opts.ctx.scope?.outer?.iteration ?? -1);

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'inner_step' });

      const innerLoop = makeLoopNode({ id: 'inner', max_iterations: 2 }, [innerBodyNode]);
      const outerLoop = makeLoopNode({ id: 'outer', max_iterations: 2 }, [innerLoop]);

      const result = await runLoop(outerLoop);

      expect(result.status).toBe('completed');
      expect(outerIterationsSeen).toHaveLength(4);
      expect(outerIterationsSeen).toEqual([0, 0, 1, 1]);
    });
  });

  describe('needs inside the loop body', () => {
    it('fails when the body references an EXTERNAL dependency via needs.<id> instead of scope.needs.<id>', async () => {
      // Set up an external dependency in ctx.needs so scope.needs.dep would work,
      // but the body uses `needs.dep` (the inner ctx.needs is empty for loop body nodes).
      // Inside the loop body, `needs` refers to the inner scheduler's accumulated sibling
      // results — external deps are not in that map; authors must use `scope.needs.<id>`.
      const depResult: NodeResult = { value: 42 };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      // A body node whose `if` expression tries `needs.dep.value` — this evaluates in the inner
      // ctx where `needs` starts as an empty map (loop body nodes cannot directly access external
      // deps via `needs`; FR-030). The `until` expression is valid.
      const body = new (class extends BaseNode {
        public override run(_opts: NodeRunOptions): Promise<NodeRunResult> {
          // Succeed unconditionally — the problematic reference is in this node's `if` expression
          // (`needs.dep.value == 42`), which is evaluated against the inner ctx where `needs` is
          // always an empty map for loop body nodes (FR-030). The `until` expression is valid.
          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'step', if: 'needs.dep.value == 42' });

      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        until: 'scope.iteration >= 1',
        bodyNodes: [body],
        outputs: undefined,
        maxIterations: undefined,
      });

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        adapter: fakeAdapter,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      // `needs` in the inner ctx is empty; `needs.dep` resolves to null/undefined in CEL,
      // which means `needs.dep.value` throws or the if expression fails — causing the body to fail.
      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: unknown }).error).toMatchObject({
        code: 'ENGINE_LOOP_BODY_FAILED',
      });
    });

    it('succeeds when a body node references a sibling result via needs.<sibling>', async () => {
      // Inside the loop body, the inner scheduler accumulates sibling completions into `needs`.
      // Node `a` completes first (node `b` depends_on `a`), then `b`'s `if` expression
      // evaluates `needs.a.value == 42` against the inner needs map — which has `a`'s result.
      let bRunCount = 0;

      const nodeA = new FactoryNode({ id: 'a' }, () => ({
        status: 'completed',
        result: { value: 42 },
      }));

      const nodeB = new (class extends BaseNode {
        public override run(_opts: NodeRunOptions): Promise<NodeRunResult> {
          bRunCount++;

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'b', depends_on: ['a'], if: 'needs.a.value == 42' });

      const loop = makeLoopNode({ max_iterations: 1 }, [nodeA, nodeB]);
      const result = await runLoop(loop);

      // The sibling reference resolves: b ran because needs.a.value == 42 was true
      expect(result.status).toBe('completed');
      expect(bRunCount).toBe(1);
    });
  });

  describe('scope.needs resolves external depends_on outputs (FR-030)', () => {
    it('scope.needs.<id> is accessible inside the body via until expression', async () => {
      const depResult: NodeResult = { threshold: 3 };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      // The until expression references scope.needs.dep.threshold — which is the external dep value.
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        until: 'scope.iteration >= scope.needs.dep.threshold',
        bodyNodes: [body],
        outputs: undefined,
        maxIterations: undefined,
      });

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        adapter: fakeAdapter,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      // threshold = 3, so until fires after 3 iterations
      expect(body.runCount).toBe(3);
      expect(
        (result as { status: 'completed'; result: NodeResult }).result['total_iterations']
      ).toBe(3);
    });

    it('scope.needs.<id> is accessible in loop outputs', async () => {
      const depResult: NodeResult = { label: 'done' };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        maxIterations: 1,
        until: undefined,
        bodyNodes: [body],
        outputs: { dep_label: 'scope.needs.dep.label' },
      });

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        adapter: fakeAdapter,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect((result as { status: 'completed'; result: NodeResult }).result['output']).toEqual({
        dep_label: 'done',
      });
    });
  });

  describe('top-level needs.<dep> resolves loop depends_on in until/outputs', () => {
    it('until reads top-level needs.<dep> to control iteration count', async () => {
      // The loop has depends_on: ['dep'] and ctx.needs has dep = { threshold: 2 }.
      // until: 'scope.iteration >= needs.dep.threshold' — the top-level `needs` in the
      // until eval context is loopNeeds (the loop's own external deps), so needs.dep
      // resolves to { threshold: 2 }. The loop should run exactly 2 body iterations.
      const depResult: NodeResult = { threshold: 2 };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        until: 'scope.iteration >= needs.dep.threshold',
        bodyNodes: [body],
        outputs: undefined,
        maxIterations: undefined,
      });

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        adapter: fakeAdapter,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      // threshold = 2, so until fires after 2 iterations
      expect(body.runCount).toBe(2);
      expect(
        (result as { status: 'completed'; result: NodeResult }).result['total_iterations']
      ).toBe(2);
    });

    it('outputs reads top-level needs.<dep> to produce loop output', async () => {
      // The loop has depends_on: ['dep'] and ctx.needs has dep = { label: 'alpha' }.
      // outputs: { dep_label: 'needs.dep.label' } — the top-level `needs` in the
      // outputs eval context is loopNeeds, so needs.dep resolves to { label: 'alpha' }.
      const depResult: NodeResult = { label: 'alpha' };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        maxIterations: 1,
        until: undefined,
        bodyNodes: [body],
        outputs: { dep_label: 'needs.dep.label' },
      });

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        adapter: fakeAdapter,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect((result as { status: 'completed'; result: NodeResult }).result['output']).toEqual({
        dep_label: 'alpha',
      });
    });

    it('body node id referenced via top-level needs.<bodyNodeId> in outputs causes ENGINE_CEL_ERROR', async () => {
      // Body results live on scope.nodes, not the loop-level needs map. If an outputs
      // expression uses needs.<bodyNodeId> (instead of scope.nodes.<bodyNodeId>), loopNeeds
      // has no entry for that id, so needs.step resolves to null in CEL. Accessing
      // needs.step.count then throws a CEL error, surfaced as ENGINE_CEL_ERROR.
      const body = new ScopeCapturingNode({ id: 'step' }, { count: 99 });
      const loop = new LoopNode({
        id: 'loop1',
        maxIterations: 1,
        until: undefined,
        bodyNodes: [body],
        // 'step' is a body node id — it lives in scope.nodes, NOT in the top-level needs map.
        // Accessing needs.step.count must fail with ENGINE_CEL_ERROR.
        outputs: { bad: 'needs.step.count' },
      });

      await expect(
        loop.run({
          ctx: makeCtx(),
          adapter: fakeAdapter,
          emitter: createEngineEmitter(),
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
    });
  });

  describe('matches', () => {
    it('returns true when raw object has a loop key', () => {
      expect(
        LoopNode.matches({
          id: 'l1',
          loop: { max_iterations: 1, nodes: [{ id: 's', bash: 'true' }] },
        })
      ).toBe(true);
    });

    it('returns false when raw object does not have a loop key', () => {
      expect(LoopNode.matches({ id: 'l1', bash: 'echo hi' })).toBe(false);
    });
  });

  describe('parse', () => {
    it('throws a ZodError when id contains invalid characters', () => {
      expect(() =>
        LoopNode.parse({
          id: 'bad-id',
          loop: { max_iterations: 1, nodes: [{ id: 's', bash: 'true' }] },
        })
      ).toThrow(ZodError);
    });

    it('throws a ZodError when nodes array is empty', () => {
      expect(() =>
        LoopNode.parse({
          id: 'l1',
          loop: { max_iterations: 1, nodes: [] },
        })
      ).toThrow(ZodError);
    });
  });

  describe('body node failure propagates', () => {
    it('returns status: failed with ENGINE_LOOP_BODY_FAILED when a body node fails', async () => {
      const failingBody = new FactoryNode({ id: 'step' }, () => ({
        status: 'failed',
        error: new Error('body exploded'),
      }));

      const loop = makeLoopNode({ max_iterations: 5 }, [failingBody]);
      const result = await runLoop(loop);

      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: unknown }).error).toMatchObject({
        code: 'ENGINE_LOOP_BODY_FAILED',
      });
      // Only ran once before stopping on failure
      expect(failingBody.runCount).toBe(1);
    });

    it('failure takes precedence over break when worker fails and stopper depends_on worker', async () => {
      // When worker fails, the scheduler sets hasFailure and halts dispatch before stopper
      // (which depends_on worker) is ever eligible to run. The scheduler returns
      // outcome: 'completed', success: false — not outcome: 'broke'. LoopNode must
      // surface status: failed with ENGINE_LOOP_BODY_FAILED, not treat it as a normal break.
      //
      // The depends_on ordering is what makes this deterministic: stopper is never dispatched
      // while hasFailure is set, so there is no race between the failure and the break paths.
      const worker = new FactoryNode({ id: 'worker' }, () => ({
        status: 'failed',
        error: new Error('worker exploded'),
      }));
      const stopper = new FactoryNode({ id: 'stopper', depends_on: ['worker'] }, () => ({
        status: 'break',
      }));

      const loop = makeLoopNode({ max_iterations: 5 }, [worker, stopper]);
      const result = await runLoop(loop);

      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: unknown }).error).toMatchObject({
        code: 'ENGINE_LOOP_BODY_FAILED',
      });
      // stopper was never dispatched because hasFailure halted the scheduler before worker's
      // dependents became eligible
      expect(stopper.runCount).toBe(0);
    });
  });

  describe('ExitNode inside body surfaces as status: exited', () => {
    it('returns status: exited when a body node returns exited', async () => {
      const exitBody = new FactoryNode({ id: 'step' }, () => ({
        status: 'exited',
        reason: 'workflow done',
        failure: false,
      }));

      const loop = makeLoopNode({ max_iterations: 5 }, [exitBody]);
      const result = await runLoop(loop);

      expect(result.status).toBe('exited');
      expect((result as { status: 'exited'; reason?: string; failure: boolean }).reason).toBe(
        'workflow done'
      );
      expect((result as { status: 'exited'; reason?: string; failure: boolean }).failure).toBe(
        false
      );
    });
  });

  describe('cancelled signal', () => {
    it('returns status: failed with ENGINE_NODE_CANCELLED when signal is already aborted', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 5 }, [body]);

      const result = await loop.run({
        ctx: makeCtx(),
        adapter: fakeAdapter,
        emitter: createEngineEmitter(),
        signal: AbortSignal.abort(),
      });

      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: unknown }).error).toMatchObject({
        code: 'ENGINE_NODE_CANCELLED',
      });
      expect(body.runCount).toBe(0);
    });
  });

  describe('validate', () => {
    it('throws EngineConfigError when a body node references an unknown depends_on id', () => {
      const body = new ScopeCapturingNode({ id: 'step', depends_on: ['nonexistent'] });
      const loop = makeLoopNode({ max_iterations: 1 }, [body]);

      expect(() => {
        loop.validate();
      }).toThrow(EngineConfigError);
    });

    it('throws EngineConfigError with a cycle message when body nodes form a dependency cycle', () => {
      // Both depend_on each other — validateDependencyReferences passes because
      // 'a' and 'b' are valid body ids, but topologicalSort detects the cycle.
      const nodeA = new ScopeCapturingNode({ id: 'a', depends_on: ['b'] });
      const nodeB = new ScopeCapturingNode({ id: 'b', depends_on: ['a'] });
      const loop = makeLoopNode({ max_iterations: 1 }, [nodeA, nodeB]);

      // Both assertions are needed: the first confirms the error type, the second
      // confirms the message is the cycle error (contains 'Cycle detected') and not
      // the unknown-reference error from validateDependencyReferences.
      expect(() => {
        loop.validate();
      }).toThrow(EngineConfigError);
      expect(() => {
        loop.validate();
      }).toThrow('Cycle detected in workflow graph');
    });

    it('throws EngineConfigError referencing the inner failure when validate() recurses into a nested loop', () => {
      // The outer body is structurally valid; the invalidity is only inside the inner loop.
      // inner_step depends_on 'ghost' which does not exist in the inner body — this is an
      // unknown-reference error that only surfaces when validate() recurses into innerLoop.
      const innerStep = new ScopeCapturingNode({ id: 'inner_step', depends_on: ['ghost'] });
      const innerLoop = makeLoopNode({ id: 'inner', max_iterations: 1 }, [innerStep]);
      const outerLoop = makeLoopNode({ id: 'outer', max_iterations: 1 }, [innerLoop]);

      expect(() => {
        outerLoop.validate();
      }).toThrow(EngineConfigError);
      // 'ghost' appears in the unknown-reference message — proves the throw came from the
      // recursive validate() call into innerLoop, not from an outer-level check.
      expect(() => {
        outerLoop.validate();
      }).toThrow("unknown depends_on reference: 'ghost'");
    });

    it('throws EngineConfigError with a context:shared fan-in message when a shared node has multiple agentic predecessors', () => {
      const agenticA1 = new (class extends BaseNode {
        public override isAgentic(): boolean {
          return true;
        }

        public override run(_opts: NodeRunOptions): Promise<NodeRunResult> {
          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'a1' });

      const agenticA2 = new (class extends BaseNode {
        public override isAgentic(): boolean {
          return true;
        }

        public override run(_opts: NodeRunOptions): Promise<NodeRunResult> {
          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'a2' });

      const sharedB = new (class extends BaseNode {
        public override useSharedContext(): boolean {
          return true;
        }

        public override run(_opts: NodeRunOptions): Promise<NodeRunResult> {
          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'b', depends_on: ['a1', 'a2'] });

      const loop = makeLoopNode({ max_iterations: 1 }, [agenticA1, agenticA2, sharedB]);

      expect(() => {
        loop.validate();
      }).toThrow(EngineConfigError);
      // The fan-in error message is the distinctive substring — confirms this is the
      // context:shared / agentic-predecessors error and not the dependency-reference error.
      expect(() => {
        loop.validate();
      }).toThrow('context:shared has multiple agentic predecessors');
    });
  });
});
