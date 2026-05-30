import { describe, expect, it, vi } from 'vitest';

import { EngineValidationError } from '../../../../../src/core/engine/errors.ts';
import type { NodeRunOptions, NodeRunResult } from '../../../../../src/core/engine/nodes/base.ts';
import { BaseNode } from '../../../../../src/core/engine/nodes/base.ts';
import type { NodeType } from '../../../../../src/core/engine/nodes/registry.ts';

class BashStubNode extends BaseNode {
  public static matches(raw: Record<string, unknown>): boolean {
    return 'bash' in raw;
  }

  public static parse(raw: Record<string, unknown>): BaseNode {
    const id = typeof raw['id'] === 'string' ? raw['id'] : 'stub-id';

    return new BashStubNode({ id });
  }

  public override run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

class AgentStubNode extends BaseNode {
  public static matches(raw: Record<string, unknown>): boolean {
    return 'agent' in raw;
  }

  public static parse(raw: Record<string, unknown>): BaseNode {
    const id = typeof raw['id'] === 'string' ? raw['id'] : 'stub-id';

    return new AgentStubNode({ id });
  }

  public override run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

interface RegistryExports {
  nodeRegistry: {
    register(type: NodeType): void;
    parseNode(raw: Record<string, unknown>): BaseNode;
  };
}

// nodeRegistry is a module-level singleton; resetModules forces a fresh evaluation so each test starts with an empty registry.
const freshRegistry = (): Promise<RegistryExports> => {
  vi.resetModules();

  return import('../../../../../src/core/engine/nodes/registry.ts');
};

describe('nodeRegistry.parseNode', () => {
  describe('happy path — registered type matches', () => {
    it('returns the BaseNode produced by the matching NodeType parse()', async () => {
      const { nodeRegistry } = await freshRegistry();
      nodeRegistry.register(BashStubNode);

      const raw = { id: 'node-1', bash: 'echo hi' };
      const result = nodeRegistry.parseNode(raw);

      expect(result).toBeInstanceOf(BashStubNode);
      expect(result.id).toBe('node-1');
    });
  });

  describe('first-match priority', () => {
    it('returns the first-registered type when both types match', async () => {
      const { nodeRegistry } = await freshRegistry();

      // Raw has both 'bash' and 'agent' keys, so both types match; first registered wins.
      nodeRegistry.register(BashStubNode);
      nodeRegistry.register(AgentStubNode);

      const raw = { id: 'node-x', bash: 'echo hi', agent: 'my-agent' };
      const result = nodeRegistry.parseNode(raw);

      expect(result).toBeInstanceOf(BashStubNode);
    });
  });

  describe('no match → EngineValidationError', () => {
    it('throws EngineValidationError with the node id and keys in the message', async () => {
      const { nodeRegistry } = await freshRegistry();
      nodeRegistry.register(BashStubNode);

      const raw = { id: 'mystery', unknown_key: true };
      expect(() => nodeRegistry.parseNode(raw)).toThrow(
        new EngineValidationError(
          'Unrecognized node shape for node "mystery" — keys: [id, unknown_key]'
        )
      );
    });

    it('uses "(no id)" in the error message when the raw object has no string id', async () => {
      const { nodeRegistry } = await freshRegistry();
      nodeRegistry.register(BashStubNode);

      const raw = { kind: 'unknown' };
      expect(() => nodeRegistry.parseNode(raw)).toThrow(
        'Unrecognized node shape for node "(no id)" — keys: [kind]'
      );
    });
  });

  describe('registration isolation — one type does not affect unrelated shapes', () => {
    it('routes each shape to its registered type', async () => {
      const { nodeRegistry } = await freshRegistry();
      nodeRegistry.register(BashStubNode);
      nodeRegistry.register(AgentStubNode);

      const bashResult = nodeRegistry.parseNode({ id: 'b1', bash: 'echo hi' });
      const agentResult = nodeRegistry.parseNode({ id: 'a1', agent: 'my-agent' });

      expect(bashResult).toBeInstanceOf(BashStubNode);
      expect(agentResult).toBeInstanceOf(AgentStubNode);
    });
  });
});
