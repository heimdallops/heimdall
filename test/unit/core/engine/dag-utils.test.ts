import { describe, expect, it } from 'vitest';

import {
  topologicalSort,
  validateDependencyReferences,
  validateNodeIds,
  validateNoNodeTypes,
} from '../../../../src/core/engine/dag-utils.ts';
import { EngineConfigError } from '../../../../src/core/engine/errors.ts';
import type { NodeRunOptions, NodeRunResult } from '../../../../src/core/engine/nodes/base.ts';
import { BaseNode, RESERVED_IDS } from '../../../../src/core/engine/nodes/base.ts';

class StubNode extends BaseNode {
  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

class BreakLikeNode extends BaseNode {
  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

class ApprovalLikeNode extends BaseNode {
  public run(_options: NodeRunOptions): Promise<NodeRunResult> {
    return Promise.resolve({ status: 'completed', result: {} });
  }
}

describe('validateNodeIds', () => {
  it('does not throw when the node list is empty', () => {
    expect(() => {
      validateNodeIds([]);
    }).not.toThrow();
  });

  it('does not throw when every id is distinct', () => {
    const nodes = [new StubNode({ id: 'alpha' }), new StubNode({ id: 'beta' })];

    expect(() => {
      validateNodeIds(nodes);
    }).not.toThrow();
  });

  it('does not throw when ids merely resemble reserved words', () => {
    const nodes = [new StubNode({ id: 'loop_body' }), new StubNode({ id: 'my_switch' })];

    expect(() => {
      validateNodeIds(nodes);
    }).not.toThrow();
  });

  it.each([...RESERVED_IDS])(
    'throws EngineConfigError naming the id when a node uses the reserved word %s',
    (id) => {
      let thrown: unknown;
      try {
        validateNodeIds([new StubNode({ id })]);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(EngineConfigError);
      expect((thrown as Error).message).toContain(`Node id '${id}' is reserved`);
    }
  );

  it('throws EngineConfigError naming the id when two nodes in the list share an id', () => {
    const nodes = [
      new StubNode({ id: 'unique' }),
      new StubNode({ id: 'dup' }),
      new StubNode({ id: 'dup' }),
    ];

    let thrown: unknown;
    try {
      validateNodeIds(nodes);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(EngineConfigError);
    expect((thrown as Error).message).toBe(
      "Duplicate node id: 'dup'; node ids must be unique across the entire workflow"
    );
  });
});

describe('validateDependencyReferences', () => {
  it('includes the referencing node id and missing dependency id in the error message', () => {
    const nodes = [new StubNode({ id: 'B', depends_on: ['ghost'] })];

    let thrown: unknown;
    try {
      validateDependencyReferences(nodes);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(EngineConfigError);
    expect((thrown as Error).message).toBe("Node 'B' has unknown depends_on reference: 'ghost'");
  });

  it('throws even when some dependencies are valid and one is not', () => {
    const nodes = [
      new StubNode({ id: 'A' }),
      new StubNode({ id: 'B', depends_on: ['A', 'missing'] }),
    ];

    expect(() => {
      validateDependencyReferences(nodes);
    }).toThrow("unknown depends_on reference: 'missing'");
  });

  it('does not throw when all dependency references are valid', () => {
    const nodes = [new StubNode({ id: 'A' }), new StubNode({ id: 'B', depends_on: ['A'] })];

    expect(() => {
      validateDependencyReferences(nodes);
    }).not.toThrow();
  });

  it('does not throw when nodes have no dependencies', () => {
    const nodes = [new StubNode({ id: 'X' }), new StubNode({ id: 'Y' })];

    expect(() => {
      validateDependencyReferences(nodes);
    }).not.toThrow();
  });
});

describe('topologicalSort', () => {
  it('includes the cycle participant ids and message in the error', () => {
    const nodes = [
      new StubNode({ id: 'X', depends_on: ['Y'] }),
      new StubNode({ id: 'Y', depends_on: ['X'] }),
    ];

    let thrown: unknown;
    try {
      topologicalSort(nodes);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(EngineConfigError);
    expect((thrown as Error).message).toContain("'X'");
    expect((thrown as Error).message).toContain("'Y'");
  });

  it('throws for a three-node cycle', () => {
    const nodes = [
      new StubNode({ id: 'A', depends_on: ['C'] }),
      new StubNode({ id: 'B', depends_on: ['A'] }),
      new StubNode({ id: 'C', depends_on: ['B'] }),
    ];

    expect(() => topologicalSort(nodes)).toThrow('Cycle detected in workflow graph');
  });

  it('returns a topologically ordered array for a valid linear chain', () => {
    const nodeA = new StubNode({ id: 'A' });
    const nodeB = new StubNode({ id: 'B', depends_on: ['A'] });
    const nodeC = new StubNode({ id: 'C', depends_on: ['B'] });

    const result = topologicalSort([nodeA, nodeB, nodeC]);

    const ids = result.map((n) => n.id);
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('B'));
    expect(ids.indexOf('B')).toBeLessThan(ids.indexOf('C'));
  });

  it('returns all input nodes when the graph is acyclic', () => {
    const nodes = [new StubNode({ id: 'X' }), new StubNode({ id: 'Y' }), new StubNode({ id: 'Z' })];

    const result = topologicalSort(nodes);

    expect(result).toHaveLength(3);
    expect(result.map((n) => n.id)).toEqual(expect.arrayContaining(['X', 'Y', 'Z']));
  });
});

describe('validateNoNodeTypes', () => {
  it('does not throw when disallowedClasses is empty, even with nodes present', () => {
    const nodes = [new BreakLikeNode({ id: 'node-a' }), new ApprovalLikeNode({ id: 'node-b' })];

    expect(() => {
      validateNoNodeTypes(nodes, []);
    }).not.toThrow();
  });

  it('does not throw when nodes array is empty', () => {
    expect(() => {
      validateNoNodeTypes([], [BreakLikeNode, ApprovalLikeNode]);
    }).not.toThrow();
  });

  it('does not throw when no node is an instance of any disallowed class', () => {
    const nodes = [new StubNode({ id: 'step-1' }), new StubNode({ id: 'step-2' })];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode, ApprovalLikeNode]);
    }).not.toThrow();
  });

  it('includes the node id, matched class name, and disallowed class names in the error message when a node is disallowed', () => {
    const nodes = [new BreakLikeNode({ id: 'offending-node' })];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode]);
    }).toThrow(
      "Node 'offending-node' has type 'BreakLikeNode' which is not allowed here; disallowed types: ['BreakLikeNode']"
    );
  });

  it('throws when a node matches any class in a multi-entry disallowed list', () => {
    const nodes = [new ApprovalLikeNode({ id: 'gate-node' })];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode, ApprovalLikeNode]);
    }).toThrow(
      "Node 'gate-node' has type 'ApprovalLikeNode' which is not allowed here; disallowed types: ['BreakLikeNode', 'ApprovalLikeNode']"
    );
  });

  it('throws on the first matching node, not the last', () => {
    const nodes = [
      new StubNode({ id: 'allowed-1' }),
      new BreakLikeNode({ id: 'first-bad' }),
      new ApprovalLikeNode({ id: 'second-bad' }),
    ];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode, ApprovalLikeNode]);
    }).toThrow(
      "Node 'first-bad' has type 'BreakLikeNode' which is not allowed here; disallowed types: ['BreakLikeNode', 'ApprovalLikeNode']"
    );
  });

  it('throws when a node is an instance of a disallowed superclass, even if the subclass itself is not listed', () => {
    class BreakLikeSubNode extends BreakLikeNode {}
    const nodes = [new BreakLikeSubNode({ id: 'node-y' })];

    expect(() => {
      validateNoNodeTypes(nodes, [BreakLikeNode]);
    }).toThrow(
      "Node 'node-y' has type 'BreakLikeSubNode' which is not allowed here; disallowed types: ['BreakLikeNode']"
    );
  });
});
