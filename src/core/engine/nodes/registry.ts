import { EngineValidationError } from '../errors.ts';
import type { BaseNode, NodeRunResult } from './base.ts';

/**
 * Implement as static methods on a node class, then pass the class to
 * nodeRegistry.register().
 */
export interface NodeType<R extends NodeRunResult = NodeRunResult> {
  matches(raw: Record<string, unknown>): boolean;
  parse(raw: Record<string, unknown>): BaseNode<R>;
}

class NodeRegistry {
  private readonly types: NodeType[] = [];

  /** Register a node type. Types are matched in registration order; the first match wins. */
  public register(type: NodeType): void {
    this.types.push(type);
  }

  public parseNode(raw: Record<string, unknown>): BaseNode {
    for (const type of this.types) {
      if (type.matches(raw)) {
        return type.parse(raw);
      }
    }

    const id = typeof raw['id'] === 'string' ? `"${raw['id']}"` : '"(no id)"';
    const keys = Object.keys(raw).sort().join(', ');
    throw new EngineValidationError(`Unrecognized node shape for node ${id} — keys: [${keys}]`);
  }
}

export const nodeRegistry = new NodeRegistry();
