import { evalCel } from '../cel.ts';
import type { EngineEmitter, NodeResult } from '../emitter.ts';
import { NodeError } from '../errors.ts';
import type { RetryPolicy } from '../schema.ts';

export type { NodeResult, RetryPolicy };

export interface NodeRunCompleted {
  status: 'completed';
  result: NodeResult;
  sessionId?: string | undefined;
}

export interface NodeRunExited {
  status: 'exited';
  reason?: string | undefined;
  failure: boolean;
}

export interface NodeRunBreak {
  status: 'break';
}

export interface NodeRunFailed {
  status: 'failed';
  error: unknown;
}

export type NodeRunResult = NodeRunCompleted | NodeRunExited | NodeRunBreak | NodeRunFailed;

export interface PlatformStream {
  on(event: string, handler: (...args: unknown[]) => void): PlatformStream;
  cancel(): void;
  sessionId(): Promise<string>;
}

export interface PlatformAdapter {
  run(prompt: string, options: Record<string, unknown>, sessionId?: string): PlatformStream;
  findAgent(name: string): Promise<string>;
  parseAgent(content: string): { prompt: string; options: Record<string, unknown> };
}

export interface LoopContext {
  readonly iteration: number;
  readonly nodes: ReadonlyMap<string, NodeResult>;
  readonly needs: ReadonlyMap<string, NodeResult>;
  readonly outer?: LoopContext | undefined;
}

export interface ExecutionContext {
  readonly inputs: Record<string, string | number | bigint | boolean>;
  readonly vars: Record<string, string | number | bigint | boolean>;
  readonly needs: ReadonlyMap<string, NodeResult>;
  readonly sessionDir: string;
  readonly scope?: LoopContext | undefined;
}

export interface NodeRunOptions {
  ctx: ExecutionContext;
  // Optional: only agentic nodes need a platform adapter, and those are not yet
  // wired up. Until they are, runs proceed without one.
  adapter?: PlatformAdapter | undefined;
  emitter: EngineEmitter;
  signal: AbortSignal;
  predecessorSessionId?: string | undefined;
}

export interface BaseNodeData {
  id: string;
  name?: string | undefined;
  depends_on?: string[] | undefined;
  if?: string | undefined;
  timeout?: number | undefined;
  retries?: RetryPolicy | undefined;
}

export abstract class BaseNode<R extends NodeRunResult = NodeRunResult> {
  public readonly id: string;
  public readonly name: string | undefined;
  public readonly timeout: number | undefined;
  public readonly retries: RetryPolicy | undefined;

  private readonly depends_on: string[];
  private readonly ifExpr: string | undefined;

  public constructor(data: BaseNodeData) {
    this.id = data.id;
    this.name = data.name;
    this.timeout = data.timeout;
    this.retries = data.retries;
    this.depends_on = [...(data.depends_on ?? [])];
    this.ifExpr = data.if;
  }

  public getDependencies(): string[] {
    return [...this.depends_on];
  }

  // Subclasses throw EngineConfigError to reject the workflow before execution starts.
  public validate(): void {
    return;
  }

  // Both default to false; subclasses opt in. False is the safe default for the engine's
  // branching logic — a subclass that forgets to override is inert, not dangerous.
  public isAgentic(): boolean {
    return false;
  }

  public useSharedContext(): boolean {
    return false;
  }

  // Default true: a skipped node cascades its skip to dependents. Control-flow nodes
  // (break/exit) override to false — they produce no output, so a skipped one settles its ordering
  // edges without forcing its dependents to skip.
  public propagatesSkip(): boolean {
    return true;
  }

  public evaluateIf(ctx: ExecutionContext): boolean {
    if (this.ifExpr === undefined) {
      return true;
    }

    const result = evalCel(this.ifExpr, ctx as unknown as Record<string, unknown>);

    if (typeof result !== 'boolean') {
      throw new NodeError(
        `if expression must evaluate to a boolean, got ${typeof result}`,
        'ENGINE_CEL_ERROR',
        this.id,
        { nodeName: this.name }
      );
    }

    return result;
  }

  public displayName(): string {
    return this.name ?? this.id;
  }

  public abstract run(options: NodeRunOptions): Promise<R>;
}
