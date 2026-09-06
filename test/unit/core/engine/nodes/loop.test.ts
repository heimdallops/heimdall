import '../../../../../src/core/engine/nodes/bash.ts';

import { tmpdir } from 'node:os';

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
} from '../../../../../src/core/engine/nodes/base.ts';
import { BaseNode } from '../../../../../src/core/engine/nodes/base.ts';
import { BreakNode } from '../../../../../src/core/engine/nodes/break.ts';
import { LoopNode } from '../../../../../src/core/engine/nodes/loop.ts';

const makeCtx = (overrides: Partial<ExecutionContext> = {}): ExecutionContext => ({
  inputs: {},
  vars: {},
  needs: new Map(),
  // Must be a real, existing directory: BashNode forwards ctx.cwd to execa, and this
  // suite runs real bash body nodes, so a placeholder path like '/tmp/work' fails them.
  cwd: tmpdir(),
  heimdall: { run_cwd: tmpdir(), session_dir: '/tmp/session' },
  scopes: new Map(),
  ...overrides,
});

const runLoop = (node: LoopNode, ctx: ExecutionContext = makeCtx()): Promise<NodeRunResult> =>
  node.run({
    ctx,
    emitter: createEngineEmitter(),
    signal: new AbortController().signal,
  });

// Reads a scope entry's `index` attribute. ScopeEntry is a union (LoopScopeEntry |
// WorktreeScopeEntry | ScopeEntryBase), so the access resolves to `unknown`, hence the cast.
const scopeIndexOf = (
  scopes: ExecutionContext['scopes'] | undefined,
  id: string
): number | undefined => scopes?.get(id)?.index as number | undefined;

// Reads a scope entry's `prev` attribute — the previous body execution's result snapshot.
const scopePrevOf = (
  scopes: ExecutionContext['scopes'] | undefined,
  id: string
): ReadonlyMap<string, NodeResult> | undefined =>
  scopes?.get(id)?.prev as ReadonlyMap<string, NodeResult> | undefined;

// Stub body node — records the scope chain it received each time it runs.
class ScopeCapturingNode extends BaseNode {
  public readonly capturedScopes: ExecutionContext['scopes'][] = [];
  private readonly nodeResult: NodeResult;

  public constructor(data: BaseNodeData, result: NodeResult = {}) {
    super(data);
    this.nodeResult = result;
  }

  public get runCount(): number {
    return this.capturedScopes.length;
  }

  public override run(options: NodeRunOptions): Promise<NodeRunResult> {
    this.capturedScopes.push(options.ctx.scopes);

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
    while?: string;
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
    while: opts.while,
    maxIterations: opts.max_iterations,
    bodyNodes,
    outputs: opts.outputs,
  });

