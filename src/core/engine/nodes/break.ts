import { BreakNodeSchema } from '../schema.ts';
import type { BaseNodeData, NodeRunBreak, NodeRunOptions } from './base.ts';
import { BaseNode } from './base.ts';
import { nodeRegistry } from './registry.ts';

type BreakNodeData = BaseNodeData;

export class BreakNode extends BaseNode<NodeRunBreak> {
  public static matches(raw: Record<string, unknown>): boolean {
    return 'break' in raw;
  }

  public static parse(raw: Record<string, unknown>): BreakNode {
    const data = BreakNodeSchema.parse(raw);

    return new BreakNode({
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.depends_on !== undefined ? { depends_on: data.depends_on } : {}),
      ...(data.if !== undefined ? { if: data.if } : {}),
      ...(data.timeout !== undefined ? { timeout: data.timeout } : {}),
      ...(data.retries !== undefined ? { retries: data.retries } : {}),
    });
  }

  public constructor(data: BreakNodeData) {
    super(data);
  }

  public override run(_options: NodeRunOptions): Promise<NodeRunBreak> {
    return Promise.resolve({ status: 'break' });
  }
}

nodeRegistry.register(BreakNode);
