import { ExitNodeSchema } from '../schema.ts';
import type { BaseNodeData, NodeRunExited, NodeRunOptions } from './base.ts';
import { BaseNode } from './base.ts';
import { nodeRegistry } from './registry.ts';

interface ExitNodeData extends BaseNodeData {
  reason: string | undefined;
  failure: boolean;
}

export class ExitNode extends BaseNode<NodeRunExited> {
  private readonly reason: string | undefined;
  private readonly failure: boolean;

  public static matches(raw: Record<string, unknown>): boolean {
    return 'exit' in raw;
  }

  public static parse(raw: Record<string, unknown>): ExitNode {
    const data = ExitNodeSchema.parse(raw);

    return new ExitNode({
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.depends_on !== undefined ? { depends_on: data.depends_on } : {}),
      ...(data.if !== undefined ? { if: data.if } : {}),
      ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      ...(data.retries !== undefined ? { retries: data.retries } : {}),
      reason: data.exit.reason,
      failure: data.exit.failure ?? false,
    });
  }

  public constructor(data: ExitNodeData) {
    super(data);
    this.reason = data.reason;
    this.failure = data.failure;
  }

  // A skipped exit produces no output and no dependent needs its result, so it must not cascade
  // its skip. This makes `if:` on an exit read as a guard: condition false → skipped → dependents
  // run; condition true → exit fires → the run terminates.
  public override propagatesSkip(): boolean {
    return false;
  }

  public override run(_options: NodeRunOptions): Promise<NodeRunExited> {
    return Promise.resolve({ status: 'exited', reason: this.reason, failure: this.failure });
  }
}

nodeRegistry.register(ExitNode);