describe('LoopNode', () => {
  describe('until exits after N iterations', () => {
    it('runs the body exactly twice when until becomes true after 2 iterations', async () => {
      // self.iterations is the terminated-execution count at the checkpoint that follows each
      // execution: 1 after the first, 2 after the second — "self.iterations >= 2" then fires.
      const body = new ScopeCapturingNode({ id: 'step' }, { value: 'x' });
      const loop = makeLoopNode({ until: 'self.iterations >= 2', max_iterations: 10 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(2);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(2);
    });

    it('runs exactly once when until is satisfied after the first iteration', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ until: 'self.iterations >= 1', max_iterations: 10 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(1);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(1);
    });
  });

  describe('max_iterations exits successfully', () => {
    it('runs exactly max_iterations times and resolves completed (not failed) when until never becomes true', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ until: 'false', max_iterations: 3 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(3);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(3);
    });

    it('resolves completed when only max_iterations is set (no until)', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 2 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(2);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(2);
    });
  });

  describe('while is a pre-condition', () => {
    it('runs the body zero times when while is false before the first iteration', async () => {
      // while is checked BEFORE the body runs, so a condition that is false up front
      // skips every iteration — the defining difference from until (a post-condition).
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ while: 'false' }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(0);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(0);
    });

    it('runs the body while the condition holds and stops once it becomes false', async () => {
      // self.iterations is 0,1,2 at the start of each iteration's while check (checked before the
      // body runs): 0<3, 1<3, 2<3 pass (3 runs); on the 4th check 3<3 is false → stop.
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ while: 'self.iterations < 3', max_iterations: 15 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(3);
      expect(body.capturedScopes.map((s) => scopeIndexOf(s, 'loop1'))).toEqual([0, 1, 2]);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(3);
    });

    it('caps a while loop with max_iterations when the condition stays true', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ while: 'true', max_iterations: 2 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(2);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(2);
    });

    it("evaluates while against self.needs (the loop's own declared depends_on)", async () => {
      const depResult: NodeResult = { threshold: 2 };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        while: 'self.iterations < self.needs.dep.threshold',
        until: undefined,
        maxIterations: 10,
        bodyNodes: [body],
        outputs: undefined,
      });

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      // threshold = 2, so while stops the loop after 2 iterations
      expect(body.runCount).toBe(2);
    });

    it('throws a NodeError (ENGINE_CEL_ERROR) when while does not evaluate to a boolean', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ while: '1 + 1' }, [body]);

      await expect(runLoop(loop)).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
      // while is a pre-condition: the bad expression is evaluated before the body ever runs
      expect(body.runCount).toBe(0);
    });
  });

  describe('empty until/while are treated as unset, not a configured expression', () => {
    it('a directly-constructed loop with while: "" runs the full max_iterations count instead of throwing ENGINE_CEL_ERROR', async () => {
      // The schema normalizes '' to undefined before LoopNode ever sees it, but the constructor
      // itself must also treat '' as falsy (evaluateWhile's `if (!this.while)` guard) — this is
      // the runtime contract, reachable via direct construction even though the schema can no
      // longer produce it. Bounded by max_iterations so the loop cannot run unbounded.
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ while: '', max_iterations: 2 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(2);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(2);
    });

    it('a directly-constructed loop with until: "" runs the full max_iterations count instead of stopping early', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ until: '', max_iterations: 2 }, [body]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(2);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(2);
    });

    it('LoopNode.parse normalizes while: "" alongside max_iterations, and the loop runs unconditionally to the max_iterations bound', async () => {
      const loop = LoopNode.parse({
        id: 'loop1',
        loop: {
          while: '',
          max_iterations: 3,
          nodes: [{ id: 'inner', bash: 'true' }],
        },
      });

      const result = await loop.run({
        ctx: makeCtx(),
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(3);
    });

    it('LoopNode.parse normalizes until: "" alongside max_iterations, and the loop runs unconditionally to the max_iterations bound', async () => {
      const loop = LoopNode.parse({
        id: 'loop1',
        loop: {
          until: '',
          max_iterations: 3,
          nodes: [{ id: 'inner', bash: 'true' }],
        },
      });

      const result = await loop.run({
        ctx: makeCtx(),
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(3);
    });
  });

  describe('BreakNode exits the loop early', () => {
    it('stops iterating when a BreakNode fires — the interrupted execution still increments iterations to 1', async () => {
      // The break node fires unconditionally on the loop's only body execution. completedIterations
      // increments before the broke branch is checked, so the execution that hit the break counts.
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
        emitter,
        signal: new AbortController().signal,
      });

      // The BreakNode is a control-flow signal — it does NOT emit node_completed.
      expect(completedEvents).not.toContain('stopper');

      // The loop itself resolves as completed (break is normal exit, not failure).
      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['iterations']).toBe(1);
    });

    it('stops before the cap — a conditional break during body index 1 yields iterations 2', async () => {
      // Body execution 0 (scopes.loop1.index=0): work runs, stopper if=false → skipped; the
      // execution completes normally, completedIterations → 1.
      // Body execution 1 (scopes.loop1.index=1): work runs, stopper if=true → breaks.
      const loop = LoopNode.parse({
        id: 'loop1',
        loop: {
          max_iterations: 10,
          nodes: [
            { id: 'work', bash: 'true' },
            { id: 'stopper', break: true, if: 'scopes.loop1.index >= 1', depends_on: ['work'] },
          ],
        },
      });

      const result = await loop.run({
        ctx: makeCtx(),
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['iterations']).toBe(2);
    });
  });

  describe('scopes.loop1.index starts at 0 and increments', () => {
    it('delivers scopes.loop1.index = 0 on the first body execution', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 1 }, [body]);

      await runLoop(loop);

      expect(scopeIndexOf(body.capturedScopes[0], 'loop1')).toBe(0);
    });

    it('delivers scopes.loop1.index = 0, 1, 2 across three iterations', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 3 }, [body]);

      await runLoop(loop);

      const indexes = body.capturedScopes.map((s) => scopeIndexOf(s, 'loop1'));
      expect(indexes).toEqual([0, 1, 2]);
    });

    it('exits after exactly 2 body runs when until uses self.iterations >= 2', async () => {
      // Validates that the until expression sees the UPDATED iteration count (post-completion).
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ until: 'self.iterations >= 2', max_iterations: 10 }, [body]);

      await runLoop(loop);

      expect(body.runCount).toBe(2);
      const indexes = body.capturedScopes.map((s) => scopeIndexOf(s, 'loop1'));
      // Body sees 0 and 1 (scopes.loop1.index is completedIterations at the START of each execution)
      expect(indexes).toEqual([0, 1]);
    });
  });

  describe('outputs evaluated at exit from final iteration context', () => {
    it('resolves output.last_value from self.nodes.<id> of the final iteration', async () => {
      // Each iteration: body produces { count: i+1 }.
      let callIndex = 0;
      const body = new FactoryNode({ id: 'counter' }, () => {
        callIndex++;

        return { status: 'completed', result: { count: callIndex } };
      });

      const loop = makeLoopNode(
        {
          max_iterations: 3,
          outputs: { last_count: 'self.nodes.counter.count' },
        },
        [body]
      );

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      // After 3 iterations, counter ran 3 times → last result is { count: 3 }
      expect(loopResult['output']).toEqual({ last_count: 3 });
    });

    it('resolves output.final_iter from self.iterations (equals the emitted iterations on normal exit)', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode(
        {
          max_iterations: 2,
          outputs: { final_iter: 'self.iterations' },
        },
        [body]
      );

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['output']).toEqual({ final_iter: 2 });
    });
  });

  describe('self.nodes reflects the just-completed iteration at checkpoints', () => {
    it('until and outputs read self.nodes from the just-completed iteration', async () => {
      // Body execution 0: body runs → result { val: 1 }. At the following checkpoint,
      //   self.nodes.counter.val=1 (self.iterations=1) — until is false.
      // Body execution 1: body runs → result { val: 2 }. At the following checkpoint,
      //   self.nodes.counter.val=2 (self.iterations=2) — until fires.
      // outputs also reads self.nodes from the final completed execution: { val: 2 }.
      let callCount = 0;
      const body = new FactoryNode({ id: 'counter' }, () => {
        callCount++;

        return { status: 'completed', result: { val: callCount } };
      });

      const loop = makeLoopNode(
        {
          until: 'self.nodes.counter.val >= 2',
          outputs: { last_val: 'self.nodes.counter.val' },
          max_iterations: 10,
        },
        [body]
      );

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['output']).toEqual({ last_val: 2 });
      expect(loopResult['iterations']).toBe(2);
    });

    it('on break: self.nodes is the partial snapshot — completed nodes present, skipped and cut-off nodes absent (not backfilled)', async () => {
      let workerCallIdx = 0;
      let afterRunCount = 0;
      const loop = new LoopNode({
        id: 'loop1',
        maxIterations: 10,
        until: undefined,
        bodyNodes: [
          new FactoryNode({ id: 'worker' }, () => {
            workerCallIdx++;

            return { status: 'completed', result: { pass: workerCallIdx } };
          }),
          new FactoryNode({ id: 'optional', if: 'scopes.loop1.index < 1' }, () => ({
            status: 'completed',
            result: { kept: true },
          })),
          new BreakNode({ id: 'stopper', if: 'scopes.loop1.index >= 1', depends_on: ['worker'] }),
          // `after` depends on the break: it runs while the break is skipped (a skipped break
          // does not cascade its skip) and is cancelled once the break fires.
          new FactoryNode({ id: 'after', depends_on: ['stopper'] }, () => {
            afterRunCount += 1;

            return { status: 'completed', result: { done: true } };
          }),
        ],
        outputs: {
          worker_pass: 'self.nodes.worker.pass',
          kept: 'has(self.nodes.optional) ? self.nodes.optional.kept : "absent"',
          after_done: 'has(self.nodes.after) ? self.nodes.after.done : "cut_off"',
          final_iterations: 'self.iterations',
        },
      });

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      // The break fires during body index 1 (see the earlier BreakNode tests for why the
      // interrupted execution still counts).
      expect(loopResult['iterations']).toBe(2);
      expect(loopResult['output']).toMatchObject({ worker_pass: 2, final_iterations: 2 });
      expect(loopResult['output']).toMatchObject({ kept: 'absent' });
      expect(afterRunCount).toBe(1);
      expect(loopResult['output']).toMatchObject({ after_done: 'cut_off' });
    });
  });

  describe("scopes.loop1.prev exposes the previous body execution's snapshot, one execution behind", () => {
    it('captures an empty prev map on body index 0 and the prior execution snapshot from index 1 onward', async () => {
      // A node that both captures the scope chain it received AND returns a distinct
      // per-execution result, to prove the one-execution lag directly from the ScopeChain.
      const capturedScopes: ExecutionContext['scopes'][] = [];

      const scopeAndResultNode = new (class extends BaseNode {
        private callIdx = 0;

        public override run(opts: NodeRunOptions): Promise<NodeRunResult> {
          capturedScopes.push(opts.ctx.scopes);
          const result = { pass: this.callIdx++ };

          return Promise.resolve({ status: 'completed', result });
        }
      })({ id: 'tracker' });

      const loop = makeLoopNode({ max_iterations: 2 }, [scopeAndResultNode]);

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      // Body index 0: no previous execution, so prev has no entry for 'tracker'.
      expect(scopePrevOf(capturedScopes[0], 'loop1')?.has('tracker')).toBe(false);
      expect(scopePrevOf(capturedScopes[0], 'loop1')?.size).toBe(0);
      // Body index 1: prev carries index 0's result for 'tracker' → { pass: 0 }.
      expect(scopePrevOf(capturedScopes[1], 'loop1')?.has('tracker')).toBe(true);
      expect(scopePrevOf(capturedScopes[1], 'loop1')?.get('tracker')).toEqual({ pass: 0 });
    });

    it('gates a body node on has(scopes.loop1.prev.tracker) so it runs only from index 1 onward, and resolves the previous execution value exactly one index behind at every step', async () => {
      const tracker = new FactoryNode({ id: 'tracker' }, (callIndex) => ({
        status: 'completed',
        result: { pass: callIndex },
      }));

      let gatedRunCount = 0;
      const gated = new FactoryNode({ id: 'gated', if: 'has(scopes.loop1.prev.tracker)' }, () => {
        gatedRunCount += 1;

        return { status: 'completed', result: {} };
      });

      let checkerRunCount = 0;
      const checker = new FactoryNode(
        {
          id: 'checker',
          // At index 0 there is no prior execution to compare against; from index 1 onward the
          // previous execution's tracker result must be exactly one execution old. (`1.0`, not
          // `1`: this CEL evaluator treats bound numbers as doubles and rejects int/double
          // arithmetic — subtraction requires matching literal types, unlike comparison.)
          if: 'scopes.loop1.index == 0 || scopes.loop1.prev.tracker.pass == scopes.loop1.index - 1.0',
        },
        () => {
          checkerRunCount += 1;

          return { status: 'completed', result: {} };
        }
      );

      const loop = makeLoopNode({ max_iterations: 3 }, [tracker, gated, checker]);
      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      // gated is skipped at index 0 (empty prev) and runs at index 1 and index 2.
      expect(gatedRunCount).toBe(2);
      // checker's if holds at every index; a false evaluation (or a thrown expression) at any
      // index would mean prev did not carry the correct one-execution-old value.
      expect(checkerRunCount).toBe(3);
    });
  });

  describe('self.nodes.<id> absent from a node that never ran surfaces a CEL error, not a crash', () => {
    it('throws a NodeError (ENGINE_CEL_ERROR) when outputs reference a node that never ran', async () => {
      // Body: a node that always skips (if: false). self.nodes.ghost is absent.
      const loop = LoopNode.parse({
        id: 'loop1',
        loop: {
          max_iterations: 1,
          nodes: [{ id: 'ghost', bash: 'true', if: 'false' }],
          outputs: { val: 'self.nodes.ghost.output' },
        },
      });

      await expect(
        loop.run({
          ctx: makeCtx(),
          emitter: createEngineEmitter(),
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
    });

    it('resolves completed with a default value when outputs use has() to guard an absent node', async () => {
      // has() is the safe escape hatch: if the node never ran, self.nodes.ghost is absent,
      // and has(self.nodes.ghost) returns false, so the ternary falls back to "default".
      const loop = LoopNode.parse({
        id: 'loop1',
        loop: {
          max_iterations: 1,
          nodes: [{ id: 'ghost', bash: 'true', if: 'false' }],
          outputs: {
            val: 'has(self.nodes.ghost) ? self.nodes.ghost.output : "default"',
          },
        },
      });

      const result = await loop.run({
        ctx: makeCtx(),
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect((result as { status: 'completed'; result: NodeResult }).result['output']).toEqual({
        val: 'default',
      });
    });
  });

  describe('ancestor scope entries resolve independently by id, with no traversal or shadowing', () => {
    it("inner loop body reads the enclosing loop's index via scopes.ci.index and its own loop's index via scopes.retry.index in the same capture", async () => {
      const ciIndexSeen: number[] = [];
      const retryIndexSeen: number[] = [];

      const innerBodyNode = new (class extends BaseNode {
        public override run(opts: NodeRunOptions): Promise<NodeRunResult> {
          ciIndexSeen.push(scopeIndexOf(opts.ctx.scopes, 'ci') ?? -1);
          retryIndexSeen.push(scopeIndexOf(opts.ctx.scopes, 'retry') ?? -1);

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'inner_step' });

      const retryLoop = makeLoopNode({ id: 'retry', max_iterations: 2 }, [innerBodyNode]);
      const ciLoop = makeLoopNode({ id: 'ci', max_iterations: 2 }, [retryLoop]);

      const result = await runLoop(ciLoop);

      expect(result.status).toBe('completed');
      expect(ciIndexSeen).toEqual([0, 0, 1, 1]);
      expect(retryIndexSeen).toEqual([0, 1, 0, 1]);
    });
  });

  describe('an ancestor scope entry passes through a loop unchanged, at every nesting depth', () => {
    const worktreeEntry = {
      needs: new Map<string, NodeResult>(),
      path: '/repo/worktrees/wt-1',
      branch: 'feat/example',
      base_commit: 'abc1234',
    };

    it('while resolves scopes.wt.branch, gating iteration on the ancestor scope', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode(
        { while: `scopes.wt.branch == '${worktreeEntry.branch}'`, max_iterations: 2 },
        [body]
      );
      const ctx = makeCtx({ scopes: new Map([['wt', worktreeEntry]]) });

      const result = await runLoop(loop, ctx);

      expect(result.status).toBe('completed');
      // while stays true on both pre-iteration checks (branch always matches); max_iterations caps it.
      expect(body.runCount).toBe(2);
    });

    it('until resolves scopes.wt.path together with self.iterations to stop the loop', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode(
        {
          until: `scopes.wt.path == '${worktreeEntry.path}' && self.iterations >= 1`,
          max_iterations: 10,
        },
        [body]
      );
      const ctx = makeCtx({ scopes: new Map([['wt', worktreeEntry]]) });

      const result = await runLoop(loop, ctx);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(1);
    });

    it('outputs resolves scopes.wt.path, .branch, and .base_commit from the ancestor scope', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode(
        {
          max_iterations: 1,
          outputs: {
            wt_path: 'scopes.wt.path',
            wt_branch: 'scopes.wt.branch',
            wt_base_commit: 'scopes.wt.base_commit',
          },
        },
        [body]
      );
      const ctx = makeCtx({ scopes: new Map([['wt', worktreeEntry]]) });

      const result = await runLoop(loop, ctx);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['output']).toEqual({
        wt_path: worktreeEntry.path,
        wt_branch: worktreeEntry.branch,
        wt_base_commit: worktreeEntry.base_commit,
      });
    });

    it('propagates the ancestor entry unchanged into a body node at one nesting level', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 1 }, [body]);
      const ctx = makeCtx({ scopes: new Map([['wt', worktreeEntry]]) });

      await runLoop(loop, ctx);

      expect(body.capturedScopes[0]?.get('wt')).toEqual(worktreeEntry);
    });

    it('propagates the same ancestor entry unchanged into a body node two nesting levels deep', async () => {
      const innerBody = new ScopeCapturingNode({ id: 'inner_step' });
      const retryLoop = makeLoopNode({ id: 'retry', max_iterations: 1 }, [innerBody]);
      const ciLoop = makeLoopNode({ id: 'ci', max_iterations: 2 }, [retryLoop]);
      const ctx = makeCtx({ scopes: new Map([['wt', worktreeEntry]]) });

      await runLoop(ciLoop, ctx);

      expect(innerBody.capturedScopes).toHaveLength(2);
      for (const scope of innerBody.capturedScopes) {
        expect(scope?.get('wt')).toEqual(worktreeEntry);
      }
    });

    it("holds exactly the loop's own entry in a body node's scopes map when there is no enclosing scope", async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 1 }, [body]);

      await runLoop(loop);

      expect(Array.from(body.capturedScopes[0]?.keys() ?? [])).toEqual(['loop1']);
    });
  });

  describe('heimdall propagation into loop bodies (run_cwd and session_dir)', () => {
    // Deliberately distinct from makeCtx's default `cwd` (tmpdir()) so a test that reads
    // this value back cannot pass by accident if the implementation forwarded ctx.cwd instead.
    const runCwd = '/original/run-cwd';
    // Likewise distinct from makeCtx's default heimdall.session_dir ('/tmp/session').
    const sessionDir = '/original/session-dir';

    it('delivers heimdall unchanged into the body node context, including both run_cwd and session_dir', async () => {
      const capturedRunCwd: string[] = [];
      const capturedSessionDir: string[] = [];
      const body = new (class extends BaseNode {
        public override run(opts: NodeRunOptions): Promise<NodeRunResult> {
          capturedRunCwd.push(opts.ctx.heimdall.run_cwd);
          capturedSessionDir.push(opts.ctx.heimdall.session_dir);

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 1 }, [body]);
      const ctx = makeCtx({ heimdall: { run_cwd: runCwd, session_dir: sessionDir } });

      await runLoop(loop, ctx);

      expect(capturedRunCwd).toEqual([runCwd]);
      // heimdall.session_dir must survive the same body-context construction site as run_cwd —
      // both fields ride the same `heimdall: ctx.heimdall` passthrough, so a regression that
      // reconstructs the object field-by-field and drops one is caught here.
      expect(capturedSessionDir).toEqual([sessionDir]);
    });

    it('propagates the same heimdall.run_cwd unchanged through nested loop bodies', async () => {
      const capturedRunCwd: string[] = [];
      const innerBody = new (class extends BaseNode {
        public override run(opts: NodeRunOptions): Promise<NodeRunResult> {
          capturedRunCwd.push(opts.ctx.heimdall.run_cwd);

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'inner_step' });

      const retryLoop = makeLoopNode({ id: 'retry', max_iterations: 1 }, [innerBody]);
      const ciLoop = makeLoopNode({ id: 'ci', max_iterations: 2 }, [retryLoop]);
      const ctx = makeCtx({ heimdall: { run_cwd: runCwd, session_dir: sessionDir } });

      const result = await runLoop(ciLoop, ctx);

      expect(result.status).toBe('completed');
      // Two outer iterations, one inner iteration each — both see the identical run_cwd
      // even though scopes.retry shadows per level.
      expect(capturedRunCwd).toEqual([runCwd, runCwd]);
    });

    it('while resolves heimdall.run_cwd, gating iteration on the propagated value', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ while: `heimdall.run_cwd == '${runCwd}'`, max_iterations: 2 }, [
        body,
      ]);
      const ctx = makeCtx({ heimdall: { run_cwd: runCwd, session_dir: sessionDir } });

      const result = await runLoop(loop, ctx);

      expect(result.status).toBe('completed');
      // while stays true on both pre-iteration checks (run_cwd always matches); max_iterations caps it.
      expect(body.runCount).toBe(2);
    });

    it('until resolves heimdall.run_cwd together with self.iterations to stop the loop', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      // max_iterations is a safety net, not part of the behavior under test: without it, a
      // regression that breaks heimdall threading into evaluateUntil leaves until permanently
      // false, spinning LoopNode's unbounded `for (;;)` until the worker OOMs instead of
      // failing a normal assertion.
      const loop = makeLoopNode(
        {
          until: `heimdall.run_cwd == '${runCwd}' && self.iterations >= 1`,
          max_iterations: 5,
        },
        [body]
      );
      const ctx = makeCtx({ heimdall: { run_cwd: runCwd, session_dir: sessionDir } });

      const result = await runLoop(loop, ctx);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(1);
    });

    it('outputs resolves heimdall.run_cwd from the propagated context', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ max_iterations: 1, outputs: { run_cwd: 'heimdall.run_cwd' } }, [
        body,
      ]);
      const ctx = makeCtx({ heimdall: { run_cwd: runCwd, session_dir: sessionDir } });

      const result = await runLoop(loop, ctx);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['output']).toEqual({ run_cwd: runCwd });
    });
  });

  describe('a body node referencing bare needs fails; self.needs.<sibling> resolves the declared edge', () => {
    it('fails when a body node references bare needs.<id> — needs is not a bound root inside the loop body', async () => {
      // Set up an external dependency in ctx.needs so scopes.loop1.needs.dep would work,
      // but the body uses bare `needs.dep` — `needs` is not bound as a root at any expression
      // site; only self.needs (declared edges) and scopes.<ancestor>.needs are reachable.
      const depResult: NodeResult = { value: 42 };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      // Referencing bare `needs.dep.value` throws "Unknown variable: needs", which fails this
      // body node's `if` and the loop surfaces ENGINE_LOOP_BODY_FAILED.
      const body = new (class extends BaseNode {
        public override run(_opts: NodeRunOptions): Promise<NodeRunResult> {
          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'step', if: 'needs.dep.value == 42' });

      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        until: 'self.iterations >= 1',
        bodyNodes: [body],
        outputs: undefined,
        maxIterations: undefined,
      });

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: unknown }).error).toMatchObject({
        code: 'ENGINE_LOOP_BODY_FAILED',
      });
    });

    it('succeeds when a body node references a declared sibling via self.needs.<sibling>', async () => {
      // Node `a` completes first (node `b` depends_on `a`), then `b`'s `if` expression
      // evaluates self.needs.a.value == 42 — self.needs is projected from `b`'s own
      // depends_on, which the inner scheduler has already populated with `a`'s result.
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
      })({ id: 'b', depends_on: ['a'], if: 'self.needs.a.value == 42' });

      const loop = makeLoopNode({ max_iterations: 1 }, [nodeA, nodeB]);
      const result = await runLoop(loop);

      // The sibling reference resolves: b ran because self.needs.a.value == 42 was true
      expect(result.status).toBe('completed');
      expect(bRunCount).toBe(1);
    });
  });

  describe('bare needs is not reachable at a checkpoint; self.needs.<dep> is the declared-edge surface', () => {
    it('until referencing bare needs.<dep> fails with ENGINE_CEL_ERROR', async () => {
      const depResult: NodeResult = { threshold: 2 };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        until: 'self.iterations >= needs.dep.threshold',
        bodyNodes: [body],
        outputs: undefined,
        maxIterations: undefined,
      });

      const ctx = makeCtx({ needs: externalNeeds });

      await expect(
        loop.run({ ctx, emitter: createEngineEmitter(), signal: new AbortController().signal })
      ).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
    });

    it('until referencing self.needs.<dep> resolves and controls the iteration count', async () => {
      const depResult: NodeResult = { threshold: 2 };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        until: 'self.iterations >= self.needs.dep.threshold',
        bodyNodes: [body],
        outputs: undefined,
        maxIterations: 10,
      });

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(2);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(2);
    });

    it('outputs referencing bare needs.<dep> fails with ENGINE_CEL_ERROR', async () => {
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

      await expect(
        loop.run({ ctx, emitter: createEngineEmitter(), signal: new AbortController().signal })
      ).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
    });

    it('outputs referencing self.needs.<dep> resolves to the declared dependency value', async () => {
      const depResult: NodeResult = { label: 'alpha' };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        maxIterations: 1,
        until: undefined,
        bodyNodes: [body],
        outputs: { dep_label: 'self.needs.dep.label' },
      });

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect((result as { status: 'completed'; result: NodeResult }).result['output']).toEqual({
        dep_label: 'alpha',
      });
    });

    it('outputs referencing self.needs.<bodyNodeId> fails — body results live on self.nodes, not self.needs', async () => {
      // 'step' is a body node id, not a declared dependency; self.needs holds declared edges
      // only, so self.needs.step is absent and accessing .count throws.
      const body = new ScopeCapturingNode({ id: 'step' }, { count: 99 });
      const loop = new LoopNode({
        id: 'loop1',
        maxIterations: 1,
        until: undefined,
        bodyNodes: [body],
        outputs: { bad: 'self.needs.step.count' },
      });

      await expect(
        loop.run({
          ctx: makeCtx(),
          emitter: createEngineEmitter(),
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
    });
  });

  describe("self.needs is filtered to the loop's declared depends_on", () => {
    it('fails reading a completed dependency the loop never declared, while the same expression against a declared dep resolves', async () => {
      const declaredResult: NodeResult = { threshold: 1 };
      const undeclaredResult: NodeResult = { threshold: 99 };
      const externalNeeds = new Map<string, NodeResult>([
        ['dep', declaredResult],
        ['other', undeclaredResult],
      ]);
      const ctx = makeCtx({ needs: externalNeeds });

      const failingLoop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        maxIterations: 1,
        until: undefined,
        bodyNodes: [new ScopeCapturingNode({ id: 'step' })],
        outputs: { bad: 'self.needs.other.threshold' },
      });

      await expect(
        failingLoop.run({
          ctx,
          emitter: createEngineEmitter(),
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });

      const resolvingLoop = new LoopNode({
        id: 'loop1',
        depends_on: ['dep'],
        maxIterations: 1,
        until: undefined,
        bodyNodes: [new ScopeCapturingNode({ id: 'step' })],
        outputs: { good: 'self.needs.dep.threshold' },
      });

      const result = await resolvingLoop.run({
        ctx,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect((result as { status: 'completed'; result: NodeResult }).result['output']).toEqual({
        good: 1,
      });
    });
  });

  describe("a body node reads an ancestor loop's declared dependency via scopes.<loop_id>.needs", () => {
    it('resolves scopes.loop1.needs.dep.threshold from the loop-level depends_on inside a body node if expression', async () => {
      const depResult: NodeResult = { threshold: 5 };
      const externalNeeds = new Map<string, NodeResult>([['dep', depResult]]);

      let bodyRan = false;
      const body = new (class extends BaseNode {
        public override run(_opts: NodeRunOptions): Promise<NodeRunResult> {
          bodyRan = true;

          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'step', if: 'scopes.loop1.needs.dep.threshold == 5' });

      const loop = makeLoopNode({ depends_on: ['dep'], max_iterations: 1 }, [body]);

      const ctx = makeCtx({ needs: externalNeeds });
      const result = await loop.run({
        ctx,
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(result.status).toBe('completed');
      expect(bodyRan).toBe(true);
      expect((result as { status: 'completed'; result: NodeResult }).result['iterations']).toBe(1);
    });
  });

  describe('referencing a non-existent ancestor scope id fails immediately', () => {
    // 'loop' covers the literal family key from the old scoping model — the id an author is
    // most likely to reflexively write instead of the loop's own id; 'outer' and 'needs' are
    // arbitrary non-existent ids that must fail the same way.
    it.each(['loop', 'outer', 'needs'])(
      "a checkpoint expression referencing the non-existent ancestor scope id '%s' fails with ENGINE_CEL_ERROR",
      async (id) => {
        const body = new ScopeCapturingNode({ id: 'step' });
        const loop = makeLoopNode({ while: `scopes.${id}.index >= 1`, max_iterations: 3 }, [body]);

        await expect(runLoop(loop)).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
        expect(body.runCount).toBe(0);
      }
    );

    it.each(['loop', 'outer', 'needs'])(
      "a body node's if expression referencing the non-existent ancestor scope id '%s' fails the loop with ENGINE_LOOP_BODY_FAILED",
      async (id) => {
        const body = new (class extends BaseNode {
          public override run(_opts: NodeRunOptions): Promise<NodeRunResult> {
            return Promise.resolve({ status: 'completed', result: {} });
          }
        })({ id: 'step', if: `scopes.${id}.dep.value == 1` });

        const loop = makeLoopNode({ max_iterations: 3 }, [body]);
        const result = await runLoop(loop);

        expect(result.status).toBe('failed');
        expect((result as { status: 'failed'; error: unknown }).error).toMatchObject({
          code: 'ENGINE_LOOP_BODY_FAILED',
        });
      }
    );
  });

  describe('scopes.<loop_id>.index resolves identically regardless of enclosing nesting (wrap-safety)', () => {
    it('resolves scopes.ci.index for a body node the same way whether or not the ci subtree is wrapped in a further enclosing loop', async () => {
      const buildCiSubtree = (): { ciLoop: LoopNode; indexReadings: number[] } => {
        const indexReadings: number[] = [];
        const innerBody = new (class extends BaseNode {
          public override run(opts: NodeRunOptions): Promise<NodeRunResult> {
            indexReadings.push(scopeIndexOf(opts.ctx.scopes, 'ci') ?? -1);

            return Promise.resolve({ status: 'completed', result: {} });
          }
        })({ id: 'inner_step' });
        const ciLoop = makeLoopNode({ id: 'ci', max_iterations: 3 }, [innerBody]);

        return { ciLoop, indexReadings };
      };

      const unwrapped = buildCiSubtree();
      await runLoop(unwrapped.ciLoop);

      const wrapped = buildCiSubtree();
      const wrapper = makeLoopNode({ id: 'wrapper', max_iterations: 1 }, [wrapped.ciLoop]);
      await runLoop(wrapper);

      expect(unwrapped.indexReadings).toEqual([0, 1, 2]);
      expect(wrapped.indexReadings).toEqual(unwrapped.indexReadings);
    });
  });

  describe("a nested loop's own checkpoint is outside its own scope", () => {
    it("reads self.iterations as its own terminated count and scopes.ci.index as the enclosing loop's current index in the same expression map", async () => {
      const innerBody = new ScopeCapturingNode({ id: 'inner_step' });
      const retryLoop = makeLoopNode(
        {
          id: 'retry',
          max_iterations: 2,
          outputs: {
            self_iterations: 'self.iterations',
            ci_index: 'scopes.ci.index',
          },
        },
        [innerBody]
      );

      const ctxAtCiIndex = (index: number): ExecutionContext =>
        makeCtx({ scopes: new Map([['ci', { needs: new Map(), index, prev: new Map() }]]) });

      const resultAt0 = await retryLoop.run({
        ctx: ctxAtCiIndex(0),
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });
      const resultAt1 = await retryLoop.run({
        ctx: ctxAtCiIndex(1),
        emitter: createEngineEmitter(),
        signal: new AbortController().signal,
      });

      expect(resultAt0.status).toBe('completed');
      expect((resultAt0 as { status: 'completed'; result: NodeResult }).result['output']).toEqual({
        self_iterations: 2,
        ci_index: 0,
      });
      expect(resultAt1.status).toBe('completed');
      expect((resultAt1 as { status: 'completed'; result: NodeResult }).result['output']).toEqual({
        self_iterations: 2,
        ci_index: 1,
      });
    });

    it('fails when a checkpoint references its own id via scopes.<own_id>.index', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode(
        { id: 'retry', until: 'scopes.retry.index >= 1', max_iterations: 3 },
        [body]
      );

      await expect(runLoop(loop)).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
    });
  });

  describe('loop counters are bound to the correct vantage only', () => {
    it('fails when a checkpoint references self.index — the counter at a checkpoint is self.iterations, not self.index', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ until: 'self.index >= 1', max_iterations: 3 }, [body]);

      await expect(runLoop(loop)).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
    });

    it('fails when a body node references scopes.<loop_id>.iterations — the counter on a scope entry is index, not iterations', async () => {
      const body = new (class extends BaseNode {
        public override run(_opts: NodeRunOptions): Promise<NodeRunResult> {
          return Promise.resolve({ status: 'completed', result: {} });
        }
      })({ id: 'step', if: 'scopes.loop1.iterations >= 1' });

      const loop = makeLoopNode({ max_iterations: 3 }, [body]);
      const result = await runLoop(loop);

      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: unknown }).error).toMatchObject({
        code: 'ENGINE_LOOP_BODY_FAILED',
      });
    });
  });

  describe('outputs sees only the latest body execution, not accumulated history', () => {
    it('a body node gated on scopes.loop1.index == 0 runs once and is absent from outputs afterward, contrasted against max_iterations: 1 where it remains present', async () => {
      let firstOnlyRunCount = 0;
      const firstOnly = new FactoryNode({ id: 'first_only', if: 'scopes.loop1.index == 0' }, () => {
        firstOnlyRunCount += 1;

        return { status: 'completed', result: { ran: true } };
      });

      let alwaysRunCount = 0;
      const always = new FactoryNode({ id: 'always' }, () => {
        alwaysRunCount += 1;

        return { status: 'completed', result: { ran: true } };
      });

      const loop = makeLoopNode(
        {
          max_iterations: 3,
          outputs: {
            first_only_present: 'has(self.nodes.first_only)',
            first_only_value: 'has(self.nodes.first_only) ? self.nodes.first_only.ran : "absent"',
            always_present: 'has(self.nodes.always)',
          },
        },
        [firstOnly, always]
      );

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      // Gated by index, first_only only ran on the first (index 0) body execution.
      expect(firstOnlyRunCount).toBe(1);
      expect(alwaysRunCount).toBe(3);
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['output']).toEqual({
        first_only_present: false,
        first_only_value: 'absent',
        always_present: true,
      });
    });

    it('the same guard remains true when max_iterations caps the loop at exactly one body execution', async () => {
      const firstOnly = new FactoryNode(
        { id: 'first_only', if: 'scopes.loop1.index == 0' },
        () => ({
          status: 'completed',
          result: { ran: true },
        })
      );

      const loop = makeLoopNode(
        { max_iterations: 1, outputs: { first_only_present: 'has(self.nodes.first_only)' } },
        [firstOnly]
      );

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['output']).toEqual({ first_only_present: true });
    });
  });

  describe('while: false skips every body execution', () => {
    it('outputs sees an empty self.nodes, self.iterations reads 0, and the emitted iterations is 0', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode(
        { while: 'false', outputs: { present: 'has(self.nodes.step)', iters: 'self.iterations' } },
        [body]
      );

      const result = await runLoop(loop);

      expect(result.status).toBe('completed');
      expect(body.runCount).toBe(0);
      const loopResult = (result as { status: 'completed'; result: NodeResult }).result;
      expect(loopResult['output']).toEqual({ present: false, iters: 0 });
      expect(loopResult['iterations']).toBe(0);
    });

    it('an unguarded reference into the empty self.nodes map fails with ENGINE_CEL_ERROR', async () => {
      const body = new ScopeCapturingNode({ id: 'step' });
      const loop = makeLoopNode({ while: 'false', outputs: { bad: 'self.nodes.step.value' } }, [
        body,
      ]);

      await expect(runLoop(loop)).rejects.toMatchObject({ code: 'ENGINE_CEL_ERROR' });
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

    it('throws a ZodError when while is an empty string and no other bound is set', () => {
      // '' is normalized to undefined before the at-least-one-of refine runs, so this is
      // rejected the same as omitting while entirely — not treated as a configured expression.
      expect(() =>
        LoopNode.parse({
          id: 'l1',
          loop: { while: '', nodes: [{ id: 's', bash: 'true' }] },
        })
      ).toThrow(ZodError);
    });

    it('throws a ZodError when until is an empty string and no other bound is set', () => {
      expect(() =>
        LoopNode.parse({
          id: 'l1',
          loop: { until: '', nodes: [{ id: 's', bash: 'true' }] },
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
        emitter: createEngineEmitter(),
        signal: AbortSignal.abort(),
      });

      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: unknown }).error).toMatchObject({
        code: 'ENGINE_NODE_CANCELLED',
      });
      expect(body.runCount).toBe(0);
    });

    it('propagates cancellation into the inner scheduler when aborted mid-iteration', async () => {
      // Gate the abort on a promise resolved by the body node when it starts — no timers.
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });

      let bodyAborted = false;
      let resolveBodyDone!: (result: NodeRunResult) => void;
      const bodyDone = new Promise<NodeRunResult>((resolve) => {
        resolveBodyDone = resolve;
      });

      // A body node that:
      //  (a) signals it has started (allows the test to gate the abort),
      //  (b) registers a one-time abort listener on opts.signal to record that it was aborted,
      //  (c) returns a pending promise that stays in-flight until its signal fires.
      const hangingBody = new (class extends BaseNode {
        public override run(opts: NodeRunOptions): Promise<NodeRunResult> {
          // (a) Unblock the test's abort sequence.
          resolveStarted();

          // (b) Record that the abort reached this in-flight body node.
          opts.signal.addEventListener(
            'abort',
            () => {
              bodyAborted = true;
              resolveBodyDone({ status: 'failed', error: new Error('aborted') });
            },
            { once: true }
          );

          // (c) Stay in-flight until our signal fires.
          return bodyDone;
        }
      })({ id: 'hanging' });

      // max_iterations >= 2 so the loop would otherwise keep running past the first iteration.
      const loop = makeLoopNode({ max_iterations: 5 }, [hangingBody]);
      const controller = new AbortController();

      // Start the run WITHOUT awaiting so the body can get dispatched.
      const runPromise = loop.run({
        ctx: makeCtx(),
        emitter: createEngineEmitter(),
        signal: controller.signal,
      });

      // Wait until the body node is in-flight, THEN abort.
      await started;
      controller.abort();

      const result = await runPromise;

      // The abort must have reached the in-flight body node.
      expect(bodyAborted).toBe(true);

      // LoopNode must surface cancellation — not the body's own failed result.
      expect(result.status).toBe('failed');
      expect((result as { status: 'failed'; error: unknown }).error).toMatchObject({
        code: 'ENGINE_NODE_CANCELLED',
      });
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
      // retry_step depends_on 'ghost' which does not exist in the inner body — this is an
      // unknown-reference error that only surfaces when validate() recurses into retryLoop.
      const retryStep = new ScopeCapturingNode({ id: 'retry_step', depends_on: ['ghost'] });
      const retryLoop = makeLoopNode({ id: 'retry', max_iterations: 1 }, [retryStep]);
      const ciLoop = makeLoopNode({ id: 'ci', max_iterations: 1 }, [retryLoop]);

      expect(() => {
        ciLoop.validate();
      }).toThrow(EngineConfigError);
      // 'ghost' appears in the unknown-reference message — proves the throw came from the
      // recursive validate() call into retryLoop, not from an outer-level check.
      expect(() => {
        ciLoop.validate();
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
