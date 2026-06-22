import { evalCel } from '../cel.ts';
import {
  buildContextInheritanceMap,
  topologicalSort,
  validateDependencyReferences,
  validateSharedContextFanIn,
  validateUniqueIds,
} from '../dag-utils.ts';
import type { NodeResult } from '../emitter.ts';
import { NodeError } from '../errors.ts';
import { runScheduler } from '../scheduler.ts';
import { LoopNodeSchema } from '../schema.ts';
import type {
  BaseNodeData,
  ExecutionContext,
  LoopContext,
  NodeRunCompleted,
  NodeRunExited,
  NodeRunFailed,
  NodeRunOptions,
} from './base.ts';
import { BaseNode } from './base.ts';
import { nodeRegistry } from './registry.ts';

interface LoopNodeData extends BaseNodeData {
  until?: string | undefined;
  while?: string | undefined;
  maxIterations?: number | undefined;
  bodyNodes: BaseNode[];
  outputs?: Record<string, string> | undefined;
}

export class LoopNode extends BaseNode<NodeRunCompleted | NodeRunExited | NodeRunFailed> {
  private readonly until: string | undefined;
  private readonly while: string | undefined;
  private readonly maxIterations: number | undefined;
  private readonly bodyNodes: BaseNode[];
  private readonly outputs: Record<string, string> | undefined;
  private readonly bodySharedContextMap: Map<string, string>;

  public static matches(raw: Record<string, unknown>): boolean {
    return 'loop' in raw;
  }

