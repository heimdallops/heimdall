import { evalCel } from '../cel.ts';
import {
  buildContextInheritanceMap,
  topologicalSort,
  validateDependencyReferences,
  validateSharedContextFanIn,
} from '../dag-utils.ts';
import type { NodeResult } from '../emitter.ts';
import { NodeError } from '../errors.ts';
import { buildCheckpointContext, extendScope, selectNeeds } from '../expression-context.ts';
import { runScheduler } from '../scheduler.ts';
import { LoopNodeSchema } from '../schema.ts';
import type {
  BaseNodeData,
  ExecutionContext,
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
  // reference a node outside the loop. Nested loops validate recursively.
  public override validate(): void {
    validateDependencyReferences(this.bodyNodes);
    validateSharedContextFanIn(this.bodyNodes);
    topologicalSort(this.bodyNodes);

    for (const node of this.bodyNodes) {
      node.validate();
    }
  }

  public override isScopedNode(): boolean {
    return true;
  }

  public override getScopeBody(): readonly BaseNode[] {
    return this.bodyNodes;
  }

  public override async run(
    options: NodeRunOptions
  ): Promise<NodeRunCompleted | NodeRunExited | NodeRunFailed> {
    const { ctx, platform, emitter, signal } = options;

    const loopNeeds = selectNeeds(ctx.needs, this.getDependencies());

    let lastIterationNodes: ReadonlyMap<string, NodeResult> = new Map<string, NodeResult>();
    let completedIterations = 0;

    for (;;) {
      if (signal.aborted) {
        return this.cancelledResult();
      }

      if (!this.evaluateWhile(ctx, lastIterationNodes, completedIterations)) {
        break;
      }

      const innerCtx: ExecutionContext = {
        inputs: ctx.inputs,
        vars: ctx.vars,
        needs: new Map(),
        cwd: ctx.cwd,
        heimdall: ctx.heimdall,
        scopes: extendScope(
          ctx.scopes,
          this.id,
          { needs: loopNeeds, prev: lastIterationNodes },
          { index: completedIterations }
        ),
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

      // Latest body execution only, never merged across executions: it is read as `self.nodes` at
      // the loop's checkpoints and as `scopes.<id>.prev` inside the next body execution.
      lastIterationNodes = res.nodeResults;

      completedIterations += 1;

      if (res.outcome === 'broke') {
        break;
      }

      if (this.evaluateUntil(ctx, lastIterationNodes, completedIterations)) {
        break;
      }

      if (this.maxIterations !== undefined && completedIterations >= this.maxIterations) {
        break;
      }
    }

    const output = this.evaluateOutputs(ctx, lastIterationNodes, completedIterations);

    const result: NodeResult = { iterations: completedIterations, output };

    return { status: 'completed', result };
  }

  // until must yield a boolean, mirroring BaseNode.evaluateIf; a bad expression
  // or non-boolean result surfaces as a NodeError rather than an unhandled throw.
  private evaluateUntil(
    ctx: ExecutionContext,
    nodes: ReadonlyMap<string, NodeResult>,
    completedIterations: number
  ): boolean {
    if (!this.until) {
      return false;
    }

    const evalCtx = buildCheckpointContext(ctx, this.getDependencies(), nodes, {
      iterations: completedIterations,
    });

    let result: unknown;
    try {
      result = evalCel(this.until, evalCtx);
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
  // is true. An unset or empty while leaves the loop unconditional, matching until.
  private evaluateWhile(
    ctx: ExecutionContext,
    nodes: ReadonlyMap<string, NodeResult>,
    completedIterations: number
  ): boolean {
    if (!this.while) {
      return true;
    }

    const evalCtx = buildCheckpointContext(ctx, this.getDependencies(), nodes, {
      iterations: completedIterations,
    });

    let result: unknown;
    try {
      result = evalCel(this.while, evalCtx);
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
    completedIterations: number
  ): Record<string, unknown> {
    if (this.outputs === undefined) {
      return {};
    }

    const evalCtx = buildCheckpointContext(ctx, this.getDependencies(), nodes, {
      iterations: completedIterations,
    });

    const output: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(this.outputs)) {
      try {
        output[key] = evalCel(expr, evalCtx);
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
