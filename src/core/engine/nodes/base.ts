import type { Platform } from '../../platform/index.ts';
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

// An implementation MUST emit exactly one terminal event — either 'done' or 'error' — over the
// stream's lifetime, including after cancel(). Consumers like AgenticNode await a single terminal
// event to settle their result; emitting none would hang the node, and emitting more than one would
// risk double-settling.
export interface PlatformStream {
  on(event: string, handler: (...args: unknown[]) => void): PlatformStream;
  cancel(): void;
  sessionId(): Promise<string>;
}

// The engine holds an opaque adapter (Record-typed options) to stay decoupled from concrete
// per-platform option types. Concrete adapters like ClaudeCodeAdapter satisfy this structural
// interface via method-parameter bivariance.
export interface PlatformAdapter {
  run(prompt: string, options: Record<string, unknown>, sessionId?: string): PlatformStream;
}

export type AdapterFactory = (platform: Platform, cwd: string) => Promise<PlatformAdapter>;

export interface PlatformRuntime {
  factory: AdapterFactory;
  defaultPlatform: Platform;
  defaultPlatformOptions?: Record<string, unknown> | undefined;
}

export interface LoopDetails {
  readonly iteration: number;
  readonly nodes: ReadonlyMap<string, NodeResult>;
}

// Scope state is namespaced per scope-node type so nested scopes of different kinds coexist.
// Same-family nesting shadows the enclosing binding; `outer` is the route to what was shadowed.
export interface ScopeContext {
  readonly needs: ReadonlyMap<string, NodeResult>;
  readonly loop?: LoopDetails | undefined;
  readonly outer?: ScopeContext | undefined;
}

export interface ExecutionContext {
  readonly inputs: Record<string, string | number | bigint | boolean>;
  readonly vars: Record<string, string | number | bigint | boolean>;
  readonly needs: ReadonlyMap<string, NodeResult>;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly scope?: ScopeContext | undefined;
}

export interface NodeRunOptions {
  ctx: ExecutionContext;
  platform?: PlatformRuntime | undefined;
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