  public static parse(raw: Record<string, unknown>): LoopNode {
    const data = LoopNodeSchema.parse(raw);
    const bodyNodes = data.loop.nodes.map((node) => nodeRegistry.parseNode(node));

    return new LoopNode({
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.depends_on !== undefined ? { depends_on: data.depends_on } : {}),
      ...(data.if !== undefined ? { if: data.if } : {}),
      ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      ...(data.retries !== undefined ? { retries: data.retries } : {}),
      until: data.loop.until,
      while: data.loop.while,
      maxIterations: data.loop.max_iterations,
      bodyNodes,
      outputs: data.loop.outputs,
    });
  }

  public constructor(data: LoopNodeData) {
    super(data);
    this.until = data.until;
    this.while = data.while;
    this.maxIterations = data.maxIterations;
    this.bodyNodes = data.bodyNodes;
    this.outputs = data.outputs;
    this.bodySharedContextMap = buildContextInheritanceMap(data.bodyNodes);
  }

  // Validates the loop body in isolation: depends_on references, shared-context
  // fan-in, and cycles are all scoped to the body list, so a body node cannot
  // reference a node outside the loop (FR-024). Nested loops validate recursively.
  public override validate(): void {
    validateUniqueIds(this.bodyNodes);
    validateDependencyReferences(this.bodyNodes);
    validateSharedContextFanIn(this.bodyNodes);
    topologicalSort(this.bodyNodes);

    for (const node of this.bodyNodes) {
      node.validate();
    }
  }

  public override async run(
    options: NodeRunOptions
  ): Promise<NodeRunCompleted | NodeRunExited | NodeRunFailed> {
    const { ctx, platform, emitter, signal } = options;
    const parentScope = ctx.scope;

    // Body nodes reach external dependencies only via scope.needs.<id> (FR-030),
    // never the top-level needs map.
    const loopNeeds = new Map<string, NodeResult>();
    for (const depId of this.getDependencies()) {
      const depResult = ctx.needs.get(depId);
      if (depResult !== undefined) {
        loopNeeds.set(depId, depResult);
      }
    }

    let lastIterationNodes: ReadonlyMap<string, NodeResult> = new Map<string, NodeResult>();
    let completedIterations = 0;

    for (;;) {
      if (signal.aborted) {
        return this.cancelledResult();
      }

      if (
        !this.evaluateWhile(ctx, lastIterationNodes, loopNeeds, parentScope, completedIterations)
      ) {
        break;
      }

      const scope: LoopContext = {
        iteration: completedIterations,
        nodes: lastIterationNodes,
        needs: loopNeeds,
        outer: parentScope,
      };

      const innerCtx: ExecutionContext = {
        inputs: ctx.inputs,
        vars: ctx.vars,
        needs: new Map(),
        sessionDir: ctx.sessionDir,
        cwd: ctx.cwd,
        scope,
      };

      const res = await runScheduler(this.bodyNodes, innerCtx, {
        platform,
        emitter,
        sharedContextMap: this.bodySharedContextMap,
        signal,
      });

      // A mid-iteration abort makes the just-returned result derive from cancelled body nodes, so
      // surface cancellation rather than the aborted run's outcome.
      if (signal.aborted) {
        return this.cancelledResult();
      }

      if (res.outcome === 'exited') {
        return { status: 'exited', reason: res.exitReason, failure: !res.success };
      }

      if (!res.success) {
        return {
          status: 'failed',
          error: new NodeError('Loop body failed', 'ENGINE_LOOP_BODY_FAILED', this.id, {
            nodeName: this.name,
          }),
        };
      }

      // The just-run iteration's snapshot — partial on a break, full otherwise. It feeds
      // `outputs` after the loop, and the next iteration's `scope.nodes` when the loop
      // continues. Assigning the partial on the break path is safe because the next-iteration
      // read is unreachable after a break, so the partial snapshot only ever reaches `outputs`.
      lastIterationNodes = res.nodeResults;

      if (res.outcome === 'broke') {
        break;
      }

      completedIterations += 1;

      if (
        this.evaluateUntil(ctx, lastIterationNodes, loopNeeds, parentScope, completedIterations)
      ) {
        break;
      }

      if (this.maxIterations !== undefined && completedIterations >= this.maxIterations) {
        break;
      }
    }

    const output = this.evaluateOutputs(
      ctx,
      lastIterationNodes,
      loopNeeds,
      parentScope,
      completedIterations
    );

    const result: NodeResult = { total_iterations: completedIterations, output };

    return { status: 'completed', result };
  }

  // until must yield a boolean, mirroring BaseNode.evaluateIf; a bad expression
  // or non-boolean result surfaces as a NodeError rather than an unhandled throw.
  private evaluateUntil(
    ctx: ExecutionContext,
    nodes: ReadonlyMap<string, NodeResult>,
    loopNeeds: ReadonlyMap<string, NodeResult>,
    parentScope: LoopContext | undefined,
    iteration: number
  ): boolean {
    if (!this.until) {
      return false;
    }

    const evalCtx: ExecutionContext = {
      inputs: ctx.inputs,
      vars: ctx.vars,
      needs: loopNeeds,
      sessionDir: ctx.sessionDir,
      cwd: ctx.cwd,
      scope: { iteration, nodes, needs: loopNeeds, outer: parentScope },
    };

    let result: unknown;
    try {
      result = evalCel(this.until, evalCtx as unknown as Record<string, unknown>);
    } catch (err) {
      throw new NodeError('Failed to evaluate until expression', 'ENGINE_CEL_ERROR', this.id, {
        nodeName: this.name,
        cause: err,
      });
    }

    if (typeof result !== 'boolean') {
      throw new NodeError(
        `until expression must evaluate to a boolean, got ${typeof result}`,
        'ENGINE_CEL_ERROR',
        this.id,
        { nodeName: this.name }
      );
    }

    return result;
  }

  // while must yield a boolean, mirroring BaseNode.evaluateIf; the loop proceeds only while it
  // is true. Returns true when no while is configured so the loop runs unconditionally. An empty
  // string is a configured expression (not "unset"), so it falls through to evalCel and fails.
  private evaluateWhile(
    ctx: ExecutionContext,
    nodes: ReadonlyMap<string, NodeResult>,
    loopNeeds: ReadonlyMap<string, NodeResult>,
    parentScope: LoopContext | undefined,
    iteration: number
  ): boolean {
    if (this.while === undefined) {
      return true;
    }

    const evalCtx: ExecutionContext = {
      inputs: ctx.inputs,
      vars: ctx.vars,
      needs: loopNeeds,
      sessionDir: ctx.sessionDir,
      cwd: ctx.cwd,
      scope: { iteration, nodes, needs: loopNeeds, outer: parentScope },
    };

    let result: unknown;
    try {
      result = evalCel(this.while, evalCtx as unknown as Record<string, unknown>);
    } catch (err) {
      throw new NodeError('Failed to evaluate while expression', 'ENGINE_CEL_ERROR', this.id, {
        nodeName: this.name,
        cause: err,
      });
    }

    if (typeof result !== 'boolean') {
      throw new NodeError(
        `while expression must evaluate to a boolean, got ${typeof result}`,
        'ENGINE_CEL_ERROR',
        this.id,
        { nodeName: this.name }
      );
    }

    return result;
  }

  private evaluateOutputs(
    ctx: ExecutionContext,
    nodes: ReadonlyMap<string, NodeResult>,
    loopNeeds: ReadonlyMap<string, NodeResult>,
    parentScope: LoopContext | undefined,
    iteration: number
  ): Record<string, unknown> {
    if (this.outputs === undefined) {
      return {};
    }

    const evalCtx: ExecutionContext = {
      inputs: ctx.inputs,
      vars: ctx.vars,
      needs: loopNeeds,
      sessionDir: ctx.sessionDir,
      cwd: ctx.cwd,
      scope: { iteration, nodes, needs: loopNeeds, outer: parentScope },
    };
    const celContext = evalCtx as unknown as Record<string, unknown>;

    const output: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(this.outputs)) {
      try {
        output[key] = evalCel(expr, celContext);
      } catch (err) {
        throw new NodeError(`Failed to evaluate output '${key}'`, 'ENGINE_CEL_ERROR', this.id, {
          nodeName: this.name,
          cause: err,
        });
      }
    }

    return output;
  }

  private cancelledResult(): NodeRunFailed {
    return {
      status: 'failed',
      error: new NodeError('Loop cancelled', 'ENGINE_NODE_CANCELLED', this.id, {
        nodeName: this.name,
      }),
    };
  }
}

nodeRegistry.register(LoopNode);
